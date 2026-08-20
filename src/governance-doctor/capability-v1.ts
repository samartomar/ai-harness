import { isProxy } from "node:util/types";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import { assertWellFormedNfcV1, canonicalStrictJsonSha256V1 } from "../contract/strict-json-v1.js";

/**
 * The closed capability boundary shared by the Governance Doctor Audit and Guide
 * modes, plus the strict-input toolkit both use.
 *
 * Audit and Guide are read-only. That boundary is expressed as data, not as a
 * runtime posture: only an id in {@link GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS}
 * can ever be represented by precomputed diagnostic data or named as the next AIH-owned
 * action, so a decision, selection, destructive, publication, provider, or raw
 * command entry has no representation to occupy. Widening the boundary is a
 * reviewed edit to this list, never a value a profile or precomputed result can supply.
 */
/**
 * Each diagnostic name is pinned to an already-owned read-only command path.
 * The Audit foundation consumes precomputed data only; this table is evidence for
 * its closed names, not a dispatcher or capability registry.
 */
export const GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES = Object.freeze([
  Object.freeze({
    commandPath: Object.freeze(["capability", "package", "doctor"]),
    diagnosticId: "aih.capability.package.doctor",
  }),
  Object.freeze({ commandPath: Object.freeze(["doctor"]), diagnosticId: "aih.doctor.root" }),
  Object.freeze({
    commandPath: Object.freeze(["pack", "status"]),
    diagnosticId: "aih.pack.status",
  }),
  Object.freeze({
    commandPath: Object.freeze(["policy", "evaluate"]),
    diagnosticId: "aih.policy.evaluate",
  }),
  Object.freeze({
    commandPath: Object.freeze(["skill", "inventory"]),
    diagnosticId: "aih.skill.inventory",
  }),
  Object.freeze({ commandPath: Object.freeze(["status"]), diagnosticId: "aih.status.root" }),
] as const);

export const GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS: readonly string[] = Object.freeze(
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES.map((surface) => surface.diagnosticId),
);

/** A completed read-only probe is evidence of coverage, never a residual fault. */
export const GOVERNANCE_DOCTOR_READ_ONLY_PROBES_COMPLETED_V1 = "AIH_READ_ONLY_PROBES_COMPLETED";

/** Hard, non-negotiable ceilings. Every bound is a raw count, code unit, or byte. */
export const GOVERNANCE_DOCTOR_V1_LIMITS = Object.freeze({
  maxAttributionCodeUnits: 128,
  maxConflicts: 16,
  maxFindingCodeCodeUnits: 64,
  maxFindings: 96,
  maxFindingsPerDiagnostic: 32,
  maxIdentifierCodeUnits: 128,
  maxPrerequisites: 16,
  maxProseCodeUnits: 400,
  maxProseUtf8Bytes: 1024,
  maxRoles: 8,
  maxShortIdentifierCodeUnits: 64,
  maxTransportBytes: 96 * 1024,
  maxVersionCodeUnits: 32,
});

/** `<namespace>:<path>` attribution, for example `catalog:aih/governance-doctor`. */
export const GOVERNANCE_DOCTOR_ATTRIBUTION_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9./-]*$/;
/** `<namespace>:<dotted-id>` surface and target identifiers. */
export const GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9.-]*$/;
/** Lower-kebab local identifiers for roles, prerequisites, and conflicts. */
export const GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Opaque version tokens; an unknown value stays visible rather than being rejected. */
export const GOVERNANCE_DOCTOR_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Control, format, unassigned, private-use, surrogate, separator, noncharacter,
 * and default-ignorable code points. This is the class that carries bidi
 * overrides, zero-width joiners, the BOM, and the soft hyphen, so prose can never
 * smuggle invisible reordering or hidden text past a reviewer.
 */
const FORBIDDEN_PROSE_CATEGORY =
  /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]/u;

/**
 * Non-ASCII space separators. U+0020 is the only permitted space, so prose cannot
 * fake indentation or a word boundary with a look-alike blank.
 */
const FORBIDDEN_PROSE_WHITESPACE: ReadonlySet<number> = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x202f, 0x205f, 0x3000,
]);

/**
 * The Guide renders prose quoted and subordinate. A double quote or a backslash in
 * the prose itself could close or escape that quoting, so both are refused at the
 * boundary rather than escaped downstream.
 */
