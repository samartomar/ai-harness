import { isProxy } from "node:util/types";
import { z } from "zod";

const MAX_REQUESTED_COMPONENTS = 32;
const MAX_ARTIFACTS = 64;
const MAX_DEPENDENCIES_PER_ARTIFACT = 32;
const MAX_LOCATOR_LENGTH = 512;
const MAX_FINDINGS = 256;
const MAX_SNAPSHOT_ARRAY_LENGTH = MAX_FINDINGS + 1;
const MAX_SNAPSHOT_RECORD_KEYS = 16;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 512;

const ArtifactIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const SourceLocatorSchema = z
  .string()
  .min(1)
  .max(MAX_LOCATOR_LENGTH)
  .regex(/^synthetic:[a-z][a-z0-9-]{0,63}$/);

const ContentDispositionSchema = z.enum(["inert", "executable", "ambiguous"]);
const LinkDispositionSchema = z.enum(["none", "symbolic", "hard", "reparse"]);
const LicenseDispositionSchema = z.enum(["permissive", "unknown", "restricted"]);

const ARTIFACT_FIELDS = [
  "id",
  "sourceLocator",
  "contentDigest",
  "contentDisposition",
  "linkDisposition",
  "licenseDisposition",
  "evidenceDigest",
  "dependencies",
] as const;
const EVIDENCE_FIELDS = [
  "artifactId",
  "sourceLocator",
  "contentDigest",
  "licenseDisposition",
  "evidenceDigest",
] as const;
const INPUT_FIELDS = [
  "schemaVersion",
  "requested",
  "declaredClosure",
  "artifacts",
  "evidence",
] as const;
const RESULT_FIELDS = ["schemaVersion", "disposition", "closure", "eligible", "findings"] as const;

const SyntheticArtifactTupleSchema = z
  .tuple([
    ArtifactIdSchema,
    SourceLocatorSchema,
    DigestSchema,
    ContentDispositionSchema,
    LinkDispositionSchema,
    LicenseDispositionSchema,
    DigestSchema,
    z.array(ArtifactIdSchema).max(MAX_DEPENDENCIES_PER_ARTIFACT),
  ])
  .transform(
    ([
      id,
      sourceLocator,
      contentDigest,
      contentDisposition,
      linkDisposition,
      licenseDisposition,
      evidenceDigest,
      dependencies,
    ]) =>
      closedRecord({
        id,
        sourceLocator,
        contentDigest,
        contentDisposition,
        linkDisposition,
        licenseDisposition,
        evidenceDigest,
        dependencies,
      }),
  );

export const SyntheticArtifactSchema = closedPublicSchema(
  z.preprocess(
    (value) => recordTuple(value, artifactCollectionsAreBounded, ARTIFACT_FIELDS),
    SyntheticArtifactTupleSchema,
  ),
  validateArtifact,
);

const SyntheticEvidenceTupleSchema = z
  .tuple([
    ArtifactIdSchema,
    SourceLocatorSchema,
    DigestSchema,
    LicenseDispositionSchema,
    DigestSchema,
  ])
  .transform(([artifactId, sourceLocator, contentDigest, licenseDisposition, evidenceDigest]) =>
    closedRecord({
      artifactId,
      sourceLocator,
      contentDigest,
      licenseDisposition,
      evidenceDigest,
    }),
  );

export const SyntheticEvidenceSchema = closedPublicSchema(
  z.preprocess(
    (value) => recordTuple(value, evidenceRecordIsClosed, EVIDENCE_FIELDS),
    SyntheticEvidenceTupleSchema,
  ),
  validateEvidence,
);

const SyntheticClassifierInputTupleSchema = z
  .tuple([
    z.literal(1),
    z.array(ArtifactIdSchema).min(1).max(MAX_REQUESTED_COMPONENTS),
    z.array(ArtifactIdSchema).min(1).max(MAX_ARTIFACTS),
    z.array(SyntheticArtifactSchema).min(1).max(MAX_ARTIFACTS),
    z.array(SyntheticEvidenceSchema).max(MAX_ARTIFACTS),
  ])
  .transform(([schemaVersion, requested, declaredClosure, artifacts, evidence]) =>
    closedRecord({ schemaVersion, requested, declaredClosure, artifacts, evidence }),
  );

export const SyntheticClassifierInputSchema = closedPublicSchema(
  z.preprocess(
    (value) => recordTuple(value, classifierCollectionsAreBounded, INPUT_FIELDS),
    SyntheticClassifierInputTupleSchema,
  ),
  validateClassifierInput,
);

