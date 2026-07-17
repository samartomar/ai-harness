import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { z } from "zod";
import {
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
const MAX_REQUESTED_COMPONENTS = 32;
const MAX_DEPENDENCIES_PER_ARTIFACT = 32;
const MAX_BLOCKED_FINDINGS = 1;
const MAX_TARGET_LENGTH = 240;
const MAX_SNAPSHOT_ARRAY_LENGTH = MAX_ENTRIES;
const MAX_SNAPSHOT_RECORD_KEYS = 32;
const MAX_SNAPSHOT_DEPTH = 12;
const MAX_SNAPSHOT_NODES = 8192;

const ArtifactIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const LocatorSchema = z.string().regex(/^synthetic:[a-z][a-z0-9-]{0,63}$/);
const MappingTargetSchema = z.string().min(1).max(MAX_TARGET_LENGTH);
const TargetSchema = z
  .string()
  .min(1)
  .max(MAX_TARGET_LENGTH)
  .refine(
    (target) => targetIsCanonical(target),
    "target must be a canonical host-neutral logical path",
  );

const ProjectionMappingObjectSchema = z
  .object({ artifactId: ArtifactIdSchema, target: MappingTargetSchema })
  .strict();

const ClassifierInputSchema = z.unknown().transform((value, ctx): SyntheticClassifierInput => {
  const result = SyntheticClassifierInputSchema.safeParse(value);
  if (result.success) return result.data;
  ctx.addIssue({
    code: "custom",
    message: "classifier input must satisfy the closed Phase 2 contract",
  });
  return z.NEVER;
});

export const ProjectionMappingSchema = z.preprocess(
  (value) =>
    failClosedPreprocess(value, (candidate) =>
      recordFieldsAreOwn(candidate, ["artifactId", "target"]),
    ),
  ProjectionMappingObjectSchema,
);

const ProjectionPlannerInputObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionVersion: z.literal(DECISION_VERSION),
    classifierVersion: z.literal(CLASSIFIER_VERSION),
    policyVersion: z.literal(POLICY_VERSION),
    manifestVersion: z.literal(MANIFEST_VERSION),
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    classifierInput: ClassifierInputSchema,
    mappings: z.array(ProjectionMappingSchema).min(1).max(MAX_ENTRIES),
  })
  .strict();

export const ProjectionPlannerInputSchema = z.preprocess(
  (value) => failClosedPreprocess(value, plannerInputCollectionsAreBounded),
  ProjectionPlannerInputObjectSchema,
);

const FindingCodeSchema = z.enum([
  "METHODOLOGY_CLASSIFICATION_INELIGIBLE",
  "METHODOLOGY_MAPPING_COVERAGE",
  "METHODOLOGY_TARGET_COLLISION",
  "METHODOLOGY_TARGET_INVALID",
]);

const FindingSchema = z.object({ code: FindingCodeSchema }).strict();
const BoundarySchema = z
  .object({
    reads: z.literal(false),
    writes: z.literal(false),
    cli: z.literal(false),
    executor: z.literal(false),
    providerExecution: z.literal(false),
    hostExecution: z.literal(false),
  })
  .strict();
const EntrySchema = z
  .object({
    artifactId: ArtifactIdSchema,
    target: TargetSchema,
    sourceLocator: LocatorSchema,
    contentDigest: DigestSchema,
  })
  .strict();

const ProjectionDecisionObjectSchema = z
  .object({
    decisionVersion: z.literal(DECISION_VERSION),
    digestVersion: z.literal(DIGEST_VERSION),
    classifierVersion: z.literal(CLASSIFIER_VERSION),
    policyVersion: z.literal(POLICY_VERSION),
    manifestVersion: z.literal(MANIFEST_VERSION),
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    classifierInput: ClassifierInputSchema,
    closure: z.array(ArtifactIdSchema).min(1).max(MAX_ENTRIES),
    eligible: z.array(ArtifactIdSchema).min(1).max(MAX_ENTRIES),
    mappings: z.array(ProjectionMappingSchema).min(1).max(MAX_ENTRIES),
    entries: z.array(EntrySchema).min(1).max(MAX_ENTRIES),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const expected = rebuildCanonicalDecision(decision);
    if (expected === undefined || canonicalSerialize(decision) !== canonicalSerialize(expected)) {
      ctx.addIssue({
        code: "custom",
        message: "projection decision must be complete, internally consistent, and canonical",
      });
    }
  });

export const ProjectionDecisionSchema = z.preprocess(
  (value) => failClosedPreprocess(value, decisionCollectionsAreBounded),
  ProjectionDecisionObjectSchema,
);

