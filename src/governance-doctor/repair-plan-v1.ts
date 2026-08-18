import { canonicalStrictJsonBytesV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import {
  canonicalGovernanceDoctorAuditV1Bytes,
  canonicalGovernanceDoctorGuideV1Bytes,
  type GovernanceDoctorAuditedV1,
  type GovernanceDoctorGuideAvailableV1,
} from "./audit-guide-v1.js";
import {
  assertArrayV1,
  assertEnumV1,
  assertExactKeysV1,
  assertReadOnlyDiagnosticIdV1,
  assertRecordV1,
  assertSha256V1,
  assertTokenV1,
  assertUniqueV1,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  governanceDoctorSha256V1,
  sortByCodeUnitsV1,
} from "./capability-v1.js";
import {
  canonicalGovernanceDoctorOperationV1Bytes,
  type GovernanceDoctorOperationCompletedV1,
} from "./operation-record-v1.js";
import { governanceDoctorProfileV1Sha256 } from "./profile-v1.js";
import {
  assertGovernanceDoctorRepairEffectArgumentsV1,
  GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1,
  GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
  type GovernanceDoctorRepairBrokerRegistryV1,
  type GovernanceDoctorRepairEffectKindV1,
  type GovernanceDoctorRepairRecipeV1,
  governanceDoctorRepairRecipeV1,
} from "./repair-broker-v1.js";
import {
  assertEpochMillisecondsV1,
  assertManagedRelativePathV1,
  assertManagedTokenV1,
  assertNoProhibitedRepairAuthorityV1,
  assertRepairNonceV1,
  boundedRepairTransportV1,
  brandedRepairValueV1,
  failGovernanceDoctorRepairV1,
  GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1,
  GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS,
} from "./repair-capability-v1.js";

/**
 * `GovernanceDoctorRepairPlanV1` -- one exact, single-use, content-addressed
 * proposal to apply a bounded set of AIH-owned mechanical effects.
 *
 * A plan is buildable only from a completed Governance Doctor run. Its Audit,
 * Guide, and operation record must all be branded by their own modules and must
 * join each other exactly, and the profile handed in must be the one that run
 * actually audited. That is what stops a plan from being assembled out of
 * fragments taken from different runs, roots, evaluation contexts, or policy
 * revisions.
 *
 * The plan cites its evidence rather than asserting it. Every finding and every
 * refusal it names has to appear in that exact Audit, so a plan can never be
 * justified by a diagnostic result nobody produced.
 *
 * Its authority is narrow and explicit: granted to AIH, bound to one policy
 * revision and one read-only surface revision, and always requiring explicit
 * out-of-band consent. No field is able to record an operator grant, a standing
 * approval, or an ambient permission.
 *
 * Its identity is single-use. A caller-supplied 256-bit nonce participates in the
 * plan digest and in every per-effect digest, so two plans over identical content
 * are distinct records and a consent, receipt, or verification minted for one can
 * never be presented for the other.
 *
 * The plan names no bytes to write. Content is identified by digest and locations
 * are safe relative POSIX paths inside a declared scope, so nothing here can be
 * read as text to interpret or as something to run.
 */
export interface GovernanceDoctorRepairAuthorityV1 {
  readonly authoritySha256: string;
  readonly grantedTo: "aih";
  readonly policyRevisionSha256: string;
  readonly requires: "explicit-out-of-band-consent";
  readonly surfaceRevisionSha256: string;
}

export interface GovernanceDoctorRepairEffectV1 {
  readonly arguments: Readonly<Record<string, string>>;
  readonly effectId: string;
  readonly effectKind: GovernanceDoctorRepairEffectKindV1;
  readonly effectSha256: string;
  readonly templateId: string;
}

export interface GovernanceDoctorRepairEvidenceV1 {
  readonly evidenceSha256: string;
  readonly findings: readonly { readonly code: string; readonly diagnosticId: string }[];
  readonly refusals: readonly { readonly diagnosticId: string; readonly state: string }[];
}

export interface GovernanceDoctorRepairScopeV1 {
  readonly paths: readonly string[];
  readonly scopeSha256: string;
}

export interface GovernanceDoctorRepairPlanV1 {
  readonly auditSha256: string;
  readonly authority: GovernanceDoctorRepairAuthorityV1;
  readonly brokerId: string;
  readonly contextSha256: string;
  readonly createdAtEpochMs: number;
  readonly effects: readonly GovernanceDoctorRepairEffectV1[];
  readonly evidence: GovernanceDoctorRepairEvidenceV1;
  readonly expiresAtEpochMs: number;
  readonly guideSha256: string;
  readonly operationSha256: string;
  readonly planNonce: string;
  readonly planSha256: string;
  readonly policyRevisionSha256: string;
  readonly profileSha256: string;
  readonly protocol: "GovernanceDoctorRepairPlanV1";
  readonly recipeId: string;
  readonly recipeSha256: string;
  readonly registrySha256: string;
  readonly rootSha256: string;
  readonly scope: GovernanceDoctorRepairScopeV1;
  readonly surfaceRevisionSha256: string;
  readonly targetId: string;
}

/** The human-visible rendering of exactly what a plan proposes to change. */
export interface GovernanceDoctorRepairEffectSummaryV1 {
  readonly effects: readonly {
    readonly arguments: Readonly<Record<string, string>>;
    readonly effectId: string;
    readonly effectKind: GovernanceDoctorRepairEffectKindV1;
  }[];
  readonly planSha256: string;
  readonly protocol: "GovernanceDoctorRepairEffectSummaryV1";
  readonly summarySha256: string;
  readonly targetId: string;
}

const PROTOCOL = "GovernanceDoctorRepairPlanV1";
const SUMMARY_PROTOCOL = "GovernanceDoctorRepairEffectSummaryV1";
const GRANTED_TO = "aih";
const REQUIRES = "explicit-out-of-band-consent";

const PLAN_FIELDS = [
  "createdAtEpochMs",
  "effects",
  "evidence",
  "expiresAtEpochMs",
  "operation",
  "planNonce",
  "profile",
  "recipeId",
  "registry",
  "scope",
] as const;

const TRANSPORT_FIELDS = [
  "auditSha256",
  "authority",
  "brokerId",
  "contextSha256",
  "createdAtEpochMs",
  "effects",
  "evidence",
  "expiresAtEpochMs",
  "guideSha256",
  "operationSha256",
  "planNonce",
  "planSha256",
  "policyRevisionSha256",
  "profileSha256",
  "protocol",
  "recipeId",
  "recipeSha256",
  "registrySha256",
  "rootSha256",
  "scope",
  "surfaceRevisionSha256",
  "targetId",
] as const;

/** Exactly the refusal states an Audit is able to report. */
const AUDIT_REFUSAL_STATES = [
  "evidence-gap",
  "missing-adapter",
  "missing-credential",
  "unmanaged-drift",
  "unsupported-host",
] as const;

const FINDING_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

type Json = Record<string, unknown>;
type EffectBody = {
  readonly arguments: Record<string, string>;
  readonly effectId: string;
  readonly effectKind: GovernanceDoctorRepairEffectKindV1;
  readonly templateId: string;
};

/** Anti-forgery brands: a structurally identical plain object is not a plan. */
const planBytes = new WeakMap<object, Buffer>();
const summaryBytes = new WeakMap<object, Buffer>();

function findingKey(item: { readonly code: string; readonly diagnosticId: string }): string {
  return `${item.diagnosticId}\u0000${item.code}`;
}

function refusalKey(item: { readonly diagnosticId: string; readonly state: string }): string {
  return `${item.diagnosticId}\u0000${item.state}`;
}

function effectDigest(effect: EffectBody, index: number, planNonce: string): string {
  return governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.effect, {
    arguments: effect.arguments,
    effectId: effect.effectId,
    effectKind: effect.effectKind,
    index,
    planNonce,
    templateId: effect.templateId,
  });
}

