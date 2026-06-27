import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bootloaderPaths, SHARED_MARKER, sharedCanonicalBlockBody } from "../bootstrap-ai/canon.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { extractManagedBlock } from "../internals/markers.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { inventory } from "../status.js";
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from "./bloat.js";
import { scanCliCoverage } from "./cli-coverage.js";
import { scanLoadGroups } from "./loadgroups.js";

/**
 * HARNESS MATURITY — a weighted 0–100 scorecard that AGGREGATES aih's already-
 * existing read-only checks into a maturity grade. It scores WIRING, not content:
 * 100 means aih's own thin-bootloader + RULE_ROUTER architecture is present AND in
 * sync, never that the rules read well. Each dimension scores `round(passed/total*
 * 100)`; the overall is their weighted mean; the grade comes from the lifted bands.
 *
 * No second source of truth: the drift check reuses `sharedCanonicalBlockBody` +
 * `extractManagedBlock` (the same logic as `bootloaderProbe`), presence reuses
 * `inventory()`, and the budget check reuses `scanContextBloat()`. Pure fs reads
 * (statSync/existsSync/read) — no spawn, no network — so it is identical dry-run vs
 * `--verify` and omitted entirely off-canon (no RULE_ROUTER.md → undefined).
 *
 * Grade bands + the `round(passed/total*100)` dimension formula are lifted as short
 * factual constants from @paniolo/scan (cli.js grade bands; dist/standards/
 * reference-thresholds.json adapter_max_lines=75). paniolo's package license is
 * unconfirmed, so this attribution is kept self-contained in this header; only the
 * public formula + threshold integers are used, no code was copied.
 */

/** Thin-pointer ceiling — an adapter note over this many lines is duplicating, not pointing. */
const ADAPTER_MAX_LINES = 75;

/** Grade bands (min score → label), lifted verbatim from paniolo (85/70/50/0), aih voice. */
const GRADE_BANDS = [
  { min: 85, grade: "mature" },
  { min: 70, grade: "solid" },
  { min: 50, grade: "emerging" },
  { min: 0, grade: "nascent" },
] as const;

type Grade = (typeof GRADE_BANDS)[number]["grade"];

interface CheckResult {
  id: string;
  passed: boolean;
  /** One-line fix, surfaced verbatim when the check fails. Every check carries one. */
  remediation: string;
  /** The aih artifact/command that defines the check (light evidence grade). */
  source: string;
}

interface DimensionResult {
  name: string;
  weight: number;
  /** 0..100, `round(passed/total*100)` (lifted formula). */
  score: number;
  checks: CheckResult[];
}

/** Map a 0–100 score to its lifted letter grade. */
export function gradeOf(score: number): Grade {
  for (const b of GRADE_BANDS) if (score >= b.min) return b.grade;
  return "nascent";
}

/** A dimension's score: the share of its checks that pass, 0–100 (lifted formula). */
function dimScore(checks: CheckResult[]): number {
  if (checks.length === 0) return 0;
  const passed = checks.filter((c) => c.passed).length;
  return Math.round((passed / checks.length) * 100);
}

function check(id: string, passed: boolean, remediation: string, source: string): CheckResult {
  return { id, passed, remediation, source };
}

function dim(name: string, weight: number, checks: CheckResult[]): DimensionResult {
  return { name, weight, score: dimScore(checks), checks };
}

/** Every present bootloader carries the SAME managed block as the freshly generated one. */
function bootloadersInSync(root: string, present: string[], sharedBody: string): boolean {
  for (const rel of present) {
    const text = readIfExists(join(root, rel));
    if (text === undefined) continue;
    if (extractManagedBlock(text, SHARED_MARKER) !== sharedBody) return false;
  }
  return true;
}

/** Every present bootloader points back at the router (the thin-pointer contract). */
function bootloadersPointToRouter(root: string, present: string[]): boolean {
  for (const rel of present) {
    const text = readIfExists(join(root, rel));
    if (text === undefined) continue;
    if (!text.includes("RULE_ROUTER.md")) return false;
  }
  return true;
}

