import { canonContextDirCheck, canonLintCheck } from "../lint/run.js";
import {
  assertRecordV1,
  failGovernanceDoctorV1,
  governanceDoctorSha256V1,
} from "./capability-v1.js";
import { GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 } from "./repair-eligibility-v1.js";
import {
  assertGovernanceDoctorRepairPreconditionScopeV1,
  GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1,
} from "./repair-scope-v1.js";
import {
  type GovernanceDoctorRepairTargetOccupancyStateV1,
  observeGovernanceDoctorRepairTargetOccupancyV1,
} from "./repair-target-occupancy-v1.js";

/**
 * The precondition for one recipe: `create-managed-directory("ai-coding")`.
 *
 * ## Why this exists rather than reusing the Doctor result
 *
 * `aih doctor` grades a workstation. A fresh checkout reports two dozen non-pass
 * checks, and at least two of them -- whether an AI CLI is runnable and whether
 * `rg`/`fd`/`jq` are on `PATH` -- are properties of the machine that no state of
 * the repository can clear. Gating a repository-local repair on that whole
 * result would make "is `jq` installed" part of the authority to create a
 * directory, and the eligible state would be unreachable rather than merely
 * rare.
 *
 * So the eligibility question is asked directly, and it is a bounded one: are
 * exactly the two checks that a missing canonical context directory causes
 * non-pass, and nothing else? The full Doctor output stays visible and
 * unchanged; it simply is not the authority for this one recipe. That is a
 * narrowing of authority granularity, not a relaxation -- this probe answers a
 * strictly smaller question than Doctor does -- and it sets no precedent for a
 * second recipe.
 *
 * ## Why the second tuple is safe here and would not be alone
 *
 * The canon lint check reports a code-less `skip` from two different places: the
 * context directory being absent, and an existing tree with informational
 * findings. Keyed on its own, that tuple cannot tell the two apart, and creating
 * a directory in the second case would be wrong.
 *
 * Bundle-exactness resolves it without reading any `detail`. The informational
 * branch runs only after the directory-exists guard, so it can only fire while
 * the context-dir check reports `pass` -- at which point the observed set is no
 * longer this bundle and eligibility is false. The disambiguation *is* the
 * requirement that the complete non-pass set equal the pair, which is why a
 * future slice must not lift either tuple out of this bundle and use it alone.
 *
 * That argument is about one reading, and says nothing across two. The bundle is
 * two filesystem observations: a directory created between them would yield
 * tuple 1 from the first and tuple 2 from the second, reproducing the pair over
 * a state the tree was never in. So a reading that would qualify is confirmed by
 * a second one before `eligible` is reported, and the confirming reading is what
 * the record carries. That bounds the window rather than closing it -- see the
 * note at the observation itself.
 *
 * ## What it will not accept
 *
 * A branded scope, and nothing else. A resolved absolute path is a format, not
 * an authority: this module cannot tell whether a caller established a root or
 * merely spelled one, so it takes the trusted scope record instead and refuses
 * every substitute *before* it touches the filesystem. There is no parameter for
 * a path to repair, a check collection, an observation callback, an eligibility
 * boolean, a configuration alias, an environment override, or a recipe
 * identifier, and this module cannot mint the scope it consumes. It reads the
 * filesystem only through the two shipped check implementations, holds no
 * mutation capability, and never reads or forwards a check's `detail`.
 *
 * ## The exact question it answers
 *
 * Two questions, and eligibility needs both. The shipped checks answer "is the
 * canonical context directory reachable?", with `existsSync` -- which is the
 * right question for a diagnostic and not enough for a repair, because a
 * dangling link reads as absent while holding the name, and a failed lookup
 * reads as absent while proving nothing. So eligibility also requires a
 * no-follow verdict that the literal name is genuinely free, taken by
 * {@link observeGovernanceDoctorRepairTargetOccupancyV1} and reported here as
 * `targetOccupancy`. Only `unoccupied` qualifies; `occupied` and
 * `indeterminate` both refuse.
 *
 * Neither verdict is atomic, and neither pretends to be. Both describe the
 * instant they were taken, which is why a consumer re-observes immediately
 * before spending a claim and again at the effect boundary, where custody
 * re-proves the same facts under the mutation grant.
 */