function authority(
  policyRevisionSha256: string,
  surfaceRevisionSha256: string,
): GovernanceDoctorRepairAuthorityV1 {
  const body = {
    grantedTo: GRANTED_TO,
    policyRevisionSha256,
    requires: REQUIRES,
    surfaceRevisionSha256,
  } as const;
  return {
    ...body,
    authoritySha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.authority, body),
  };
}

function scope(value: unknown): GovernanceDoctorRepairScopeV1 {
  const paths = assertArrayV1(
    value,
    1,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxScopePaths,
    "repair scope paths",
  ).map((item) => assertManagedRelativePathV1(item, "repair scope path"));
  assertUniqueV1(paths, "repair scope paths");
  const ordered = sortByCodeUnitsV1(paths, (item) => item);
  return {
    paths: ordered,
    scopeSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.scope, {
      paths: ordered,
    }),
  };
}

/** Every location an effect names must be one the plan's own scope declares. */
function assertEffectWithinScope(effect: EffectBody, scopePaths: readonly string[]): void {
  for (const argument of GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1[effect.effectKind])
    if (
      argument.type === "managed-relative-path" &&
      !scopePaths.includes(effect.arguments[argument.name] ?? "")
    )
      failGovernanceDoctorRepairV1("repair effect names a location outside its declared scope");
}

