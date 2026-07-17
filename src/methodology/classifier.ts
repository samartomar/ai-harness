import { z } from "zod";

const MAX_SYNTHETIC_ROOTS = 32;
const MAX_SYNTHETIC_ARTIFACTS = 64;
const MAX_SYNTHETIC_DEPENDENCIES = 32;
const MAX_SYNTHETIC_PATH_LENGTH = 512;
const MAX_SYNTHETIC_ARTIFACT_FINDINGS = 8;
// Only declared roots are traversed; every non-root dependency is excluded, not visited.
const MAX_SYNTHETIC_FINDINGS =
  MAX_SYNTHETIC_ROOTS * (MAX_SYNTHETIC_DEPENDENCIES + MAX_SYNTHETIC_ARTIFACT_FINDINGS);

const ArtifactIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const WindowsReservedSegmentSchema = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;

function hasWindowsReservedSegment(value: string): boolean {
  return value.split("/").some((segment) => WindowsReservedSegmentSchema.test(segment));
}

export const SyntheticMethodologyPathSchema = z
  .string()
  .max(MAX_SYNTHETIC_PATH_LENGTH)
  .regex(
    /^(?!\/)(?!.*\\\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-z0-9_-](?:[a-z0-9._-]*[a-z0-9_-])?(?:\/[a-z0-9_-](?:[a-z0-9._-]*[a-z0-9_-])?)*$/,
  )
  .refine((path) => !hasWindowsReservedSegment(path), {
    message: "synthetic paths cannot contain Windows-reserved device names",
  });
export const SyntheticMethodologyDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SyntheticMethodologySourceLocatorSchema = z
  .string()
  .max(256)
  .regex(
    /^synthetic:\/\/[a-z][a-z0-9-]{0,63}\/(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-z0-9_-](?:[a-z0-9._-]*[a-z0-9_-])?(?:\/[a-z0-9_-](?:[a-z0-9._-]*[a-z0-9_-])?)*$/,
  )
  .refine((locator) => !hasWindowsReservedSegment(locator), {
    message: "synthetic source locators cannot contain Windows-reserved device names",
  });

export const SyntheticArtifactKindSchema = z.enum([
  "regular",
  "directory",
  "symlink",
  "hard-link",
  "reparse-point",
]);
export const SyntheticContentSchema = z
  .object({
    classification: z.enum(["passive", "ambiguous", "executable"]),
    digest: SyntheticMethodologyDigestSchema,
  })
  .strict();
export const SyntheticSourceIdentitySchema = z
  .object({
    locator: SyntheticMethodologySourceLocatorSchema,
    digest: SyntheticMethodologyDigestSchema,
  })
  .strict();
export const SyntheticEvidenceTargetSchema = z
  .object({
    artifact: ArtifactIdSchema,
    path: SyntheticMethodologyPathSchema,
    sourceIdentity: SyntheticSourceIdentitySchema,
    contentDigest: SyntheticMethodologyDigestSchema,
  })
  .strict();
export const SyntheticEvidenceSchema = z
  .object({
    target: SyntheticEvidenceTargetSchema,
    source: z.enum(["exact", "drifted"]),
    trust: z.enum(["admitted", "held"]),
    license: z.enum(["allowed", "unlicensed"]),
  })
  .strict();

export const SyntheticMethodologyArtifactSchema = z
  .object({
    id: ArtifactIdSchema,
    path: SyntheticMethodologyPathSchema,
    kind: SyntheticArtifactKindSchema,
    content: SyntheticContentSchema,
    sourceIdentity: SyntheticSourceIdentitySchema,
    evidence: SyntheticEvidenceSchema,
    dependencies: z.array(ArtifactIdSchema).max(MAX_SYNTHETIC_DEPENDENCIES),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const dependencies = new Set<string>();
    for (const [index, dependency] of artifact.dependencies.entries()) {
      if (dependencies.has(dependency)) {
        ctx.addIssue({
          code: "custom",
          path: ["dependencies", index],
          message: "synthetic dependencies must be unique",
        });
      }
      dependencies.add(dependency);
    }
  });

