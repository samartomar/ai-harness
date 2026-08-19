import {
  assertExactKeysV1,
  assertRecordV1,
  assertSha256V1,
  failGovernanceDoctorV1,
} from "./capability-v1.js";

/**
 * The closed eligibility record: the only value the pure Repair preview module
 * accepts from the trusted command boundary.
 *
 * The preview module may not read the filesystem, settings, the environment, or
 * a caller callback, so it cannot establish for itself that this repository is
 * one whose canonical context directory AIH owns. This module carries that
 * conclusion across the boundary as data instead of as capability: the command
 * route resolves and validates the committed bootstrap marker, and mints a
 * record here only when every binding agrees.
 *
 * The mint enforces exactly four facts, and the boundary that calls it supplies
 * a fifth:
 *
 * 1. the submitted marker context directory is exactly {@link
 *    GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1};
 * 2. the submitted resolved execution context directory is exactly that same
 *    constant, so a flag, environment, or fallback override disagreeing with
 *    the marker mints nothing;
 * 3. those two agree -- both are compared against the constant, never against
 *    each other, so neither can validate the other;
 * 4. the record is bound to one root, by the same digest the operation record
 *    binds, so a record minted for one repository cannot be presented beside
 *    another repository's audit.
 *
 * The fifth -- that a committed marker was actually present and validated -- is
 * a precondition of the *call*, not something this module can verify, and the
 * distinction matters. **The brand proves that a first-party module called this
 * mint with the canonical constant. It does not prove that anyone read a
 * marker.** Any in-package module could pass the literal directly, exactly as
 * an in-package module could construct any other value this package builds. The
 * property the brand actually delivers is that nothing *outside* the module
 * graph can produce a record: no config file, command option, environment
 * variable, JSON parse, or transported byte string is one. `command-v1.ts` is
 * the single caller and does read and validate the marker; a future consumer
 * that treats holding a record as evidence the filesystem was consulted would
 * be trusting more than this module establishes, and would need a real
 * capability rather than a brand.
 *
 * The record carries no path a caller authored: its directory fields are
 * assigned from the module constant below, never from the submitted values,
 * which are only ever compared. It is frozen and branded in a module-private
 * `WeakSet`, so a plain object, a spread copy, an accessor-bearing look-alike, a
 * proxy, a prototype child, or a value with an altered protocol string is
 * refused.
 */
export const GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 = "ai-coding";

const PROTOCOL = "GovernanceDoctorRepairEligibilityV1";

const ELIGIBILITY_KEYS = [
  "markerContextDir",
  "protocol",
  "resolvedContextDir",
  "rootSha256",
] as const;

/** Anti-forgery brand: a hand-built look-alike is not an eligibility record. */
const brands = new WeakSet<object>();

export interface GovernanceDoctorRepairEligibilityV1 {
  readonly markerContextDir: "ai-coding";
  readonly protocol: "GovernanceDoctorRepairEligibilityV1";
  readonly resolvedContextDir: "ai-coding";
  readonly rootSha256: string;
}

/**
 * Mints the record, or nothing. The two directory arguments are compared against
 * the code-owned constant and then discarded; a value that is not exactly that
 * constant -- an alternate directory, an absolute path, a traversal, a nested
 * path, a case variant, a padded string, or a non-string -- mints nothing rather
 * than a record describing it.
 *
 * A malformed root binding is a different failure: the digest comes from the
 * operation record the same run already minted, so a value that is not a digest
 * means the caller is not the boundary it claims to be, and that fails closed
 * with a label rather than silently reporting ineligibility.
 */
export function mintGovernanceDoctorRepairEligibilityV1(
  markerContextDir: unknown,
  resolvedContextDir: unknown,
  rootSha256: unknown,
): GovernanceDoctorRepairEligibilityV1 | undefined {
  if (
    markerContextDir !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 ||
    resolvedContextDir !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
  )
    return undefined;
  const record = Object.freeze({
    markerContextDir: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
    protocol: PROTOCOL,
    resolvedContextDir: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
    rootSha256: assertSha256V1(rootSha256, "repair eligibility root binding"),
  }) as GovernanceDoctorRepairEligibilityV1;
  brands.add(record);
  return record;
}

/**
 * Closed-schema validation of an eligibility record. The brand is checked after
 * the shape so a hostile value is refused for being unbranded rather than for
 * whatever it happens to contain, and the directory fields are re-verified
 * against the constant so a record cannot outlive a change to it.
 */
export function assertGovernanceDoctorRepairEligibilityV1(
  value: unknown,
): GovernanceDoctorRepairEligibilityV1 {
  const record = assertRecordV1(value, "repair eligibility");
  assertExactKeysV1(record, ELIGIBILITY_KEYS, "repair eligibility");
  if (!brands.has(record)) failGovernanceDoctorV1("repair eligibility is not AIH-owned");
  if (
    record.protocol !== PROTOCOL ||
    record.markerContextDir !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 ||
    record.resolvedContextDir !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
  )
    failGovernanceDoctorV1("repair eligibility is not the canonical context directory");
  return {
    markerContextDir: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
    protocol: PROTOCOL,
    resolvedContextDir: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
    rootSha256: assertSha256V1(record.rootSha256, "repair eligibility root binding"),
  };
}