/** No effect identity and no exact mechanical effect may appear twice in one plan. */
function assertDistinctEffects(built: readonly GovernanceDoctorRepairEffectV1[]): void {
  assertUniqueV1(
    built.map((effect) => effect.effectId),
    "repair effects",
  );
  assertUniqueV1(
    built.map(
      (effect) =>
        `${effect.effectKind}\u0000${canonicalStrictJsonBytesV1(effect.arguments).toString("utf8")}`,
    ),
    "repair effects",
  );
}

function requestedEffects(
  value: unknown,
  recipe: GovernanceDoctorRepairRecipeV1,
  scopePaths: readonly string[],
  planNonce: string,
): readonly GovernanceDoctorRepairEffectV1[] {
  const templates = new Map(recipe.effects.map((template) => [template.templateId, template]));
  const built = assertArrayV1(
    value,
    1,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects,
    "repair effects",
  ).map((item, index) => {
    const record = assertRecordV1(item, "repair effect");
    assertExactKeysV1(record, ["arguments", "effectId", "templateId"], "repair effect");
    const template = templates.get(
      assertManagedTokenV1(record.templateId, "repair effect template ID"),
    );
    if (template === undefined)
      failGovernanceDoctorRepairV1("repair effect names a template outside its recipe");
    const effect: EffectBody = {
      arguments: assertGovernanceDoctorRepairEffectArgumentsV1(
        template.effectKind,
        record.arguments,
        "repair effect arguments",
      ),
      effectId: assertManagedTokenV1(record.effectId, "repair effect ID"),
      effectKind: template.effectKind,
      templateId: template.templateId,
    };
    assertEffectWithinScope(effect, scopePaths);
    return { ...effect, effectSha256: effectDigest(effect, index, planNonce) };
  });
  assertDistinctEffects(built);
  return built;
}

interface EvidenceBodyV1 {
  readonly findings: readonly { readonly code: string; readonly diagnosticId: string }[];
  readonly refusals: readonly { readonly diagnosticId: string; readonly state: string }[];
}

/** Shape-only validation. The caller has already closed the container's key set. */
function evidenceBody(record: Json): EvidenceBodyV1 {
  const findings = assertArrayV1(
    record.findings,
    0,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEvidenceFindings,
    "repair evidence findings",
  ).map((item) => {
    const finding = assertRecordV1(item, "repair evidence finding");
    assertExactKeysV1(finding, ["code", "diagnosticId"], "repair evidence finding");
    return {
      code: assertTokenV1(
        finding.code,
        FINDING_CODE_PATTERN,
        GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingCodeCodeUnits,
        "repair evidence finding code",
      ),
      diagnosticId: assertReadOnlyDiagnosticIdV1(
        finding.diagnosticId,
        "repair evidence finding diagnostic ID",
      ),
    };
  });
  const refusals = assertArrayV1(
    record.refusals,
    0,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEvidenceRefusals,
    "repair evidence refusals",
  ).map((item) => {
    const refusal = assertRecordV1(item, "repair evidence refusal");
    assertExactKeysV1(refusal, ["diagnosticId", "state"], "repair evidence refusal");
    return {
      diagnosticId: assertReadOnlyDiagnosticIdV1(
        refusal.diagnosticId,
        "repair evidence refusal diagnostic ID",
      ),
      state: assertEnumV1(refusal.state, AUDIT_REFUSAL_STATES, "repair evidence refusal state"),
    };
  });
  if (findings.length + refusals.length === 0)
    failGovernanceDoctorRepairV1("repair evidence must cite at least one audited result");
  assertUniqueV1(findings.map(findingKey), "repair evidence findings");
  assertUniqueV1(
    refusals.map((refusal) => refusal.diagnosticId),
    "repair evidence refusals",
  );
  return {
    findings: sortByCodeUnitsV1(findings, findingKey),
    refusals: sortByCodeUnitsV1(refusals, (refusal) => refusal.diagnosticId),
  };
}

