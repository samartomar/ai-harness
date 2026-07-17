import { z } from "zod";

const MAX_REQUESTED_COMPONENTS = 32;
const MAX_ARTIFACTS = 64;
const MAX_DEPENDENCIES_PER_ARTIFACT = 32;
const MAX_GRAPH_EDGES = 2_048;
const MAX_LOCATOR_LENGTH = 512;
const MAX_FINDINGS = 256;

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

export const SyntheticArtifactSchema = z
  .object({
    id: ArtifactIdSchema,
    sourceLocator: SourceLocatorSchema,
    contentDigest: DigestSchema,
    contentDisposition: ContentDispositionSchema,
    linkDisposition: LinkDispositionSchema,
    licenseDisposition: LicenseDispositionSchema,
    evidenceDigest: DigestSchema,
    dependencies: z.array(ArtifactIdSchema).max(MAX_DEPENDENCIES_PER_ARTIFACT),
  })
  .strict();

export const SyntheticEvidenceSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    sourceLocator: SourceLocatorSchema,
    contentDigest: DigestSchema,
    licenseDisposition: LicenseDispositionSchema,
    evidenceDigest: DigestSchema,
  })
  .strict();

export const SyntheticClassifierInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    requested: z.array(ArtifactIdSchema).min(1).max(MAX_REQUESTED_COMPONENTS),
    declaredClosure: z.array(ArtifactIdSchema).min(1).max(MAX_ARTIFACTS),
    artifacts: z.array(SyntheticArtifactSchema).min(1).max(MAX_ARTIFACTS),
    evidence: z.array(SyntheticEvidenceSchema).max(MAX_ARTIFACTS),
  })
  .strict()
  .superRefine((input, ctx) => {
    const edgeCount = input.artifacts.reduce(
      (total, artifact) => total + artifact.dependencies.length,
      0,
    );
    if (edgeCount > MAX_GRAPH_EDGES) {
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "synthetic dependency graph exceeds the Phase 2 edge limit",
      });
    }
    for (const [index, artifact] of input.artifacts.entries()) {
      if (new Set(artifact.dependencies).size !== artifact.dependencies.length) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", index, "dependencies"],
          message: "synthetic artifact dependencies must be unique",
        });
      }
    }
  });

export const SyntheticFindingCodeSchema = z.enum([
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
]);

export const SyntheticFindingSchema = z
  .object({
    code: SyntheticFindingCodeSchema,
    artifactId: ArtifactIdSchema.optional(),
  })
  .strict();

const GLOBAL_FINDING_CODES = new Set<z.infer<typeof SyntheticFindingCodeSchema>>([
  "METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE",
  "METHODOLOGY_FINDINGS_LIMIT",
  "METHODOLOGY_REQUEST_DUPLICATE",
]);

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

function findingKey(finding: z.infer<typeof SyntheticFindingSchema>): string {
  return `${finding.code}\u0000${finding.artifactId ?? ""}`;
}

export const SyntheticClassificationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    disposition: z.enum(["eligible", "ineligible"]),
    closure: z.array(ArtifactIdSchema).max(MAX_ARTIFACTS),
    eligible: z.array(ArtifactIdSchema).max(MAX_ARTIFACTS),
    findings: z.array(SyntheticFindingSchema).max(MAX_FINDINGS),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (!isCanonicalUnique(result.closure)) {
      ctx.addIssue({
        code: "custom",
        path: ["closure"],
        message: "synthetic closure ids must be unique and code-unit canonicalized",
      });
    }
    if (!isCanonicalUnique(result.eligible)) {
      ctx.addIssue({
        code: "custom",
        path: ["eligible"],
        message: "eligible ids must be unique and code-unit canonicalized",
      });
    }
    const keys = result.findings.map(findingKey);
    if (!isCanonicalUnique(keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "findings must be unique and code-unit canonicalized",
      });
    }
    if (
      result.findings.some((finding) => finding.code === "METHODOLOGY_FINDINGS_LIMIT") &&
      (result.findings.length !== 1 || result.findings[0]?.code !== "METHODOLOGY_FINDINGS_LIMIT")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "the findings-limit denial must be the sole finding",
      });
    }
    if (
      (result.disposition === "eligible" &&
        (result.closure.length === 0 ||
          result.findings.length !== 0 ||
          !sameStrings(result.eligible, result.closure))) ||
      (result.disposition === "ineligible" &&
        (result.findings.length === 0 || result.eligible.length !== 0))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "eligibility result must bind its disposition, closure, eligible ids, and findings",
      });
    }
    for (const [index, finding] of result.findings.entries()) {
      const global = GLOBAL_FINDING_CODES.has(finding.code);
      if (
        (global && finding.artifactId !== undefined) ||
        (!global && finding.artifactId === undefined)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index, "artifactId"],
          message: "synthetic finding attribution must match its fixed finding code",
        });
      }
    }
  });

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

function canonicalArtifactKey(artifact: Artifact): string {
  return JSON.stringify({
    id: artifact.id,
    sourceLocator: artifact.sourceLocator,
    contentDigest: artifact.contentDigest,
    contentDisposition: artifact.contentDisposition,
    linkDisposition: artifact.linkDisposition,
    licenseDisposition: artifact.licenseDisposition,
    evidenceDigest: artifact.evidenceDigest,
    dependencies: [...artifact.dependencies].sort(compareCodeUnits),
  });
}

function canonicalEvidenceKey(evidence: Evidence): string {
  return JSON.stringify({
    artifactId: evidence.artifactId,
    sourceLocator: evidence.sourceLocator,
    contentDigest: evidence.contentDigest,
    licenseDisposition: evidence.licenseDisposition,
    evidenceDigest: evidence.evidenceDigest,
  });
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
