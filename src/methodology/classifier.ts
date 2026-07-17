import { isProxy } from "node:util/types";

const INTRINSIC_APPLY = Reflect.apply;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const MAP_FOR_EACH = Map.prototype.forEach;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const SET_FOR_EACH = Set.prototype.forEach;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const REGEXP_TEST = RegExp.prototype.test;

function callIntrinsic<T>(
  intrinsic: CallableFunction,
  receiver: unknown,
  argumentsList: readonly unknown[],
): T {
  return INTRINSIC_APPLY(intrinsic, receiver, argumentsList) as T;
}

function mapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  return callIntrinsic<V | undefined>(MAP_GET, map, [key]);
}

function mapHas<K, V>(map: Map<K, V>, key: K): boolean {
  return callIntrinsic<boolean>(MAP_HAS, map, [key]);
}

function mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  callIntrinsic<Map<K, V>>(MAP_SET, map, [key, value]);
}

function mapForEach<K, V>(map: Map<K, V>, callback: (value: V, key: K) => void): void {
  callIntrinsic<void>(MAP_FOR_EACH, map, [callback]);
}

function setAdd<T>(set: Set<T>, value: T): void {
  callIntrinsic<Set<T>>(SET_ADD, set, [value]);
}

function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  return callIntrinsic<boolean>(SET_HAS, set, [value]);
}

function setForEach<T>(set: Set<T>, callback: (value: T) => void): void {
  callIntrinsic<void>(SET_FOR_EACH, set, [callback]);
}

function weakSetAdd<T extends WeakKey>(set: WeakSet<T>, value: T): void {
  callIntrinsic<WeakSet<T>>(WEAK_SET_ADD, set, [value]);
}

function weakSetDelete<T extends WeakKey>(set: WeakSet<T>, value: T): void {
  callIntrinsic<boolean>(WEAK_SET_DELETE, set, [value]);
}

function weakSetHas<T extends WeakKey>(set: WeakSet<T>, value: T): boolean {
  return callIntrinsic<boolean>(WEAK_SET_HAS, set, [value]);
}

function regexpTest(pattern: RegExp, value: string): boolean {
  return callIntrinsic<boolean>(REGEXP_TEST, pattern, [value]);
}

const MAX_REQUESTED_COMPONENTS = 32;
const MAX_ARTIFACTS = 64;
const MAX_DEPENDENCIES_PER_ARTIFACT = 32;
const MAX_LOCATOR_LENGTH = 512;
const MAX_FINDINGS = 256;
const MAX_SNAPSHOT_ARRAY_LENGTH = MAX_FINDINGS + 1;
const MAX_SNAPSHOT_RECORD_KEYS = 16;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 512;

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

export type SyntheticFindingCode = (typeof FINDING_CODES)[number];

const GLOBAL_FINDING_CODES = setOf<SyntheticFindingCode>([
  "METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE",
  "METHODOLOGY_FINDINGS_LIMIT",
  "METHODOLOGY_REQUEST_DUPLICATE",
]);
const FINDING_REQUIRED_FIELDS = ["code"] as const;
export type SyntheticFinding = {
  code: SyntheticFindingCode;
  artifactId?: string;
};

type SyntheticFindingRecord = SyntheticFinding;

export type SyntheticArtifact = {
  id: string;
  sourceLocator: string;
  contentDigest: string;
  contentDisposition: "inert" | "executable" | "ambiguous";
  linkDisposition: "none" | "symbolic" | "hard" | "reparse";
  licenseDisposition: "permissive" | "unknown" | "restricted";
  evidenceDigest: string;
  dependencies: string[];
};

export type SyntheticEvidence = {
  artifactId: string;
  sourceLocator: string;
  contentDigest: string;
  licenseDisposition: "permissive" | "unknown" | "restricted";
  evidenceDigest: string;
};

export type SyntheticClassifierInput = {
  schemaVersion: 1;
  requested: string[];
  declaredClosure: string[];
  artifacts: SyntheticArtifact[];
  evidence: SyntheticEvidence[];
};

export type SyntheticClassificationResult = {
  schemaVersion: 1;
  disposition: "eligible" | "ineligible";
  closure: string[];
  eligible: string[];
  findings: SyntheticFinding[];
};

