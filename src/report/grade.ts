/**
 * Shared grade/dimension machinery for aih's read-only SCORED digests — harness maturity
 * (`scorecard.ts`) and developer readiness (`readiness.ts`). A dimension scores
 * `round(passed/total*100)`; the overall is a weighted mean; the grade comes from the bands.
 *
 * Grade bands (85/70/50/0) + the `round(passed/total*100)` dimension formula are lifted as
 * short factual constants from @paniolo/scan (cli.js grade bands). paniolo's package license
 * is unconfirmed, so this attribution is kept self-contained here; only the public formula +
 * threshold integers are used, no code was copied.
 */

/** Grade bands (min score → label), lifted verbatim from paniolo (85/70/50/0), aih voice. */
export const GRADE_BANDS = [
  { min: 85, grade: "mature" },
  { min: 70, grade: "solid" },
  { min: 50, grade: "emerging" },
  { min: 0, grade: "nascent" },
] as const;

export type Grade = (typeof GRADE_BANDS)[number]["grade"];

/** Map a 0–100 score to its lifted letter grade. */
export function gradeOf(score: number): Grade {
  for (const b of GRADE_BANDS) if (score >= b.min) return b.grade;
  return "nascent";
}

export interface CheckResult {
  id: string;
  passed: boolean;
  /** One-line fix, surfaced verbatim when the check fails. Every check carries one. */
  remediation: string;
  /** The aih artifact/command that defines the check (light evidence grade). */
  source: string;
}

export interface DimensionResult {
  name: string;
  weight: number;
  /** 0..100, `round(passed/total*100)` (lifted formula). */
  score: number;
  checks: CheckResult[];
}

/** A dimension's score: the share of its checks that pass, 0–100 (lifted formula). */
export function dimScore(checks: CheckResult[]): number {
  if (checks.length === 0) return 0;
  const passed = checks.filter((c) => c.passed).length;
  return Math.round((passed / checks.length) * 100);
}

export function check(
  id: string,
  passed: boolean,
  remediation: string,
  source: string,
): CheckResult {
  return { id, passed, remediation, source };
}

export function dim(name: string, weight: number, checks: CheckResult[]): DimensionResult {
  return { name, weight, score: dimScore(checks), checks };
}