const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    digestVersion: z.literal(DIGEST_VERSION),
    digest: DigestSchema,
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    entries: z.array(EntrySchema).min(1).max(MAX_ENTRIES),
    decision: ProjectionDecisionSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const entries = manifest.entries;
    if (new Set(entries.map((entry) => entry.artifactId)).size !== entries.length) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "manifest artifact entries must be unique",
      });
    }
    if (
      entries.some((entry, index) => {
        const previous = entries[index - 1];
        return (
          previous !== undefined &&
          (compare(previous.target, entry.target) > 0 ||
            (previous.target === entry.target &&
              compare(previous.artifactId, entry.artifactId) >= 0))
        );
      })
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "manifest entries must be canonicalized",
      });
    }
    if (
      entries.some((entry, index) =>
        entries.some(
          (other, otherIndex) =>
            index !== otherIndex &&
            (entry.target === other.target || other.target.startsWith(`${entry.target}/`)),
        ),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "manifest targets may not collide",
      });
    }
    if (
      manifest.owner !== manifest.decision.owner ||
      canonicalSerialize(manifest.entries) !== canonicalSerialize(manifest.decision.entries)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "manifest owner and entries must match its canonical decision",
      });
    }
    if (manifest.digest !== digestDecision(manifest.decision)) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "manifest digest must match its canonical decision",
      });
    }
  });

const ProjectionPlanResultUnionSchema = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal("planned"),
      manifest: ManifestSchema,
      boundary: BoundarySchema,
      findings: z.array(FindingSchema).length(0),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal("blocked"),
      boundary: BoundarySchema,
      findings: z.array(FindingSchema).length(MAX_BLOCKED_FINDINGS),
    })
    .strict(),
]);

export const ProjectionPlanResultSchema = z.preprocess(
  (value) => failClosedPreprocess(value, resultCollectionsAreBounded),
  ProjectionPlanResultUnionSchema,
);

type ClassifierInput = SyntheticClassifierInput;
type ClassifierResult = SyntheticClassificationResult;
type Artifact = ClassifierInput["artifacts"][number];
type PlannerInput = z.infer<typeof ProjectionPlannerInputSchema>;
type Decision = z.infer<typeof ProjectionDecisionSchema>;
type Entry = z.infer<typeof EntrySchema>;
type Finding = z.infer<typeof FindingSchema>;

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
      snapshot.push(child.value);
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

function staticRecordOf(value: unknown): Record<string, unknown> | undefined {
  const surface = snapshotSurface(value);
  return surface.ok ? recordOf(surface.value) : undefined;
}

function recordFieldsAreOwn(value: unknown, fields: readonly string[]): boolean {
  const record = staticRecordOf(value);
  return record === undefined || fields.every((field) => Object.hasOwn(record, field));
}

function collectionRecordFieldsAreOwn(value: unknown, fields: readonly string[]): boolean {
  if (!Array.isArray(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor !== undefined && !recordFieldsAreOwn(descriptor.value, fields)) return false;
  }
  return true;
}

function recordSurfaceIsStatic(value: unknown): boolean {
  return snapshotSurface(value).ok;
}

function collectionIsBounded(value: unknown, maximum: number): boolean {
  if (isProxy(value)) return false;
  if (!Array.isArray(value)) return true;
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = value.length;
  if (length > maximum) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) return false;
    if (!("value" in descriptor) || !recordSurfaceIsStatic(descriptor.value)) return false;
  }
  return Reflect.ownKeys(value).length === length + 1;
}

function failClosedPreprocess(value: unknown, predicate: (candidate: unknown) => boolean): unknown {
  const surface = snapshotSurface(value);
  if (!surface.ok || !predicate(surface.value)) return null;
  const snapshot = snapshotPlainData(surface.value, {
    depth: 0,
    nodes: 0,
    active: new WeakSet<object>(),
  });
  return snapshot.ok ? snapshot.value : null;
}

function classifierCollectionsAreBounded(value: unknown): boolean {
  const input = staticRecordOf(value);
  if (input === undefined) return true;
  if (
    !recordFieldsAreOwn(input, [
      "schemaVersion",
      "requested",
      "declaredClosure",
      "artifacts",
      "evidence",
    ])
  ) {
    return false;
  }
  if (!collectionIsBounded(input.requested, MAX_REQUESTED_COMPONENTS)) return false;
  if (!collectionIsBounded(input.declaredClosure, MAX_ENTRIES)) return false;
  if (!collectionIsBounded(input.artifacts, MAX_ENTRIES)) return false;
  if (!collectionIsBounded(input.evidence, MAX_ENTRIES)) return false;
  if (
    !collectionRecordFieldsAreOwn(input.artifacts, [
      "id",
      "sourceLocator",
      "contentDigest",
      "contentDisposition",
      "linkDisposition",
      "licenseDisposition",
      "evidenceDigest",
      "dependencies",
    ]) ||
    !collectionRecordFieldsAreOwn(input.evidence, [
      "artifactId",
      "sourceLocator",
      "contentDigest",
      "licenseDisposition",
      "evidenceDigest",
    ])
  ) {
    return false;
  }
  if (Array.isArray(input.artifacts)) {
    for (let index = 0; index < input.artifacts.length; index += 1) {
      const candidate = input.artifacts[index];
      const artifact = staticRecordOf(candidate);
      if (
        artifact !== undefined &&
        !collectionIsBounded(artifact.dependencies, MAX_DEPENDENCIES_PER_ARTIFACT)
      ) {
        return false;
      }
    }
  }
  return true;
}