const FINDING_CODES = [
  "METHODOLOGY_ARTIFACT_DUPLICATE",
  "METHODOLOGY_CONTENT_AMBIGUOUS",
  "METHODOLOGY_CONTENT_EXECUTABLE",
  "METHODOLOGY_CONTENT_LINKED",
  "METHODOLOGY_DEPENDENCY_CYCLE",
  "METHODOLOGY_DEPENDENCY_MISSING",
  "METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE",
  "METHODOLOGY_EVIDENCE_CONFLICT",
  "METHODOLOGY_EVIDENCE_DRIFT",
  "METHODOLOGY_EVIDENCE_MISSING",
  "METHODOLOGY_EVIDENCE_UNBOUND",
  "METHODOLOGY_FINDINGS_LIMIT",
  "METHODOLOGY_LICENSE_UNAPPROVED",
  "METHODOLOGY_LOCATOR_DUPLICATE",
  "METHODOLOGY_REQUEST_DUPLICATE",
] as const;

export const SyntheticFindingCodeSchema = closedPublicSchema(
  z.enum(FINDING_CODES),
  validateFindingCode,
);

const GLOBAL_FINDING_CODES = new Set<z.infer<typeof SyntheticFindingCodeSchema>>([
  "METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE",
  "METHODOLOGY_FINDINGS_LIMIT",
  "METHODOLOGY_REQUEST_DUPLICATE",
]);
const FINDING_REQUIRED_FIELDS = ["code"] as const;
const FINDING_FIELDS = ["code", "artifactId"] as const;
type SyntheticFindingRecord = {
  code: z.infer<typeof SyntheticFindingCodeSchema>;
  artifactId?: string;
};

const SyntheticFindingTupleSchema = z
  .tuple([SyntheticFindingCodeSchema, ArtifactIdSchema.optional()])
  .transform(([code, artifactId]): SyntheticFindingRecord => {
    return artifactId === undefined ? closedRecord({ code }) : closedRecord({ code, artifactId });
  });

export const SyntheticFindingSchema = closedPublicSchema(
  z.preprocess((value) => findingTuple(value), SyntheticFindingTupleSchema),
  validateFinding,
);

type SnapshotResult = { ok: true; value: unknown } | { ok: false };
type SnapshotState = { nodes: number; active: WeakSet<object> };

const INVALID_SNAPSHOT = Object.freeze({ ok: false as const });

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function snapshotSurface(value: unknown): SnapshotResult {
  if (value === null || typeof value !== "object") return { ok: true, value };
  if (isProxy(value)) return INVALID_SNAPSHOT;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return INVALID_SNAPSHOT;
    const length = value.length;
    if (length > MAX_SNAPSHOT_ARRAY_LENGTH) return INVALID_SNAPSHOT;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) {
      return INVALID_SNAPSHOT;
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return INVALID_SNAPSHOT;
      }
    }
    return { ok: true, value };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return INVALID_SNAPSHOT;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_SNAPSHOT_RECORD_KEYS || keys.some((key) => typeof key !== "string")) {
    return INVALID_SNAPSHOT;
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return INVALID_SNAPSHOT;
    }
    snapshot[key] = descriptor.value;
  }
  return { ok: true, value: snapshot };
}

function snapshotPlainData(value: unknown, depth: number, state: SnapshotState): SnapshotResult {
  const surface = snapshotSurface(value);
  if (!surface.ok) return INVALID_SNAPSHOT;
  if (value === null || typeof value !== "object") return surface;
  if (depth >= MAX_SNAPSHOT_DEPTH || state.nodes >= MAX_SNAPSHOT_NODES) {
    return INVALID_SNAPSHOT;
  }
  if (state.active.has(value)) return INVALID_SNAPSHOT;
  state.nodes += 1;
  state.active.add(value);
  try {
    if (Array.isArray(surface.value)) {
      const snapshot: unknown[] = [];
      for (let index = 0; index < surface.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(surface.value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) return INVALID_SNAPSHOT;
        const child = snapshotPlainData(descriptor.value, depth + 1, state);
        if (!child.ok) return INVALID_SNAPSHOT;
        snapshot.push(child.value);
      }
      return { ok: true, value: snapshot };
    }
    const record = recordOf(surface.value);
    if (record === undefined) return INVALID_SNAPSHOT;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) return INVALID_SNAPSHOT;
      const child = snapshotPlainData(descriptor.value, depth + 1, state);
      if (!child.ok) return INVALID_SNAPSHOT;
      snapshot[key] = child.value;
    }
    return { ok: true, value: snapshot };
  } finally {
    state.active.delete(value);
  }
}

