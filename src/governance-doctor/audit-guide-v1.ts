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
  assertProseTextV1,
  assertReadOnlyDiagnosticIdV1,
  assertRecordV1,
  assertSha256V1,
  assertTokenV1,
  assertUniqueV1,
  failGovernanceDoctorV1,
  GOVERNANCE_DOCTOR_ATTRIBUTION_PATTERN,
  GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
  GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  type GovernanceDoctorQuotedProseV1,
  governanceDoctorSha256V1,
  quoteProseV1,
  sortByCodeUnitsV1,
} from "./capability-v1.js";
import { type GovernanceDoctorProfileV1, governanceDoctorProfileV1Sha256 } from "./profile-v1.js";

/**
 * Governance Doctor Audit and Guide -- the two read-only conversational modes.
 *
 * Audit consumes precomputed read-only AIH diagnostic results a profile declares
 * and summarizes their stable coded findings. It imports no filesystem, process,
 * or network capability and executes no diagnostic, so its only effect is to
 * return a value. Guide turns one completed audit plus its profile into an explanation of
 * roles, prerequisites, conflicts, policy state, and the next AIH-owned action.
 *
 * Neither mode previews, authorizes, sequences, or performs a change. The next
 * action is named by id and carries `executable: false`; no command text is ever
 * composed, so there is nothing for a reader to paste.
 *
 * Refusal states stay distinct rather than collapsing into one failure. Two are
 * audit-level and stop the whole run before diagnostic data is consumed -- `policy-denied`
 * and `compatibility-required`. Five are per-diagnostic and sit beside the
 * findings -- `missing-adapter`, which AIH derives when a declared diagnostic has
 * no precomputed result, and `evidence-gap`, `missing-credential`,
 * `unsupported-host`, and `unmanaged-drift`, which precomputed data carries. A
 * diagnostic result cannot report an audit-level state, so it cannot fabricate a policy or
 * compatibility verdict.
 */
export type GovernanceDoctorPrecomputedRefusalStateV1 =
  | "evidence-gap"
  | "missing-credential"
  | "unmanaged-drift"
  | "unsupported-host";

export type GovernanceDoctorDiagnosticRefusalStateV1 =
  | GovernanceDoctorPrecomputedRefusalStateV1
  | "missing-adapter";

export type GovernanceDoctorAuditRefusalStateV1 = "compatibility-required" | "policy-denied";

export interface GovernanceDoctorDiagnosticRegistryV1 {
  readonly diagnosticIds: readonly string[];
  readonly protocol: "GovernanceDoctorDiagnosticRegistryV1";
}

export interface GovernanceDoctorFindingV1 {
  readonly code: string;
  readonly diagnosticId: string;
  readonly severity: "critical" | "high" | "info" | "low" | "medium";
  readonly summary: { readonly attribution: string; readonly text: string };
}

export interface GovernanceDoctorDiagnosticRefusalV1 {
  readonly diagnosticId: string;
  readonly state: GovernanceDoctorDiagnosticRefusalStateV1;
}

export interface GovernanceDoctorAuditedV1 {
  readonly auditSha256: string;
  readonly findings: readonly GovernanceDoctorFindingV1[];
  readonly kind: "audited";
  readonly policyRevisionSha256: string;
  readonly profileSha256: string;
  readonly protocol: "GovernanceDoctorAuditV1";
  readonly refusals: readonly GovernanceDoctorDiagnosticRefusalV1[];
}

export interface GovernanceDoctorAuditRefusedV1 {
  readonly actionable: false;
  readonly auditSha256: string;
  readonly kind: "refused";
  readonly policyRevisionSha256: string;
  readonly profileSha256: string;
  readonly protocol: "GovernanceDoctorAuditV1";
  readonly state: GovernanceDoctorAuditRefusalStateV1;
}

export type GovernanceDoctorAuditV1Result =
  | GovernanceDoctorAuditedV1
  | GovernanceDoctorAuditRefusedV1;

