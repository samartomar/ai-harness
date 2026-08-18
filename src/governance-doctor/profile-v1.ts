import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import {
  assertArrayV1,
  assertAttributedProseV1,
  assertEnumV1,
  assertExactKeysV1,
  assertNotProxyV1,
  assertReadOnlyDiagnosticIdV1,
  assertRecordV1,
  assertSha256V1,
  assertTokenV1,
  assertUniqueV1,
  failGovernanceDoctorV1,
  GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
  GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  GOVERNANCE_DOCTOR_VERSION_PATTERN,
  type GovernanceDoctorAttributedProseV1,
  governanceDoctorSha256V1,
  sortByCodeUnitsV1,
} from "./capability-v1.js";

/**
 * `GovernanceDoctorProfileV1` -- the declarative, content-hash-governed profile a
 * signed catalog member may carry to describe one AIH-governed surface.
 *
 * A profile is untrusted data published by a catalog. It declares which
 * registered read-only diagnostics describe its surface, who owns which role,
 * what the prerequisites and conflicts are, and which AIH-owned action comes
 * next. It cannot carry a command, a script, a path, a credential, or a mutator:
 * no schema field is able to hold one, and every id it names is checked against
 * the frozen read-only allow-list in `capability-v1.ts`.
 *
 * `repairPosture` is deliberately a two-value enum. In this foundation a surface
 * is either explained (`guided-only`) or not covered (`unavailable`); a profile
 * has no way to declare a mechanical action, so it cannot widen what the Audit or
 * the Guide is able to do.
 *
 * Version fields are opaque tokens, not gates. An unknown `schemaVersion`,
 * `effectVersion`, or `profileVersion` still parses and stays fully visible; the
 * Audit is what refuses it as `compatibility-required`. Refusing to parse it
 * would make the incompatibility invisible rather than non-actionable.
 */
export interface GovernanceDoctorRoleV1 {
  readonly owner: "aih" | "catalog-publisher" | "operator" | "org-policy";
  readonly roleId: string;
  readonly summary: GovernanceDoctorAttributedProseV1;
}

export interface GovernanceDoctorPrerequisiteV1 {
  readonly note: GovernanceDoctorAttributedProseV1;
  readonly prerequisiteId: string;
  readonly satisfiedBy: "aih" | "operator" | "org-policy";
}

export interface GovernanceDoctorConflictV1 {
  readonly conflictId: string;
  readonly conflictsWithSurfaceId: string;
  readonly note: GovernanceDoctorAttributedProseV1;
}

export interface GovernanceDoctorProfileV1 {
  readonly conflicts: readonly GovernanceDoctorConflictV1[];
  readonly diagnosticIds: readonly string[];
  readonly effectVersion: string;
  readonly governanceDoctorProfileSha256: string;
  readonly guidance: GovernanceDoctorAttributedProseV1;
  readonly nextActionId: string;
  readonly prerequisites: readonly GovernanceDoctorPrerequisiteV1[];
  readonly profileVersion: string;
  readonly protocol: "GovernanceDoctorProfileV1";
  readonly repairPosture: "guided-only" | "unavailable";
  readonly roles: readonly GovernanceDoctorRoleV1[];
  readonly schemaVersion: string;
  readonly surfaceId: string;
  readonly targetId: string;
}

const PROFILE_FIELDS = [
  "conflicts",
  "diagnosticIds",
  "effectVersion",
  "guidance",
  "nextActionId",
  "prerequisites",
  "profileVersion",
  "protocol",
  "repairPosture",
  "roles",
  "schemaVersion",
  "surfaceId",
  "targetId",
] as const;

const ROLE_OWNERS = ["aih", "catalog-publisher", "operator", "org-policy"] as const;
const PREREQUISITE_OWNERS = ["aih", "operator", "org-policy"] as const;
const REPAIR_POSTURES = ["guided-only", "unavailable"] as const;

const IDENTITY_DOMAIN = "aih.governance-doctor-profile-v1";

/**
 * Anti-forgery brand. A structurally identical plain object -- for example the
 * result of `JSON.parse` over a profile's own transport bytes -- is not a
 * profile: only a value this module minted is present in this map, so a caller
 * cannot hand a hand-built object to the Audit and have it treated as validated.
 */
