import type { Check } from "../internals/verify.js";
import { TRUST_DANGER_CODES } from "../trust/acknowledge.js";
import type { SkillShape } from "./shape.js";

/** Four-state install verdict (docs/security/skill-trust-gate.md). */
export type SkillVerdict = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";

export interface SkillVerdictResult {
  verdict: SkillVerdict;
  reasons: string[];
}

/** Escalation rank: a worse verdict always wins, so RED beats UNKNOWN beats YELLOW. */
const VERDICT_RANK: Record<SkillVerdict, number> = { GREEN: 0, YELLOW: 1, UNKNOWN: 2, RED: 3 };

/** Codes rules 1–2 already attribute — excluded from the rule-3 "any other FAIL" sweep. */
const ATTRIBUTED_CODES = new Set<string>(["trust.fetch-blocked", "trust.license-missing"]);

function isDangerFail(check: Check): boolean {
  return check.verdict === "fail" && check.code !== undefined && TRUST_DANGER_CODES.has(check.code);
}

function isUnattributedFail(check: Check): boolean {
  if (check.verdict !== "fail") return false;
  if (check.code === undefined) return true;
  return !TRUST_DANGER_CODES.has(check.code) && !ATTRIBUTED_CODES.has(check.code);
}

/**
 * Pure verdict engine: fold checks + shape + acquisition facts into one
 * GREEN/YELLOW/RED/UNKNOWN verdict. Rules, in priority order:
 *   1. any proven-dangerous FAIL (TRUST_DANGER_CODES)          → RED
 *   2. not fetched / fetch-blocked, a detector-unavailable skip on a REMOTE
 *      source, license missing, or an unpinned GitHub source   → UNKNOWN
 *   3. any other FAIL, or a shape trigger (install scripts /
 *      MCP config / full-codebase analysis)                    → YELLOW
 *   4. otherwise                                               → GREEN
 * Every contributing rule pushes a human-readable reason, so a RED verdict
 * still lists its UNKNOWN/YELLOW contributors for the operator.
 *
 * First-party exemption: a LOCAL source (`opts.local`) is graded on aih-native
 * coverage, so an unavailable third-party deep detector (skillspector/cisco) does
 * NOT force UNKNOWN — those scanners guard UNTRUSTED REMOTE fetches, while a local
 * path is operator-controlled in-repo content whose approval anchor is the human
 * review + git history. Native rules still fully apply: a malicious-code finding
 * is still RED, a shape trigger is still YELLOW, and a missing license is still
 * UNKNOWN. When the deep detectors ARE available they still run on local sources
 * and still escalate on their findings.
 */
export function skillVerdict(
  checks: readonly Check[],
  shape: SkillShape,
  opts: { pinned: boolean; fetched: boolean; local?: boolean },
): SkillVerdictResult {
  const reasons: string[] = [];
  let verdict: SkillVerdict = "GREEN";
  const escalate = (next: SkillVerdict, reason: string): void => {
    reasons.push(reason);
    if (VERDICT_RANK[next] > VERDICT_RANK[verdict]) verdict = next;
  };

  for (const check of checks) {
    if (isDangerFail(check)) {
      escalate("RED", `proven-dangerous finding ${check.code}: ${check.detail ?? check.name}`);
    }
  }

  if (!opts.fetched || checks.some((check) => check.code === "trust.fetch-blocked")) {
    escalate("UNKNOWN", "source was not fetched; scan evidence is insufficient");
  }
  if (
    !opts.local &&
    checks.some((check) => check.verdict === "skip" && check.code === "trust.detector-unavailable")
  ) {
    escalate("UNKNOWN", "a trust detector was unavailable; scan coverage is degraded");
  }
  if (checks.some((check) => check.verdict === "fail" && check.code === "trust.license-missing")) {
    escalate("UNKNOWN", "no license was found at the source root");
  }
  if (!opts.pinned) {
    escalate("UNKNOWN", "source is not pinned to a reviewed commit");
  }

  for (const check of checks) {
    if (isUnattributedFail(check)) {
      escalate(
        "YELLOW",
        `finding requires manual review — ${check.code ?? check.name}${check.detail ? `: ${check.detail}` : ""}`,
      );
    }
  }
  if (shape.installScripts) escalate("YELLOW", "shape: install scripts present");
  if (shape.mcpConfig) escalate("YELLOW", "shape: MCP config present");
  if (shape.fullCodebaseAnalysis) escalate("YELLOW", "shape: documents full-codebase analysis");

  return { verdict, reasons };
}
