import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  type ClosedSchema,
  ClosedSchemaError,
  type ClosedSchemaIssue,
  classifySyntheticProjection,
  type SyntheticClassificationResult,
  type SyntheticClassifierInput,
  SyntheticClassifierInputSchema,
} from "./classifier.js";

const INTRINSIC_APPLY = Reflect.apply;
const HASH_PROTOTYPE = Object.getPrototypeOf(createHash("sha256")) as {
  digest: CallableFunction;
  update: CallableFunction;
};
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const HASH_UPDATE = HASH_PROTOTYPE.update;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const REGEXP_TEST = RegExp.prototype.test;
const NUMBER_IS_FINITE = Number.isFinite;
const STRING_CONVERT = String;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_SPLIT = String.prototype.split;
const STRING_STARTS_WITH = String.prototype.startsWith;

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

function hashDigest(hash: ReturnType<typeof createHash>, encoding: "hex"): string {
  return callIntrinsic<string>(HASH_DIGEST, hash, [encoding]);
}

function hashUpdate(hash: ReturnType<typeof createHash>, value: string): void {
  callIntrinsic<ReturnType<typeof createHash>>(HASH_UPDATE, hash, [value]);
}

function mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  callIntrinsic<Map<K, V>>(MAP_SET, map, [key, value]);
}

function setAdd<T>(set: Set<T>, value: T): void {
  callIntrinsic<Set<T>>(SET_ADD, set, [value]);
}

function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  return callIntrinsic<boolean>(SET_HAS, set, [value]);
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

function numberIsFinite(value: number): boolean {
  return NUMBER_IS_FINITE(value);
}

function stringConvert(value: unknown): string {
  return callIntrinsic<string>(STRING_CONVERT, undefined, [value]);
}

function stringCharCodeAt(value: string, index: number): number {
  return callIntrinsic<number>(STRING_CHAR_CODE_AT, value, [index]);
}

function stringEndsWith(value: string, suffix: string): boolean {
  return callIntrinsic<boolean>(STRING_ENDS_WITH, value, [suffix]);
}

function stringSplit(value: string, separator: string): string[] {
  return callIntrinsic<string[]>(STRING_SPLIT, value, [separator]);
}

function stringStartsWith(value: string, prefix: string): boolean {
  return callIntrinsic<boolean>(STRING_STARTS_WITH, value, [prefix]);
}

const DECISION_VERSION = "phase-3-decision-v1";
const CLASSIFIER_VERSION = "phase-2-classifier-v1";
const POLICY_VERSION = "phase-3-policy-v1";
const MANIFEST_VERSION = 1;
const DIGEST_VERSION = 1;
const MAX_ENTRIES = 64;
const MAX_TARGET_LENGTH = 240;
const MAX_SNAPSHOT_ARRAY_LENGTH = MAX_ENTRIES;
const MAX_SNAPSHOT_RECORD_KEYS = 32;
const MAX_SNAPSHOT_DEPTH = 12;
const MAX_SNAPSHOT_NODES = 8192;

type ClassifierInput = SyntheticClassifierInput;
type ClassifierResult = SyntheticClassificationResult;
type Artifact = ClassifierInput["artifacts"][number];
type ProjectionMapping = { artifactId: string; target: string };
type PlannerInput = {
  schemaVersion: 1;
  decisionVersion: typeof DECISION_VERSION;
  classifierVersion: typeof CLASSIFIER_VERSION;
  policyVersion: typeof POLICY_VERSION;
  manifestVersion: typeof MANIFEST_VERSION;
  owner: string;
  classifierInput: ClassifierInput;
  mappings: ProjectionMapping[];
};
type Entry = {
  artifactId: string;
  target: string;
  sourceLocator: string;
  contentDigest: string;
};
type Finding = {
  code:
    | "METHODOLOGY_CLASSIFICATION_INELIGIBLE"
    | "METHODOLOGY_MAPPING_COVERAGE"
    | "METHODOLOGY_TARGET_COLLISION"
    | "METHODOLOGY_TARGET_INVALID";
};
type Decision = {
  decisionVersion: typeof DECISION_VERSION;
  digestVersion: typeof DIGEST_VERSION;
  classifierVersion: typeof CLASSIFIER_VERSION;
  policyVersion: typeof POLICY_VERSION;
  manifestVersion: typeof MANIFEST_VERSION;
  owner: string;
  classifierInput: ClassifierInput;
  closure: string[];
  eligible: string[];
  mappings: ProjectionMapping[];
  entries: Entry[];
};
type Boundary = {
  reads: false;
  writes: false;
  cli: false;
  executor: false;
  providerExecution: false;
  hostExecution: false;
};
type Manifest = {
  schemaVersion: 1;
  digestVersion: typeof DIGEST_VERSION;
  digest: string;
  owner: string;
  entries: Entry[];
  decision: Decision;
};
type ProjectionPlanResult =
  | {
      schemaVersion: 1;
      state: "planned";
      manifest: Manifest;
      boundary: Boundary;
      findings: [];
    }
  | {
      schemaVersion: 1;
      state: "blocked";
      boundary: Boundary;
      findings: [Finding];
    };