export interface GovernanceDoctorGuideAvailableV1 {
  readonly auditSha256: string;
  readonly conflicts: readonly {
    readonly conflictId: string;
    readonly conflictsWithSurfaceId: string;
    readonly note: GovernanceDoctorQuotedProseV1;
  }[];
  readonly findings: readonly {
    readonly code: string;
    readonly diagnosticId: string;
    readonly severity: "critical" | "high" | "info" | "low" | "medium";
    readonly summary: GovernanceDoctorQuotedProseV1;
  }[];
  readonly guidance: GovernanceDoctorQuotedProseV1;
  readonly guideSha256: string;
  readonly kind: "available";
  readonly nextAction: {
    readonly actionId: string;
    readonly executable: false;
    readonly owner: "aih";
  };
  readonly policy: { readonly decision: "allowed"; readonly revisionSha256: string };
  readonly prerequisites: readonly {
    readonly note: GovernanceDoctorQuotedProseV1;
    readonly prerequisiteId: string;
    readonly satisfiedBy: "aih" | "operator" | "org-policy";
  }[];
  readonly profileSha256: string;
  readonly protocol: "GovernanceDoctorGuideV1";
  readonly refusals: readonly GovernanceDoctorDiagnosticRefusalV1[];
  readonly repairPosture: "guided-only" | "unavailable";
  readonly roles: readonly {
    readonly owner: "aih" | "catalog-publisher" | "operator" | "org-policy";
    readonly roleId: string;
    readonly summary: GovernanceDoctorQuotedProseV1;
  }[];
  readonly surfaceId: string;
  readonly targetId: string;
}

export interface GovernanceDoctorGuideWithheldV1 {
  readonly guideSha256: string;
  readonly kind: "withheld";
  readonly nextAction: {
    readonly executable: false;
    readonly owner: "aih";
    readonly unavailable: true;
  };
  readonly policyRevisionSha256: string;
  readonly profileSha256: string;
  readonly protocol: "GovernanceDoctorGuideV1";
  readonly state: GovernanceDoctorAuditRefusalStateV1;
}

export type GovernanceDoctorGuideV1 =
  | GovernanceDoctorGuideAvailableV1
  | GovernanceDoctorGuideWithheldV1;

const PRECOMPUTED_REFUSAL_STATES = [
  "evidence-gap",
  "missing-credential",
  "unmanaged-drift",
  "unsupported-host",
] as const;

const SEVERITIES = ["critical", "high", "info", "low", "medium"] as const;
const POLICY_DECISIONS = ["allowed", "denied"] as const;

/** Stable, machine-readable finding codes. Never prose, never a command. */
const FINDING_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

const SUPPORTED_SCHEMA_VERSION = "1";
const SUPPORTED_EFFECT_VERSION = "1";
const SUPPORTED_PROFILE_VERSION = "1";

const AUDIT_DOMAIN = "aih.governance-doctor-audit-v1";
const GUIDE_DOMAIN = "aih.governance-doctor-guide-v1";

/**
 * Diagnostics are precomputed data, not executable callbacks. The foundation
 * has no mechanism to invoke a caller-provided function.
 */

type Json = Record<string, unknown>;
type Diagnostics = ReadonlyMap<string, DiagnosticResult>;

/** Anti-forgery brands: a hand-built look-alike is not a registry or an audit. */
const registryDiagnostics = new WeakMap<object, Diagnostics>();
const auditBytes = new WeakMap<object, Buffer>();
const guideBytes = new WeakMap<object, Buffer>();

function brandedDiagnostics(value: unknown): Diagnostics {
  const diagnostics =
    typeof value === "object" && value !== null ? registryDiagnostics.get(value) : undefined;
  if (diagnostics === undefined)
    failGovernanceDoctorV1("diagnostic registry requires a validated brand");
  return diagnostics;
}

function findingsFrom(outcome: Json, diagnosticId: string): GovernanceDoctorFindingV1[] {
  assertExactKeysV1(outcome, ["findings", "kind"], "diagnostic outcome");
  const items = assertArrayV1(
    outcome.findings,
    0,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingsPerDiagnostic,
    "diagnostic findings",
  ).map((item) => {
    const record = assertRecordV1(item, "finding");
    assertExactKeysV1(record, ["code", "severity", "summary"], "finding");
    return {
      code: assertTokenV1(
        record.code,
        FINDING_CODE_PATTERN,
        GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingCodeCodeUnits,
        "finding code",
      ),
      diagnosticId,
      severity: assertEnumV1(record.severity, SEVERITIES, "finding severity"),
      summary: assertAttributedProseV1(record.summary, "finding summary"),
    };
  });
  assertUniqueV1(
    items.map((item) => item.code),
    "diagnostic findings",
  );
  return sortByCodeUnitsV1(items, (item) => item.code);
}

function refusalFrom(outcome: Json): GovernanceDoctorPrecomputedRefusalStateV1 {
  assertExactKeysV1(outcome, ["kind", "state"], "diagnostic outcome");
  return assertEnumV1(outcome.state, PRECOMPUTED_REFUSAL_STATES, "diagnostic refusal state");
}

interface DiagnosticResult {
  readonly findings: readonly GovernanceDoctorFindingV1[];
  readonly refusal: GovernanceDoctorDiagnosticRefusalV1 | undefined;
}

