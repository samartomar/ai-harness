import {
  type ContextCostReport,
  estimateContextCostFromTree,
} from "../hosts/claude/context-cost.js";
import type { FrameworkId } from "../schema.js";
import type { CostGateVerdict } from "./cost-gate.js";

/**
 * W8 Framework Value Gate — the CREDIT side of the ledger (the shipped W4
 * {@link CostGateRecord} is the DEBIT side). Per DECISION-LOG 2026-07-23 "PFB v1
 * SCOPE REDUCTION" and VALIDATION-AND-RELEASE Layer-3 check 14, each supported
 * framework must demonstrate MEASURED value against the Project C no-framework
 * baseline before v1 ships.
 *
 * This module delivers the PURE, deterministic half:
 *  - {@link measureFrameworkSurfaces} sums the SHIPPED
 *    {@link estimateContextCostFromTree} counts over a project's surface roots —
 *    the identical primitive {@link measureCostGateVariant} already sums; the
 *    token/count heuristics are NEVER re-implemented here.
 *  - {@link buildFrameworkValueRecord} is the pure verdict function: value is
 *    ORTHOGONAL to cost/risk (no composite score), the characteristic-workflow
 *    signal is the DECISIVE non-gameable dimension (surface counts alone can
 *    never pass), and it FAILS CLOSED to `INCOMPLETE_MEASUREMENT` on any missing
 *    dimension.
 *
 * The live characteristic-workflow success boolean is an OPTIONAL runtime hole
 * the W8 acceptance driver fills from the check-11 transcript — never fabricated
 * here, exactly like {@link CostGateVariantMeasurement.runtime}. The record is
 * JSON-serializable and byte-reproducible: no wall-clock, no `Math.random`.
 */

/** The measurement evidence label — the same string the cost gate records. */
const MEASUREMENT_EVIDENCE = "aih static tree measurement";

/**
 * D-CAP / D-GOV surface measurement for one project's surface set. Reuses the
 * cost-gate/context-cost `counts` shape verbatim and adds the managed-block bit
 * (D-GOV's "+1 if a managed CLAUDE.md routing block is present").
 */
export interface FrameworkSurfaceMeasurement {
  /** Reused {@link ContextCostReport} count shape (never re-derived here). */
  counts: ContextCostReport["counts"];
  /** 1 when a managed CLAUDE.md routing block is present (a host-level D-GOV surface). */
  managedBlock: 0 | 1;
  /** Non-authoritative label, e.g. "aih static tree measurement". */
  evidence: string;
}

/**
 * Sum {@link estimateContextCostFromTree}'s `counts` over the surface roots a
 * project loads — the Q3 measurement input contract: the caller passes the bind
 * report's INSTALLED-surfaces roots so the invocable count is honest (the raw
 * component-root tree estimate can understate — e.g. ECC-Lean's `skills:0`).
 * Baseline C passes `[]` (all-zero). Fails closed with the same
 * `ClaudeHostWriteError` a bad tree path already raises via the reused call.
 *
 * `managedBlock` is always `0` here: a tree-path sum cannot observe a
 * host-level managed routing block, which is not part of a component tree. A
 * caller that has evidence of one constructs the measurement as
 * `{ ...measureFrameworkSurfaces(paths), managedBlock: 1 }`.
 */
export function measureFrameworkSurfaces(
  treePaths: readonly string[],
): FrameworkSurfaceMeasurement {
  const counts: FrameworkSurfaceMeasurement["counts"] = {
    skills: 0,
    agents: 0,
    commands: 0,
    rules: 0,
    hooks: 0,
    mcpServers: 0,
  };
  for (const treePath of treePaths) {
    const report = estimateContextCostFromTree(treePath);
    counts.skills += report.counts.skills;
    counts.agents += report.counts.agents;
    counts.commands += report.counts.commands;
    counts.rules += report.counts.rules;
    counts.hooks += report.counts.hooks;
    counts.mcpServers += report.counts.mcpServers;
  }
  return { counts, managedBlock: 0, evidence: MEASUREMENT_EVIDENCE };
}