export const SyntheticMethodologyInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    roots: z.array(ArtifactIdSchema).min(1).max(MAX_SYNTHETIC_ROOTS),
    artifacts: z.array(SyntheticMethodologyArtifactSchema).min(1).max(MAX_SYNTHETIC_ARTIFACTS),
  })
  .strict()
  .superRefine((input, ctx) => {
    const roots = new Set<string>();
    for (const [index, root] of input.roots.entries()) {
      if (roots.has(root)) {
        ctx.addIssue({
          code: "custom",
          path: ["roots", index],
          message: "synthetic roots must be unique",
        });
      }
      roots.add(root);
    }
    const artifacts = new Set<string>();
    for (const [index, artifact] of input.artifacts.entries()) {
      if (artifacts.has(artifact.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", index, "id"],
          message: "synthetic artifact ids must be unique",
        });
      }
      artifacts.add(artifact.id);
    }
  });

export const SyntheticMethodologyFindingCodeSchema = z.enum([
  "METHODOLOGY_SYNTHETIC_AMBIGUOUS",
  "METHODOLOGY_SYNTHETIC_ARTIFACT_MISSING",
  "METHODOLOGY_SYNTHETIC_DEPENDENCY_MISSING",
  "METHODOLOGY_SYNTHETIC_DRIFTED",
  "METHODOLOGY_SYNTHETIC_EVIDENCE_UNBOUND",
  "METHODOLOGY_SYNTHETIC_EXECUTABLE",
  "METHODOLOGY_SYNTHETIC_HELD",
  "METHODOLOGY_SYNTHETIC_LINKED",
  "METHODOLOGY_SYNTHETIC_NON_REGULAR",
  "METHODOLOGY_SYNTHETIC_OUT_OF_CLOSURE",
  "METHODOLOGY_SYNTHETIC_PATH_AMBIGUOUS",
  "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
  "METHODOLOGY_SYNTHETIC_UNLICENSED",
]);

export const SyntheticMethodologyFindingSchema = z
  .object({
    code: SyntheticMethodologyFindingCodeSchema,
    disposition: z.literal("excluded"),
    artifact: ArtifactIdSchema,
  })
  .strict();

export const SyntheticMethodologyClassificationSchema = z
  .object({
    schemaVersion: z.literal(1),
    disposition: z.enum(["admitted", "excluded"]),
    admitted: z.array(ArtifactIdSchema).max(MAX_SYNTHETIC_ROOTS),
    findings: z.array(SyntheticMethodologyFindingSchema).max(MAX_SYNTHETIC_FINDINGS),
  })
  .strict()
  .superRefine((classification, ctx) => {
    const admitted = new Set<string>();
    for (const [index, artifact] of classification.admitted.entries()) {
      if (admitted.has(artifact)) {
        ctx.addIssue({
          code: "custom",
          path: ["admitted", index],
          message: "admitted synthetic artifacts must be unique",
        });
      }
      admitted.add(artifact);
    }

    const findings = new Set<string>();
    for (const [index, finding] of classification.findings.entries()) {
      const key = `${finding.artifact}\u0000${finding.code}`;
      if (findings.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index],
          message: "synthetic findings must be unique",
        });
      }
      findings.add(key);
    }

    if (classification.disposition === "admitted") {
      if (classification.admitted.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["admitted"],
          message: "an admitted synthetic result must contain artifacts",
        });
      }
      if (classification.findings.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "an admitted synthetic result cannot contain findings",
        });
      }
    } else {
      if (classification.admitted.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["admitted"],
          message: "an excluded synthetic result cannot admit artifacts",
        });
      }
      if (classification.findings.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "an excluded synthetic result must contain findings",
        });
      }
    }
  });

type SyntheticArtifact = z.infer<typeof SyntheticMethodologyArtifactSchema>;
type SyntheticFinding = z.infer<typeof SyntheticMethodologyFindingSchema>;
type SyntheticFindingCode = z.infer<typeof SyntheticMethodologyFindingCodeSchema>;
type SyntheticMethodologyInput = z.infer<typeof SyntheticMethodologyInputSchema>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareCodeUnits);
}