function diagnosticResult(outcome: unknown, diagnosticId: string): DiagnosticResult {
  const record = assertRecordV1(outcome, "diagnostic outcome");
  if (record.kind === "findings")
    return { findings: findingsFrom(record, diagnosticId), refusal: undefined };
  if (record.kind === "refusal")
    return {
      findings: [],
      refusal: { diagnosticId, state: refusalFrom(record) },
    };
  return failGovernanceDoctorV1("diagnostic outcome kind is not recognized");
}

function diagnostic(value: unknown): readonly [string, DiagnosticResult] {
  const record = assertRecordV1(value, "precomputed diagnostic");
  assertExactKeysV1(record, ["diagnosticId", "outcome"], "precomputed diagnostic");
  const diagnosticId = assertReadOnlyDiagnosticIdV1(record.diagnosticId, "diagnostic ID");
  return [diagnosticId, diagnosticResult(record.outcome, diagnosticId)];
}

/**
 * Records precomputed, validated outcomes for AIH-owned read-only diagnostics.
 * This foundation deliberately has no callback or runner shape, so it cannot
 * execute caller-provided filesystem, process, network, or mutation authority.
 */
export function createGovernanceDoctorDiagnosticRegistryV1(
  input: unknown,
): GovernanceDoctorDiagnosticRegistryV1 {
  const record = assertRecordV1(input, "diagnostic registry");
  assertExactKeysV1(record, ["diagnostics"], "diagnostic registry");
  const entries = assertArrayV1(
    record.diagnostics,
    1,
    GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length,
    "precomputed diagnostics",
  ).map(diagnostic);
  const diagnosticIds = entries.map(([diagnosticId]) => diagnosticId);
  assertUniqueV1(diagnosticIds, "precomputed diagnostics");
  const registry = deepFreezeStrictJsonV1({
    diagnosticIds: sortByCodeUnitsV1(diagnosticIds, (item) => item),
    protocol: "GovernanceDoctorDiagnosticRegistryV1" as const,
  }) as GovernanceDoctorDiagnosticRegistryV1;
  registryDiagnostics.set(registry, new Map(entries));
  return registry;
}

function refuse(
  profileSha256: string,
  policyRevisionSha256: string,
  state: GovernanceDoctorAuditRefusalStateV1,
): GovernanceDoctorAuditRefusedV1 {
  const body = {
    actionable: false as const,
    kind: "refused" as const,
    policyRevisionSha256,
    profileSha256,
    protocol: "GovernanceDoctorAuditV1" as const,
    state,
  };
  const refused = deepFreezeStrictJsonV1({
    ...body,
    auditSha256: governanceDoctorSha256V1(AUDIT_DOMAIN, body),
  }) as GovernanceDoctorAuditRefusedV1;
  auditBytes.set(refused, canonicalStrictJsonBytesV1(refused));
  return refused;
}

/** The one V1 compatibility predicate shared by precondition gates and Audit. */
export function isGovernanceDoctorProfileCompatibleV1(profile: GovernanceDoctorProfileV1): boolean {
  return (
    profile.schemaVersion === SUPPORTED_SCHEMA_VERSION &&
    profile.effectVersion === SUPPORTED_EFFECT_VERSION &&
    profile.profileVersion === SUPPORTED_PROFILE_VERSION
  );
}

/**
 * Consumes precomputed diagnostic results a profile declares and summarizes their
 * coded findings. Policy is evaluated before the profile's content is used at all, so
 * a denied policy is never bypassed by anything the profile says.
 */