export const SyntheticArtifactSchema = closedPublicSchema<SyntheticArtifact>(validateArtifact);
export const SyntheticEvidenceSchema = closedPublicSchema<SyntheticEvidence>(validateEvidence);
export const SyntheticClassifierInputSchema =
  closedPublicSchema<SyntheticClassifierInput>(validateClassifierInput);
export const SyntheticFindingCodeSchema =
  closedPublicSchema<SyntheticFindingCode>(validateFindingCode);
export const SyntheticFindingSchema = closedPublicSchema<SyntheticFinding>(validateFinding);
export const SyntheticClassificationResultSchema =
  closedPublicSchema<SyntheticClassificationResult>(validateClassificationResult);

type SnapshotResult = { ok: true; value: unknown } | { ok: false };
type SnapshotState = { nodes: number; active: WeakSet<object> };

const INVALID_SNAPSHOT = Object.freeze({ ok: false as const });

function appendOwn<T>(values: T[], value: T): void {
  Object.defineProperty(values, String(values.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function setOf<T>(values: readonly T[]): Set<T> {
  const result = new Set<T>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined) setAdd(result, value);
  }
  return result;
}

function copyOwnValues<T>(values: readonly T[]): T[] {
  const copy: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined) appendOwn(copy, value);
  }
  return copy;
}

function concatOwnValues<T>(left: readonly T[], right: readonly T[]): T[] {
  const combined = copyOwnValues(left);
  for (let index = 0; index < right.length; index += 1) {
    const value = right[index];
    if (value !== undefined) appendOwn(combined, value);
  }
  return combined;
}

function ownKeysAreStrings(keys: readonly PropertyKey[]): keys is string[] {
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== "string") return false;
  }
  return true;
}

function popOwn<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const index = values.length - 1;
  const value = values[index];
  delete values[index];
  values.length = index;
  return value;
}

function sortOwnedValues<T>(values: T[], compare: (left: T, right: T) => number): T[] {
  for (let index = 1; index < values.length; index += 1) {
    const candidate = values[index];
    if (candidate === undefined) continue;
    let target = index;
    while (target > 0) {
      const previous = values[target - 1];
      if (previous === undefined || compare(previous, candidate) <= 0) break;
      values[target] = previous;
      target -= 1;
    }
    values[target] = candidate;
  }
  return values;
}

function sortedArrayCopy<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return sortOwnedValues(copyOwnValues(values), compare);
}

function sortedMapValuesCopy<K, V>(values: Map<K, V>, compare: (left: V, right: V) => number): V[] {
  const copy: V[] = [];
  mapForEach(values, (value) => appendOwn(copy, value));
  return sortOwnedValues(copy, compare);
}

function sortedSetValuesCopy<T>(values: Set<T>, compare: (left: T, right: T) => number): T[] {
  const copy: T[] = [];
  setForEach(values, (value) => appendOwn(copy, value));
  return sortOwnedValues(copy, compare);
}

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
    if (keys.length !== length + 1 || !ownKeysAreStrings(keys)) {
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
  if (keys.length > MAX_SNAPSHOT_RECORD_KEYS || !ownKeysAreStrings(keys)) {
    return INVALID_SNAPSHOT;
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) return INVALID_SNAPSHOT;
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
  if (weakSetHas(state.active, value)) return INVALID_SNAPSHOT;
  state.nodes += 1;
  weakSetAdd(state.active, value);
  try {
    if (Array.isArray(surface.value)) {
      const snapshot: unknown[] = [];
      for (let index = 0; index < surface.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(surface.value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) return INVALID_SNAPSHOT;
        const child = snapshotPlainData(descriptor.value, depth + 1, state);
        if (!child.ok) return INVALID_SNAPSHOT;
        appendOwn(snapshot, child.value);
      }
      return { ok: true, value: snapshot };
    }
    const record = recordOf(surface.value);
    if (record === undefined) return INVALID_SNAPSHOT;
    const snapshot = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) return INVALID_SNAPSHOT;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) return INVALID_SNAPSHOT;
      const child = snapshotPlainData(descriptor.value, depth + 1, state);
      if (!child.ok) return INVALID_SNAPSHOT;
      snapshot[key] = child.value;
    }
    return { ok: true, value: snapshot };
  } finally {
    weakSetDelete(state.active, value);
  }
}

