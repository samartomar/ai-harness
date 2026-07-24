import { existsSync } from "node:fs";
import { join } from "node:path";
import { entry } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { LOADABILITY_SENTINEL } from "../internals/loadability-sentinel.js";
import type { PlanContext } from "../internals/plan.js";

/**
 * LOADABILITY — present file ≠ loaded. The coverage matrix asks "is the bootloader
 * there and in sync"; this asks "will the CLI actually load it every turn, and does
 * the pointer chain it routes to resolve". It catches the silent-failure class a
 * file-existence check can't see: a Cursor `.mdc` with `alwaysApply:false` (present,
 * in sync, never auto-loaded), a Kiro steering file missing `inclusion: always`, a
 * BOM/unterminated frontmatter that won't parse, or a bootloader that points at a
 * `RULE_ROUTER.md` that isn't there.
 *
 * Honesty rule (D0/D6): three verdicts, never collapsed. `loads` means the
 * structural checks pass AND a registered Tier-2 dry-run probe printed the router
 * sentinel. `wontLoad` is proven broken. `unverified` is "can't prove from a repo
 * scan" (e.g. no bootloader yet, or no CLI context-dump probe is registered).
 */

export type LoadVerdict = "loads" | "wontLoad" | "unverified";

export interface LoadCheck {
  name: "activation" | "frontmatter-hygiene" | "router-chain" | "context-cap" | "dry-run-probe";
  /** true = pass, false = fail (→ wontLoad), undefined = n/a or not runtime-proven. */
  ok: boolean | undefined;
  detail: string;
}

export interface CliLoadability {
  cli: Cli;
  verdict: LoadVerdict;
  checks: LoadCheck[];
  /** One-line fix, present only when `wontLoad`. */
  fix?: string;
}

/** A frontmatter opener: `---` at byte 0, optional trailing spaces, LF or CRLF (#500). */
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/;

/**
 * Parse a leading `---` frontmatter block into flat key/value pairs. Byte-level
 * variance that leaves the YAML document identical — a UTF-8 BOM, CRLF line
 * endings, spaces before the colon — must not change the result (#500: Windows
 * -flavored Kiro steering files were flagged as missing `inclusion: always`).
 * Keys stay anchored at column 0 so a nested mapping never counts as top-level,
 * and values keep their quotes: equivalence is decided in
 * {@link activationValueMatches}, not here. A spaced colon must still be a YAML
 * mapping indicator (followed by whitespace or end-of-line): `key :value` is a
 * plain scalar in strict YAML — no key at all — so it stays rejected.
 */
function frontmatterOf(text: string): Record<string, string> | undefined {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = t.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!m?.[1]) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)(?::|[ \t]+:(?=[ \t]|$))\s*(.*)$/);
    if (kv?.[1]) fields[kv[1]] = (kv[2] ?? "").trim();
  }
  return fields;
}

/** Plain YAML literals whose type changes when quoted; a quoted form must not match them. */
const YAML_NON_STRING_LITERALS = new Set(["true", "false", "null", "~"]);

/**
 * Whether a parsed frontmatter value carries the required activation value.
 * Byte-equal always matches. A quoted value (`inclusion: "always"`) is the same
 * YAML string as the plain form, so it matches too (#500) — unless the expected
 * value is a non-string literal: quoting `true` turns Cursor's `alwaysApply`
 * boolean into a string, so that stays byte-strict and keeps failing closed.
 */
function activationValueMatches(raw: string | undefined, expected: string): boolean {
  if (raw === undefined) return false;
  if (raw === expected) return true;
  if (YAML_NON_STRING_LITERALS.has(expected)) return false;
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  return quoted !== null && quoted[1] === expected;
}

/** The bootloader carries the required activation key (Cursor/Kiro), or n/a. */
function activationCheck(ctx: PlanContext, cli: Cli, present: string[]): LoadCheck {
  const act = entry(cli).activation;
  if (!act) {
    return {
      name: "activation",
      ok: undefined,
      detail: "inherently always-on (no frontmatter activation required)",
    };
  }
  const bad: string[] = [];
  for (const rel of present) {
    const fm = frontmatterOf(readIfExists(join(ctx.root, rel)) ?? "");
    if (!fm || !activationValueMatches(fm[act.key], act.value)) bad.push(rel);
  }
  return bad.length === 0
    ? { name: "activation", ok: true, detail: `${act.key}: ${act.value} set` }
    : {
        name: "activation",
        ok: false,
        detail: `${act.key}: ${act.value} missing in ${bad.join(", ")} — present but not auto-loaded`,
      };
}

/**
 * No load-blocking bytes, and any opened frontmatter block actually closes/parses.
 * Kiro's steering loader strips a UTF-8 BOM before parsing frontmatter
 * (field-verified, #500), so a BOM alone is not a load blocker there; every other
 * CLI keeps the strict no-BOM contract.
 */
