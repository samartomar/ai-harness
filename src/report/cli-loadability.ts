import { existsSync } from "node:fs";
import { join } from "node:path";
import { entry } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
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
 * Honesty rule (D0): three verdicts, never collapsed. `loads` is proven structurally;
 * `wontLoad` is proven broken; `unverified` is "can't prove from a repo scan" (e.g.
 * the bootloader isn't on disk yet — the coverage `missing` cell already flags that,
 * so loadability does not double-count it). Only a `wontLoad` is a real new signal.
 */

export type LoadVerdict = "loads" | "wontLoad" | "unverified";

export interface LoadCheck {
  name: "activation" | "frontmatter-hygiene" | "router-chain" | "context-cap";
  /** true = pass, false = fail (→ wontLoad), undefined = not applicable to this tool. */
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

/** Parse a leading `---` frontmatter block into flat key/value pairs (BOM-tolerant). */
function frontmatterOf(text: string): Record<string, string> | undefined {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = t.match(/^---\n([\s\S]*?)\n---/);
  if (!m?.[1]) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv?.[1]) fields[kv[1]] = (kv[2] ?? "").trim();
  }
  return fields;
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
    if (!fm || fm[act.key] !== act.value) bad.push(rel);
  }
  return bad.length === 0
    ? { name: "activation", ok: true, detail: `${act.key}: ${act.value} set` }
    : {
        name: "activation",
        ok: false,
        detail: `${act.key}: ${act.value} missing in ${bad.join(", ")} — present but not auto-loaded`,
      };
}

/** No BOM, and any opened frontmatter block actually closes/parses. */
function hygieneCheck(ctx: PlanContext, present: string[]): LoadCheck {
  const bad: string[] = [];
  for (const rel of present) {
    const text = readIfExists(join(ctx.root, rel)) ?? "";
    if (text.charCodeAt(0) === 0xfeff) bad.push(`${rel} (BOM before content)`);
    else if (/^---\n/.test(text) && frontmatterOf(text) === undefined) {
      bad.push(`${rel} (unterminated frontmatter)`);
    }
  }
  return bad.length === 0
    ? { name: "frontmatter-hygiene", ok: true, detail: "no BOM; frontmatter parses" }
    : {
        name: "frontmatter-hygiene",
        ok: false,
        detail: `byte/frontmatter issue: ${bad.join(", ")}`,
      };
}

/** The canon the bootloader routes to (RULE_ROUTER.md + the core) actually exists. */
function routerChainCheck(ctx: PlanContext): LoadCheck {
  const targets: Array<[label: string, path: string]> = [
    [`${ctx.contextDir}/RULE_ROUTER.md`, join(ctx.root, ctx.contextDir, "RULE_ROUTER.md")],
    [
      `${ctx.contextDir}/rules/agent-behavior-core.md`,
      join(ctx.root, ctx.contextDir, "rules", "agent-behavior-core.md"),
    ],
  ];
  const missing = targets.filter(([, p]) => !existsSync(p)).map(([label]) => label);
  return missing.length === 0
    ? { name: "router-chain", ok: true, detail: "router + behavior core reachable" }
    : { name: "router-chain", ok: false, detail: `pointer target missing: ${missing.join(", ")}` };
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

/**
 * The load verdict for one CLI. Runs only over the bootloader files actually on
 * disk: if none are present, the verdict is `unverified` (the coverage `missing`
 * cell owns that gap). Any failed check → `wontLoad`; all pass/na → `loads`.
 */
export function loadabilityFor(ctx: PlanContext, cli: Cli): CliLoadability {
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
    hygieneCheck(ctx, present),
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

/** Compact one-line reason for the matrix tooltip / terminal remediation. */
export function loadReason(l: CliLoadability): string {
  const failed = l.checks.filter((c) => c.ok === false).map((c) => c.detail);
  if (failed.length > 0) return failed.join("; ");
  if (l.verdict === "loads") return "loads: activation, hygiene, and router chain all pass";
  return l.checks[0]?.detail ?? "unverified";
}