function staticRecordOf(value: unknown): Record<string, unknown> | undefined {
  const surface = snapshotSurface(value);
  return surface.ok ? recordOf(surface.value) : undefined;
}

function closedRecord<T extends Record<string, unknown>>(value: T): T {
  const record = Object.create(null) as T;
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return record;
}

type ValidationPath = readonly (string | number)[];
type ValidationIssue = {
  readonly code: "custom";
  readonly path: ValidationPath;
  readonly message: string;
};

export type ClosedSchemaIssue = ValidationIssue;

export type ClosedSchemaResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: ClosedSchemaError };

export interface ClosedSchema<T> {
  decode(value: unknown): T;
  decodeAsync(value: unknown): Promise<T>;
  parse(value: unknown): T;
  parseAsync(value: unknown): Promise<T>;
  safeDecode(value: unknown): ClosedSchemaResult<T>;
  safeDecodeAsync(value: unknown): Promise<ClosedSchemaResult<T>>;
  safeParse(value: unknown): ClosedSchemaResult<T>;
  safeParseAsync(value: unknown): Promise<ClosedSchemaResult<T>>;
  spa(value: unknown): Promise<ClosedSchemaResult<T>>;
}

const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_LOCATOR_PATTERN = /^synthetic:[a-z][a-z0-9-]{0,63}$/;
const CONTENT_DISPOSITIONS = setOf(["inert", "executable", "ambiguous"]);
const LINK_DISPOSITIONS = setOf(["none", "symbolic", "hard", "reparse"]);
const LICENSE_DISPOSITIONS = setOf(["permissive", "unknown", "restricted"]);
const RESULT_DISPOSITIONS = setOf(["eligible", "ineligible"]);
const FINDING_CODE_SET = setOf<string>(FINDING_CODES);

function validationIssue(path: ValidationPath, message: string): ValidationIssue {
  return closedRecord({ code: "custom" as const, path: copyOwnValues(path), message });
}

function prefixedIssue(prefix: ValidationPath, issue: ValidationIssue): ValidationIssue {
  return validationIssue(concatOwnValues(prefix, issue.path), issue.message);
}

type CollectionBound = {
  readonly field: string;
  readonly maximum: number;
};

function preflightRecordCollections(
  value: unknown,
  bounds: readonly CollectionBound[],
): ValidationIssue | undefined {
  const surface = snapshotSurface(value);
  if (!surface.ok) return undefined;
  const record = recordOf(surface.value);
  if (record === undefined) return undefined;
  for (let index = 0; index < bounds.length; index += 1) {
    const bound = bounds[index];
    if (bound === undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(record, bound.field);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const collection = descriptor.value;
    if (isProxy(collection)) {
      return validationIssue([bound.field], "collection must not be a proxy");
    }
    if (!Array.isArray(collection)) continue;
    if (
      Object.getPrototypeOf(collection) !== Array.prototype ||
      collection.length > bound.maximum
    ) {
      return validationIssue([bound.field], "array is outside the closed resource bounds");
    }
  }
  return undefined;
}

function preflightClassifierCollections(value: unknown): ValidationIssue | undefined {
  const rootIssue = preflightRecordCollections(value, [
    { field: "requested", maximum: MAX_REQUESTED_COMPONENTS },
    { field: "declaredClosure", maximum: MAX_ARTIFACTS },
    { field: "artifacts", maximum: MAX_ARTIFACTS },
    { field: "evidence", maximum: MAX_ARTIFACTS },
  ]);
  if (rootIssue !== undefined) return rootIssue;
  const input = staticRecordOf(value);
  const descriptor =
    input === undefined ? undefined : Object.getOwnPropertyDescriptor(input, "artifacts");
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const artifacts = descriptor.value;
  if (
    isProxy(artifacts) ||
    !Array.isArray(artifacts) ||
    Object.getPrototypeOf(artifacts) !== Array.prototype ||
    artifacts.length > MAX_ARTIFACTS
  ) {
    return undefined;
  }
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = Object.getOwnPropertyDescriptor(artifacts, String(index));
    if (artifact === undefined || !("value" in artifact)) continue;
    const artifactIssue = preflightRecordCollections(artifact.value, [
      { field: "dependencies", maximum: MAX_DEPENDENCIES_PER_ARTIFACT },
    ]);
    if (artifactIssue !== undefined) return prefixedIssue(["artifacts", index], artifactIssue);
  }
  return undefined;
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
  const permitted = new Set<string>();
  for (let index = 0; index < required.length; index += 1) {
    const field = required[index];
    if (field !== undefined) setAdd(permitted, field);
  }
  for (let index = 0; index < optional.length; index += 1) {
    const field = optional[index];
    if (field !== undefined) setAdd(permitted, field);
  }
  const keys = Object.keys(record);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (!setHas(permitted, key)) return validationIssue([key], "unknown field is not permitted");
  }
  for (let index = 0; index < required.length; index += 1) {
    const field = required[index];
    if (field === undefined) continue;
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
  return typeof value === "string" && regexpTest(pattern, value)
    ? undefined
    : validationIssue(path, message);
}

