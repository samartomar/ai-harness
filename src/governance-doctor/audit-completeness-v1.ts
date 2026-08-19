import {
  canonicalGovernanceDoctorAuditV1Bytes,
  type GovernanceDoctorAuditV1Result,
  type GovernanceDoctorDiagnosticRefusalStateV1,
  type GovernanceDoctorDiagnosticRefusalV1,
} from "./audit-guide-v1.js";
import {
  assertArrayV1,
  assertEnumV1,
  assertExactKeysV1,
  assertReadOnlyDiagnosticIdV1,
  assertRecordV1,
  assertSha256V1,
  assertUniqueV1,
  failGovernanceDoctorV1,
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS,
  GOVERNANCE_DOCTOR_V1_LIMITS,
} from "./capability-v1.js";

/**
 * How much of the workstation an audit actually managed to see.
 *
 * ## The state that had no name
 *
 * An Audit already carries findings and per-diagnostic refusals side by side --
 * one diagnostic can report a real problem while another reports that it could
 * not look. Every surface downstream, though, asked only whether the refusal
 * list was empty, so a run that found problems *and* could not see part of the
 * workstation was labelled `evidence-gap`: the same word used for a run that saw
 * nothing at all. The findings were still in the payload, but the outcome said
 * "no evidence" over the top of them.
 *
 * `partial` is that missing state. The three are exhaustive over an audited
 * result and mean exactly this:
 *
 * - `completed` -- every declared diagnostic resolved. Findings may be present
 *   or absent; the question was answered either way.
 * - `partial` -- some diagnostics produced findings and some did not resolve.
 * - `evidence-gap` -- nothing resolved into a finding and at least one
 *   diagnostic did not resolve at all.
 *
 * The first and third are exactly what the surfaces reported before, for exactly
 * the runs they reported them for. Only the mixed run changes, because only the
 * mixed run was being described as something it was not.
 *
 * ## Unresolved is wider than "evidence gap"
 *
 * A diagnostic fails to resolve in five distinct ways -- `missing-adapter`,
 * `evidence-gap`, `missing-credential`, `unsupported-host`, and
 * `unmanaged-drift` -- and only one of them is literally an evidence gap. The
 * field below is therefore `unresolved`, not `evidenceGaps`, and it carries each
 * diagnostic's own state so a reader learns *why* that part of the workstation
 * went unseen. The `evidence-gap` *state* name is kept because it is the outcome
 * string these surfaces already emit and callers already parse; renaming it
 * would be a separate breaking change with no safety gain.
 *
 * ## Why this is a record and not a boolean
 *
 * Three surfaces need this answer -- the presentation, the human text, and the
 * Repair plan preview -- and a later slice adds two more, the receipt and the
 * post-execution report. Five independent re-derivations of "is the refusal list
 * empty" would be five chances to get it wrong in the direction that matters,
 * which is calling a partial run healthy. So the classification happens once,
 * here, against the branded Audit, and travels as a frozen record.
 *
 * The record cannot contradict itself. {@link
 * assertGovernanceDoctorAuditCompletenessV1} re-checks the state against the
 * contents it claims to summarize, so a value reporting `completed` while
 * carrying an unresolved diagnostic is refused rather than believed -- by
 * construction on the way out, and by validation on the way in.
 */
export type GovernanceDoctorAuditCompletenessStateV1 = "completed" | "evidence-gap" | "partial";

export interface GovernanceDoctorAuditCompletenessV1 {
  readonly auditSha256: string;
  readonly findingCount: number;
  readonly protocol: "GovernanceDoctorAuditCompletenessV1";
  readonly state: GovernanceDoctorAuditCompletenessStateV1;
  readonly unresolved: readonly GovernanceDoctorDiagnosticRefusalV1[];
}

const PROTOCOL = "GovernanceDoctorAuditCompletenessV1";

const COMPLETENESS_STATES = ["completed", "evidence-gap", "partial"] as const;

const COMPLETENESS_KEYS = [
  "auditSha256",
  "findingCount",
  "protocol",
  "state",
  "unresolved",
] as const;

/** The five ways one declared diagnostic can fail to resolve. */
const UNRESOLVED_STATES = [
  "evidence-gap",
  "missing-adapter",
  "missing-credential",
  "unmanaged-drift",
  "unsupported-host",
] as const;

/** Anti-forgery brand: a hand-built look-alike is not a classification. */
const brands = new WeakSet<object>();