function evidence(body: EvidenceBodyV1, auditSha256: string): GovernanceDoctorRepairEvidenceV1 {
  return {
    ...body,
    evidenceSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.evidence, {
      auditSha256,
      findings: body.findings,
      refusals: body.refusals,
    }),
  };
}

/** Every citation must be something this exact Audit actually reported. */
function assertEvidenceWasAudited(body: EvidenceBodyV1, audit: GovernanceDoctorAuditedV1): void {
  const auditedFindings = new Set(audit.findings.map(findingKey));
  for (const finding of body.findings)
    if (!auditedFindings.has(findingKey(finding)))
      failGovernanceDoctorRepairV1("repair evidence cites a finding this audit did not report");
  const auditedRefusals = new Set(audit.refusals.map(refusalKey));
  for (const refusal of body.refusals)
    if (!auditedRefusals.has(refusalKey(refusal)))
      failGovernanceDoctorRepairV1("repair evidence cites a refusal this audit did not report");
}

function validityWindow(record: Json): readonly [number, number] {
  const createdAtEpochMs = assertEpochMillisecondsV1(
    record.createdAtEpochMs,
    "repair plan creation",
  );
  const expiresAtEpochMs = assertEpochMillisecondsV1(record.expiresAtEpochMs, "repair plan expiry");
  if (
    expiresAtEpochMs <= createdAtEpochMs ||
    expiresAtEpochMs - createdAtEpochMs > GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxPlanLifetimeMs
  )
    failGovernanceDoctorRepairV1("repair plan validity window is invalid or unbounded");
  return [createdAtEpochMs, expiresAtEpochMs];
}

function mint(body: Json): GovernanceDoctorRepairPlanV1 {
  const plan = deepFreezeStrictJsonV1({
    ...body,
    planSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.plan, body),
  }) as GovernanceDoctorRepairPlanV1;
  planBytes.set(plan, canonicalStrictJsonBytesV1(plan));
  return plan;
}

/** The branded, completed Audit, Guide, and operation record for one exact run. */
function completedOperation(value: unknown): {
  readonly audit: GovernanceDoctorAuditedV1;
  readonly record: GovernanceDoctorOperationCompletedV1;
} {
  const container = assertRecordV1(value, "governance doctor operation");
  assertExactKeysV1(container, ["audit", "guide", "record"], "governance doctor operation");
  canonicalGovernanceDoctorAuditV1Bytes(container.audit);
  canonicalGovernanceDoctorGuideV1Bytes(container.guide);
  canonicalGovernanceDoctorOperationV1Bytes(container.record);
  const audit = container.audit as GovernanceDoctorAuditedV1;
  const guide = container.guide as GovernanceDoctorGuideAvailableV1;
  const record = container.record as GovernanceDoctorOperationCompletedV1;
  if (record.kind !== "completed" || audit.kind !== "audited" || guide.kind !== "available")
    failGovernanceDoctorRepairV1("repair plan requires a completed governance doctor operation");
  if (
    record.auditSha256 !== audit.auditSha256 ||
    record.guideSha256 !== guide.guideSha256 ||
    guide.auditSha256 !== audit.auditSha256 ||
    record.profileSha256 !== audit.profileSha256 ||
    record.profileSha256 !== guide.profileSha256 ||
    record.policyRevisionSha256 !== audit.policyRevisionSha256 ||
    record.policyRevisionSha256 !== guide.policy.revisionSha256 ||
    record.targetId !== guide.targetId
  )
    failGovernanceDoctorRepairV1("governance doctor operation identities do not join");
  return { audit, record };
}