export function runGovernanceDoctorAuditV1(input: unknown): GovernanceDoctorAuditV1Result {
  const record = assertRecordV1(input, "governance doctor audit request");
  assertExactKeysV1(record, ["policy", "profile", "registry"], "governance doctor audit request");
  const profileSha256 = governanceDoctorProfileV1Sha256(record.profile);
  const profile = record.profile as GovernanceDoctorProfileV1;
  const policy = assertRecordV1(record.policy, "policy state");
  assertExactKeysV1(policy, ["decision", "revisionSha256"], "policy state");
  const decision = assertEnumV1(policy.decision, POLICY_DECISIONS, "policy decision");
  const policyRevisionSha256 = assertSha256V1(policy.revisionSha256, "policy revision");

  if (decision === "denied") return refuse(profileSha256, policyRevisionSha256, "policy-denied");
  if (!isGovernanceDoctorProfileCompatibleV1(profile))
    return refuse(profileSha256, policyRevisionSha256, "compatibility-required");
  const diagnostics = brandedDiagnostics(record.registry);

  const findings: GovernanceDoctorFindingV1[] = [];
  const refusals: GovernanceDoctorDiagnosticRefusalV1[] = [];
  // The profile's ids are already canonically ordered; only supplied immutable
  // diagnostic data for declared IDs can contribute to this audit.
  for (const diagnosticId of profile.diagnosticIds) {
    const result = diagnostics.get(diagnosticId);
    if (result === undefined) {
      refusals.push({ diagnosticId, state: "missing-adapter" });
      continue;
    }
    findings.push(...result.findings);
    if (result.refusal !== undefined) refusals.push(result.refusal);
  }
  if (findings.length > GOVERNANCE_DOCTOR_V1_LIMITS.maxFindings)
    failGovernanceDoctorV1("audit findings exceed their bounded cardinality");

  const body = {
    findings,
    kind: "audited" as const,
    policyRevisionSha256,
    profileSha256,
    protocol: "GovernanceDoctorAuditV1" as const,
    refusals,
  };
  const audited = deepFreezeStrictJsonV1({
    ...body,
    auditSha256: governanceDoctorSha256V1(AUDIT_DOMAIN, body),
  }) as GovernanceDoctorAuditedV1;
  auditBytes.set(audited, canonicalStrictJsonBytesV1(audited));
  return audited;
}

function withheld(
  audit: GovernanceDoctorAuditRefusedV1,
  profileSha256: string,
): GovernanceDoctorGuideWithheldV1 {
  const body = {
    kind: "withheld" as const,
    nextAction: { executable: false as const, owner: "aih" as const, unavailable: true as const },
    policyRevisionSha256: audit.policyRevisionSha256,
    profileSha256,
    protocol: "GovernanceDoctorGuideV1" as const,
    state: audit.state,
  };
  const guide = deepFreezeStrictJsonV1({
    ...body,
    guideSha256: governanceDoctorSha256V1(GUIDE_DOMAIN, body),
  }) as GovernanceDoctorGuideWithheldV1;
  guideBytes.set(guide, canonicalStrictJsonBytesV1(guide));
  return guide;
}

function available(
  audit: GovernanceDoctorAuditedV1,
  profile: GovernanceDoctorProfileV1,
): GovernanceDoctorGuideAvailableV1 {
  const body = {
    auditSha256: audit.auditSha256,
    conflicts: profile.conflicts.map((item) => ({
      conflictId: item.conflictId,
      conflictsWithSurfaceId: item.conflictsWithSurfaceId,
      note: quoteProseV1(item.note),
    })),
    findings: audit.findings.map((item) => ({
      code: item.code,
      diagnosticId: item.diagnosticId,
      severity: item.severity,
      summary: quoteProseV1(item.summary),
    })),
    guidance: quoteProseV1(profile.guidance),
    kind: "available" as const,
    // Named by id and marked non-executable: the Guide points at an AIH-owned
    // read-only action, it never composes something to run.
    nextAction: {
      actionId: profile.nextActionId,
      executable: false as const,
      owner: "aih" as const,
    },
    policy: { decision: "allowed" as const, revisionSha256: audit.policyRevisionSha256 },
    prerequisites: profile.prerequisites.map((item) => ({
      note: quoteProseV1(item.note),
      prerequisiteId: item.prerequisiteId,
      satisfiedBy: item.satisfiedBy,
    })),
    profileSha256: audit.profileSha256,
    protocol: "GovernanceDoctorGuideV1" as const,
    refusals: audit.refusals.map((item) => ({
      diagnosticId: item.diagnosticId,
      state: item.state,
    })),
    repairPosture: profile.repairPosture,
    roles: profile.roles.map((item) => ({
      owner: item.owner,
      roleId: item.roleId,
      summary: quoteProseV1(item.summary),
    })),
    surfaceId: profile.surfaceId,
    targetId: profile.targetId,
  };
  const guide = deepFreezeStrictJsonV1({
    ...body,
    guideSha256: governanceDoctorSha256V1(GUIDE_DOMAIN, body),
  }) as GovernanceDoctorGuideAvailableV1;
  guideBytes.set(guide, canonicalStrictJsonBytesV1(guide));
  return guide;
}

function boundedTransportBytes(value: unknown, label: string): Buffer {
  assertNotProxyV1(value, `${label} transport`);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    return failGovernanceDoctorV1(`${label} transport must be UTF-8 bytes`);
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > GOVERNANCE_DOCTOR_V1_LIMITS.maxTransportBytes)
    failGovernanceDoctorV1(`${label} transport exceeds its bounded byte length`);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    failGovernanceDoctorV1(`${label} transport must not carry a byte-order mark`);
  return bytes;
}