const profileBytes = new WeakMap<object, Buffer>();

type Json = Record<string, unknown>;

function qualifiedId(value: unknown, label: string): string {
  return assertTokenV1(
    value,
    GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
    label,
  );
}

function localId(value: unknown, label: string): string {
  return assertTokenV1(
    value,
    GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxShortIdentifierCodeUnits,
    label,
  );
}

function version(value: unknown, label: string): string {
  return assertTokenV1(
    value,
    GOVERNANCE_DOCTOR_VERSION_PATTERN,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxVersionCodeUnits,
    label,
  );
}

function role(value: unknown): GovernanceDoctorRoleV1 {
  const record = assertRecordV1(value, "role");
  assertExactKeysV1(record, ["owner", "roleId", "summary"], "role");
  return {
    owner: assertEnumV1(record.owner, ROLE_OWNERS, "role owner"),
    roleId: localId(record.roleId, "role ID"),
    summary: assertAttributedProseV1(record.summary, "role summary"),
  };
}

function prerequisite(value: unknown): GovernanceDoctorPrerequisiteV1 {
  const record = assertRecordV1(value, "prerequisite");
  assertExactKeysV1(record, ["note", "prerequisiteId", "satisfiedBy"], "prerequisite");
  return {
    note: assertAttributedProseV1(record.note, "prerequisite note"),
    prerequisiteId: localId(record.prerequisiteId, "prerequisite ID"),
    satisfiedBy: assertEnumV1(record.satisfiedBy, PREREQUISITE_OWNERS, "prerequisite owner"),
  };
}

function conflict(value: unknown): GovernanceDoctorConflictV1 {
  const record = assertRecordV1(value, "conflict");
  assertExactKeysV1(record, ["conflictId", "conflictsWithSurfaceId", "note"], "conflict");
  return {
    conflictId: localId(record.conflictId, "conflict ID"),
    conflictsWithSurfaceId: qualifiedId(record.conflictsWithSurfaceId, "conflicting surface ID"),
    note: assertAttributedProseV1(record.note, "conflict note"),
  };
}

function collection<T>(
  value: unknown,
  max: number,
  label: string,
  build: (item: unknown) => T,
  key: (item: T) => string,
): readonly T[] {
  const items = assertArrayV1(value, 1, max, label).map(build);
  assertUniqueV1(items.map(key), label);
  return sortByCodeUnitsV1(items, key);
}

function diagnosticIds(value: unknown): readonly string[] {
  const ids = assertArrayV1(
    value,
    1,
    GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length,
    "diagnostic IDs",
  ).map((item) => assertReadOnlyDiagnosticIdV1(item, "diagnostic ID"));
  assertUniqueV1(ids, "diagnostic IDs");
  return sortByCodeUnitsV1(ids, (item) => item);
}

/**
 * Validates and deep-copies a profile into its canonical body. Every value is
 * rebuilt into a fresh object, so a caller that mutates its input afterwards
 * cannot reach into the minted profile.
 */
function profileBody(input: unknown): Json {
  const record = assertRecordV1(input, "governance doctor profile");
  assertExactKeysV1(record, PROFILE_FIELDS, "governance doctor profile");
  if (record.protocol !== "GovernanceDoctorProfileV1")
    failGovernanceDoctorV1("governance doctor profile protocol is not recognized");
  return {
    conflicts: collection(
      record.conflicts,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxConflicts,
      "conflicts",
      conflict,
      (item) => item.conflictId,
    ),
    diagnosticIds: diagnosticIds(record.diagnosticIds),
    effectVersion: version(record.effectVersion, "effect version"),
    guidance: assertAttributedProseV1(record.guidance, "guidance"),
    nextActionId: assertReadOnlyDiagnosticIdV1(record.nextActionId, "next action ID"),
    prerequisites: collection(
      record.prerequisites,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxPrerequisites,
      "prerequisites",
      prerequisite,
      (item) => item.prerequisiteId,
    ),
    profileVersion: version(record.profileVersion, "profile version"),
    protocol: "GovernanceDoctorProfileV1",
    repairPosture: assertEnumV1(record.repairPosture, REPAIR_POSTURES, "repair posture"),
    roles: collection(
      record.roles,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxRoles,
      "roles",
      role,
      (item) => item.roleId,
    ),
    schemaVersion: version(record.schemaVersion, "schema version"),
    surfaceId: qualifiedId(record.surfaceId, "surface ID"),
    targetId: qualifiedId(record.targetId, "target ID"),
  };
}