/** No adapter note exceeds the thin-pointer line ceiling (vacuously true with no adapters). */
function adaptersThin(root: string, dir: string): boolean {
  const adaptersDir = join(root, dir, "adapters");
  let entries: string[];
  try {
    entries = readdirSync(adaptersDir);
  } catch {
    return true;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const text = readIfExists(join(adaptersDir, name));
    if (text === undefined) continue;
    const count = text.replace(/\r\n/g, "\n").split("\n").length;
    if (count > ADAPTER_MAX_LINES) return false;
  }
  return true;
}

/**
 * Per-targeted-CLI wiring + loadability checks, from the shared {@link scanCliCoverage}
 * model — replacing the old global trio (`bootloader-present` for ANY tool,
 * `.mcp.json` exists, `.claude/settings.json` exists), which scored a Kiro-only repo
 * against Claude's shape. Only TARGETED, GRADEABLE cells are scored: `manual`/`na`
 * MCP and settings cells are skipped (not counted), and a `wontLoad` loadability
 * verdict is a hard fail (D7) — a present-but-won't-load tool is not mature wiring.
 */
function wiringChecks(ctx: PlanContext): CheckResult[] {
  const out: CheckResult[] = [];
  for (const r of scanCliCoverage(ctx).rows) {
    if (!r.targeted) continue;
    out.push(
      check(
        `${r.cli}-bootloader`,
        r.bootloader.state === "wired",
        r.bootloader.fix ?? "run: aih bootstrap-ai --apply",
        `cli-registry bootloaders (${r.cli})`,
      ),
    );
    if (r.mcp.state === "wired" || r.mcp.state === "missing") {
      out.push(
        check(
          `${r.cli}-mcp`,
          r.mcp.state === "wired",
          r.mcp.fix ?? "run: aih mcp --apply",
          `${r.mcp.path ?? ".mcp.json"} (${r.cli})`,
        ),
      );
    }
    if (r.settings.state === "wired" || r.settings.state === "missing") {
      out.push(
        check(
          `${r.cli}-settings`,
          r.settings.state === "wired",
          r.settings.fix ?? "run: aih bootstrap --apply",
          `${r.settings.path ?? "settings"} (${r.cli})`,
        ),
      );
    }
    if (r.load.verdict !== "unverified") {
      out.push(
        check(
          `${r.cli}-loadable`,
          r.load.verdict === "loads",
          r.load.fix ?? "run: aih bootstrap-ai --apply",
          `loadability (${r.cli})`,
        ),
      );
    }
  }
  return out;
}