/** Reject deep unknown JSON before the general parser recursively visits it. */
function parseBoundedTransport(value: unknown, label: string): readonly [Buffer, Json] {
  const bytes = boundedTransportBytes(value, label);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > 32) failGovernanceDoctorV1(`${label} transport exceeds its bounded nesting`);
    } else if (character === "}" || character === "]") depth -= 1;
  }
  return [bytes, parseStrictJsonObjectV1(text, label)];
}

function findingFromTransport(value: unknown): GovernanceDoctorFindingV1 {
  const record = assertRecordV1(value, "audit finding");
  assertExactKeysV1(record, ["code", "diagnosticId", "severity", "summary"], "audit finding");
  return {
    code: assertTokenV1(
      record.code,
      FINDING_CODE_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingCodeCodeUnits,
      "audit finding code",
    ),
    diagnosticId: assertReadOnlyDiagnosticIdV1(record.diagnosticId, "audit finding diagnostic ID"),
    severity: assertEnumV1(record.severity, SEVERITIES, "audit finding severity"),
    summary: assertAttributedProseV1(record.summary, "audit finding summary"),
  };
}

function refusalFromTransport(value: unknown): GovernanceDoctorDiagnosticRefusalV1 {
  const record = assertRecordV1(value, "audit refusal");
  assertExactKeysV1(record, ["diagnosticId", "state"], "audit refusal");
  return {
    diagnosticId: assertReadOnlyDiagnosticIdV1(record.diagnosticId, "audit refusal diagnostic ID"),
    state: assertEnumV1(
      record.state,
      [...PRECOMPUTED_REFUSAL_STATES, "missing-adapter"],
      "audit refusal state",
    ),
  };
}

function mintParsedAudit(record: Json): GovernanceDoctorAuditV1Result {
  const kind = assertEnumV1(record.kind, ["audited", "refused"] as const, "audit kind");
  const supplied = assertSha256V1(record.auditSha256, "audit identity");
  if (kind === "refused") {
    assertExactKeysV1(
      record,
      [
        "actionable",
        "auditSha256",
        "kind",
        "policyRevisionSha256",
        "profileSha256",
        "protocol",
        "state",
      ],
      "refused audit",
    );
    if (record.actionable !== false || record.protocol !== "GovernanceDoctorAuditV1")
      failGovernanceDoctorV1("refused audit is malformed");
    const body = {
      actionable: false as const,
      kind: "refused" as const,
      policyRevisionSha256: assertSha256V1(record.policyRevisionSha256, "audit policy revision"),
      profileSha256: assertSha256V1(record.profileSha256, "audit profile identity"),
      protocol: "GovernanceDoctorAuditV1" as const,
      state: assertEnumV1(
        record.state,
        ["compatibility-required", "policy-denied"] as const,
        "audit state",
      ),
    };
    if (governanceDoctorSha256V1(AUDIT_DOMAIN, body) !== supplied)
      failGovernanceDoctorV1("audit identity does not match its content");
    const result = deepFreezeStrictJsonV1({
      ...body,
      auditSha256: supplied,
    }) as GovernanceDoctorAuditRefusedV1;
    auditBytes.set(result, canonicalStrictJsonBytesV1(result));
    return result;
  }
  assertExactKeysV1(
    record,
    [
      "auditSha256",
      "findings",
      "kind",
      "policyRevisionSha256",
      "profileSha256",
      "protocol",
      "refusals",
    ],
    "audited audit",
  );
  if (record.protocol !== "GovernanceDoctorAuditV1")
    failGovernanceDoctorV1("audited audit is malformed");
  const findings = sortByCodeUnitsV1(
    assertArrayV1(
      record.findings,
      0,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxFindings,
      "audit findings",
    ).map(findingFromTransport),
    (item) => `${item.diagnosticId}\u0000${item.code}`,
  );
  assertUniqueV1(
    findings.map((item) => `${item.diagnosticId}\u0000${item.code}`),
    "audit findings",
  );
  const refusals = sortByCodeUnitsV1(
    assertArrayV1(
      record.refusals,
      0,
      GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length,
      "audit refusals",
    ).map(refusalFromTransport),
    (item) => item.diagnosticId,
  );
  assertUniqueV1(
    refusals.map((item) => item.diagnosticId),
    "audit refusals",
  );
  assertDiagnosticPartition(findings, refusals, "audit transport");
  const body = {
    findings,
    kind: "audited" as const,
    policyRevisionSha256: assertSha256V1(record.policyRevisionSha256, "audit policy revision"),
    profileSha256: assertSha256V1(record.profileSha256, "audit profile identity"),
    protocol: "GovernanceDoctorAuditV1" as const,
    refusals,
  };
  if (governanceDoctorSha256V1(AUDIT_DOMAIN, body) !== supplied)
    failGovernanceDoctorV1("audit identity does not match its content");
  const result = deepFreezeStrictJsonV1({
    ...body,
    auditSha256: supplied,
  }) as GovernanceDoctorAuditedV1;
  auditBytes.set(result, canonicalStrictJsonBytesV1(result));
  return result;
}

