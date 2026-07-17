import { createHash } from "node:crypto";
import { z } from "zod";
import {
  classifySyntheticProjection,
  type SyntheticClassificationResultSchema,
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

const ArtifactIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const LocatorSchema = z.string().regex(/^synthetic:[a-z][a-z0-9-]{0,63}$/);
const MappingTargetSchema = z.string().min(1).max(240);
const TargetSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (target) => targetIsCanonical(target),
    "target must be a canonical host-neutral logical path",
  );

export const ProjectionMappingSchema = z
  .object({ artifactId: ArtifactIdSchema, target: MappingTargetSchema })
  .strict();

const ProjectionPlannerInputObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionVersion: z.literal(DECISION_VERSION),
    classifierVersion: z.literal(CLASSIFIER_VERSION),
    policyVersion: z.literal(POLICY_VERSION),
    manifestVersion: z.literal(MANIFEST_VERSION),
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    classifierInput: SyntheticClassifierInputSchema,
    mappings: z.array(ProjectionMappingSchema).min(1).max(MAX_ENTRIES),
  })
  .strict();

export const ProjectionPlannerInputSchema = z.preprocess(
  (value) => (plannerInputCollectionsAreBounded(value) ? value : null),
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
    classifierInput: SyntheticClassifierInputSchema,
    closure: z.array(ArtifactIdSchema).min(1).max(MAX_ENTRIES),
    eligible: z.array(ArtifactIdSchema).min(1).max(MAX_ENTRIES),
    mappings: z.array(ProjectionMappingSchema).min(1).max(MAX_ENTRIES),
    entries: z.array(EntrySchema).min(1).max(MAX_ENTRIES),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const expected = rebuildCanonicalDecision(decision);
    if (expected === undefined || JSON.stringify(decision) !== JSON.stringify(expected)) {
      ctx.addIssue({
        code: "custom",
        message: "projection decision must be complete, internally consistent, and canonical",
      });
    }
  });

export const ProjectionDecisionSchema = z.preprocess(
  (value) => (decisionCollectionsAreBounded(value) ? value : null),
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
      JSON.stringify(manifest.entries) !== JSON.stringify(manifest.decision.entries)
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
  (value) => (resultCollectionsAreBounded(value) ? value : null),
  ProjectionPlanResultUnionSchema,
);

type ClassifierInput = z.infer<typeof SyntheticClassifierInputSchema>;
type ClassifierResult = z.infer<typeof SyntheticClassificationResultSchema>;
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

function collectionIsBounded(value: unknown, maximum: number): boolean {
  return !Array.isArray(value) || value.length <= maximum;
}

function classifierCollectionsAreBounded(value: unknown): boolean {
  const input = recordOf(value);
  if (input === undefined) return true;
  if (!collectionIsBounded(input.requested, MAX_REQUESTED_COMPONENTS)) return false;
  if (!collectionIsBounded(input.declaredClosure, MAX_ENTRIES)) return false;
  if (!collectionIsBounded(input.artifacts, MAX_ENTRIES)) return false;
  if (!collectionIsBounded(input.evidence, MAX_ENTRIES)) return false;
  if (Array.isArray(input.artifacts)) {
    for (const candidate of input.artifacts) {
      const artifact = recordOf(candidate);
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
  const input = recordOf(value);
  if (input === undefined) return true;
  return (
    collectionIsBounded(input.mappings, MAX_ENTRIES) &&
    classifierCollectionsAreBounded(input.classifierInput)
  );
}

function decisionCollectionsAreBounded(value: unknown): boolean {
  const decision = recordOf(value);
  if (decision === undefined) return true;
  return (
    collectionIsBounded(decision.closure, MAX_ENTRIES) &&
    collectionIsBounded(decision.eligible, MAX_ENTRIES) &&
    collectionIsBounded(decision.mappings, MAX_ENTRIES) &&
    collectionIsBounded(decision.entries, MAX_ENTRIES) &&
    classifierCollectionsAreBounded(decision.classifierInput)
  );
}

function manifestCollectionsAreBounded(value: unknown): boolean {
  const manifest = recordOf(value);
  if (manifest === undefined) return true;
  return (
    collectionIsBounded(manifest.entries, MAX_ENTRIES) &&
    decisionCollectionsAreBounded(manifest.decision)
  );
}

function resultCollectionsAreBounded(value: unknown): boolean {
  const result = recordOf(value);
  if (result === undefined) return true;
  return (
    collectionIsBounded(result.findings, MAX_BLOCKED_FINDINGS) &&
    manifestCollectionsAreBounded(result.manifest)
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetIsCanonical(target: string): boolean {
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
      .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))),
    evidence: [...input.evidence]
      .map((evidence) => ({
        artifactId: evidence.artifactId,
        sourceLocator: evidence.sourceLocator,
        contentDigest: evidence.contentDigest,
        licenseDisposition: evidence.licenseDisposition,
        evidenceDigest: evidence.evidenceDigest,
      }))
      .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))),
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
): Entry[] | undefined {
  const artifacts = new Map(classifierInput.artifacts.map((artifact) => [artifact.id, artifact]));
  const entries: Entry[] = [];
  for (const mapping of mappings) {
    const artifact = artifacts.get(mapping.artifactId);
    if (artifact === undefined) return undefined;
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
  if (entries === undefined || hasTargetCollision(entries)) return undefined;
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
  return createHash("sha256").update(JSON.stringify(decision)).digest("hex");
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
  if (entries === undefined) {
    return blocked({ code: "METHODOLOGY_MAPPING_COVERAGE" });
  }
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