function validateEnumValue(
  value: unknown,
  permitted: ReadonlySet<string>,
  path: ValidationPath,
  message: string,
): ValidationIssue | undefined {
  return typeof value === "string" && setHas(permitted, value)
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
    if (childIssue !== undefined) {
      const childPath = copyOwnValues(path);
      appendOwn(childPath, index);
      return prefixedIssue(childPath, childIssue);
    }
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
  return regexpTest(SOURCE_LOCATOR_PATTERN, value)
    ? undefined
    : validationIssue([], "source locator must use the synthetic canonical form");
}

function validateFindingCode(value: unknown): ValidationIssue | undefined {
  return validateEnumValue(value, FINDING_CODE_SET, [], "finding code is not supported");
}

function validateArtifact(value: unknown): ValidationIssue | undefined {
  const preflightIssue = preflightRecordCollections(value, [
    { field: "dependencies", maximum: MAX_DEPENDENCIES_PER_ARTIFACT },
  ]);
  if (preflightIssue !== undefined) return preflightIssue;
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
  for (let index = 0; index < fieldIssues.length; index += 1) {
    const issue = fieldIssues[index];
    if (issue !== undefined) return issue;
  }

  const dependenciesIssue = validateArray(
    artifact.dependencies,
    0,
    MAX_DEPENDENCIES_PER_ARTIFACT,
    ["dependencies"],
    validateArtifactId,
  );
  if (dependenciesIssue !== undefined) return dependenciesIssue;
  const dependencies = artifact.dependencies as unknown[];
  const uniqueDependencies = new Set<unknown>();
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    if (setHas(uniqueDependencies, dependency)) {
      return validationIssue(["dependencies"], "synthetic artifact dependencies must be unique");
    }
    setAdd(uniqueDependencies, dependency);
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
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    if (issue !== undefined) return issue;
  }
  return undefined;
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
  if (setHas(GLOBAL_FINDING_CODES, code) === hasArtifactId) {
    return validationIssue(
      ["artifactId"],
      "synthetic finding attribution must match its fixed finding code",
    );
  }
  return undefined;
}

function validateClassifierInput(value: unknown): ValidationIssue | undefined {
  const preflightIssue = preflightClassifierCollections(value);
  if (preflightIssue !== undefined) return preflightIssue;
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
  const preflightIssue = preflightRecordCollections(value, [
    { field: "closure", maximum: MAX_ARTIFACTS },
    { field: "eligible", maximum: MAX_ARTIFACTS },
    { field: "findings", maximum: MAX_FINDINGS },
  ]);
  if (preflightIssue !== undefined) return preflightIssue;
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
  const findingKeys: string[] = [];
  let hasFindingsLimit = false;
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (finding === undefined) continue;
    appendOwn(findingKeys, `${finding.code}\u0000${finding.artifactId ?? ""}`);
    if (finding.code === "METHODOLOGY_FINDINGS_LIMIT") hasFindingsLimit = true;
  }
  if (!isCanonicalUnique(findingKeys)) {
    return validationIssue(["findings"], "findings must be canonical and unique");
  }
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