function hygieneCheck(ctx: PlanContext, cli: Cli, present: string[]): LoadCheck {
  const bad: string[] = [];
  let bomTolerated = false;
  for (const rel of present) {
    const text = readIfExists(join(ctx.root, rel)) ?? "";
    const hasBom = text.charCodeAt(0) === 0xfeff;
    if (hasBom && cli !== "kiro") {
      bad.push(`${rel} (BOM before content)`);
      continue;
    }
    bomTolerated ||= hasBom;
    const t = hasBom ? text.slice(1) : text;
    if (FRONTMATTER_OPEN.test(t) && frontmatterOf(t) === undefined) {
      bad.push(`${rel} (unterminated frontmatter)`);
    }
  }
  if (bad.length > 0) {
    return {
      name: "frontmatter-hygiene",
      ok: false,
      detail: `byte/frontmatter issue: ${bad.join(", ")}`,
    };
  }
  return {
    name: "frontmatter-hygiene",
    ok: true,
    detail: bomTolerated
      ? "frontmatter parses (UTF-8 BOM tolerated by Kiro's loader)"
      : "no BOM; frontmatter parses",
  };
}

function targetChainCheck(
  targets: Array<[label: string, path: string]>,
  okDetail: string,
  missingPrefix: string,
): LoadCheck {
  const missing = targets.filter(([, p]) => !existsSync(p)).map(([label]) => label);
  return missing.length === 0
    ? { name: "router-chain", ok: true, detail: okDetail }
    : { name: "router-chain", ok: false, detail: `${missingPrefix}: ${missing.join(", ")}` };
}

function isWorkspaceRoot(ctx: PlanContext): boolean {
  const raw = readIfExists(join(ctx.root, ".aih-workspace.json"));
  if (raw === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { workspaceType?: unknown }).workspaceType === "multi-repo" &&
      (parsed as { generatedBy?: unknown }).generatedBy === "aih workspace"
    );
  } catch {
    return false;
  }
}

/** The repo canon the bootloader routes to (RULE_ROUTER.md + the core) exists. */
function repoRouterChainCheck(ctx: PlanContext): LoadCheck {
  return targetChainCheck(
    [
      [`${ctx.contextDir}/RULE_ROUTER.md`, join(ctx.root, ctx.contextDir, "RULE_ROUTER.md")],
      [
        `${ctx.contextDir}/rules/agent-behavior-core.md`,
        join(ctx.root, ctx.contextDir, "rules", "agent-behavior-core.md"),
      ],
    ],
    "router + behavior core reachable",
    "pointer target missing",
  );
}

/** The parent workspace canon the bootloader routes to exists. */
function workspaceRouterChainCheck(ctx: PlanContext): LoadCheck {
  return targetChainCheck(
    [
      [
        `${ctx.contextDir}/cross-repo-architecture.md`,
        join(ctx.root, ctx.contextDir, "cross-repo-architecture.md"),
      ],
      [
        `${ctx.contextDir}/repo-discipline.md`,
        join(ctx.root, ctx.contextDir, "repo-discipline.md"),
      ],
    ],
    "workspace canon docs reachable",
    "workspace target missing",
  );
}

/** The canon the bootloader routes to actually exists. */
function routerChainCheck(ctx: PlanContext): LoadCheck {
  if (isWorkspaceRoot(ctx)) return workspaceRouterChainCheck(ctx);
  return repoRouterChainCheck(ctx);
}

/** The always-loaded bundle is within the tool's documented char cap (or n/a). */
function contextCapCheck(ctx: PlanContext, cli: Cli, present: string[]): LoadCheck {
  const cap = entry(cli).contextCap;
  if (cap === undefined) {
    return { name: "context-cap", ok: undefined, detail: "no documented per-bootloader cap" };
  }
  const chars = present.reduce((n, rel) => n + (readIfExists(join(ctx.root, rel))?.length ?? 0), 0);
  return chars <= cap
    ? { name: "context-cap", ok: true, detail: `${chars} ≤ ${cap} char cap` }
    : {
        name: "context-cap",
        ok: false,
        detail: `${chars} > ${cap} char cap — tail may be silently truncated`,
      };
}

const DRY_RUN_PROBE_TIMEOUT_MS = 10_000;

function dryRunProbeStaticCheck(cli: Cli): LoadCheck {
  const probe = entry(cli).dryRunProbe;
  if (probe.kind === "manual") {
    return { name: "dry-run-probe", ok: undefined, detail: `manual check: ${probe.detail}` };
  }
  return {
    name: "dry-run-probe",
    ok: undefined,
    detail: `dry-run probe registered (${probe.argv.join(" ")}) — run aih doctor --verify to grep ${LOADABILITY_SENTINEL}`,
  };
}