/**
 * The decisive signal — the OPTIONAL runtime hole the acceptance driver fills
 * from the check-11 transcript; never fabricated by this module. `undefined`
 * (with {@link FrameworkValueThresholds.requireCharacteristicWorkflow}) drives
 * `INCOMPLETE_MEASUREMENT`.
 */
export interface CharacteristicWorkflowResult {
  /** e.g. "ecc-review" | "superpowers-brainstorm-plan". */
  name: string;
  /** check-11 live adjudication. */
  succeeded: boolean;
  /** The same invocation is rejected/absent in Project C (check 3). */
  baselineAbsent: boolean;
  /** Transcript / evidence id (path-free per H3). */
  evidence: string;
}

/** Ratifiable knobs with defaults, recorded with provenance (W4 `CostGateBudget` precedent). */
export interface FrameworkValueThresholds {
  /** The "not pure cost" floor — Δtotal must reach this. Default 1 (ratifiable). */
  minSurfaceDelta: number;
  /** The workflow signal is mandatory; absent ⇒ INCOMPLETE. Default true (ratifiable). */
  requireCharacteristicWorkflow: boolean;
  approvedBy: string;
  approvedOn: string;
}

/** Maintainer-ratified defaults (2026-07-23): the honest, non-gameable package. */
export const DEFAULT_VALUE_THRESHOLDS: FrameworkValueThresholds = {
  minSurfaceDelta: 1,
  requireCharacteristicWorkflow: true,
  approvedBy: "maintainer",
  approvedOn: "2026-07-23",
};

export type FrameworkValueVerdict =
  | "DELIVERS_VALUE"
  | "INSUFFICIENT_VALUE"
  | "INCOMPLETE_MEASUREMENT";

/** The framework identity a record is built for (kept off the surface measurement). */
export interface FrameworkValueIdentity {
  framework: FrameworkId;
  mode?: "lean" | "full";
}

/** Measured surface deltas (framework − baseline). May be negative on a dirty baseline (Q8). */
export interface FrameworkValueDeltas {
  invocable: number;
  governance: number;
  total: number;
}

/**
 * The JSON-serializable value-gate record — the D14 evidence written to
 * `14-value-gate.json`. Surface measurements + deltas are OMITTED (not fabricated
 * as zero) when the corresponding dimension was not measured; a fully-measured
 * DELIVERS/INSUFFICIENT record carries all of them.
 */
export interface FrameworkValueRecord {
  framework: FrameworkId;
  mode?: "lean" | "full";
  /** Project C (expected all-zero); absent when the baseline was not measured. */
  baseline?: FrameworkSurfaceMeasurement;
  /** The bound framework's measured surfaces; absent when not measured. */
  framework_?: FrameworkSurfaceMeasurement;
  /** Present iff BOTH baseline and framework surfaces were measured. */
  deltas?: FrameworkValueDeltas;
  /** The context-cost debit (disclosed, not gated here — its pass/fail is the cost gate's). */
  costTokens?: number;
  costVerdict?: CostGateVerdict;
  characteristicWorkflow?: CharacteristicWorkflowResult;
  thresholds: FrameworkValueThresholds;
  /** Honest per-dimension delivery, e.g. ["capability(+5)","governance(+122)","workflow:ecc-review"]. */
  dimensionsDelivered: string[];
  verdict: FrameworkValueVerdict;
}

/** Invocable surface count (D-CAP): skills + agents + commands (NOT rules). */
function invocable(measurement: FrameworkSurfaceMeasurement): number {
  return measurement.counts.skills + measurement.counts.agents + measurement.counts.commands;
}

/** Governance surface count (D-GOV): rules + hooks + managed-block (DISJOINT from D-CAP). */
function governance(measurement: FrameworkSurfaceMeasurement): number {
  return measurement.counts.rules + measurement.counts.hooks + measurement.managedBlock;
}

/** The decisive signal: the workflow succeeded bound AND is absent in the baseline. */
function workflowSignalOk(workflow: CharacteristicWorkflowResult | undefined): boolean {
  if (workflow === undefined) return false;
  return workflow.succeeded && workflow.baselineAbsent;
}