export const ProjectionMappingSchema =
  closedPlannerSchema<ProjectionMapping>(validateProjectionMapping);
export const ProjectionPlannerInputSchema = closedPlannerSchema<PlannerInput>(validatePlannerInput);
export const ProjectionDecisionSchema = closedPlannerSchema<Decision>(validateDecision);
export const ProjectionPlanResultSchema =
  closedPlannerSchema<ProjectionPlanResult>(validatePlanResult);

const BOUNDARY = Object.freeze({
  reads: false,
  writes: false,
  cli: false,
  executor: false,
  providerExecution: false,
  hostExecution: false,
});

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type SnapshotState = { depth: number; nodes: number; active: WeakSet<object> };
type SnapshotResult = { ok: true; value: unknown } | { ok: false };

const INVALID_SNAPSHOT = Object.freeze({ ok: false as const });

function appendOwn<T>(values: T[], value: T): void {
  Object.defineProperty(values, stringConvert(values.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
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

function sortOwnedValues<T>(values: T[], compareValues: (left: T, right: T) => number): T[] {
  for (let index = 1; index < values.length; index += 1) {
    const candidate = values[index];
    if (candidate === undefined) continue;
    let target = index;
    while (target > 0) {
      const previous = values[target - 1];
      if (previous === undefined || compareValues(previous, candidate) <= 0) break;
      values[target] = previous;
      target -= 1;
    }
    values[target] = candidate;
  }
  return values;
}

function sortedArrayCopy<T>(
  values: readonly T[],
  compareValues: (left: T, right: T) => number,
): T[] {
  return sortOwnedValues(copyOwnValues(values), compareValues);
}

function ownKeysAreStrings(keys: readonly PropertyKey[]): keys is string[] {
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== "string") return false;
  }
  return true;
}

function arrayContains<T>(values: readonly T[], candidate: T): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === candidate) return true;
  }
  return false;
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
      const descriptor = Object.getOwnPropertyDescriptor(value, stringConvert(index));
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

function snapshotPlainData(value: unknown, state: SnapshotState): SnapshotResult {
  const surface = snapshotSurface(value);
  if (!surface.ok) return INVALID_SNAPSHOT;
  if (value === null || typeof value !== "object") return surface;
  if (state.depth >= MAX_SNAPSHOT_DEPTH || state.nodes >= MAX_SNAPSHOT_NODES) {
    return INVALID_SNAPSHOT;
  }
  if (weakSetHas(state.active, value)) return INVALID_SNAPSHOT;
  weakSetAdd(state.active, value);
  const nextState = { ...state, depth: state.depth + 1, nodes: state.nodes + 1 };
  try {
    if (Array.isArray(surface.value)) {
      const snapshot: unknown[] = [];
      for (let index = 0; index < surface.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(surface.value, stringConvert(index));
        if (descriptor === undefined || !("value" in descriptor)) return INVALID_SNAPSHOT;
        const child = snapshotPlainData(descriptor.value, nextState);
        if (!child.ok) return INVALID_SNAPSHOT;
        appendOwn(snapshot, child.value);
      }
      state.nodes = nextState.nodes;
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
      const child = snapshotPlainData(descriptor.value, nextState);
      if (!child.ok) return INVALID_SNAPSHOT;
      snapshot[key] = child.value;
    }
    state.nodes = nextState.nodes;
    return { ok: true, value: snapshot };
  } finally {
    weakSetDelete(state.active, value);
  }
}

const OWNER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LOCATOR_PATTERN = /^synthetic:[a-z][a-z0-9-]{0,63}$/;
const FINDING_CODES = [
  "METHODOLOGY_CLASSIFICATION_INELIGIBLE",
  "METHODOLOGY_MAPPING_COVERAGE",
  "METHODOLOGY_TARGET_COLLISION",
  "METHODOLOGY_TARGET_INVALID",
] as const;