export const GOVERNANCE_DOCTOR_REPAIR_PRECONDITION_DIAGNOSTIC_ID_V1 =
  "aih.repair.precondition.canon-context-v1";

const PROTOCOL = "GovernanceDoctorRepairPreconditionV1";

/**
 * The frozen causal bundle, established by differential observation: creating
 * the canonical directory flips exactly these two checks and introduces none.
 * `code: null` records that the lint skip carries no code -- an absence this
 * module requires, never a wildcard.
 *
 * Each member carries the shipped check it observes alongside the tuple that
 * check must report, so this list is the *only* declaration of the order. The
 * comparison below is positional, and a positional comparison against a
 * separately written expectation list would silently come to mean "in whatever
 * order the calls happen to appear" -- fail-closed if the two ever drifted, but
 * true only by coincidence. Here they cannot drift: there is one order, and it
 * is this one. Every member's verdict is non-pass by construction, which is what
 * lets the filter below preserve the mapping.
 */
const BUNDLE_V1 = Object.freeze([
  Object.freeze({
    check: canonContextDirCheck,
    code: "canon.context-dir-missing",
    name: "context-dir",
    verdict: "skip",
  }),
  Object.freeze({
    check: canonLintCheck,
    code: null,
    name: "canon markdown lint",
    verdict: "skip",
  }),
] as const);

/** The sanitized projection of one check: name, verdict, and code only. */
export interface GovernanceDoctorRepairPreconditionObservationV1 {
  readonly code: string | null;
  readonly name: string;
  readonly verdict: string;
}

/**
 * Precondition evidence, bound rather than bare. A consumer must be able to see
 * which probe produced it, for which recipe, against which root, for which
 * target, and on the strength of exactly which observations -- an `eligible`
 * flag alone would be a verdict with no accountable subject.
 */
export interface GovernanceDoctorRepairPreconditionV1 {
  readonly diagnosticId: "aih.repair.precondition.canon-context-v1";
  readonly eligible: boolean;
  readonly observations: readonly GovernanceDoctorRepairPreconditionObservationV1[];
  readonly protocol: "GovernanceDoctorRepairPreconditionV1";
  readonly recipeId: "aih.repair.recipe.canon-context-dir-v1";
  readonly rootSha256: string;
  readonly targetOccupancy: GovernanceDoctorRepairTargetOccupancyStateV1;
  readonly targetPath: "ai-coding";
}

const brands = new WeakSet<object>();

function failPrecondition(): never {
  return failGovernanceDoctorV1("repair precondition observation is malformed");
}

/** The bounded projection of one shipped check: never its detail or location. */
function projection(value: unknown): { code: string | null; name: string; verdict: string } {
  const check = assertRecordV1(value, "repair precondition check");
  if (typeof check.name !== "string" || typeof check.verdict !== "string") failPrecondition();
  if (check.code !== undefined && typeof check.code !== "string") failPrecondition();
  return {
    code: typeof check.code === "string" ? check.code : null,
    name: check.name,
    verdict: check.verdict,
  };
}

/** One complete non-pass projection of the bundle's checks over the live tree. */
function reading(root: string): GovernanceDoctorRepairPreconditionObservationV1[] {
  return BUNDLE_V1.map((member) =>
    projection(member.check(root, GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1)),
  ).filter((check) => check.verdict !== "pass");
}

/**
 * Exact set equality, in order and cardinality: an extra observation, a missing
 * one, or one whose code differs -- including a code where the bundle records
 * none -- is not this bundle.
 */
function isBundle(observed: readonly GovernanceDoctorRepairPreconditionObservationV1[]): boolean {
  return (
    observed.length === BUNDLE_V1.length &&
    BUNDLE_V1.every(
      (expected, index) =>
        observed[index]?.name === expected.name &&
        observed[index]?.verdict === expected.verdict &&
        observed[index]?.code === expected.code,
    )
  );
}

/**
 * Observes the two shipped checks against one resolved root and reports whether
 * their complete non-pass projection is exactly the frozen bundle.
 *
 * The root must already be absolute; this module resolves nothing and creates
 * nothing, so a caller that has not established its root has established
 * nothing this can bind to.
 */
