import { z } from "zod";

const ArtifactIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SyntheticPathSchema = z
  .string()
  .regex(/^(?!\/)(?!.*\\\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]+$/);

export const SyntheticArtifactKindSchema = z.enum([
  "regular",
  "directory",
  "symlink",
  "hard-link",
  "reparse-point",
]);
export const SyntheticContentSchema = z.enum(["passive", "ambiguous", "executable"]);
export const SyntheticEvidenceSchema = z
  .object({
    source: z.enum(["exact", "drifted"]),
    trust: z.enum(["admitted", "held"]),
    license: z.enum(["allowed", "unlicensed"]),
  })
  .strict();

export const SyntheticMethodologyArtifactSchema = z
  .object({
    id: ArtifactIdSchema,
    path: SyntheticPathSchema,
    kind: SyntheticArtifactKindSchema,
    content: SyntheticContentSchema,
    evidence: SyntheticEvidenceSchema,
    dependencies: z.array(ArtifactIdSchema).max(32),
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
    roots: z.array(ArtifactIdSchema).min(1).max(32),
    artifacts: z.array(SyntheticMethodologyArtifactSchema).min(1).max(64),
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
  "METHODOLOGY_SYNTHETIC_EXECUTABLE",
  "METHODOLOGY_SYNTHETIC_HELD",
  "METHODOLOGY_SYNTHETIC_LINKED",
  "METHODOLOGY_SYNTHETIC_NON_REGULAR",
  "METHODOLOGY_SYNTHETIC_OUT_OF_CLOSURE",
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
    admitted: z.array(ArtifactIdSchema),
    findings: z.array(SyntheticMethodologyFindingSchema),
  })
  .strict();

type SyntheticArtifact = z.infer<typeof SyntheticMethodologyArtifactSchema>;
type SyntheticFinding = z.infer<typeof SyntheticMethodologyFindingSchema>;
type SyntheticFindingCode = z.infer<typeof SyntheticMethodologyFindingCodeSchema>;
type SyntheticMethodologyInput = z.infer<typeof SyntheticMethodologyInputSchema>;

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
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
  if (artifact.content === "executable") findings.push("METHODOLOGY_SYNTHETIC_EXECUTABLE");
  if (artifact.content === "ambiguous") findings.push("METHODOLOGY_SYNTHETIC_AMBIGUOUS");
  if (artifact.evidence.source === "drifted") findings.push("METHODOLOGY_SYNTHETIC_DRIFTED");
  if (artifact.evidence.trust === "held") findings.push("METHODOLOGY_SYNTHETIC_HELD");
  if (artifact.evidence.license === "unlicensed") findings.push("METHODOLOGY_SYNTHETIC_UNLICENSED");
  return findings;
}

function canonicalFindings(findings: Map<string, SyntheticFinding>): SyntheticFinding[] {
  return [...findings.values()].sort(
    (left, right) =>
      left.artifact.localeCompare(right.artifact) || left.code.localeCompare(right.code),
  );
}

/**
 * Classify only synthetic, caller-supplied records. This module deliberately has no
 * filesystem, process, provider, host, or network capability.
 */
export function classifySyntheticMethodology(value: unknown) {
  const input: SyntheticMethodologyInput = SyntheticMethodologyInputSchema.parse(value);
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
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