/**
 * Validates one repair proposal against a completed run and mints a branded,
 * frozen, single-use plan. Every value is rebuilt into a fresh object, so a
 * caller that mutates its input afterwards cannot reach into the minted plan.
 */
export function createGovernanceDoctorRepairPlanV1(input: unknown): GovernanceDoctorRepairPlanV1 {
  const request = assertRecordV1(input, "repair plan request");
  assertExactKeysV1(request, PLAN_FIELDS, "repair plan request");

  const { audit, record } = completedOperation(request.operation);
  if (governanceDoctorProfileV1Sha256(request.profile) !== record.profileSha256)
    failGovernanceDoctorRepairV1("repair plan profile is not the audited profile");

  const [createdAtEpochMs, expiresAtEpochMs] = validityWindow(request);
  const planNonce = assertRepairNonceV1(request.planNonce, "repair plan nonce");
  const recipe = governanceDoctorRepairRecipeV1(request.registry, request.recipeId);
  const registry = request.registry as {
    readonly brokerId: string;
    readonly registrySha256: string;
  };
  const scopeRequest = assertRecordV1(request.scope, "repair scope");
  assertExactKeysV1(scopeRequest, ["paths"], "repair scope");
  const declaredScope = scope(scopeRequest.paths);
  const evidenceRequest = assertRecordV1(request.evidence, "repair evidence");
  assertExactKeysV1(evidenceRequest, ["findings", "refusals"], "repair evidence");
  const citations = evidenceBody(evidenceRequest);
  assertEvidenceWasAudited(citations, audit);

  return mint({
    auditSha256: record.auditSha256,
    authority: authority(record.policyRevisionSha256, record.surfaceRevisionSha256),
    brokerId: registry.brokerId,
    contextSha256: record.contextSha256,
    createdAtEpochMs,
    effects: requestedEffects(request.effects, recipe, declaredScope.paths, planNonce),
    evidence: evidence(citations, record.auditSha256),
    expiresAtEpochMs,
    guideSha256: record.guideSha256,
    operationSha256: record.operationSha256,
    planNonce,
    policyRevisionSha256: record.policyRevisionSha256,
    profileSha256: record.profileSha256,
    protocol: PROTOCOL,
    recipeId: recipe.recipeId,
    recipeSha256: recipe.recipeSha256,
    registrySha256: registry.registrySha256,
    rootSha256: record.rootSha256,
    scope: declaredScope,
    surfaceRevisionSha256: record.surfaceRevisionSha256,
    targetId: record.targetId,
  });
}

/**
 * Derives the human-visible effect summary a consent ruling is taken over. It is
 * computed here rather than supplied, so the effects a person approves and the
 * effects a plan carries cannot drift apart.
 */
export function governanceDoctorRepairEffectSummaryV1(
  value: unknown,
): GovernanceDoctorRepairEffectSummaryV1 {
  brandedRepairValueV1(planBytes, value, "repair plan");
  const plan = value as GovernanceDoctorRepairPlanV1;
  const body = {
    effects: plan.effects.map((effect) => ({
      arguments: { ...effect.arguments },
      effectId: effect.effectId,
      effectKind: effect.effectKind,
    })),
    planSha256: plan.planSha256,
    protocol: SUMMARY_PROTOCOL,
    targetId: plan.targetId,
  };
  const summary = deepFreezeStrictJsonV1({
    ...body,
    summarySha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.effectSummary, body),
  }) as GovernanceDoctorRepairEffectSummaryV1;
  summaryBytes.set(summary, canonicalStrictJsonBytesV1(summary));
  return summary;
}

/** The exact canonical JCS UTF-8 bytes of a minted plan, as a defensive copy. */
export function canonicalGovernanceDoctorRepairPlanV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(planBytes, value, "repair plan"));
}