function mint(body: Json): GovernanceDoctorProfileV1 {
  const governanceDoctorProfileSha256 = governanceDoctorSha256V1(IDENTITY_DOMAIN, body);
  const profile = deepFreezeStrictJsonV1({
    ...body,
    governanceDoctorProfileSha256,
  }) as GovernanceDoctorProfileV1;
  profileBytes.set(profile, canonicalStrictJsonBytesV1(profile));
  return profile;
}

/** Validates untrusted profile data and mints a branded, frozen, identified profile. */
export function createGovernanceDoctorProfileV1(input: unknown): GovernanceDoctorProfileV1 {
  return mint(profileBody(input));
}

/**
 * Transport is bytes, never a decoded string: the canonical form is defined in
 * UTF-8 bytes, and a strict decoder is what rejects malformed input up front.
 */
function boundedTransportBytes(value: unknown): Buffer {
  assertNotProxyV1(value, "governance doctor profile transport");
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    return failGovernanceDoctorV1("governance doctor profile transport must be UTF-8 bytes");
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > GOVERNANCE_DOCTOR_V1_LIMITS.maxTransportBytes)
    failGovernanceDoctorV1("governance doctor profile transport exceeds its bounded byte length");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    failGovernanceDoctorV1("governance doctor profile transport must not carry a byte-order mark");
  return bytes;
}

/**
 * Reject pathological nesting before the general JSON parser walks unknown
 * fields. The closed schema then rejects those fields without recursively
 * traversing their contents.
 */
function assertBoundedJsonNesting(text: string, label: string): void {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > 32) failGovernanceDoctorV1(`${label} exceeds its bounded nesting`);
    } else if (character === "}" || character === "]") depth -= 1;
  }
}

function decodeUtf8(value: unknown): readonly [Buffer, string] {
  const bytes = boundedTransportBytes(value);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assertBoundedJsonNesting(text, "governance doctor profile transport");
  return [bytes, text];
}

/**
 * Parses transport bytes. The supplied identity must match the recomputed
 * identity, and the bytes must be exactly the canonical JCS encoding -- a
 * re-ordered, padded, commented, BOM-prefixed, or duplicate-keyed encoding is
 * refused rather than accepted and silently re-canonicalized.
 */
export function parseGovernanceDoctorProfileV1Json(value: unknown): GovernanceDoctorProfileV1 {
  const [bytes, text] = decodeUtf8(value);
  const parsed = parseStrictJsonObjectV1(text, "governance doctor profile");
  const record = assertRecordV1(parsed, "governance doctor profile transport");
  const supplied = assertSha256V1(
    record.governanceDoctorProfileSha256,
    "governance doctor profile identity",
  );
  const { governanceDoctorProfileSha256: _supplied, ...body } = record;
  const profile = mint(profileBody(body));
  if (profile.governanceDoctorProfileSha256 !== supplied)
    failGovernanceDoctorV1("governance doctor profile identity does not match its content");
  if (!canonicalGovernanceDoctorProfileV1Bytes(profile).equals(bytes))
    failGovernanceDoctorV1("governance doctor profile bytes are not canonical");
  return profile;
}

/** The exact canonical JCS UTF-8 bytes of a minted profile, as a defensive copy. */
export function canonicalGovernanceDoctorProfileV1Bytes(value: unknown): Buffer {
  const bytes = typeof value === "object" && value !== null ? profileBytes.get(value) : undefined;
  if (bytes === undefined)
    failGovernanceDoctorV1("governance doctor profile requires a validated brand");
  return Buffer.from(bytes);
}

/** The domain-separated content identity of a minted profile. */
export function governanceDoctorProfileV1Sha256(value: unknown): string {
  const branded = typeof value === "object" && value !== null ? profileBytes.has(value) : false;
  if (!branded) failGovernanceDoctorV1("governance doctor profile requires a validated brand");
  return (value as GovernanceDoctorProfileV1).governanceDoctorProfileSha256;
}