function evidenceIsBound(artifact: SyntheticArtifact): boolean {
  const { target } = artifact.evidence;
  return (
    target.artifact === artifact.id &&
    target.path === artifact.path &&
    target.contentDigest === artifact.content.digest &&
    target.sourceIdentity.locator === artifact.sourceIdentity.locator &&
    target.sourceIdentity.digest === artifact.sourceIdentity.digest
  );
}

function artifactFindings(artifact: SyntheticArtifact): SyntheticFindingCode[] {
  const findings: SyntheticFindingCode[] = [];
  if (
    artifact.kind === "symlink" ||
    artifact.kind === "hard-link" ||
    artifact.kind === "reparse-point"
  ) {
    findings.push("METHODOLOGY_SYNTHETIC_LINKED");
  } else if (artifact.kind !== "regular") {
    findings.push("METHODOLOGY_SYNTHETIC_NON_REGULAR");
  }
  if (!evidenceIsBound(artifact)) findings.push("METHODOLOGY_SYNTHETIC_EVIDENCE_UNBOUND");
  if (artifact.content.classification === "executable") {
    findings.push("METHODOLOGY_SYNTHETIC_EXECUTABLE");
  }
  if (artifact.content.classification === "ambiguous") {
    findings.push("METHODOLOGY_SYNTHETIC_AMBIGUOUS");
  }
  if (artifact.evidence.source === "drifted") findings.push("METHODOLOGY_SYNTHETIC_DRIFTED");
  if (artifact.evidence.trust === "held") findings.push("METHODOLOGY_SYNTHETIC_HELD");
  if (artifact.evidence.license === "unlicensed") findings.push("METHODOLOGY_SYNTHETIC_UNLICENSED");
  return findings;
}

function canonicalFindings(findings: Map<string, SyntheticFinding>): SyntheticFinding[] {
  return [...findings.values()].sort(
    (left, right) =>
      compareCodeUnits(left.artifact, right.artifact) || compareCodeUnits(left.code, right.code),
  );
}

/**
 * Classify only synthetic, caller-supplied records. This module deliberately has no
 * filesystem, process, provider, host, or network capability.
 */
export function classifySyntheticMethodology(value: unknown) {
  const input: SyntheticMethodologyInput = SyntheticMethodologyInputSchema.parse(value);
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const paths = new Map<string, number>();
  const sourceLocators = new Map<string, number>();
  for (const artifact of input.artifacts) {
    paths.set(artifact.path, (paths.get(artifact.path) ?? 0) + 1);
    sourceLocators.set(
      artifact.sourceIdentity.locator,
      (sourceLocators.get(artifact.sourceIdentity.locator) ?? 0) + 1,
    );
  }
  const roots = new Set(input.roots);
  const findings = new Map<string, SyntheticFinding>();
  const visited = new Set<string>();
  const pending = sortStrings(roots).reverse();

  function exclude(code: SyntheticFindingCode, artifact: string): void {
    findings.set(`${artifact}\u0000${code}`, { code, disposition: "excluded", artifact });
  }

  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const artifact = artifacts.get(id);
    if (artifact === undefined) {
      exclude("METHODOLOGY_SYNTHETIC_ARTIFACT_MISSING", id);
      continue;
    }

    if ((paths.get(artifact.path) ?? 0) > 1) {
      exclude("METHODOLOGY_SYNTHETIC_PATH_AMBIGUOUS", artifact.id);
    }
    if ((sourceLocators.get(artifact.sourceIdentity.locator) ?? 0) > 1) {
      exclude("METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS", artifact.id);
    }
    for (const code of artifactFindings(artifact)) exclude(code, artifact.id);
    for (const dependency of sortStrings(artifact.dependencies).reverse()) {
      if (!artifacts.has(dependency)) {
        exclude("METHODOLOGY_SYNTHETIC_DEPENDENCY_MISSING", dependency);
      } else if (!roots.has(dependency)) {
        exclude("METHODOLOGY_SYNTHETIC_OUT_OF_CLOSURE", dependency);
      } else {
        pending.push(dependency);
      }
    }
  }

  const canonical = canonicalFindings(findings);
  return SyntheticMethodologyClassificationSchema.parse({
    schemaVersion: 1,
    disposition: canonical.length === 0 ? "admitted" : "excluded",
    admitted: canonical.length === 0 ? sortStrings(roots) : [],
    findings: canonical,
  });
}