function staticRecordOf(value: unknown): Record<string, unknown> | undefined {
  const surface = snapshotSurface(value);
  return surface.ok ? recordOf(surface.value) : undefined;
}

function recordFieldsAreExact(value: unknown, fields: readonly string[]): boolean {
  const record = staticRecordOf(value);
  if (record === undefined) return false;
  const keys = Object.keys(record);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field));
}

function collectionIsBounded(value: unknown, maximum: number): boolean {
  if (isProxy(value)) return false;
  if (!Array.isArray(value)) return true;
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
  }
  return true;
}

function collectionRecordsSatisfy(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  if (!Array.isArray(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !predicate(descriptor.value)) {
      return false;
    }
  }
  return true;
}

function failClosedPreprocess(value: unknown, predicate: (candidate: unknown) => boolean): unknown {
  const surface = snapshotSurface(value);
  if (!surface.ok || !predicate(surface.value)) return null;
  const snapshot = snapshotPlainData(surface.value, 0, {
    nodes: 0,
    active: new WeakSet<object>(),
  });
  return snapshot.ok ? snapshot.value : null;
}

function closedRecord<T extends Record<string, unknown>>(value: T): T {
  const record = Object.create(null) as T;
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }
  return record;
}

function recordTuple(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
  fields: readonly string[],
): unknown {
  const snapshot = failClosedPreprocess(value, predicate);
  const record = recordOf(snapshot);
  if (record === undefined) return null;
  const tuple: unknown[] = [];
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    tuple.push(descriptor.value);
  }
  return tuple;
}

function findingTuple(value: unknown): unknown {
  const snapshot = failClosedPreprocess(value, findingRecordIsClosed);
  const record = recordOf(snapshot);
  if (record === undefined) return null;
  const code = Object.getOwnPropertyDescriptor(record, "code");
  const artifactId = Object.getOwnPropertyDescriptor(record, "artifactId");
  if (code === undefined || !("value" in code)) return null;
  return [
    code.value,
    artifactId !== undefined && "value" in artifactId ? artifactId.value : undefined,
  ];
}

function artifactCollectionsAreBounded(value: unknown): boolean {
  const artifact = staticRecordOf(value);
  if (artifact === undefined) return true;
  return (
    recordFieldsAreExact(artifact, ARTIFACT_FIELDS) &&
    collectionIsBounded(artifact.dependencies, MAX_DEPENDENCIES_PER_ARTIFACT)
  );
}

function evidenceRecordIsClosed(value: unknown): boolean {
  return recordFieldsAreExact(value, EVIDENCE_FIELDS);
}

function findingRecordIsClosed(value: unknown): boolean {
  const record = staticRecordOf(value);
  if (record === undefined) return false;
  const fields = Object.hasOwn(record, "artifactId") ? FINDING_FIELDS : FINDING_REQUIRED_FIELDS;
  return recordFieldsAreExact(record, fields);
}

function classifierCollectionsAreBounded(value: unknown): boolean {
  const input = staticRecordOf(value);
  if (input === undefined) return true;
  return (
    recordFieldsAreExact(input, INPUT_FIELDS) &&
    collectionIsBounded(input.requested, MAX_REQUESTED_COMPONENTS) &&
    collectionIsBounded(input.declaredClosure, MAX_ARTIFACTS) &&
    collectionIsBounded(input.artifacts, MAX_ARTIFACTS) &&
    collectionIsBounded(input.evidence, MAX_ARTIFACTS) &&
    collectionRecordsSatisfy(input.artifacts, artifactCollectionsAreBounded) &&
    collectionRecordsSatisfy(input.evidence, evidenceRecordIsClosed)
  );
}

function resultCollectionsAreBounded(value: unknown): boolean {
  const result = staticRecordOf(value);
  if (result === undefined) return true;
  return (
    recordFieldsAreExact(result, RESULT_FIELDS) &&
    collectionIsBounded(result.closure, MAX_ARTIFACTS) &&
    collectionIsBounded(result.eligible, MAX_ARTIFACTS) &&
    collectionIsBounded(result.findings, MAX_FINDINGS) &&
    collectionRecordsSatisfy(result.findings, findingRecordIsClosed)
  );
}

type ValidationPath = readonly (string | number)[];
type ValidationIssue = {
  readonly code: "custom";
  readonly path: ValidationPath;
  readonly message: string;
};

const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_LOCATOR_PATTERN = /^synthetic:[a-z][a-z0-9-]{0,63}$/;
const CONTENT_DISPOSITIONS = new Set(["inert", "executable", "ambiguous"]);
const LINK_DISPOSITIONS = new Set(["none", "symbolic", "hard", "reparse"]);
const LICENSE_DISPOSITIONS = new Set(["permissive", "unknown", "restricted"]);
const RESULT_DISPOSITIONS = new Set(["eligible", "ineligible"]);
const FINDING_CODE_SET = new Set<string>(FINDING_CODES);