const FORBIDDEN_PROSE_DELIMITER = /["\\]/;

/** Untrusted, bounded, source-attributed prose. It is data, never authority. */
export interface GovernanceDoctorAttributedProseV1 {
  readonly attribution: string;
  readonly text: string;
}

/** Prose as the Guide renders it: quoted, attributed, explicitly non-authoritative. */
export interface GovernanceDoctorQuotedProseV1 {
  readonly attribution: string;
  readonly authority: "none";
  readonly quoted: string;
}

/**
 * Fails with a label only. The offending value is never interpolated, so a hostile
 * profile or precomputed result cannot use an error message as an output channel.
 */
export function failGovernanceDoctorV1(label: string): never {
  throw new TypeError(`GOVERNANCE_DOCTOR_V1: ${label}`);
}

/** Rejects same-realm proxies, whose traps could observe or vary every read. */
export function assertNotProxyV1(value: unknown, label: string): void {
  if (isProxy(value)) failGovernanceDoctorV1(`${label} must not be a proxy`);
}

/** A plain object whose every own key is a string-keyed data property. */
export function assertRecordV1(value: unknown, label: string): Record<string, unknown> {
  assertNotProxyV1(value, label);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    failGovernanceDoctorV1(`${label} must be a record`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    failGovernanceDoctorV1(`${label} has an unsupported prototype`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") failGovernanceDoctorV1(`${label} must not carry symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      failGovernanceDoctorV1(`${label} must contain only own data properties`);
  }
  return value as Record<string, unknown>;
}

/** Closed schema: the key set must match exactly, with no extra and no missing field. */
export function assertExactKeysV1(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    failGovernanceDoctorV1(`${label} must declare exactly its schema fields`);
}

/** A dense, bounded, prototype-clean array with no holes and no extra keys. */
export function assertArrayV1(
  value: unknown,
  min: number,
  max: number,
  label: string,
): readonly unknown[] {
  assertNotProxyV1(value, label);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    failGovernanceDoctorV1(`${label} must be an array`);
  if (value.length < min || value.length > max)
    failGovernanceDoctorV1(`${label} is outside its bounded cardinality`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    failGovernanceDoctorV1(`${label} must not carry symbol keys`);
  if (Object.keys(value).length !== value.length)
    failGovernanceDoctorV1(`${label} must not carry extra keys`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      failGovernanceDoctorV1(`${label} must be dense and hole-free`);
  }
  return value;
}

/** A value drawn from a closed set of literals. */
export function assertEnumV1<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    failGovernanceDoctorV1(`${label} is not a permitted value`);
  return value as T;
}

/** A bounded, well-formed, NFC token matching an exact pattern. */
export function assertTokenV1(value: unknown, pattern: RegExp, max: number, label: string): string {
  if (typeof value !== "string") failGovernanceDoctorV1(`${label} must be a string`);
  if (value.length === 0 || value.length > max)
    failGovernanceDoctorV1(`${label} is outside its bounded length`);
  assertWellFormedNfcV1(value, `GOVERNANCE_DOCTOR_V1: ${label}`);
  if (!pattern.test(value)) failGovernanceDoctorV1(`${label} is malformed`);
  return value;
}

/** A lowercase hex SHA-256 digest. */
export function assertSha256V1(value: unknown, label: string): string {
  return assertTokenV1(value, SHA256_PATTERN, 64, label);
}

/**
 * Bounded prose. Rejects rather than sanitizes, so nothing downstream has to
 * reason about a coerced value. Bounds are measured in raw UTF-16 code units and
 * in UTF-8 bytes, both of which a caller can reproduce exactly.
 */
export function assertProseTextV1(value: unknown, label: string): string {
  if (typeof value !== "string") failGovernanceDoctorV1(`${label} must be a string`);
  if (value.length === 0 || value.length > GOVERNANCE_DOCTOR_V1_LIMITS.maxProseCodeUnits)
    failGovernanceDoctorV1(`${label} is outside its bounded length`);
  if (Buffer.byteLength(value, "utf8") > GOVERNANCE_DOCTOR_V1_LIMITS.maxProseUtf8Bytes)
    failGovernanceDoctorV1(`${label} exceeds its bounded byte length`);
  assertWellFormedNfcV1(value, `GOVERNANCE_DOCTOR_V1: ${label}`);
  if (FORBIDDEN_PROSE_CATEGORY.test(value))
    failGovernanceDoctorV1(`${label} contains a control, format, or invisible code point`);
  if (FORBIDDEN_PROSE_DELIMITER.test(value))
    failGovernanceDoctorV1(`${label} contains a quoting delimiter`);
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && FORBIDDEN_PROSE_WHITESPACE.has(point))
      failGovernanceDoctorV1(`${label} contains a non-ASCII space separator`);
  }
  if (value.trim() !== value) failGovernanceDoctorV1(`${label} must not be padded`);
  return value;
}

/** Untrusted prose plus the source it is attributed to. */
export function assertAttributedProseV1(
  value: unknown,
  label: string,
): GovernanceDoctorAttributedProseV1 {
  const record = assertRecordV1(value, label);
  assertExactKeysV1(record, ["attribution", "text"], label);
  return {
    attribution: assertTokenV1(
      record.attribution,
      GOVERNANCE_DOCTOR_ATTRIBUTION_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxAttributionCodeUnits,
      `${label} attribution`,
    ),
    text: assertProseTextV1(record.text, `${label} text`),
  };
}

/**
 * Renders prose as the Guide presents it: quoted, attributed to its source, and
 * carrying an explicit `authority: "none"` so the reading never reads as an
 * instruction. {@link assertProseTextV1} has already refused every quoting
 * delimiter, so the quoted form cannot be broken out of.
 */
export function quoteProseV1(
  prose: GovernanceDoctorAttributedProseV1,
): GovernanceDoctorQuotedProseV1 {
  return { attribution: prose.attribution, authority: "none", quoted: `"${prose.text}"` };
}

/**
 * The single gate for every diagnostic id and every next-action id. An id outside
 * the frozen allow-list has no representation, so a decision, destructive,
 * publication, provider, or raw command entry is refused here.
 */
export function assertReadOnlyDiagnosticIdV1(value: unknown, label: string): string {
  if (typeof value !== "string" || !GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.includes(value))
    failGovernanceDoctorV1(`${label} is not a registered read-only AIH diagnostic`);
  return value;
}

/** Rejects duplicates so no collection can be flooded with one member. */
export function assertUniqueV1(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    failGovernanceDoctorV1(`${label} must not contain duplicates`);
}

/** Deterministic ordering by raw UTF-16 code units. Never locale collation. */
export function sortByCodeUnitsV1<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => codeUnitCompare(key(left), key(right)));
}

/**
 * Domain-separated content identity over JCS canonical UTF-8 bytes. The domain
 * label keeps a profile, an audit, and a guide digest distinct even when their
 * bodies coincide, so one identity can never be presented as another.
 */
export function governanceDoctorSha256V1(domain: string, record: unknown): string {
  return canonicalStrictJsonSha256V1({ domain, record });
}