function plannerIssue(path: readonly (string | number)[], message: string): ClosedSchemaIssue {
  return closedRecord({ code: "custom" as const, path: copyOwnValues(path), message });
}

function prefixedPlannerIssue(
  prefix: readonly (string | number)[],
  issue: ClosedSchemaIssue,
): ClosedSchemaIssue {
  return plannerIssue(concatOwnValues(prefix, issue.path), issue.message);
}

function validationSnapshot(value: unknown): SnapshotResult {
  return snapshotPlainData(value, {
    depth: 0,
    nodes: 0,
    active: new WeakSet<object>(),
  });
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
): { record?: Record<string, unknown>; issue?: ClosedSchemaIssue } {
  const record = recordOf(value);
  if (record === undefined) return { issue: plannerIssue([], "value must be a closed record") };
  const keys = Object.keys(record);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (!arrayContains(fields, key))
      return { issue: plannerIssue([key], "unknown field is not allowed") };
  }
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined) continue;
    if (!Object.hasOwn(record, field)) {
      return { issue: plannerIssue([field], "required field is missing") };
    }
  }
  return { record };
}

function stringIssue(
  value: unknown,
  pattern: RegExp,
  path: readonly (string | number)[],
): ClosedSchemaIssue | undefined {
  return typeof value === "string" && regexpTest(pattern, value)
    ? undefined
    : plannerIssue(path, "string does not match the closed canonical form");
}

function arrayIssue(
  value: unknown,
  minimum: number,
  maximum: number,
  path: readonly (string | number)[],
  validate: (candidate: unknown) => ClosedSchemaIssue | undefined,
): ClosedSchemaIssue | undefined {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return plannerIssue(path, "array is outside the closed resource bounds");
  }
  for (let index = 0; index < value.length; index += 1) {
    const issue = validate(value[index]);
    if (issue !== undefined) {
      const childPath = copyOwnValues(path);
      appendOwn(childPath, index);
      return prefixedPlannerIssue(childPath, issue);
    }
  }
  return undefined;
}