/** Parses the exact canonical transport for either audited or refused records. */
export function parseGovernanceDoctorAuditV1Json(value: unknown): GovernanceDoctorAuditV1Result {
  const [bytes, record] = parseBoundedTransport(value, "governance doctor audit");
  const audit = mintParsedAudit(record);
  if (!canonicalGovernanceDoctorAuditV1Bytes(audit).equals(bytes))
    failGovernanceDoctorV1("governance doctor audit bytes are not canonical");
  return audit;
}

/** Exact canonical JCS bytes for a validated audit, returned as a defensive copy. */
export function canonicalGovernanceDoctorAuditV1Bytes(value: unknown): Buffer {
  const bytes = typeof value === "object" && value !== null ? auditBytes.get(value) : undefined;
  if (bytes === undefined)
    failGovernanceDoctorV1("governance doctor audit requires a validated brand");
  return Buffer.from(bytes);
}

function quotedProseFromTransport(value: unknown, label: string): GovernanceDoctorQuotedProseV1 {
  const record = assertRecordV1(value, label);
  assertExactKeysV1(record, ["attribution", "authority", "quoted"], label);
  const attribution = assertTokenV1(
    record.attribution,
    GOVERNANCE_DOCTOR_ATTRIBUTION_PATTERN,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxAttributionCodeUnits,
    `${label} attribution`,
  );
  if (record.authority !== "none" || typeof record.quoted !== "string")
    failGovernanceDoctorV1(`${label} is malformed`);
  if (record.quoted.length < 2 || !record.quoted.startsWith('"') || !record.quoted.endsWith('"'))
    failGovernanceDoctorV1(`${label} is not quoted`);
  return quoteProseV1({
    attribution,
    text: assertProseTextV1(record.quoted.slice(1, -1), `${label} text`),
  });
}

function parsedGuideArray<T>(
  value: unknown,
  min: number,
  max: number,
  label: string,
  parse: (item: unknown) => T,
  key: (item: T) => string,
): readonly T[] {
  const items = assertArrayV1(value, min, max, label).map(parse);
  assertUniqueV1(items.map(key), label);
  return sortByCodeUnitsV1(items, key);
}

function assertDiagnosticPartition(
  findings: readonly { readonly diagnosticId: string }[],
  refusals: readonly GovernanceDoctorDiagnosticRefusalV1[],
  label: string,
): void {
  const counts = new Map<string, number>();
  for (const finding of findings)
    counts.set(finding.diagnosticId, (counts.get(finding.diagnosticId) ?? 0) + 1);
  for (const count of counts.values())
    if (count > GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingsPerDiagnostic)
      failGovernanceDoctorV1(`${label} exceeds its per-diagnostic finding bound`);
  const refused = new Set(refusals.map((item) => item.diagnosticId));
  for (const diagnosticId of counts.keys())
    if (refused.has(diagnosticId))
      failGovernanceDoctorV1(`${label} must not overlap findings and refusals`);
}