/** Build the five maturity dimensions from aih's own artifacts (pure fs reads). */
function buildDimensions(ctx: PlanContext): DimensionResult[] {
  const { root, contextDir: dir } = ctx;
  const inv = inventory(root, dir);
  const has = (name: string): boolean => inv.find((i) => i.name === name)?.present ?? false;
  const present = bootloaderPaths(SUPPORTED_CLIS).filter((rel) => existsSync(join(root, rel)));
  const sharedBody = sharedCanonicalBlockBody(dir).trim();
  const preCommitHook = existsSync(join(root, ".git", "hooks", "pre-commit"));

  return [
    dim("layering", 1, [
      check(
        "router-present",
        existsSync(join(root, dir, "RULE_ROUTER.md")),
        "run: aih scaffold --apply",
        `${dir}/RULE_ROUTER.md`,
      ),
      check(
        "core-rules-doc",
        existsSync(join(root, dir, "rules", "agent-behavior-core.md")),
        "run: aih scaffold --apply",
        `${dir}/rules/agent-behavior-core.md`,
      ),
    ]),
    dim("sharing", 1, [
      check(
        "shared-block-source",
        existsSync(join(root, dir, "adapters", "_shared-canonical-block.md")),
        "run: aih scaffold --apply",
        `${dir}/adapters/_shared-canonical-block.md`,
      ),
      check(
        "bootloaders-in-sync",
        bootloadersInSync(root, present, sharedBody),
        "run: aih bootstrap-ai --apply to regenerate the drifted bootloader block",
        "bootloaderProbe (managed-block drift)",
      ),
      check(
        "bootloaders-point-to-router",
        bootloadersPointToRouter(root, present),
        "run: aih bootstrap-ai --apply so each bootloader points at RULE_ROUTER.md",
        "thin-pointer contract",
      ),
    ]),
    // Per-targeted-CLI wiring + loadability (replaces the old global Claude-shaped trio).
    dim("harnessWiring", 1, wiringChecks(ctx)),
    dim("guardrails", 1, [
      check(
        "gitleaks-config",
        has("gitleaks"),
        "run: aih guardrails --apply to write .gitleaks.toml",
        ".gitleaks.toml (inventory)",
      ),
      check(
        "pre-commit-config",
        has("pre-commit"),
        "run: aih guardrails --apply to write .pre-commit-config.yaml",
        ".pre-commit-config.yaml (inventory)",
      ),
      check(
        "pre-commit-installed",
        preCommitHook,
        "run: pre-commit install to activate the git hook",
        ".git/hooks/pre-commit (enforcement)",
      ),
    ]),
    dim("discoverability", 0.5, [
      check(
        "regeneration-doc",
        existsSync(join(root, dir, "REGENERATION.md")),
        "run: aih scaffold --apply",
        `${dir}/REGENERATION.md`,
      ),
      check(
        // The CORRECTED per-turn cost: the heaviest single tool's bootloader bundle
        // (scanLoadGroups), NOT the old summed footprint that double-counts every
        // mutually-exclusive bootloader. Built on LOAD's worst-case, never the overcount.
        "context-within-budget",
        !scanLoadGroups(root, dir, DEFAULT_CONTEXT_BUDGET_TOKENS).overBudget,
        "trim the worst tool's bootloader — run: aih report --gate to find it",
        "scanLoadGroups worst-case (loadgroups.ts)",
      ),
      check(
        "adapters-thin",
        adaptersThin(root, dir),
        `keep each adapter note ≤ ${ADAPTER_MAX_LINES} lines — point at RULE_ROUTER, don't duplicate it`,
        "reference-thresholds.json adapter_max_lines=75",
      ),
    ]),
  ];
}

const mark = (score: number): string => (score >= 70 ? "✓" : score >= 50 ? "~" : "·");

/**
 * The harness maturity digest — a weighted score over aih's own wiring. Returns
 * `undefined` off-canon (no RULE_ROUTER.md), exactly like `qualityDigest` /
 * `repoInfoDigest`, so it omits cleanly instead of scoring an empty repo.
 */
export function scorecardDigest(ctx: PlanContext): DigestAction | undefined {
  if (!existsSync(join(ctx.root, ctx.contextDir, "RULE_ROUTER.md"))) return undefined;

  const dims = buildDimensions(ctx);
  const totalWeight = dims.reduce((n, d) => n + d.weight, 0);
  const overall = Math.round(dims.reduce((n, d) => n + d.score * d.weight, 0) / totalWeight);
  const grade = gradeOf(overall);
  const failing = dims.flatMap((d) => d.checks.filter((c) => !c.passed));

  const body = lines(
    `Overall: ${overall}/100 (${grade})  — wiring present + in sync, not rules content`,
    "",
    ...dims.map(
      (d) => `  ${mark(d.score)} ${d.name.padEnd(16)} ${d.score}/100  (${gradeOf(d.score)})`,
    ),
    "",
    ...(failing.length > 0
      ? failing.map((c) => `  → ${c.id}: ${c.remediation}`)
      : ["  All maturity checks pass — artifacts present and in sync."]),
  );

  return digest(`Harness maturity — ${overall}/100 (${grade})`, body, {
    overall,
    grade,
    dimensions: dims.map((d) => ({
      name: d.name,
      score: d.score,
      grade: gradeOf(d.score),
      weight: d.weight,
      checks: d.checks.map((c) => ({ id: c.id, passed: c.passed, source: c.source })),
    })),
  });
}