/**
 * Build the pure, deterministic {@link FrameworkValueRecord}. Verdict logic
 * (design §"Verdict function"):
 *
 *  1. FAIL CLOSED to `INCOMPLETE_MEASUREMENT` on any missing dimension — no
 *     baseline, no framework surface measurement, no cost measurement, or (when
 *     `requireCharacteristicWorkflow`) no workflow result. Never a false green.
 *  2. Surface deltas are measured, disjoint, and may be negative (a contaminated
 *     baseline honestly drives INSUFFICIENT rather than being clamped to clean).
 *  3. The decisive signal is `workflow.succeeded AND workflow.baselineAbsent` —
 *     surface counts alone can NEVER pass (V3: 500 stubs with a dead workflow
 *     FAIL).
 *  4. `DELIVERS_VALUE` iff `Δtotal >= minSurfaceDelta` AND the workflow signal
 *     holds; otherwise `INSUFFICIENT_VALUE`.
 *
 * `dimensionsDelivered` honestly enumerates the dimensions that positively
 * contributed, independent of the overall verdict (an INSUFFICIENT record whose
 * surfaces cleared the floor still lists them). Cost is DISCLOSED, never gated
 * here (V1). Pure: no wall-clock, no `Math.random` — byte-identical per inputs.
 */
export function buildFrameworkValueRecord(
  identity: FrameworkValueIdentity,
  baseline: FrameworkSurfaceMeasurement | undefined,
  frameworkM: FrameworkSurfaceMeasurement | undefined,
  cost: { tokens?: number; verdict?: CostGateVerdict } | undefined,
  workflow: CharacteristicWorkflowResult | undefined,
  thresholds?: FrameworkValueThresholds,
): FrameworkValueRecord {
  const T = thresholds ?? DEFAULT_VALUE_THRESHOLDS;

  // (2) surface deltas — only when BOTH surfaces were measured (never fabricated).
  let deltas: FrameworkValueDeltas | undefined;
  if (baseline !== undefined && frameworkM !== undefined) {
    const invocableDelta = invocable(frameworkM) - invocable(baseline);
    const governanceDelta = governance(frameworkM) - governance(baseline);
    deltas = {
      invocable: invocableDelta,
      governance: governanceDelta,
      total: invocableDelta + governanceDelta,
    };
  }

  // (3) the decisive workflow signal.
  const workflowOk = workflowSignalOk(workflow);

  // Honest per-dimension delivery (independent of the overall verdict).
  const dimensionsDelivered: string[] = [];
  if (deltas !== undefined && deltas.invocable > 0) {
    dimensionsDelivered.push(`capability(+${deltas.invocable})`);
  }
  if (deltas !== undefined && deltas.governance > 0) {
    dimensionsDelivered.push(`governance(+${deltas.governance})`);
  }
  if (workflowOk && workflow !== undefined) {
    dimensionsDelivered.push(`workflow:${workflow.name}`);
  }

  // (1) fail closed to INCOMPLETE on any missing dimension.
  const incomplete =
    deltas === undefined ||
    cost === undefined ||
    (T.requireCharacteristicWorkflow && workflow === undefined);

  // (4) verdict.
  let verdict: FrameworkValueVerdict;
  if (incomplete) {
    verdict = "INCOMPLETE_MEASUREMENT";
  } else {
    const surfaceOk = deltas !== undefined && deltas.total >= T.minSurfaceDelta;
    verdict = surfaceOk && workflowOk ? "DELIVERS_VALUE" : "INSUFFICIENT_VALUE";
  }

  return {
    framework: identity.framework,
    ...(identity.mode !== undefined ? { mode: identity.mode } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(frameworkM !== undefined ? { framework_: frameworkM } : {}),
    ...(deltas !== undefined ? { deltas } : {}),
    ...(cost?.tokens !== undefined ? { costTokens: cost.tokens } : {}),
    ...(cost?.verdict !== undefined ? { costVerdict: cost.verdict } : {}),
    ...(workflow !== undefined ? { characteristicWorkflow: workflow } : {}),
    thresholds: T,
    dimensionsDelivered,
    verdict,
  };
}