function mintParsedGuide(record: Json): GovernanceDoctorGuideV1 {
  const kind = assertEnumV1(record.kind, ["available", "withheld"] as const, "guide kind");
  const supplied = assertSha256V1(record.guideSha256, "guide identity");
  if (kind === "withheld") {
    assertExactKeysV1(
      record,
      [
        "guideSha256",
        "kind",
        "nextAction",
        "policyRevisionSha256",
        "profileSha256",
        "protocol",
        "state",
      ],
      "withheld guide",
    );
    const action = assertRecordV1(record.nextAction, "withheld next action");
    assertExactKeysV1(action, ["executable", "owner", "unavailable"], "withheld next action");
    if (
      action.executable !== false ||
      action.owner !== "aih" ||
      action.unavailable !== true ||
      record.protocol !== "GovernanceDoctorGuideV1"
    )
      failGovernanceDoctorV1("withheld guide is malformed");
    const body = {
      kind: "withheld" as const,
      nextAction: { executable: false as const, owner: "aih" as const, unavailable: true as const },
      policyRevisionSha256: assertSha256V1(record.policyRevisionSha256, "guide policy revision"),
      profileSha256: assertSha256V1(record.profileSha256, "guide profile identity"),
      protocol: "GovernanceDoctorGuideV1" as const,
      state: assertEnumV1(
        record.state,
        ["compatibility-required", "policy-denied"] as const,
        "guide state",
      ),
    };
    if (governanceDoctorSha256V1(GUIDE_DOMAIN, body) !== supplied)
      failGovernanceDoctorV1("guide identity does not match its content");
    const guide = deepFreezeStrictJsonV1({
      ...body,
      guideSha256: supplied,
    }) as GovernanceDoctorGuideWithheldV1;
    guideBytes.set(guide, canonicalStrictJsonBytesV1(guide));
    return guide;
  }
  assertExactKeysV1(
    record,
    [
      "auditSha256",
      "conflicts",
      "findings",
      "guidance",
      "guideSha256",
      "kind",
      "nextAction",
      "policy",
      "prerequisites",
      "profileSha256",
      "protocol",
      "refusals",
      "repairPosture",
      "roles",
      "surfaceId",
      "targetId",
    ],
    "available guide",
  );
  if (record.protocol !== "GovernanceDoctorGuideV1")
    failGovernanceDoctorV1("available guide is malformed");
  const roles = parsedGuideArray(
    record.roles,
    1,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxRoles,
    "guide roles",
    (value) => {
      const item = assertRecordV1(value, "guide role");
      assertExactKeysV1(item, ["owner", "roleId", "summary"], "guide role");
      return {
        owner: assertEnumV1(
          item.owner,
          ["aih", "catalog-publisher", "operator", "org-policy"] as const,
          "guide role owner",
        ),
        roleId: assertTokenV1(
          item.roleId,
          GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
          GOVERNANCE_DOCTOR_V1_LIMITS.maxShortIdentifierCodeUnits,
          "guide role ID",
        ),
        summary: quotedProseFromTransport(item.summary, "guide role summary"),
      };
    },
    (item) => item.roleId,
  );
  const prerequisites = parsedGuideArray(
    record.prerequisites,
    1,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxPrerequisites,
    "guide prerequisites",
    (value) => {
      const item = assertRecordV1(value, "guide prerequisite");
      assertExactKeysV1(item, ["note", "prerequisiteId", "satisfiedBy"], "guide prerequisite");
      return {
        note: quotedProseFromTransport(item.note, "guide prerequisite note"),
        prerequisiteId: assertTokenV1(
          item.prerequisiteId,
          GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
          GOVERNANCE_DOCTOR_V1_LIMITS.maxShortIdentifierCodeUnits,
          "guide prerequisite ID",
        ),
        satisfiedBy: assertEnumV1(
          item.satisfiedBy,
          ["aih", "operator", "org-policy"] as const,
          "guide prerequisite owner",
        ),
      };
    },
    (item) => item.prerequisiteId,
  );
  const conflicts = parsedGuideArray(
    record.conflicts,
    1,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxConflicts,
    "guide conflicts",
    (value) => {
      const item = assertRecordV1(value, "guide conflict");
      assertExactKeysV1(item, ["conflictId", "conflictsWithSurfaceId", "note"], "guide conflict");
      return {
        conflictId: assertTokenV1(
          item.conflictId,
          GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
          GOVERNANCE_DOCTOR_V1_LIMITS.maxShortIdentifierCodeUnits,
          "guide conflict ID",
        ),
        conflictsWithSurfaceId: assertTokenV1(
          item.conflictsWithSurfaceId,
          GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
          GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
          "guide conflict surface ID",
        ),
        note: quotedProseFromTransport(item.note, "guide conflict note"),
      };
    },
    (item) => item.conflictId,
  );
  const findings = parsedGuideArray(
    record.findings,
    0,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxFindings,
    "guide findings",
    (value) => {
      const item = assertRecordV1(value, "guide finding");
      assertExactKeysV1(item, ["code", "diagnosticId", "severity", "summary"], "guide finding");
      return {
        code: assertTokenV1(
          item.code,
          FINDING_CODE_PATTERN,
          GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingCodeCodeUnits,
          "guide finding code",
        ),
        diagnosticId: assertReadOnlyDiagnosticIdV1(
          item.diagnosticId,
          "guide finding diagnostic ID",
        ),
        severity: assertEnumV1(item.severity, SEVERITIES, "guide finding severity"),
        summary: quotedProseFromTransport(item.summary, "guide finding summary"),
      };
    },
    (item) => `${item.diagnosticId}\u0000${item.code}`,
  );
  const refusals = parsedGuideArray(
    record.refusals,
    0,
    GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length,
    "guide refusals",
    refusalFromTransport,
    (item) => item.diagnosticId,
  );
  assertDiagnosticPartition(findings, refusals, "guide transport");
  const nextAction = assertRecordV1(record.nextAction, "guide next action");
  assertExactKeysV1(nextAction, ["actionId", "executable", "owner"], "guide next action");
  const policy = assertRecordV1(record.policy, "guide policy");
  assertExactKeysV1(policy, ["decision", "revisionSha256"], "guide policy");
  if (
    nextAction.executable !== false ||
    nextAction.owner !== "aih" ||
    policy.decision !== "allowed"
  )
    failGovernanceDoctorV1("available guide is malformed");
  const body = {
    auditSha256: assertSha256V1(record.auditSha256, "guide audit identity"),
    conflicts,
    findings,
    guidance: quotedProseFromTransport(record.guidance, "guide guidance"),
    kind: "available" as const,
    nextAction: {
      actionId: assertReadOnlyDiagnosticIdV1(nextAction.actionId, "guide next action ID"),
      executable: false as const,
      owner: "aih" as const,
    },
    policy: {
      decision: "allowed" as const,
      revisionSha256: assertSha256V1(policy.revisionSha256, "guide policy revision"),
    },
    prerequisites,
    profileSha256: assertSha256V1(record.profileSha256, "guide profile identity"),
    protocol: "GovernanceDoctorGuideV1" as const,
    refusals,
    repairPosture: assertEnumV1(
      record.repairPosture,
      ["guided-only", "unavailable"] as const,
      "guide repair posture",
    ),
    roles,
    surfaceId: assertTokenV1(
      record.surfaceId,
      GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
      "guide surface ID",
    ),
    targetId: assertTokenV1(
      record.targetId,
      GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
      "guide target ID",
    ),
  };
  if (governanceDoctorSha256V1(GUIDE_DOMAIN, body) !== supplied)
    failGovernanceDoctorV1("guide identity does not match its content");
  const guide = deepFreezeStrictJsonV1({
    ...body,
    guideSha256: supplied,
  }) as GovernanceDoctorGuideAvailableV1;
  guideBytes.set(guide, canonicalStrictJsonBytesV1(guide));
  return guide;
}