/**
 * The one classification rule. `completed` is defined by the absence of an
 * unresolved diagnostic and by nothing else, so no count, severity, or finding
 * can argue a partial run up into a complete one.
 */
function classify(
  findingCount: number,
  unresolvedCount: number,
): GovernanceDoctorAuditCompletenessStateV1 {
  if (unresolvedCount === 0) return "completed";
  return findingCount === 0 ? "evidence-gap" : "partial";
}

/**
 * Derives the classification from an audit this package minted. The brand is
 * checked first, so a structurally identical parse of a real audit's own bytes
 * classifies nothing -- a completeness record implies the audit it summarizes
 * was a real one.
 *
 * An audit-level refusal has no completeness to report: `policy-denied` and
 * `compatibility-required` stop the run before any diagnostic is consulted, so
 * there is no partition of resolved and unresolved to describe. Those callers
 * present `refused` and never reach here.
 */
export function deriveGovernanceDoctorAuditCompletenessV1(
  value: unknown,
): GovernanceDoctorAuditCompletenessV1 {
  canonicalGovernanceDoctorAuditV1Bytes(value);
  const audit = value as GovernanceDoctorAuditV1Result;
  if (audit.kind !== "audited")
    failGovernanceDoctorV1("audit completeness requires an audited result");
  const unresolved = audit.refusals.map((refusal) =>
    Object.freeze({ diagnosticId: refusal.diagnosticId, state: refusal.state }),
  );
  const record = Object.freeze({
    auditSha256: audit.auditSha256,
    findingCount: audit.findings.length,
    protocol: PROTOCOL,
    state: classify(audit.findings.length, unresolved.length),
    unresolved: Object.freeze(unresolved),
  }) as GovernanceDoctorAuditCompletenessV1;
  brands.add(record);
  return record;
}

/** True only for a classification that says every declared diagnostic resolved. */
export function isGovernanceDoctorAuditCompleteV1(value: unknown): boolean {
  return assertGovernanceDoctorAuditCompletenessV1(value).state === "completed";
}

function unresolvedFrom(value: unknown): GovernanceDoctorDiagnosticRefusalV1 {
  const record = assertRecordV1(value, "audit completeness unresolved diagnostic");
  assertExactKeysV1(record, ["diagnosticId", "state"], "audit completeness unresolved diagnostic");
  return {
    diagnosticId: assertReadOnlyDiagnosticIdV1(
      record.diagnosticId,
      "audit completeness unresolved diagnostic ID",
    ),
    state: assertEnumV1(
      record.state,
      UNRESOLVED_STATES,
      "audit completeness unresolved diagnostic state",
    ) as GovernanceDoctorDiagnosticRefusalStateV1,
  };
}

/**
 * Closed-schema validation. The shape is checked before the brand so a hostile
 * value is refused for what it is rather than for what it lacks, and the state
 * is checked against the contents last: a record whose own fields contradict its
 * verdict is malformed no matter who minted it.
 */
export function assertGovernanceDoctorAuditCompletenessV1(
  value: unknown,
): GovernanceDoctorAuditCompletenessV1 {
  const record = assertRecordV1(value, "audit completeness");
  assertExactKeysV1(record, COMPLETENESS_KEYS, "audit completeness");
  if (record.protocol !== PROTOCOL)
    failGovernanceDoctorV1("audit completeness protocol is not this version");
  assertSha256V1(record.auditSha256, "audit completeness audit binding");
  const findingCount = record.findingCount;
  if (
    typeof findingCount !== "number" ||
    !Number.isSafeInteger(findingCount) ||
    findingCount < 0 ||
    findingCount > GOVERNANCE_DOCTOR_V1_LIMITS.maxFindings
  )
    failGovernanceDoctorV1("audit completeness finding count is outside its bound");
  const unresolved = assertArrayV1(
    record.unresolved,
    0,
    GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length,
    "audit completeness unresolved diagnostics",
  ).map(unresolvedFrom);
  assertUniqueV1(
    unresolved.map((item) => item.diagnosticId),
    "audit completeness unresolved diagnostics",
  );
  const state = assertEnumV1(record.state, COMPLETENESS_STATES, "audit completeness state");
  // The verdict must be the one its own contents imply. This is what stops a
  // partial run from being read as a healthy one through transport.
  if (state !== classify(findingCount, unresolved.length))
    failGovernanceDoctorV1("audit completeness state contradicts its own contents");
  if (!brands.has(record)) failGovernanceDoctorV1("audit completeness is not AIH-owned");
  return record as unknown as GovernanceDoctorAuditCompletenessV1;
}