function validateProjectionMapping(value: unknown): ClosedSchemaIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return plannerIssue([], "mapping must contain only closed plain data");
  const shape = exactRecord(snapshot.value, ["artifactId", "target"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const idIssue = stringIssue(shape.record.artifactId, ARTIFACT_ID_PATTERN, ["artifactId"]);
  if (idIssue !== undefined) return idIssue;
  return typeof shape.record.target === "string" &&
    shape.record.target.length > 0 &&
    shape.record.target.length <= MAX_TARGET_LENGTH
    ? undefined
    : plannerIssue(["target"], "mapping target is outside the closed resource bounds");
}

function validatePlannerInput(value: unknown): ClosedSchemaIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return plannerIssue([], "planner input must contain only closed plain data");
  const shape = exactRecord(snapshot.value, [
    "schemaVersion",
    "decisionVersion",
    "classifierVersion",
    "policyVersion",
    "manifestVersion",
    "owner",
    "classifierInput",
    "mappings",
  ]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const input = shape.record;
  if (input.schemaVersion !== 1) return plannerIssue(["schemaVersion"], "unsupported version");
  if (input.decisionVersion !== DECISION_VERSION) {
    return plannerIssue(["decisionVersion"], "unsupported version");
  }
  if (input.classifierVersion !== CLASSIFIER_VERSION) {
    return plannerIssue(["classifierVersion"], "unsupported version");
  }
  if (input.policyVersion !== POLICY_VERSION) {
    return plannerIssue(["policyVersion"], "unsupported version");
  }
  if (input.manifestVersion !== MANIFEST_VERSION) {
    return plannerIssue(["manifestVersion"], "unsupported version");
  }
  const ownerIssue = stringIssue(input.owner, OWNER_PATTERN, ["owner"]);
  if (ownerIssue !== undefined) return ownerIssue;
  const classifier = SyntheticClassifierInputSchema.safeParse(input.classifierInput);
  if (!classifier.success) {
    return prefixedPlannerIssue(
      ["classifierInput"],
      classifier.error.issues[0] ?? plannerIssue([], "invalid classifier input"),
    );
  }
  return arrayIssue(input.mappings, 1, MAX_ENTRIES, ["mappings"], validateProjectionMapping);
}

function validateId(value: unknown): ClosedSchemaIssue | undefined {
  return stringIssue(value, ARTIFACT_ID_PATTERN, []);
}

function validateEntry(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, ["artifactId", "target", "sourceLocator", "contentDigest"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const entry = shape.record;
  return (
    stringIssue(entry.artifactId, ARTIFACT_ID_PATTERN, ["artifactId"]) ??
    (typeof entry.target === "string" && targetIsCanonical(entry.target)
      ? undefined
      : plannerIssue(["target"], "target is not canonical")) ??
    stringIssue(entry.sourceLocator, LOCATOR_PATTERN, ["sourceLocator"]) ??
    stringIssue(entry.contentDigest, DIGEST_PATTERN, ["contentDigest"])
  );
}

function validateDecision(value: unknown): ClosedSchemaIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return plannerIssue([], "decision must contain only closed plain data");
  const shape = exactRecord(snapshot.value, [
    "decisionVersion",
    "digestVersion",
    "classifierVersion",
    "policyVersion",
    "manifestVersion",
    "owner",
    "classifierInput",
    "closure",
    "eligible",
    "mappings",
    "entries",
  ]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const decision = shape.record;
  if (
    decision.decisionVersion !== DECISION_VERSION ||
    decision.digestVersion !== DIGEST_VERSION ||
    decision.classifierVersion !== CLASSIFIER_VERSION ||
    decision.policyVersion !== POLICY_VERSION ||
    decision.manifestVersion !== MANIFEST_VERSION
  ) {
    return plannerIssue([], "decision contains an unsupported version");
  }
  const ownerIssue = stringIssue(decision.owner, OWNER_PATTERN, ["owner"]);
  if (ownerIssue !== undefined) return ownerIssue;
  const classifier = SyntheticClassifierInputSchema.safeParse(decision.classifierInput);
  if (!classifier.success) return plannerIssue(["classifierInput"], "invalid classifier input");
  const collectionIssue =
    arrayIssue(decision.closure, 1, MAX_ENTRIES, ["closure"], validateId) ??
    arrayIssue(decision.eligible, 1, MAX_ENTRIES, ["eligible"], validateId) ??
    arrayIssue(decision.mappings, 1, MAX_ENTRIES, ["mappings"], validateProjectionMapping) ??
    arrayIssue(decision.entries, 1, MAX_ENTRIES, ["entries"], validateEntry);
  if (collectionIssue !== undefined) return collectionIssue;
  const typed = snapshot.value as Decision;
  const expected = rebuildCanonicalDecision(typed);
  return expected !== undefined && canonicalSerialize(typed) === canonicalSerialize(expected)
    ? undefined
    : plannerIssue([], "decision is not complete, consistent, and canonical");
}

function validateBoundary(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, [
    "reads",
    "writes",
    "cli",
    "executor",
    "providerExecution",
    "hostExecution",
  ]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const fields = [
    "reads",
    "writes",
    "cli",
    "executor",
    "providerExecution",
    "hostExecution",
  ] as const;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field !== undefined && shape.record[field] !== false) {
      return plannerIssue([], "all execution and mutation boundary values must be false");
    }
  }
  return undefined;
}