export class ClosedSchemaError extends Error {
  declare readonly issues: readonly ValidationIssue[];

  constructor(issue: ValidationIssue) {
    super(issue.message);
    Object.defineProperty(this, "name", { value: "ClosedSchemaError" });
    Object.defineProperty(this, "issues", { enumerable: true, value: Object.freeze([issue]) });
  }
}

function closedPublicSchema<T>(
  validate: (value: unknown) => ValidationIssue | undefined,
): ClosedSchema<T> {
  const guardedSafeParse = (value: unknown): ClosedSchemaResult<T> => {
    const issue = validate(value);
    if (issue !== undefined) {
      return closedRecord({ success: false as const, error: new ClosedSchemaError(issue) });
    }
    const snapshot = validationSnapshot(value);
    if (!snapshot.ok) {
      return closedRecord({
        success: false as const,
        error: new ClosedSchemaError(
          validationIssue([], "closed schema could not project manually validated input"),
        ),
      });
    }
    return closedRecord({ success: true as const, data: snapshot.value as T });
  };
  const guardedParse = (value: unknown): T => {
    const result = guardedSafeParse(value);
    if (!result.success) throw result.error;
    return result.data;
  };
  const guardedSafeParseAsync = (value: unknown): Promise<ClosedSchemaResult<T>> => {
    return Promise.resolve(guardedSafeParse(value));
  };
  const guardedParseAsync = (value: unknown): Promise<T> => {
    try {
      return Promise.resolve(guardedParse(value));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return Object.freeze(
    closedRecord({
      decode: guardedParse,
      decodeAsync: guardedParseAsync,
      parse: guardedParse,
      parseAsync: guardedParseAsync,
      safeDecode: guardedSafeParse,
      safeDecodeAsync: guardedSafeParseAsync,
      safeParse: guardedSafeParse,
      safeParseAsync: guardedSafeParseAsync,
      spa: guardedSafeParseAsync,
    }),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    const previous = values[index - 1];
    if (value === undefined || previous === undefined || previous >= value) return false;
  }
  return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function findingArtifactId(finding: SyntheticFindingRecord): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(finding, "artifactId");
  return descriptor !== undefined && "value" in descriptor
    ? (descriptor.value as string | undefined)
    : undefined;
}

function findingKey(finding: SyntheticFindingRecord): string {
  return `${finding.code}\u0000${findingArtifactId(finding) ?? ""}`;
}

type Artifact = SyntheticArtifact;
type Evidence = SyntheticEvidence;
type Finding = SyntheticFinding;

class Findings {
  private readonly values = new Map<string, Finding>();

  add(code: SyntheticFindingCode, artifactId?: string): void {
    const finding = artifactId === undefined ? { code } : { code, artifactId };
    mapSet(this.values, findingKey(finding), finding);
  }

  sorted(): Finding[] {
    return sortedMapValuesCopy(this.values, (left, right) =>
      compareCodeUnits(findingKey(left), findingKey(right)),
    );
  }
}

function sortedArtifacts(artifacts: readonly Artifact[]): Artifact[] {
  return sortedArrayCopy(artifacts, (left, right) =>
    compareCodeUnits(canonicalArtifactKey(left), canonicalArtifactKey(right)),
  );
}

function sortedEvidence(evidence: readonly Evidence[]): Evidence[] {
  return sortedArrayCopy(evidence, (left, right) =>
    compareCodeUnits(canonicalEvidenceKey(left), canonicalEvidenceKey(right)),
  );
}

function canonicalKey(parts: readonly string[]): string {
  let key = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part !== undefined) key += `${part.length}:${part};`;
  }
  return key;
}

