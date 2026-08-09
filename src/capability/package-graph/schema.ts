import { z } from "zod";

const MAX_ID_LENGTH = 160;
const ID_SEGMENT = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const SURFACE_ID = new RegExp(`^(?!package:)[a-z][a-z0-9-]*:${ID_SEGMENT}(?:/${ID_SEGMENT})*$`);
const PACKAGE_ID = new RegExp(`^package:[a-z][a-z0-9-]*/${ID_SEGMENT}(?:/${ID_SEGMENT})*$`);
const SAFE_IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const LOWER_GIT_SHA1 = /^[0-9a-f]{40}$/;
const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_VERSION = /^(?=.*\S)[^\p{Cc}\p{Cf}\u2028\u2029]+$/u;

function duplicateIssues(
  values: readonly string[],
  label: string,
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `duplicate ${label}`,
      });
    }
    seen.add(value);
  }
}

function lengthPrefixedIdentity(parts: readonly string[]): string {
  let identity = "";
  for (const part of parts) identity += `${part.length}:${part}`;
  return identity;
}

export const SurfaceIdSchema = z.string().min(3).max(MAX_ID_LENGTH).regex(SURFACE_ID);

export const PackageIdSchema = z.string().min(9).max(MAX_ID_LENGTH).regex(PACKAGE_ID);

const SafeIdentifierSchema = z.string().min(1).max(120).regex(SAFE_IDENTIFIER);

export const PackageGraphSourceSchema = z
  .object({
    provider: z.string().min(1).max(120).regex(PROVIDER_ID),
    repository: z.string().min(3).max(240).regex(REPOSITORY),
  })
  .strict();

const GitSha1DigestSchema = z
  .object({
    algorithm: z.literal("git-sha1"),
    value: z.string().regex(LOWER_GIT_SHA1),
  })
  .strict();

const Sha256DigestSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(LOWER_SHA256),
  })
  .strict();

export const PackageGraphSourceDigestSchema = z.discriminatedUnion("algorithm", [
  GitSha1DigestSchema,
  Sha256DigestSchema,
]);

export const PackageGraphDeclaredRiskSchema = z
  .object({
    axis: SafeIdentifierSchema,
    value: SafeIdentifierSchema,
  })
  .strict();

export const PackageGraphDetectorSchema = z
  .object({
    name: SafeIdentifierSchema,
    version: z.string().min(1).max(120).regex(SAFE_VERSION),
  })
  .strict();

export const PackageGraphEvidenceSchema = z
  .object({
    sha256: z.string().regex(LOWER_SHA256),
    subjectDigest: PackageGraphSourceDigestSchema,
  })
  .strict();

export const PackageGraphRiskFindingSchema = z
  .object({
    code: SafeIdentifierSchema,
    count: z.number().int().min(1).optional(),
  })
  .strict();

export const PackageGraphObservedRiskSchema = z
  .object({
    detector: PackageGraphDetectorSchema,
    evidence: PackageGraphEvidenceSchema,
    verdict: z.enum(["pass", "warn", "blocked", "unknown"]),
    findings: z.array(PackageGraphRiskFindingSchema).superRefine((findings, context) => {
      duplicateIssues(
        findings.map((finding) => finding.code),
        "observed risk finding code",
        context,
      );
    }),
  })
  .strict();

const DeclaredRiskListSchema = z
  .array(PackageGraphDeclaredRiskSchema)
  .default([])
  .superRefine((risks, context) => {
    duplicateIssues(
      risks.map((risk) => risk.axis),
      "declared risk axis",
      context,
    );
  });

const ObservedRiskListSchema = z
  .array(PackageGraphObservedRiskSchema)
  .default([])
  .superRefine((risks, context) => {
    duplicateIssues(
      risks.map((risk) =>
        lengthPrefixedIdentity([
          risk.detector.name,
          risk.detector.version,
          risk.evidence.sha256,
          risk.evidence.subjectDigest.algorithm,
          risk.evidence.subjectDigest.value,
        ]),
      ),
      "observed detector evidence identity",
      context,
    );
  });

function evidenceSubjectIssues(
  sourceDigest: PackageGraphSourceDigest,
  observedRisk: PackageGraphObservedRisk[],
  context: z.core.$RefinementCtx,
): void {
  for (const [index, risk] of observedRisk.entries()) {
    const subject = risk.evidence.subjectDigest;
    if (subject.algorithm === sourceDigest.algorithm && subject.value === sourceDigest.value) {
      continue;
    }
    context.addIssue({
      code: "custom",
      path: ["observedRisk", index, "evidence", "subjectDigest"],
      message: "observed evidence subject digest must match the entity source digest",
    });
  }
}

export const PackageGraphSurfaceSchema = z
  .object({
    id: SurfaceIdSchema,
    source: PackageGraphSourceSchema,
    sourceDigest: PackageGraphSourceDigestSchema,
    declaredRisk: DeclaredRiskListSchema,
    observedRisk: ObservedRiskListSchema,
  })
  .strict()
  .superRefine((surface, context) => {
    evidenceSubjectIssues(surface.sourceDigest, surface.observedRisk, context);
  });

export const PackageGraphPackageSchema = z
  .object({
    id: PackageIdSchema,
    source: PackageGraphSourceSchema,
    sourceDigest: PackageGraphSourceDigestSchema,
    members: z
      .array(SurfaceIdSchema)
      .min(1)
      .superRefine((members, context) => duplicateIssues(members, "package member", context)),
    declaredRisk: DeclaredRiskListSchema,
    observedRisk: ObservedRiskListSchema,
  })
  .strict()
  .superRefine((pkg, context) => {
    evidenceSubjectIssues(pkg.sourceDigest, pkg.observedRisk, context);
  });

export const PackageGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    surfaces: z.array(PackageGraphSurfaceSchema),
    packages: z.array(PackageGraphPackageSchema),
  })
  .strict()
  .superRefine((graph, context) => {
    const surfaceIds = new Set(graph.surfaces.map((surface) => surface.id));
    duplicateIssues(
      graph.surfaces.map((surface) => surface.id),
      "surface id",
      context,
    );
    duplicateIssues(
      graph.packages.map((pkg) => pkg.id),
      "package id",
      context,
    );
    for (const [packageIndex, pkg] of graph.packages.entries()) {
      for (const [memberIndex, member] of pkg.members.entries()) {
        if (surfaceIds.has(member)) continue;
        context.addIssue({
          code: "custom",
          path: ["packages", packageIndex, "members", memberIndex],
          message: `package member references undeclared surface: ${member}`,
        });
      }
    }
  });

export type SurfaceId = z.infer<typeof SurfaceIdSchema>;
export type PackageId = z.infer<typeof PackageIdSchema>;
export type PackageGraphSource = z.infer<typeof PackageGraphSourceSchema>;
export type PackageGraphSourceDigest = z.infer<typeof PackageGraphSourceDigestSchema>;
export type PackageGraphDeclaredRisk = z.infer<typeof PackageGraphDeclaredRiskSchema>;
export type PackageGraphDetector = z.infer<typeof PackageGraphDetectorSchema>;
export type PackageGraphEvidence = z.infer<typeof PackageGraphEvidenceSchema>;
export type PackageGraphRiskFinding = z.infer<typeof PackageGraphRiskFindingSchema>;
export type PackageGraphObservedRisk = z.infer<typeof PackageGraphObservedRiskSchema>;
export type PackageGraphSurface = z.infer<typeof PackageGraphSurfaceSchema>;
export type PackageGraphPackage = z.infer<typeof PackageGraphPackageSchema>;
export type PackageGraph = z.infer<typeof PackageGraphSchema>;
