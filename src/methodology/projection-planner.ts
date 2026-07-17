import { createHash } from "node:crypto";
import { z } from "zod";
import {
  classifySyntheticProjection,
  type SyntheticClassificationResultSchema,
  SyntheticClassifierInputSchema,
} from "./classifier.js";

const ArtifactIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const LocatorSchema = z.string().regex(/^synthetic:[a-z][a-z0-9-]{0,63}$/);
const TargetSchema = z.string().min(1).max(240);

export const ProjectionMappingSchema = z
  .object({ artifactId: ArtifactIdSchema, target: TargetSchema })
  .strict();

export const ProjectionPlannerInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionVersion: z.literal("phase-3-decision-v1"),
    classifierVersion: z.string().regex(/^phase-2-classifier-v\d+$/),
    policyVersion: z.string().regex(/^phase-3-policy-v\d+$/),
    manifestVersion: z.number().int().min(1).max(16),
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    classifierInput: SyntheticClassifierInputSchema,
    mappings: z.array(ProjectionMappingSchema).min(1).max(64),
  })
  .strict();

const FindingCodeSchema = z.enum([
  "METHODOLOGY_CLASSIFICATION_INELIGIBLE",
  "METHODOLOGY_MAPPING_COVERAGE",
  "METHODOLOGY_TARGET_COLLISION",
  "METHODOLOGY_TARGET_INVALID",
]);

const FindingSchema = z
  .object({ code: FindingCodeSchema, artifactId: ArtifactIdSchema.optional() })
  .strict();
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
const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    digestVersion: z.literal(1),
    digest: DigestSchema,
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    entries: z.array(EntrySchema).min(1).max(64),
  })
  .strict();

export const ProjectionPlanResultSchema = z.union([
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
      findings: z.array(FindingSchema).min(1).max(128),
    })
    .strict(),
]);

type ClassifierInput = z.infer<typeof SyntheticClassifierInputSchema>;
type ClassifierResult = z.infer<typeof SyntheticClassificationResultSchema>;
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

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetIsCanonical(target: string): boolean {
  return (
    !target.startsWith("/") &&
    !target.includes("\\") &&
    target.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function canonicalClassifierInput(input: ClassifierInput): unknown {
  return {
    schemaVersion: input.schemaVersion,
    requested: [...input.requested].sort(compare),
    declaredClosure: [...input.declaredClosure].sort(compare),
    artifacts: [...input.artifacts]
      .map((artifact) => ({ ...artifact, dependencies: [...artifact.dependencies].sort(compare) }))
      .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))),
    evidence: [...input.evidence].sort((left, right) =>
      compare(JSON.stringify(left), JSON.stringify(right)),
    ),
  };
}

function findings(...values: Finding[]): Finding[] {
  return values.sort((left, right) =>
    compare(
      `${left.code}\u0000${left.artifactId ?? ""}`,
      `${right.code}\u0000${right.artifactId ?? ""}`,
    ),
  );
}

function blocked(...values: Finding[]): z.infer<typeof ProjectionPlanResultSchema> {
  return ProjectionPlanResultSchema.parse({
    schemaVersion: 1,
    state: "blocked",
    boundary: BOUNDARY,
    findings: findings(...values),
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
  const targets = entries.map((entry) => entry.target).sort(compare);
  return targets.some((target, index) => {
    const previous = targets[index - 1];
    return previous !== undefined && (target === previous || target.startsWith(`${previous}/`));
  });
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
  const artifacts = new Map(
    input.classifierInput.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const entries = input.mappings
    .map((mapping) => {
      const artifact = artifacts.get(mapping.artifactId);
      if (artifact === undefined) throw new Error("validated mapping did not identify an artifact");
      return {
        artifactId: mapping.artifactId,
        target: mapping.target,
        sourceLocator: artifact.sourceLocator,
        contentDigest: artifact.contentDigest,
      };
    })
    .sort(
      (left, right) =>
        compare(left.target, right.target) || compare(left.artifactId, right.artifactId),
    );
  if (hasTargetCollision(entries)) {
    return blocked({ code: "METHODOLOGY_TARGET_COLLISION" });
  }
  const decision = {
    decisionVersion: input.decisionVersion,
    digestVersion: 1,
    classifierVersion: input.classifierVersion,
    policyVersion: input.policyVersion,
    manifestVersion: input.manifestVersion,
    owner: input.owner,
    classifierInput: canonicalClassifierInput(input.classifierInput),
    closure: classification.closure,
    eligible,
    mappings: [...input.mappings].sort((left, right) => compare(left.artifactId, right.artifactId)),
    entries,
  };
  const digest = createHash("sha256").update(JSON.stringify(decision)).digest("hex");
  return ProjectionPlanResultSchema.parse({
    schemaVersion: 1,
    state: "planned",
    manifest: { schemaVersion: 1, digestVersion: 1, digest, owner: input.owner, entries },
    boundary: BOUNDARY,
    findings: [],
  });
}