export function observeGovernanceDoctorRepairPreconditionV1(
  scope: unknown,
): GovernanceDoctorRepairPreconditionV1 {
  // Before any filesystem call: an unbranded scope buys no observation at all.
  const bound = assertGovernanceDoctorRepairPreconditionScopeV1(scope);
  const root = bound.rootRealPath;
  const first = reading(root);
  // A reading is two filesystem observations, and a live tree can change
  // between them. That matters here specifically: a directory created after the
  // context-dir check and before the lint check yields tuple 1 from the first
  // observation and tuple 2 from the second, reproducing the bundle over a
  // state the tree was never in. Confirm a reading that would qualify, and let
  // the confirming one decide -- so the record reports a reading that stood,
  // not a composite. It runs only on the qualifying path, where the directory
  // was absent, so the ordinary cost is one more `existsSync` and the lint's
  // own early return.
  //
  // This bounds the window; it does not make the observation atomic, and no
  // arrangement of these APIs would. A change that lands and reverts entirely
  // between the two readings is not observable -- and in that case the tree
  // ends in the state the record reports, which is the state a consumer that
  // acts will revalidate against anyway.
  const observed = isBundle(first) ? reading(root) : first;
  // The bundle says the canon is unreachable, which the shipped checks answer
  // with `existsSync`. Eligibility also needs the name to be genuinely free, and
  // those are different questions: a dangling link reads as absent while
  // occupying the name, and a lookup that failed reads as absent while proving
  // nothing. Both must hold, and only `unoccupied` satisfies the second.
  const targetOccupancy = observeGovernanceDoctorRepairTargetOccupancyV1(bound).state;
  const eligible = isBundle(observed) && targetOccupancy === "unoccupied";
  const record = Object.freeze({
    diagnosticId: GOVERNANCE_DOCTOR_REPAIR_PRECONDITION_DIAGNOSTIC_ID_V1,
    eligible,
    // The sanitized projection travels as evidence; no raw Check and no detail
    // is retained, returned, hashed, or forwarded anywhere.
    observations: Object.freeze(observed.map((check) => Object.freeze({ ...check }))),
    protocol: PROTOCOL,
    recipeId: GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1,
    rootSha256: bound.rootSha256,
    targetOccupancy,
    targetPath: bound.targetPath,
  }) as GovernanceDoctorRepairPreconditionV1;
  brands.add(record);
  return record;
}

/**
 * The evidence digest of one precondition record.
 *
 * A consumer that records why a repair was licensed needs to name the evidence,
 * not restate it: a digest binds the exact eligibility, the exact observed
 * tuples, the occupancy verdict, and the checkout, in one value that cannot be
 * edited into agreement afterwards. The record is asserted first, so only an
 * observation this module produced can be digested at all.
 */
export function governanceDoctorRepairPreconditionSha256V1(value: unknown): string {
  const record = assertGovernanceDoctorRepairPreconditionV1(value);
  return governanceDoctorSha256V1("aih.governance-doctor-repair-precondition-v1", {
    diagnosticId: record.diagnosticId,
    eligible: record.eligible,
    observations: record.observations.map((observation) => ({
      code: observation.code,
      name: observation.name,
      verdict: observation.verdict,
    })),
    recipeId: record.recipeId,
    rootSha256: record.rootSha256,
    targetOccupancy: record.targetOccupancy,
    targetPath: record.targetPath,
  });
}

/**
 * Accepts only a record this module observed. A plain object, a spread copy, a
 * proxy, an accessor-bearing look-alike, or a parse is not one, so "eligible"
 * can never arrive as caller-authored data.
 */
export function assertGovernanceDoctorRepairPreconditionV1(
  value: unknown,
): GovernanceDoctorRepairPreconditionV1 {
  const record = assertRecordV1(value, "repair precondition");
  if (!brands.has(record)) failGovernanceDoctorV1("repair precondition is not AIH-owned");
  if (
    record.protocol !== PROTOCOL ||
    record.diagnosticId !== GOVERNANCE_DOCTOR_REPAIR_PRECONDITION_DIAGNOSTIC_ID_V1 ||
    record.recipeId !== GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1 ||
    record.targetPath !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 ||
    typeof record.rootSha256 !== "string" ||
    typeof record.targetOccupancy !== "string" ||
    !Array.isArray(record.observations) ||
    typeof record.eligible !== "boolean"
  )
    failGovernanceDoctorV1("repair precondition is malformed");
  return record as unknown as GovernanceDoctorRepairPreconditionV1;
}