/** The exact canonical JCS UTF-8 bytes of a derived effect summary, as a copy. */
export function canonicalGovernanceDoctorRepairEffectSummaryV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(summaryBytes, value, "repair effect summary"));
}

function parsedAuthority(value: unknown): GovernanceDoctorRepairAuthorityV1 {
  const record = assertRecordV1(value, "repair authority");
  assertExactKeysV1(
    record,
    ["authoritySha256", "grantedTo", "policyRevisionSha256", "requires", "surfaceRevisionSha256"],
    "repair authority",
  );
  if (record.grantedTo !== GRANTED_TO || record.requires !== REQUIRES)
    failGovernanceDoctorRepairV1("repair authority is malformed");
  const rebuilt = authority(
    assertSha256V1(record.policyRevisionSha256, "repair authority policy revision"),
    assertSha256V1(record.surfaceRevisionSha256, "repair authority surface revision"),
  );
  if (
    rebuilt.authoritySha256 !== assertSha256V1(record.authoritySha256, "repair authority identity")
  )
    failGovernanceDoctorRepairV1("repair authority identity does not match its content");
  return rebuilt;
}

function parsedScope(value: unknown): GovernanceDoctorRepairScopeV1 {
  const record = assertRecordV1(value, "repair scope");
  assertExactKeysV1(record, ["paths", "scopeSha256"], "repair scope");
  const rebuilt = scope(record.paths);
  if (rebuilt.scopeSha256 !== assertSha256V1(record.scopeSha256, "repair scope identity"))
    failGovernanceDoctorRepairV1("repair scope identity does not match its content");
  return rebuilt;
}

function parsedEvidence(value: unknown, auditSha256: string): GovernanceDoctorRepairEvidenceV1 {
  const record = assertRecordV1(value, "repair evidence");
  assertExactKeysV1(record, ["evidenceSha256", "findings", "refusals"], "repair evidence");
  const rebuilt = evidence(evidenceBody(record), auditSha256);
  if (rebuilt.evidenceSha256 !== assertSha256V1(record.evidenceSha256, "repair evidence identity"))
    failGovernanceDoctorRepairV1("repair evidence identity does not match its content");
  return rebuilt;
}

function parsedEffects(
  value: unknown,
  recipe: GovernanceDoctorRepairRecipeV1,
  scopePaths: readonly string[],
  planNonce: string,
): readonly GovernanceDoctorRepairEffectV1[] {
  const templates = new Map(recipe.effects.map((template) => [template.templateId, template]));
  const built = assertArrayV1(
    value,
    1,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects,
    "repair effects",
  ).map((item, index) => {
    const record = assertRecordV1(item, "repair effect");
    assertExactKeysV1(
      record,
      ["arguments", "effectId", "effectKind", "effectSha256", "templateId"],
      "repair effect",
    );
    const effect: EffectBody = {
      arguments: assertGovernanceDoctorRepairEffectArgumentsV1(
        record.effectKind,
        record.arguments,
        "repair effect arguments",
      ),
      effectId: assertManagedTokenV1(record.effectId, "repair effect ID"),
      effectKind: assertEnumV1(
        record.effectKind,
        GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
        "repair effect kind",
      ),
      templateId: assertNoProhibitedRepairAuthorityV1(
        assertManagedTokenV1(record.templateId, "repair effect template ID"),
        "repair effect template ID",
      ),
    };
    const template = templates.get(effect.templateId);
    if (template === undefined || template.effectKind !== effect.effectKind)
      failGovernanceDoctorRepairV1("repair effect does not bind its registered template");
    assertEffectWithinScope(effect, scopePaths);
    const effectSha256 = effectDigest(effect, index, planNonce);
    if (effectSha256 !== assertSha256V1(record.effectSha256, "repair effect identity"))
      failGovernanceDoctorRepairV1("repair effect identity does not match its content");
    return { ...effect, effectSha256 };
  });
  assertDistinctEffects(built);
  return built;
}