function plannerInputCollectionsAreBounded(value: unknown): boolean {
  const input = staticRecordOf(value);
  if (input === undefined) return true;
  return (
    recordFieldsAreOwn(input, [
      "schemaVersion",
      "decisionVersion",
      "classifierVersion",
      "policyVersion",
      "manifestVersion",
      "owner",
      "classifierInput",
      "mappings",
    ]) &&
    collectionIsBounded(input.mappings, MAX_ENTRIES) &&
    collectionRecordFieldsAreOwn(input.mappings, ["artifactId", "target"]) &&
    classifierCollectionsAreBounded(input.classifierInput)
  );
}

function decisionCollectionsAreBounded(value: unknown): boolean {
  const decision = staticRecordOf(value);
  if (decision === undefined) return true;
  return (
    recordFieldsAreOwn(decision, [
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
    ]) &&
    collectionIsBounded(decision.closure, MAX_ENTRIES) &&
    collectionIsBounded(decision.eligible, MAX_ENTRIES) &&
    collectionIsBounded(decision.mappings, MAX_ENTRIES) &&
    collectionIsBounded(decision.entries, MAX_ENTRIES) &&
    collectionRecordFieldsAreOwn(decision.mappings, ["artifactId", "target"]) &&
    collectionRecordFieldsAreOwn(decision.entries, [
      "artifactId",
      "target",
      "sourceLocator",
      "contentDigest",
    ]) &&
    classifierCollectionsAreBounded(decision.classifierInput)
  );
}

function manifestCollectionsAreBounded(value: unknown): boolean {
  const manifest = staticRecordOf(value);
  if (manifest === undefined) return true;
  return (
    recordFieldsAreOwn(manifest, [
      "schemaVersion",
      "digestVersion",
      "digest",
      "owner",
      "entries",
      "decision",
    ]) &&
    collectionIsBounded(manifest.entries, MAX_ENTRIES) &&
    collectionRecordFieldsAreOwn(manifest.entries, [
      "artifactId",
      "target",
      "sourceLocator",
      "contentDigest",
    ]) &&
    decisionCollectionsAreBounded(manifest.decision)
  );
}

function resultCollectionsAreBounded(value: unknown): boolean {
  const result = staticRecordOf(value);
  if (result === undefined) return true;
  return (
    recordFieldsAreOwn(result, ["schemaVersion", "state", "boundary", "findings"]) &&
    (result.state !== "planned" || Object.hasOwn(result, "manifest")) &&
    collectionIsBounded(result.findings, MAX_BLOCKED_FINDINGS) &&
    collectionRecordFieldsAreOwn(result.findings, ["code"]) &&
    recordFieldsAreOwn(result.boundary, [
      "reads",
      "writes",
      "cli",
      "executor",
      "providerExecution",
      "hostExecution",
    ]) &&
    manifestCollectionsAreBounded(result.manifest)
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

function canonicalMappings(
  mappings: readonly z.infer<typeof ProjectionMappingSchema>[],
): z.infer<typeof ProjectionMappingSchema>[] {
  return [...mappings].sort(
    (left, right) =>
      compare(left.artifactId, right.artifactId) || compare(left.target, right.target),
  );
}

function blocked(value: Finding): z.infer<typeof ProjectionPlanResultSchema> {
  return ProjectionPlanResultSchema.parse({
    schemaVersion: 1,
    state: "blocked",
    boundary: BOUNDARY,
    findings: [value],
  });
}

function mappingsCover(
  expected: readonly string[],
  mappings: readonly z.infer<typeof ProjectionMappingSchema>[],
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
  mappings: readonly z.infer<typeof ProjectionMappingSchema>[],
): Entry[] {
  const artifacts = new Map(classifierInput.artifacts.map((artifact) => [artifact.id, artifact]));
  const entries: Entry[] = [];
  for (const mapping of mappings) {
    const artifact = artifacts.get(mapping.artifactId) as Artifact;
    entries.push({
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
export function planSyntheticProjection(
  value: unknown,
): z.infer<typeof ProjectionPlanResultSchema> {
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
