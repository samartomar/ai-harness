import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { estimateContextCostFromTree } from "../hosts/claude/context-cost.js";

/**
 * D10 cost-gate measurement + record machinery (W4d). The D10 ruling: "Cost is
 * a gate, not a report: W4 measures no-framework baseline vs Lean vs Full
 * (session-start skill metadata, loaded rule bytes, skill/agent/hook/MCP
 * counts, startup latency, child processes, network activity) and records a
 * maintainer-approved Lean context budget before W4 closes."
 *
 * This module delivers the STATIC half now — {@link measureCostGateVariant}
 * aggregates the tree-based dimensions (counts, bytes, a projected-token
 * estimate) over the surface roots a variant loads, and
 * {@link buildCostGateRecord} assembles the three variants plus delta math and
 * a budget verdict into one JSON-serializable {@link CostGateRecord}. Runtime
 * dimensions (startup latency, child processes, network activity) are NOT
 * measured here — {@link CostGateVariantMeasurement.runtime} stays an optional
 * hole an acceptance-phase run fills in with its own evidence label; this
 * module never fabricates one.
 *
 * Reuse, not duplication: {@link measureCostGateVariant} calls the existing
 * {@link estimateContextCostFromTree} once per tree path and sums its `counts`
 * / `totalBytes` / `projectedTokens` across paths — the exact heuristics
 * `context-cost.ts` already owns are never re-implemented here. That reused
 * call is ALSO the fail-closed check on a missing/invalid tree path (it throws
 * `ClaudeHostWriteError` for a non-directory), so this module adds no separate
 * validation of its own. `metadataBytes`/`ruleBytes` are the two fields
 * `ContextCostReport` does not itself expose (it only reports one combined
 * `totalBytes`); those are derived here via a small, generic recursive byte
 * sum over each tree's `agents/`+`skills/` and `rules/` subdirectories
 * respectively — a coarser, different primitive from `context-cost.ts`'s
 * per-category walkers (no SKILL.md-specific detection, no nested-vs-top-level
 * skills union, no extension filtering), so it does not duplicate them.
 */

/** The three D10 cost-gate variants: no framework, ECC Lean, ECC Full. */
export type CostGateVariant = "baseline" | "lean" | "full";

export interface CostGateVariantMeasurement {
  variant: CostGateVariant;
  counts: {
    skills: number;
    agents: number;
    commands: number;
    rules: number;
    hooks: number;
    mcpServers: number;
  };
  /** Bytes of skill/agent metadata surfaces (SKILL.md frontmatter + agent .md files). */
  metadataBytes: number;
  /** Bytes under rules/. */
  ruleBytes: number;
  totalBytes: number;
  /** bytes/4 estimate, labeled (summed from the reused per-path estimates). */
  projectedTokens?: number;
  evidence: string;
  /** Acceptance-phase fills; ALWAYS optional, never fabricated by this module. */
  runtime?: {
    startupLatencyMs?: number;
    childProcesses?: number;
    networkRequests?: number;
    evidence: string;
  };
}

const MEASUREMENT_EVIDENCE = "aih static tree measurement";

function zeroCounts(): CostGateVariantMeasurement["counts"] {
  return { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0, mcpServers: 0 };
}

/** Recursive byte sum of every file under `dir` (missing/unreadable dir -> 0). */
function sumBytesRecursive(dir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let sum = 0;
  for (const name of entries) {
    const full = join(dir, name);
    let isDirectory: boolean;
    let size: number;
    try {
      const stats = statSync(full);
      isDirectory = stats.isDirectory();
      size = stats.size;
    } catch {
      continue;
    }
    sum += isDirectory ? sumBytesRecursive(full) : size;
  }
  return sum;
}

/**
 * Measure one D10 variant over the surface roots it loads: `treePaths` is the
 * surface roots the variant loads (baseline = `[]`, lean = installed
 * component roots, full = the plugin tree). Calls
 * {@link estimateContextCostFromTree} once per path and sums the result —
 * counts, `totalBytes`, and `projectedTokens` compose additively across
 * independent roots. Throws the same {@link ClaudeHostWriteError} a bad
 * treePath already produces via that reused call (a non-directory tree path
 * fails closed there; nothing here re-validates it).
 */
export function measureCostGateVariant(
  variant: CostGateVariant,
  treePaths: readonly string[],
): CostGateVariantMeasurement {
  const counts = zeroCounts();
  let totalBytes = 0;
  let metadataBytes = 0;
  let ruleBytes = 0;
  let projectedTokens = 0;

  for (const treePath of treePaths) {
    const report = estimateContextCostFromTree(treePath);
    counts.skills += report.counts.skills;
    counts.agents += report.counts.agents;
    counts.commands += report.counts.commands;
    counts.rules += report.counts.rules;
    counts.hooks += report.counts.hooks;
    counts.mcpServers += report.counts.mcpServers;
    totalBytes += report.totalBytes;
    projectedTokens += report.projectedTokens ?? 0;

    metadataBytes +=
      sumBytesRecursive(join(treePath, "agents")) + sumBytesRecursive(join(treePath, "skills"));
    ruleBytes += sumBytesRecursive(join(treePath, "rules"));
  }

  return {
    variant,
    counts,
    metadataBytes,
    ruleBytes,
    totalBytes,
    projectedTokens,
    evidence: MEASUREMENT_EVIDENCE,
  };
}

/** The maintainer-approved Lean context budget ruling (filled at W4 close). */
export interface CostGateBudget {
  leanTokenBudget: number;
  approvedBy: string;
  approvedOn: string;
}

export type CostGateVerdict = "within-budget" | "over-budget" | "no-budget-set";

export interface CostGateRecord {
  baseline: CostGateVariantMeasurement;
  lean: CostGateVariantMeasurement;
  full: CostGateVariantMeasurement;
  /** projectedTokens deltas. */
  deltas: { leanVsBaseline: number; fullVsBaseline: number; fullVsLean: number };
  /** Maintainer ruling, filled at W4 close. */
  budget?: CostGateBudget;
  verdict: CostGateVerdict;
}

/** A measurement's projectedTokens, defaulting an absent value to 0 for delta/verdict math. */
function tokensOf(measurement: CostGateVariantMeasurement): number {
  return measurement.projectedTokens ?? 0;
}

/**
 * Assemble the three variant measurements into one D10 record: projectedTokens
 * deltas across variants, plus a budget verdict — `"no-budget-set"` when
 * `budget` is omitted, else `"within-budget"`/`"over-budget"` from the Lean
 * measurement's projected tokens against `budget.leanTokenBudget`. Fully
 * JSON-serializable (it becomes internal-record evidence).
 */
export function buildCostGateRecord(
  baseline: CostGateVariantMeasurement,
  lean: CostGateVariantMeasurement,
  full: CostGateVariantMeasurement,
  budget?: CostGateBudget,
): CostGateRecord {
  const baselineTokens = tokensOf(baseline);
  const leanTokens = tokensOf(lean);
  const fullTokens = tokensOf(full);
  const verdict: CostGateVerdict =
    budget === undefined
      ? "no-budget-set"
      : leanTokens <= budget.leanTokenBudget
        ? "within-budget"
        : "over-budget";

  return {
    baseline,
    lean,
    full,
    deltas: {
      leanVsBaseline: leanTokens - baselineTokens,
      fullVsBaseline: fullTokens - baselineTokens,
      fullVsLean: fullTokens - leanTokens,
    },
    ...(budget !== undefined ? { budget } : {}),
    verdict,
  };
}