/** Parses exact canonical transport for either an available or withheld guide. */
export function parseGovernanceDoctorGuideV1Json(value: unknown): GovernanceDoctorGuideV1 {
  const [bytes, record] = parseBoundedTransport(value, "governance doctor guide");
  const guide = mintParsedGuide(record);
  if (!canonicalGovernanceDoctorGuideV1Bytes(guide).equals(bytes))
    failGovernanceDoctorV1("governance doctor guide bytes are not canonical");
  return guide;
}

/** Exact canonical JCS bytes for a validated guide, returned as a defensive copy. */
export function canonicalGovernanceDoctorGuideV1Bytes(value: unknown): Buffer {
  const bytes = typeof value === "object" && value !== null ? guideBytes.get(value) : undefined;
  if (bytes === undefined)
    failGovernanceDoctorV1("governance doctor guide requires a validated brand");
  return Buffer.from(bytes);
}

/**
 * Explains one completed audit. Every piece of profile or finding prose is
 * rendered quoted, attributed to its source, and marked `authority: "none"`, so
 * untrusted text stays subordinate to the AIH-owned facts around it and never
 * reads as an instruction.
 */
export function renderGovernanceDoctorGuideV1(input: unknown): GovernanceDoctorGuideV1 {
  const record = assertRecordV1(input, "governance doctor guide request");
  assertExactKeysV1(record, ["audit", "profile"], "governance doctor guide request");
  if (typeof record.audit !== "object" || record.audit === null || !auditBytes.has(record.audit))
    failGovernanceDoctorV1("governance doctor audit requires a validated brand");
  const profileSha256 = governanceDoctorProfileV1Sha256(record.profile);
  const audit = record.audit as GovernanceDoctorAuditV1Result;
  // The guide must describe the profile the audit actually ran against; a
  // different profile is drift, not a rendering choice.
  if (audit.profileSha256 !== profileSha256)
    failGovernanceDoctorV1("governance doctor audit and profile identities do not match");
  const profile = record.profile as GovernanceDoctorProfileV1;
  if (
    audit.kind === "audited" &&
    [...audit.findings, ...audit.refusals].some(
      (item) => !profile.diagnosticIds.includes(item.diagnosticId),
    )
  )
    failGovernanceDoctorV1("governance doctor audit names a diagnostic outside its profile");
  if (audit.kind === "refused") return withheld(audit, profileSha256);
  return available(audit, profile);
}