function validationIssue(path: ValidationPath, message: string): ValidationIssue {
  return closedRecord({ code: "custom" as const, path: [...path], message });
}

function prefixedIssue(prefix: ValidationPath, issue: ValidationIssue): ValidationIssue {
  return validationIssue([...prefix, ...issue.path], issue.message);
}

function validationSnapshot(value: unknown): SnapshotResult {
  return snapshotPlainData(value, 0, {
    nodes: 0,
    active: new WeakSet<object>(),
  });
}

function validateRecordFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): ValidationIssue | undefined {
  const permitted = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) return validationIssue([key], "unknown field is not permitted");
  }
  for (const field of required) {
    if (!Object.hasOwn(record, field)) return validationIssue([field], "required field is missing");
  }
  return undefined;
}

function validateStringPattern(
  value: unknown,
  pattern: RegExp,
  path: ValidationPath,
  message: string,
): ValidationIssue | undefined {
  return typeof value === "string" && pattern.test(value)
    ? undefined
    : validationIssue(path, message);
}

function validateEnumValue(
  value: unknown,
  permitted: ReadonlySet<string>,
  path: ValidationPath,
  message: string,
): ValidationIssue | undefined {
  return typeof value === "string" && permitted.has(value)
    ? undefined
    : validationIssue(path, message);
}

function validateArray(
  value: unknown,
  minimum: number,
  maximum: number,
  path: ValidationPath,
  itemValidator: (item: unknown) => ValidationIssue | undefined,
): ValidationIssue | undefined {
  if (!Array.isArray(value)) return validationIssue(path, "value must be a closed array");
  if (value.length < minimum || value.length > maximum) {
    return validationIssue(path, "array length is outside the closed resource bounds");
  }
  for (let index = 0; index < value.length; index += 1) {
    const childIssue = itemValidator(value[index]);
    if (childIssue !== undefined) return prefixedIssue([...path, index], childIssue);
  }
  return undefined;
}

function validateArtifactId(value: unknown): ValidationIssue | undefined {
  return validateStringPattern(
    value,
    ARTIFACT_ID_PATTERN,
    [],
    "artifact id must use the closed canonical form",
  );
}

function validateDigest(value: unknown): ValidationIssue | undefined {
  return validateStringPattern(value, DIGEST_PATTERN, [], "digest must be 64 lowercase hex bytes");
}

function validateSourceLocator(value: unknown): ValidationIssue | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOCATOR_LENGTH) {
    return validationIssue([], "source locator is outside the closed resource bounds");
  }
  return SOURCE_LOCATOR_PATTERN.test(value)
    ? undefined
    : validationIssue([], "source locator must use the synthetic canonical form");
}

function validateFindingCode(value: unknown): ValidationIssue | undefined {
  return validateEnumValue(value, FINDING_CODE_SET, [], "finding code is not supported");
}

function validateArtifact(value: unknown): ValidationIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return validationIssue([], "artifact must contain only closed plain data");
  const artifact = recordOf(snapshot.value);
  if (artifact === undefined) return validationIssue([], "artifact must be a closed record");
  const shapeIssue = validateRecordFields(artifact, ARTIFACT_FIELDS);
  if (shapeIssue !== undefined) return shapeIssue;

  const fieldIssues: readonly (ValidationIssue | undefined)[] = [
    prefixedOptional(["id"], validateArtifactId(artifact.id)),
    prefixedOptional(["sourceLocator"], validateSourceLocator(artifact.sourceLocator)),
    prefixedOptional(["contentDigest"], validateDigest(artifact.contentDigest)),
    validateEnumValue(
      artifact.contentDisposition,
      CONTENT_DISPOSITIONS,
      ["contentDisposition"],
      "content disposition is not supported",
    ),
    validateEnumValue(
      artifact.linkDisposition,
      LINK_DISPOSITIONS,
      ["linkDisposition"],
      "link disposition is not supported",
    ),
    validateEnumValue(
      artifact.licenseDisposition,
      LICENSE_DISPOSITIONS,
      ["licenseDisposition"],
      "license disposition is not supported",
    ),
    prefixedOptional(["evidenceDigest"], validateDigest(artifact.evidenceDigest)),
  ];
  for (const issue of fieldIssues) if (issue !== undefined) return issue;

  const dependenciesIssue = validateArray(
    artifact.dependencies,
    0,
    MAX_DEPENDENCIES_PER_ARTIFACT,
    ["dependencies"],
    validateArtifactId,
  );
  if (dependenciesIssue !== undefined) return dependenciesIssue;
  const dependencies = artifact.dependencies as unknown[];
  if (new Set(dependencies).size !== dependencies.length) {
    return validationIssue(["dependencies"], "synthetic artifact dependencies must be unique");
  }
  return undefined;
}