function canonicalArtifactKey(artifact: Artifact): string {
  const parts = [
    artifact.id,
    artifact.sourceLocator,
    artifact.contentDigest,
    artifact.contentDisposition,
    artifact.linkDisposition,
    artifact.licenseDisposition,
    artifact.evidenceDigest,
  ];
  const dependencies = sortedArrayCopy(artifact.dependencies, compareCodeUnits);
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    if (dependency !== undefined) appendOwn(parts, dependency);
  }
  return canonicalKey(parts);
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
  const sorted = sortedArrayCopy(values, compareCodeUnits);
  const unique: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const value = sorted[index];
    if (value !== undefined && (unique.length === 0 || value !== unique[unique.length - 1])) {
      appendOwn(unique, value);
    }
  }
  return unique;
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
export function classifySyntheticProjection(value: unknown): SyntheticClassificationResult {
  const input = SyntheticClassifierInputSchema.parse(value);
  const findings = new Findings();
  const artifactsById = new Map<string, Artifact>();
  const artifactByLocator = new Map<string, Artifact>();

  const artifacts = sortedArtifacts(input.artifacts);
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (artifact === undefined) continue;
    if (mapHas(artifactsById, artifact.id)) {
      findings.add("METHODOLOGY_ARTIFACT_DUPLICATE", artifact.id);
      continue;
    }
    mapSet(artifactsById, artifact.id, artifact);
    if (mapHas(artifactByLocator, artifact.sourceLocator)) {
      findings.add("METHODOLOGY_LOCATOR_DUPLICATE", artifact.id);
    } else {
      mapSet(artifactByLocator, artifact.sourceLocator, artifact);
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

  for (let rootIndex = 0; rootIndex < requested.length; rootIndex += 1) {
    const root = requested[rootIndex];
    if (root === undefined) continue;
    appendOwn(stack, { id: root, complete: false });
    while (stack.length > 0) {
      const frame = popOwn(stack);
      if (frame === undefined) continue;
      const current = mapGet(artifactsById, frame.id);
      if (current === undefined) {
        findings.add("METHODOLOGY_DEPENDENCY_MISSING", frame.id);
        continue;
      }
      if (frame.complete) {
        mapSet(state, frame.id, "complete");
        setAdd(closure, frame.id);
        continue;
      }
      const currentState = mapGet(state, frame.id);
      if (currentState === "complete") continue;
      if (currentState === "visiting") {
        findings.add("METHODOLOGY_DEPENDENCY_CYCLE", frame.id);
        continue;
      }
      mapSet(state, frame.id, "visiting");
      setAdd(closure, frame.id);
      appendOwn(stack, { id: frame.id, complete: true });
      const dependencies = sortedArrayCopy(current.dependencies, compareCodeUnits);
      for (let index = dependencies.length - 1; index >= 0; index -= 1) {
        const dependency = dependencies[index];
        if (dependency === undefined) continue;
        if (mapGet(state, dependency) === "visiting") {
          findings.add("METHODOLOGY_DEPENDENCY_CYCLE", dependency);
        } else {
          appendOwn(stack, { id: dependency, complete: false });
        }
      }
    }
  }

  const canonicalClosure = sortedSetValuesCopy(closure, compareCodeUnits);
  const declaredClosure = canonicalUnique(input.declaredClosure);
  if (
    declaredClosure.length !== input.declaredClosure.length ||
    !sameStrings(canonicalClosure, declaredClosure)
  ) {
    findings.add("METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE");
  }

  const evidenceByArtifact = new Map<string, Evidence>();
  const evidenceRecords = sortedEvidence(input.evidence);
  for (let index = 0; index < evidenceRecords.length; index += 1) {
    const evidence = evidenceRecords[index];
    if (evidence === undefined) continue;
    if (!mapHas(artifactsById, evidence.artifactId)) {
      findings.add("METHODOLOGY_EVIDENCE_UNBOUND", evidence.artifactId);
      continue;
    }
    if (mapHas(evidenceByArtifact, evidence.artifactId)) {
      findings.add("METHODOLOGY_EVIDENCE_CONFLICT", evidence.artifactId);
      continue;
    }
    mapSet(evidenceByArtifact, evidence.artifactId, evidence);
  }

  for (let index = 0; index < canonicalClosure.length; index += 1) {
    const id = canonicalClosure[index];
    if (id === undefined) continue;
    const artifact = mapGet(artifactsById, id);
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
    const evidence = mapGet(evidenceByArtifact, id);
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
