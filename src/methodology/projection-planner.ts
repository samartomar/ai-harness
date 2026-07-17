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
  Object.defineProperty(values, String(values.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
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

function snapshotPlainData(value: unknown, state: SnapshotState): SnapshotResult {
  const surface = snapshotSurface(value);
  if (!surface.ok) return INVALID_SNAPSHOT;
  if (value === null || typeof value !== "object") return surface;
  if (state.depth >= MAX_SNAPSHOT_DEPTH || state.nodes >= MAX_SNAPSHOT_NODES) {
    return INVALID_SNAPSHOT;
  }
  if (state.active.has(value)) return INVALID_SNAPSHOT;
  state.active.add(value);
  const nextState = { ...state, depth: state.depth + 1, nodes: state.nodes + 1 };
  if (Array.isArray(surface.value)) {
    const snapshot: unknown[] = [];
    for (let index = 0; index < surface.value.length; index += 1) {
      const child = snapshotPlainData(surface.value[index], nextState);
      if (!child.ok) return INVALID_SNAPSHOT;
      appendOwn(snapshot, child.value);
    }
    state.nodes = nextState.nodes;
    state.active.delete(value);
    return { ok: true, value: snapshot };
  }
  const record = recordOf(surface.value);
  if (record === undefined) return INVALID_SNAPSHOT;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const child = snapshotPlainData(entry, nextState);
    if (!child.ok) return INVALID_SNAPSHOT;
    snapshot[key] = child.value;
  }
  state.nodes = nextState.nodes;
  state.active.delete(value);
  return { ok: true, value: snapshot };
}

const OWNER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LOCATOR_PATTERN = /^synthetic:[a-z][a-z0-9-]{0,63}$/;
const FINDING_CODES = new Set([
  "METHODOLOGY_CLASSIFICATION_INELIGIBLE",
  "METHODOLOGY_MAPPING_COVERAGE",
  "METHODOLOGY_TARGET_COLLISION",
  "METHODOLOGY_TARGET_INVALID",
]);

function plannerIssue(path: readonly (string | number)[], message: string): ClosedSchemaIssue {
  return closedRecord({ code: "custom" as const, path: [...path], message });
}

function prefixedPlannerIssue(
  prefix: readonly (string | number)[],
  issue: ClosedSchemaIssue,
): ClosedSchemaIssue {
  return plannerIssue([...prefix, ...issue.path], issue.message);
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
  for (const key of keys) {
    if (!fields.includes(key))
      return { issue: plannerIssue([key], "unknown field is not allowed") };
  }
  for (const field of fields) {
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
  return typeof value === "string" && pattern.test(value)
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
    if (issue !== undefined) return prefixedPlannerIssue([...path, index], issue);
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
  return Object.values(shape.record).every((entry) => entry === false)
    ? undefined
    : plannerIssue([], "all execution and mutation boundary values must be false");
}

function validateFinding(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, ["code"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  return typeof shape.record.code === "string" && FINDING_CODES.has(shape.record.code)
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
    new Set(typed.entries.map((entry) => entry.artifactId)).size !== typed.entries.length ||
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
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
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
      result += `\\u${code.toString(16).padStart(4, "0")}`;
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
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    let result = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) result += ",";
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
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
  const keys = Object.keys(record).sort(compare);
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
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(target)) return false;
  return target
    .split("/")
    .every(
      (segment) =>
        !segment.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/.test(segment),
    );
}

function canonicalClassifierInput(input: ClassifierInput): ClassifierInput {
  return {
    schemaVersion: input.schemaVersion,
    requested: [...input.requested].sort(compare),
    declaredClosure: [...input.declaredClosure].sort(compare),
    artifacts: [...input.artifacts]
      .map((artifact) => ({
        id: artifact.id,
        sourceLocator: artifact.sourceLocator,
        contentDigest: artifact.contentDigest,
        contentDisposition: artifact.contentDisposition,
        linkDisposition: artifact.linkDisposition,
        licenseDisposition: artifact.licenseDisposition,
        evidenceDigest: artifact.evidenceDigest,
        dependencies: [...artifact.dependencies].sort(compare),
      }))
      .sort((left, right) => compare(canonicalSerialize(left), canonicalSerialize(right))),
    evidence: [...input.evidence]
      .map((evidence) => ({
        artifactId: evidence.artifactId,
        sourceLocator: evidence.sourceLocator,
        contentDigest: evidence.contentDigest,
        licenseDisposition: evidence.licenseDisposition,
        evidenceDigest: evidence.evidenceDigest,
      }))
      .sort((left, right) => compare(canonicalSerialize(left), canonicalSerialize(right))),
  };
}

function canonicalMappings(mappings: readonly ProjectionMapping[]): ProjectionMapping[] {
  return [...mappings].sort(
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
  const ids = mappings.map((mapping) => mapping.artifactId).sort(compare);
  return ids.length === expected.length && ids.every((id, index) => id === expected[index]);
}

function hasTargetCollision(entries: readonly Entry[]): boolean {
  return entries.some((entry, index) =>
    entries.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        (entry.target === other.target || other.target.startsWith(`${entry.target}/`)),
    ),
  );
}

function deriveEntries(
  classifierInput: ClassifierInput,
  mappings: readonly ProjectionMapping[],
): Entry[] {
  const artifacts = new Map(classifierInput.artifacts.map((artifact) => [artifact.id, artifact]));
  const entries: Entry[] = [];
  for (const mapping of mappings) {
    const artifact = artifacts.get(mapping.artifactId) as Artifact;
    appendOwn(entries, {
      artifactId: mapping.artifactId,
      target: mapping.target,
      sourceLocator: artifact.sourceLocator,
      contentDigest: artifact.contentDigest,
    });
  }
  return entries.sort(
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
    closure: [...classification.closure],
    eligible: [...classification.eligible],
    mappings: canonicalMappings(input.mappings),
    entries,
  };
}

function rebuildCanonicalDecision(decision: Decision): Decision | undefined {
  const classification = classifySyntheticProjection(decision.classifierInput);
  if (classification.disposition !== "eligible") return undefined;
  if (!mappingsCover(classification.eligible, decision.mappings)) return undefined;
  if (decision.mappings.some((mapping) => !targetIsCanonical(mapping.target))) return undefined;
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
  return createHash("sha256").update(canonicalSerialize(decision)).digest("hex");
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
  if (input.mappings.some((mapping) => !targetIsCanonical(mapping.target))) {
    return blocked({ code: "METHODOLOGY_TARGET_INVALID" });
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