function validateFinding(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, ["code"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  return typeof shape.record.code === "string" &&
    arrayContains<string>(FINDING_CODES, shape.record.code)
    ? undefined
    : plannerIssue(["code"], "finding code is not supported");
}

function validateManifest(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, [
    "schemaVersion",
    "digestVersion",
    "digest",
    "owner",
    "entries",
    "decision",
  ]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const manifest = shape.record;
  if (manifest.schemaVersion !== MANIFEST_VERSION || manifest.digestVersion !== DIGEST_VERSION) {
    return plannerIssue([], "manifest contains an unsupported version");
  }
  const fieldIssue =
    stringIssue(manifest.digest, DIGEST_PATTERN, ["digest"]) ??
    stringIssue(manifest.owner, OWNER_PATTERN, ["owner"]) ??
    arrayIssue(manifest.entries, 1, MAX_ENTRIES, ["entries"], validateEntry) ??
    validateDecision(manifest.decision);
  if (fieldIssue !== undefined) return fieldIssue;
  const typed = manifest as unknown as {
    digest: string;
    owner: string;
    entries: Entry[];
    decision: Decision;
  };
  if (
    hasDuplicateArtifactIds(typed.entries) ||
    hasTargetCollision(typed.entries) ||
    canonicalSerialize(typed.entries) !== canonicalSerialize(typed.decision.entries) ||
    typed.owner !== typed.decision.owner ||
    typed.digest !== digestDecision(typed.decision)
  ) {
    return plannerIssue([], "manifest is not bound to its canonical decision");
  }
  for (let index = 1; index < typed.entries.length; index += 1) {
    const previous = typed.entries[index - 1];
    const current = typed.entries[index];
    if (
      previous === undefined ||
      current === undefined ||
      compare(previous.target, current.target) > 0 ||
      (previous.target === current.target && compare(previous.artifactId, current.artifactId) >= 0)
    ) {
      return plannerIssue(["entries"], "manifest entries are not canonical");
    }
  }
  return undefined;
}

function validatePlanResult(value: unknown): ClosedSchemaIssue | undefined {
  const snapshot = validationSnapshot(value);
  if (!snapshot.ok) return plannerIssue([], "plan result must contain only closed plain data");
  const result = recordOf(snapshot.value);
  if (result === undefined) return plannerIssue([], "plan result must be a closed record");
  if (result.state === "planned") {
    const shape = exactRecord(result, [
      "schemaVersion",
      "state",
      "manifest",
      "boundary",
      "findings",
    ]);
    if (shape.issue !== undefined) return shape.issue;
    if (result.schemaVersion !== 1) return plannerIssue(["schemaVersion"], "unsupported version");
    const boundaryIssue = validateBoundary(result.boundary);
    if (boundaryIssue !== undefined) return prefixedPlannerIssue(["boundary"], boundaryIssue);
    const findingsIssue = arrayIssue(result.findings, 0, 0, ["findings"], validateFinding);
    if (findingsIssue !== undefined) return findingsIssue;
    const manifestIssue = validateManifest(result.manifest);
    return manifestIssue === undefined
      ? undefined
      : prefixedPlannerIssue(["manifest"], manifestIssue);
  }
  if (result.state === "blocked") {
    const shape = exactRecord(result, ["schemaVersion", "state", "boundary", "findings"]);
    if (shape.issue !== undefined) return shape.issue;
    if (result.schemaVersion !== 1) return plannerIssue(["schemaVersion"], "unsupported version");
    const boundaryIssue = validateBoundary(result.boundary);
    if (boundaryIssue !== undefined) return prefixedPlannerIssue(["boundary"], boundaryIssue);
    return arrayIssue(result.findings, 1, 1, ["findings"], validateFinding);
  }
  return plannerIssue(["state"], "plan result state is not supported");
}

function closedPlannerSchema<T>(
  validate: (value: unknown) => ClosedSchemaIssue | undefined,
): ClosedSchema<T> {
  const safeParse = (value: unknown) => {
    const issue = validate(value);
    if (issue !== undefined) {
      return closedRecord({ success: false as const, error: new ClosedSchemaError(issue) });
    }
    const snapshot = validationSnapshot(value);
    if (!snapshot.ok) {
      return closedRecord({
        success: false as const,
        error: new ClosedSchemaError(
          plannerIssue([], "validated planner value could not be projected"),
        ),
      });
    }
    return closedRecord({ success: true as const, data: snapshot.value as T });
  };
  const parse = (value: unknown): T => {
    const result = safeParse(value);
    if (!result.success) throw result.error;
    return result.data;
  };
  const safeParseAsync = (value: unknown) => Promise.resolve(safeParse(value));
  const parseAsync = (value: unknown): Promise<T> => {
    try {
      return Promise.resolve(parse(value));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return Object.freeze(
    closedRecord({
      decode: parse,
      decodeAsync: parseAsync,
      parse,
      parseAsync,
      safeDecode: safeParse,
      safeDecodeAsync: safeParseAsync,
      safeParse,
      safeParseAsync,
      spa: safeParseAsync,
    }),
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quotedString(value: string): string {
  const hex = "0123456789abcdef";
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = stringCharCodeAt(value, index);
    const character = value[index];
    if (character === '"' || character === "\\") {
      result += `\\${character}`;
    } else if (code === 8) {
      result += "\\b";
    } else if (code === 9) {
      result += "\\t";
    } else if (code === 10) {
      result += "\\n";
    } else if (code === 12) {
      result += "\\f";
    } else if (code === 13) {
      result += "\\r";
    } else if (code < 32) {
      result += `\\u00${hex[(code >> 4) & 15]}${hex[code & 15]}`;
    } else {
      result += character;
    }
  }
  return `${result}"`;
}

function canonicalSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return quotedString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && numberIsFinite(value)) return stringConvert(value);
  if (Array.isArray(value)) {
    let result = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) result += ",";
      const descriptor = Object.getOwnPropertyDescriptor(value, stringConvert(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("canonical arrays must contain only own data elements");
      }
      result += canonicalSerialize(descriptor.value);
    }
    return `${result}]`;
  }
  const record = recordOf(value);
  if (record === undefined) throw new Error("canonical values must be closed plain data");
  let result = "{";
  const keys = sortOwnedValues(Object.keys(record), compare);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("canonical records must contain only own data properties");
    }
    if (index > 0) result += ",";
    result += `${quotedString(key)}:${canonicalSerialize(descriptor.value)}`;
  }
  return `${result}}`;
}