/**
 * Parses transport only against the exact trusted operation, profile, and
 * registry that originally authorize a plan. Bytes alone never mint a plan
 * brand: every operation/recipe/effect join is rebuilt through the same trusted
 * construction path used for an in-process proposal.
 */
export function parseGovernanceDoctorRepairPlanV1Json(
  input: unknown,
): GovernanceDoctorRepairPlanV1 {
  const request = assertRecordV1(input, "repair plan transport request");
  assertExactKeysV1(
    request,
    ["bytes", "operation", "profile", "registry"],
    "repair plan transport request",
  );
  const { audit, record: operation } = completedOperation(request.operation);
  if (governanceDoctorProfileV1Sha256(request.profile) !== operation.profileSha256)
    failGovernanceDoctorRepairV1("repair plan profile is not the audited profile");
  const [bytes, record] = boundedRepairTransportV1(request.bytes, "repair plan");
  assertExactKeysV1(record, TRANSPORT_FIELDS, "repair plan transport");
  if (record.protocol !== PROTOCOL)
    failGovernanceDoctorRepairV1("repair plan transport is malformed");
  const supplied = assertSha256V1(record.planSha256, "repair plan identity");
  const fields = [
    "auditSha256",
    "contextSha256",
    "guideSha256",
    "operationSha256",
    "policyRevisionSha256",
    "profileSha256",
    "rootSha256",
    "surfaceRevisionSha256",
    "targetId",
  ] as const;
  for (const field of fields)
    if (record[field] !== operation[field])
      failGovernanceDoctorRepairV1("repair plan transport does not bind its trusted operation");
  const recipeId = assertNoProhibitedRepairAuthorityV1(
    assertManagedTokenV1(record.recipeId, "repair recipe ID"),
    "repair recipe ID",
  );
  const recipe = governanceDoctorRepairRecipeV1(request.registry, recipeId);
  const registry = request.registry as GovernanceDoctorRepairBrokerRegistryV1;
  if (
    record.brokerId !== registry.brokerId ||
    record.registrySha256 !== registry.registrySha256 ||
    record.recipeSha256 !== recipe.recipeSha256
  )
    failGovernanceDoctorRepairV1("repair plan transport does not bind its trusted registry");
  const parsedAuthorityValue = parsedAuthority(record.authority);
  if (
    parsedAuthorityValue.policyRevisionSha256 !== operation.policyRevisionSha256 ||
    parsedAuthorityValue.surfaceRevisionSha256 !== operation.surfaceRevisionSha256 ||
    record.policyRevisionSha256 !== parsedAuthorityValue.policyRevisionSha256 ||
    record.surfaceRevisionSha256 !== parsedAuthorityValue.surfaceRevisionSha256
  )
    failGovernanceDoctorRepairV1("repair plan transport authority does not bind its operation");
  const declaredScope = parsedScope(record.scope);
  const planNonce = assertRepairNonceV1(record.planNonce, "repair plan nonce");
  const effects = parsedEffects(record.effects, recipe, declaredScope.paths, planNonce).map(
    (effect) => ({
      arguments: effect.arguments,
      effectId: effect.effectId,
      templateId: effect.templateId,
    }),
  );
  const parsedEvidenceValue = parsedEvidence(record.evidence, operation.auditSha256);
  assertEvidenceWasAudited(
    { findings: parsedEvidenceValue.findings, refusals: parsedEvidenceValue.refusals },
    audit,
  );
  const plan = createGovernanceDoctorRepairPlanV1({
    createdAtEpochMs: record.createdAtEpochMs,
    effects,
    evidence: { findings: parsedEvidenceValue.findings, refusals: parsedEvidenceValue.refusals },
    expiresAtEpochMs: record.expiresAtEpochMs,
    operation: request.operation,
    planNonce,
    profile: request.profile,
    recipeId,
    registry: request.registry,
    scope: { paths: declaredScope.paths },
  });
  if (plan.planSha256 !== supplied)
    failGovernanceDoctorRepairV1("repair plan identity does not match its content");
  if (!canonicalGovernanceDoctorRepairPlanV1Bytes(plan).equals(bytes))
    failGovernanceDoctorRepairV1("repair plan bytes are not canonical");
  return plan;
}