function validateEvidence(value: unknown): ValidationIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return validationIssue([], "evidence must contain only closed plain data");
  const evidence = recordOf(snapshot.value);
  if (evidence === undefined) return validationIssue([], "evidence must be a closed record");
  const shapeIssue = validateRecordFields(evidence, EVIDENCE_FIELDS);
  if (shapeIssue !== undefined) return shapeIssue;

  const issues: readonly (ValidationIssue | undefined)[] = [
    prefixedOptional(["artifactId"], validateArtifactId(evidence.artifactId)),
    prefixedOptional(["sourceLocator"], validateSourceLocator(evidence.sourceLocator)),
    prefixedOptional(["contentDigest"], validateDigest(evidence.contentDigest)),
    validateEnumValue(
      evidence.licenseDisposition,
      LICENSE_DISPOSITIONS,
      ["licenseDisposition"],
      "license disposition is not supported",
    ),
    prefixedOptional(["evidenceDigest"], validateDigest(evidence.evidenceDigest)),
  ];
  return issues.find((issue) => issue !== undefined);
}

function validateFinding(value: unknown): ValidationIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return validationIssue([], "finding must contain only closed plain data");
  const finding = recordOf(snapshot.value);
  if (finding === undefined) return validationIssue([], "finding must be a closed record");
  const shapeIssue = validateRecordFields(finding, FINDING_REQUIRED_FIELDS, ["artifactId"]);
  if (shapeIssue !== undefined) return shapeIssue;
  const codeIssue = prefixedOptional(["code"], validateFindingCode(finding.code));
  if (codeIssue !== undefined) return codeIssue;
  if (Object.hasOwn(finding, "artifactId")) {
    const artifactIssue = prefixedOptional(["artifactId"], validateArtifactId(finding.artifactId));
    if (artifactIssue !== undefined) return artifactIssue;
  }
  const code = finding.code as (typeof FINDING_CODES)[number];
  const hasArtifactId = Object.hasOwn(finding, "artifactId");
  if (GLOBAL_FINDING_CODES.has(code) === hasArtifactId) {
    return validationIssue(
      ["artifactId"],
      "synthetic finding attribution must match its fixed finding code",
    );
  }
  return undefined;
}

function validateClassifierInput(value: unknown): ValidationIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok)
    return validationIssue([], "classifier input must contain only closed plain data");
  const input = recordOf(snapshot.value);
  if (input === undefined) return validationIssue([], "classifier input must be a closed record");
  const shapeIssue = validateRecordFields(input, INPUT_FIELDS);
  if (shapeIssue !== undefined) return shapeIssue;
  if (input.schemaVersion !== 1) {
    return validationIssue(["schemaVersion"], "classifier schema version is not supported");
  }
  return (
    validateArray(
      input.requested,
      1,
      MAX_REQUESTED_COMPONENTS,
      ["requested"],
      validateArtifactId,
    ) ??
    validateArray(
      input.declaredClosure,
      1,
      MAX_ARTIFACTS,
      ["declaredClosure"],
      validateArtifactId,
    ) ??
    validateArray(input.artifacts, 1, MAX_ARTIFACTS, ["artifacts"], validateArtifact) ??
    validateArray(input.evidence, 0, MAX_ARTIFACTS, ["evidence"], validateEvidence)
  );
}