function targetIsCanonical(target: string): boolean {
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) return false;
  if (!regexpTest(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/, target)) {
    return false;
  }
  const segments = stringSplit(target, "/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment === undefined ||
      stringEndsWith(segment, ".") ||
      regexpTest(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/, segment)
    ) {
      return false;
    }
  }
  return true;
}

function canonicalClassifierInput(input: ClassifierInput): ClassifierInput {
  const artifacts: ClassifierInput["artifacts"] = [];
  for (let index = 0; index < input.artifacts.length; index += 1) {
    const artifact = input.artifacts[index];
    if (artifact === undefined) continue;
    appendOwn(artifacts, {
      id: artifact.id,
      sourceLocator: artifact.sourceLocator,
      contentDigest: artifact.contentDigest,
      contentDisposition: artifact.contentDisposition,
      linkDisposition: artifact.linkDisposition,
      licenseDisposition: artifact.licenseDisposition,
      evidenceDigest: artifact.evidenceDigest,
      dependencies: sortedArrayCopy(artifact.dependencies, compare),
    });
  }
  sortOwnedValues(artifacts, (left, right) =>
    compare(canonicalSerialize(left), canonicalSerialize(right)),
  );
  const evidenceRecords: ClassifierInput["evidence"] = [];
  for (let index = 0; index < input.evidence.length; index += 1) {
    const evidence = input.evidence[index];
    if (evidence === undefined) continue;
    appendOwn(evidenceRecords, {
      artifactId: evidence.artifactId,
      sourceLocator: evidence.sourceLocator,
      contentDigest: evidence.contentDigest,
      licenseDisposition: evidence.licenseDisposition,
      evidenceDigest: evidence.evidenceDigest,
    });
  }
  sortOwnedValues(evidenceRecords, (left, right) =>
    compare(canonicalSerialize(left), canonicalSerialize(right)),
  );
  return {
    schemaVersion: input.schemaVersion,
    requested: sortedArrayCopy(input.requested, compare),
    declaredClosure: sortedArrayCopy(input.declaredClosure, compare),
    artifacts,
    evidence: evidenceRecords,
  };
}

function canonicalMappings(mappings: readonly ProjectionMapping[]): ProjectionMapping[] {
  return sortedArrayCopy(
    mappings,
    (left, right) =>
      compare(left.artifactId, right.artifactId) || compare(left.target, right.target),
  );
}

function blocked(value: Finding): ProjectionPlanResult {
  return ProjectionPlanResultSchema.parse({
    schemaVersion: 1,
    state: "blocked",
    boundary: BOUNDARY,
    findings: [value],
  });
}

function mappingsCover(
  expected: readonly string[],
  mappings: readonly ProjectionMapping[],
): boolean {
  const ids: string[] = [];
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];
    if (mapping !== undefined) appendOwn(ids, mapping.artifactId);
  }
  sortOwnedValues(ids, compare);
  if (ids.length !== expected.length) return false;
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== expected[index]) return false;
  }
  return true;
}