function outputFor(
  probe: Extract<ReturnType<typeof entry>["dryRunProbe"], { kind: "command" }>,
  stdout: string,
  stderr: string,
): string {
  if (probe.output === "stdout") return stdout;
  if (probe.output === "stderr") return stderr;
  return `${stdout}\n${stderr}`;
}

function withDryRunCheck(base: CliLoadability, check: LoadCheck): CliLoadability {
  const checks = [...base.checks, check];
  if (check.ok === true) return { cli: base.cli, verdict: "loads", checks };
  if (check.ok === false) {
    return {
      cli: base.cli,
      verdict: "wontLoad",
      checks,
      fix: base.fix ?? `aih bootstrap-ai --apply --cli ${base.cli}`,
    };
  }
  return { cli: base.cli, verdict: "unverified", checks };
}

async function dryRunProbeCheck(ctx: PlanContext, cli: Cli): Promise<LoadCheck> {
  const probe = entry(cli).dryRunProbe;
  if (probe.kind === "manual") return dryRunProbeStaticCheck(cli);

  const res = await ctx.run(probe.argv, {
    cwd: ctx.root,
    timeoutMs: probe.timeoutMs ?? DRY_RUN_PROBE_TIMEOUT_MS,
  });
  const cmd = probe.argv.join(" ");
  if (res.spawnError || res.code !== 0) {
    const status = res.spawnError ? "spawn failed or timed out" : `exit ${res.code ?? "signal"}`;
    return {
      name: "dry-run-probe",
      ok: undefined,
      detail: `dry-run probe could not run (${cmd}; ${status})`,
    };
  }
  const output = outputFor(probe, res.stdout, res.stderr);
  return output.includes(LOADABILITY_SENTINEL)
    ? {
        name: "dry-run-probe",
        ok: true,
        detail: `dry-run probe printed ${LOADABILITY_SENTINEL}`,
      }
    : {
        name: "dry-run-probe",
        ok: false,
        detail: `dry-run probe ran (${cmd}) but did not print ${LOADABILITY_SENTINEL}`,
      };
}

/**
 * The structural load verdict for one CLI. Runs only over the bootloader files
 * actually on disk: if none are present, the verdict is `unverified` (the coverage
 * `missing` cell owns that gap). Any failed check -> `wontLoad`; all pass/na -> a
 * candidate that still needs Tier-2 proof before it can be called `loads`.
 */
function structuralLoadabilityFor(ctx: PlanContext, cli: Cli): CliLoadability {
  const present = entry(cli).bootloaders.filter((p) => existsSync(join(ctx.root, p)));
  if (present.length === 0) {
    return {
      cli,
      verdict: "unverified",
      checks: [
        { name: "activation", ok: undefined, detail: "no bootloader on disk — nothing to load" },
      ],
    };
  }
  const checks: LoadCheck[] = [
    activationCheck(ctx, cli, present),
    hygieneCheck(ctx, cli, present),
    routerChainCheck(ctx),
    contextCapCheck(ctx, cli, present),
  ];
  const failed = checks.filter((c) => c.ok === false);
  return failed.length > 0
    ? {
        cli,
        verdict: "wontLoad",
        checks,
        fix: `aih bootstrap-ai --apply --cli ${cli}`,
      }
    : { cli, verdict: "loads", checks };
}

/**
 * Spawn-free loadability for reports/digests. Structural failures still fail
 * closed, but a structural pass becomes `unverified` unless a dry-run probe is
 * executed by {@link loadabilityForWithDryRun}.
 */
export function loadabilityFor(ctx: PlanContext, cli: Cli): CliLoadability {
  const structural = structuralLoadabilityFor(ctx, cli);
  if (structural.verdict !== "loads") return structural;
  return withDryRunCheck(structural, dryRunProbeStaticCheck(cli));
}

/** Runtime Tier-2 loadability for doctor --verify; executes only registered local probes. */
export async function loadabilityForWithDryRun(
  ctx: PlanContext,
  cli: Cli,
): Promise<CliLoadability> {
  const structural = structuralLoadabilityFor(ctx, cli);
  if (structural.verdict !== "loads") return structural;
  return withDryRunCheck(structural, await dryRunProbeCheck(ctx, cli));
}

/** Compact one-line reason for the matrix tooltip / terminal remediation. */
export function loadReason(l: CliLoadability): string {
  const failed = l.checks.filter((c) => c.ok === false).map((c) => c.detail);
  if (failed.length > 0) return failed.join("; ");
  if (l.verdict === "loads") {
    return "loads: activation, hygiene, router chain, and dry-run probe all pass";
  }
  return (
    l.checks.find((c) => c.name === "dry-run-probe")?.detail ?? l.checks[0]?.detail ?? "unverified"
  );
}