function validateClassificationResult(value: unknown): ValidationIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return validationIssue([], "result must contain only closed plain data");
  const result = recordOf(snapshot.value);
  if (result === undefined) return validationIssue([], "result must be a closed record");
  const shapeIssue = validateRecordFields(result, RESULT_FIELDS);
  if (shapeIssue !== undefined) return shapeIssue;
  if (result.schemaVersion !== 1) {
    return validationIssue(["schemaVersion"], "result schema version is not supported");
  }
  const dispositionIssue = validateEnumValue(
    result.disposition,
    RESULT_DISPOSITIONS,
    ["disposition"],
    "result disposition is not supported",
  );
  if (dispositionIssue !== undefined) return dispositionIssue;
  const collectionIssue =
    validateArray(result.closure, 0, MAX_ARTIFACTS, ["closure"], validateArtifactId) ??
    validateArray(result.eligible, 0, MAX_ARTIFACTS, ["eligible"], validateArtifactId) ??
    validateArray(result.findings, 0, MAX_FINDINGS, ["findings"], validateFinding);
  if (collectionIssue !== undefined) return collectionIssue;

  const closure = result.closure as string[];
  const eligible = result.eligible as string[];
  const findings = result.findings as SyntheticFindingRecord[];
  if (!isCanonicalUnique(closure)) {
    return validationIssue(["closure"], "synthetic closure ids must be canonical and unique");
  }
  if (!isCanonicalUnique(eligible)) {
    return validationIssue(["eligible"], "eligible ids must be canonical and unique");
  }
  const findingKeys = findings.map((finding) => `${finding.code}\u0000${finding.artifactId ?? ""}`);
  if (!isCanonicalUnique(findingKeys)) {
    return validationIssue(["findings"], "findings must be canonical and unique");
  }
  const hasFindingsLimit = findings.some(
    (finding) => finding.code === "METHODOLOGY_FINDINGS_LIMIT",
  );
  if (
    hasFindingsLimit &&
    (findings.length !== 1 || findings[0]?.code !== "METHODOLOGY_FINDINGS_LIMIT")
  ) {
    return validationIssue(["findings"], "the findings-limit denial must be the sole finding");
  }
  if (
    (result.disposition === "eligible" &&
      (closure.length === 0 || findings.length !== 0 || !sameStrings(eligible, closure))) ||
    (result.disposition === "ineligible" && (findings.length === 0 || eligible.length !== 0))
  ) {
    return validationIssue(
      ["disposition"],
      "eligibility result must bind disposition, closure, eligible ids, and findings",
    );
  }
  return undefined;
}

function prefixedOptional(
  prefix: ValidationPath,
  issue: ValidationIssue | undefined,
): ValidationIssue | undefined {
  return issue === undefined ? undefined : prefixedIssue(prefix, issue);
}

class ClosedSchemaError extends Error {
  declare readonly issues: readonly ValidationIssue[];

  constructor(issue: ValidationIssue) {
    super(issue.message);
    Object.defineProperty(this, "name", { value: "ClosedSchemaError" });
    Object.defineProperty(this, "issues", { enumerable: true, value: Object.freeze([issue]) });
  }
}