function hasTargetCollision(entries: readonly Entry[]): boolean {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    for (let otherIndex = 0; otherIndex < entries.length; otherIndex += 1) {
      const other = entries[otherIndex];
      if (
        other !== undefined &&
        index !== otherIndex &&
        (entry.target === other.target || stringStartsWith(other.target, `${entry.target}/`))
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasDuplicateArtifactIds(entries: readonly Entry[]): boolean {
  const ids = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (setHas(ids, entry.artifactId)) return true;
    setAdd(ids, entry.artifactId);
  }
  return false;
}

function deriveEntries(
  classifierInput: ClassifierInput,
  mappings: readonly ProjectionMapping[],
): Entry[] {
  const artifacts = new Map<string, Artifact>();
  for (let index = 0; index < classifierInput.artifacts.length; index += 1) {
    const artifact = classifierInput.artifacts[index];
    if (artifact !== undefined) mapSet(artifacts, artifact.id, artifact);
  }
  const entries: Entry[] = [];
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];
    if (mapping === undefined) continue;
    const artifact = mapGet(artifacts, mapping.artifactId) as Artifact;
    appendOwn(entries, {
      artifactId: mapping.artifactId,
      target: mapping.target,
      sourceLocator: artifact.sourceLocator,
      contentDigest: artifact.contentDigest,
    });
  }
  return sortOwnedValues(
    entries,
    (left, right) =>
      compare(left.target, right.target) || compare(left.artifactId, right.artifactId),
  );
}

function buildCanonicalDecision(
  input: PlannerInput,
  classification: ClassifierResult,
  entries: Entry[],
): Decision {
  return {
    decisionVersion: input.decisionVersion,
    digestVersion: DIGEST_VERSION,
    classifierVersion: input.classifierVersion,
    policyVersion: input.policyVersion,
    manifestVersion: input.manifestVersion,
    owner: input.owner,
    classifierInput: canonicalClassifierInput(input.classifierInput),
    closure: copyOwnValues(classification.closure),
    eligible: copyOwnValues(classification.eligible),
    mappings: canonicalMappings(input.mappings),
    entries,
  };
}

function rebuildCanonicalDecision(decision: Decision): Decision | undefined {
  const classification = classifySyntheticProjection(decision.classifierInput);
  if (classification.disposition !== "eligible") return undefined;
  if (!mappingsCover(classification.eligible, decision.mappings)) return undefined;
  for (let index = 0; index < decision.mappings.length; index += 1) {
    const mapping = decision.mappings[index];
    if (mapping !== undefined && !targetIsCanonical(mapping.target)) return undefined;
  }
  const entries = deriveEntries(decision.classifierInput, decision.mappings);
  if (hasTargetCollision(entries)) return undefined;
  return buildCanonicalDecision(
    {
      schemaVersion: 1,
      decisionVersion: decision.decisionVersion,
      classifierVersion: decision.classifierVersion,
      policyVersion: decision.policyVersion,
      manifestVersion: decision.manifestVersion,
      owner: decision.owner,
      classifierInput: decision.classifierInput,
      mappings: decision.mappings,
    },
    classification,
    entries,
  );
}

function digestDecision(decision: Decision): string {
  const hash = createHash("sha256");
  hashUpdate(hash, canonicalSerialize(decision));
  return hashDigest(hash, "hex");
}

/** Pure Phase 3 object planning; it never reads, writes, launches, or applies a projection. */
export function planSyntheticProjection(value: unknown): ProjectionPlanResult {
  const input = ProjectionPlannerInputSchema.parse(value);
  const classification: ClassifierResult = classifySyntheticProjection(input.classifierInput);
  if (classification.disposition !== "eligible") {
    return blocked({ code: "METHODOLOGY_CLASSIFICATION_INELIGIBLE" });
  }
  const eligible = classification.eligible;
  if (!mappingsCover(eligible, input.mappings)) {
    return blocked({ code: "METHODOLOGY_MAPPING_COVERAGE" });
  }
  for (let index = 0; index < input.mappings.length; index += 1) {
    const mapping = input.mappings[index];
    if (mapping !== undefined && !targetIsCanonical(mapping.target)) {
      return blocked({ code: "METHODOLOGY_TARGET_INVALID" });
    }
  }
  const entries = deriveEntries(input.classifierInput, input.mappings);
  if (hasTargetCollision(entries)) {
    return blocked({ code: "METHODOLOGY_TARGET_COLLISION" });
  }
  const decision = buildCanonicalDecision(input, classification, entries);
  const digest = digestDecision(decision);
  return ProjectionPlanResultSchema.parse({
    schemaVersion: 1,
    state: "planned",
    manifest: {
      schemaVersion: MANIFEST_VERSION,
      digestVersion: DIGEST_VERSION,
      digest,
      owner: input.owner,
      entries,
      decision,
    },
    boundary: BOUNDARY,
    findings: [],
  });
}