function closedPublicSchema<T extends z.ZodType>(
  schema: T,
  validate: (value: unknown) => ValidationIssue | undefined,
): T {
  const originalSafeParse = schema.safeParse.bind(schema);
  const originalSafeParseAsync = schema.safeParseAsync.bind(schema);
  const originalParse = schema.parse.bind(schema);
  const originalParseAsync = schema.parseAsync.bind(schema);
  const guardedSafeParse = (
    ...parameters: Parameters<T["safeParse"]>
  ): ReturnType<T["safeParse"]> => {
    const issue = validate(parameters[0]);
    return issue === undefined
      ? (Reflect.apply(originalSafeParse, schema, parameters) as ReturnType<T["safeParse"]>)
      : (closedRecord({
          success: false as const,
          error: new ClosedSchemaError(issue),
        }) as ReturnType<T["safeParse"]>);
  };
  const guardedParse = (...parameters: Parameters<T["parse"]>): ReturnType<T["parse"]> => {
    const issue = validate(parameters[0]);
    if (issue !== undefined) throw new ClosedSchemaError(issue);
    return Reflect.apply(originalParse, schema, parameters) as ReturnType<T["parse"]>;
  };
  const guardedSafeParseAsync = async (
    ...parameters: Parameters<T["safeParseAsync"]>
  ): Promise<Awaited<ReturnType<T["safeParseAsync"]>>> => {
    const issue = validate(parameters[0]);
    return issue === undefined
      ? (Reflect.apply(originalSafeParseAsync, schema, parameters) as Awaited<
          ReturnType<T["safeParseAsync"]>
        >)
      : (closedRecord({ success: false as const, error: new ClosedSchemaError(issue) }) as Awaited<
          ReturnType<T["safeParseAsync"]>
        >);
  };
  const guardedParseAsync = async (
    ...parameters: Parameters<T["parseAsync"]>
  ): Promise<Awaited<ReturnType<T["parseAsync"]>>> => {
    const issue = validate(parameters[0]);
    if (issue !== undefined) throw new ClosedSchemaError(issue);
    return Reflect.apply(originalParseAsync, schema, parameters) as Awaited<
      ReturnType<T["parseAsync"]>
    >;
  };
  Object.defineProperties(schema, {
    decode: { configurable: true, value: guardedParse },
    decodeAsync: { configurable: true, value: guardedParseAsync },
    parse: { configurable: true, value: guardedParse },
    parseAsync: { configurable: true, value: guardedParseAsync },
    safeDecode: { configurable: true, value: guardedSafeParse },
    safeDecodeAsync: { configurable: true, value: guardedSafeParseAsync },
    safeParse: { configurable: true, value: guardedSafeParse },
    safeParseAsync: { configurable: true, value: guardedSafeParseAsync },
    spa: { configurable: true, value: guardedSafeParseAsync },
  });
  return schema;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalUnique(values: readonly string[]): boolean {
  return values.every((value, index) => {
    if (index === 0) return true;
    const previous = values[index - 1];
    return previous !== undefined && previous < value;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findingArtifactId(finding: z.infer<typeof SyntheticFindingSchema>): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(finding, "artifactId");
  return descriptor !== undefined && "value" in descriptor
    ? (descriptor.value as string | undefined)
    : undefined;
}

function findingKey(finding: z.infer<typeof SyntheticFindingSchema>): string {
  return `${finding.code}\u0000${findingArtifactId(finding) ?? ""}`;
}

const SyntheticClassificationResultTupleSchema = z
  .tuple([
    z.literal(1),
    z.enum(["eligible", "ineligible"]),
    z.array(ArtifactIdSchema).max(MAX_ARTIFACTS),
    z.array(ArtifactIdSchema).max(MAX_ARTIFACTS),
    z.array(SyntheticFindingSchema).max(MAX_FINDINGS),
  ])
  .transform(([schemaVersion, disposition, closure, eligible, findings]) =>
    closedRecord({ schemaVersion, disposition, closure, eligible, findings }),
  );

export const SyntheticClassificationResultSchema = closedPublicSchema(
  z.preprocess(
    (value) => recordTuple(value, resultCollectionsAreBounded, RESULT_FIELDS),
    SyntheticClassificationResultTupleSchema,
  ),
  validateClassificationResult,
);

type Artifact = z.infer<typeof SyntheticArtifactSchema>;
type Evidence = z.infer<typeof SyntheticEvidenceSchema>;
type Finding = z.infer<typeof SyntheticFindingSchema>;

class Findings {
  private readonly values = new Map<string, Finding>();

  add(code: z.infer<typeof SyntheticFindingCodeSchema>, artifactId?: string): void {
    const finding = artifactId === undefined ? { code } : { code, artifactId };
    this.values.set(findingKey(finding), finding);
  }

  sorted(): Finding[] {
    return [...this.values.values()].sort((left, right) =>
      compareCodeUnits(findingKey(left), findingKey(right)),
    );
  }
}

function sortedArtifacts(artifacts: readonly Artifact[]): Artifact[] {
  return [...artifacts].sort((left, right) =>
    compareCodeUnits(canonicalArtifactKey(left), canonicalArtifactKey(right)),
  );
}

function sortedEvidence(evidence: readonly Evidence[]): Evidence[] {
  return [...evidence].sort((left, right) =>
    compareCodeUnits(canonicalEvidenceKey(left), canonicalEvidenceKey(right)),
  );
}

function canonicalKey(parts: readonly string[]): string {
  let key = "";
  for (const part of parts) key += `${part.length}:${part};`;
  return key;
}

function canonicalArtifactKey(artifact: Artifact): string {
  return canonicalKey([
    artifact.id,
    artifact.sourceLocator,
    artifact.contentDigest,
    artifact.contentDisposition,
    artifact.linkDisposition,
    artifact.licenseDisposition,
    artifact.evidenceDigest,
    ...[...artifact.dependencies].sort(compareCodeUnits),
  ]);
}

function canonicalEvidenceKey(evidence: Evidence): string {
  return canonicalKey([
    evidence.artifactId,
    evidence.sourceLocator,
    evidence.contentDigest,
    evidence.licenseDisposition,
    evidence.evidenceDigest,
  ]);
}

function canonicalUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function exactEvidenceBinding(artifact: Artifact, evidence: Evidence): boolean {
  return (
    artifact.sourceLocator === evidence.sourceLocator &&
    artifact.contentDigest === evidence.contentDigest &&
    artifact.licenseDisposition === evidence.licenseDisposition &&
    artifact.evidenceDigest === evidence.evidenceDigest
  );
}

/**
 * Classifies caller-supplied synthetic records only. This is deliberately pure
 * in-memory Phase 2 code: it does not read a provider checkout or invoke a host.
 */
export function classifySyntheticProjection(
  value: unknown,
): z.infer<typeof SyntheticClassificationResultSchema> {
  const input = SyntheticClassifierInputSchema.parse(value);
  const findings = new Findings();
  const artifactsById = new Map<string, Artifact>();
  const artifactByLocator = new Map<string, Artifact>();

  for (const artifact of sortedArtifacts(input.artifacts)) {
    if (artifactsById.has(artifact.id)) {
      findings.add("METHODOLOGY_ARTIFACT_DUPLICATE", artifact.id);
      continue;
    }
    artifactsById.set(artifact.id, artifact);
    if (artifactByLocator.has(artifact.sourceLocator)) {
      findings.add(
        "METHODOLOGY_LOCATOR_DUPLICATE",
        artifact.sourceLocator.replace("synthetic:", ""),
      );
    } else {
      artifactByLocator.set(artifact.sourceLocator, artifact);
    }
  }

  const requested = canonicalUnique(input.requested);
  if (requested.length !== input.requested.length) {
    findings.add("METHODOLOGY_REQUEST_DUPLICATE");
  }

  const closure = new Set<string>();
  const state = new Map<string, "visiting" | "complete">();
  type Frame = { id: string; complete: boolean };
  const stack: Frame[] = [];

  for (const root of requested) {
    stack.push({ id: root, complete: false });
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) continue;
      const current = artifactsById.get(frame.id);
      if (current === undefined) {
        findings.add("METHODOLOGY_DEPENDENCY_MISSING", frame.id);
        continue;
      }
      if (frame.complete) {
        state.set(frame.id, "complete");
        closure.add(frame.id);
        continue;
      }
      const currentState = state.get(frame.id);
      if (currentState === "complete") continue;
      if (currentState === "visiting") {
        findings.add("METHODOLOGY_DEPENDENCY_CYCLE", frame.id);
        continue;
      }
      state.set(frame.id, "visiting");
      closure.add(frame.id);
      stack.push({ id: frame.id, complete: true });
      for (const dependency of [...current.dependencies].sort(compareCodeUnits).reverse()) {
        if (state.get(dependency) === "visiting") {
          findings.add("METHODOLOGY_DEPENDENCY_CYCLE", dependency);
        } else {
          stack.push({ id: dependency, complete: false });
        }
      }
    }
  }

  const canonicalClosure = [...closure].sort(compareCodeUnits);
  const declaredClosure = canonicalUnique(input.declaredClosure);
  if (
    declaredClosure.length !== input.declaredClosure.length ||
    !sameStrings(canonicalClosure, declaredClosure)
  ) {
    findings.add("METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE");
  }

  const evidenceByArtifact = new Map<string, Evidence>();
  for (const evidence of sortedEvidence(input.evidence)) {
    if (!artifactsById.has(evidence.artifactId)) {
      findings.add("METHODOLOGY_EVIDENCE_UNBOUND", evidence.artifactId);
      continue;
    }
    if (evidenceByArtifact.has(evidence.artifactId)) {
      findings.add("METHODOLOGY_EVIDENCE_CONFLICT", evidence.artifactId);
      continue;
    }
    evidenceByArtifact.set(evidence.artifactId, evidence);
  }

  for (const id of canonicalClosure) {
    const artifact = artifactsById.get(id);
    if (artifact === undefined) continue;
    if (artifact.contentDisposition === "executable") {
      findings.add("METHODOLOGY_CONTENT_EXECUTABLE", id);
    }
    if (artifact.contentDisposition === "ambiguous") {
      findings.add("METHODOLOGY_CONTENT_AMBIGUOUS", id);
    }
    if (artifact.linkDisposition !== "none") {
      findings.add("METHODOLOGY_CONTENT_LINKED", id);
    }
    if (artifact.licenseDisposition !== "permissive") {
      findings.add("METHODOLOGY_LICENSE_UNAPPROVED", id);
    }
    const evidence = evidenceByArtifact.get(id);
    if (evidence === undefined) {
      findings.add("METHODOLOGY_EVIDENCE_MISSING", id);
    } else if (!exactEvidenceBinding(artifact, evidence)) {
      findings.add("METHODOLOGY_EVIDENCE_DRIFT", id);
    }
  }

  const sortedFindings = findings.sorted();
  const resultFindings: Finding[] =
    sortedFindings.length > MAX_FINDINGS
      ? [{ code: "METHODOLOGY_FINDINGS_LIMIT" }]
      : sortedFindings;
  return SyntheticClassificationResultSchema.parse({
    schemaVersion: 1,
    disposition: resultFindings.length === 0 ? "eligible" : "ineligible",
    closure: canonicalClosure,
    eligible: resultFindings.length === 0 ? canonicalClosure : [],
    findings: resultFindings,
  });
}
