import { isProxy } from "node:util/types";
import { z } from "zod";

const MAX_REQUESTED_COMPONENTS = 32;
const MAX_ARTIFACTS = 64;
const MAX_DEPENDENCIES_PER_ARTIFACT = 32;
const MAX_GRAPH_EDGES = 2_048;
const MAX_LOCATOR_LENGTH = 512;
const MAX_FINDINGS = 256;
const MAX_SNAPSHOT_ARRAY_LENGTH = MAX_FINDINGS;
const MAX_SNAPSHOT_RECORD_KEYS = 16;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 512;

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

const SyntheticArtifactObjectSchema = z
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

export const SyntheticArtifactSchema = z.preprocess(
  (value) => failClosedPreprocess(value, artifactCollectionsAreBounded),
  SyntheticArtifactObjectSchema,
);

const SyntheticEvidenceObjectSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    sourceLocator: SourceLocatorSchema,
    contentDigest: DigestSchema,
    licenseDisposition: LicenseDispositionSchema,
    evidenceDigest: DigestSchema,
  })
  .strict();

export const SyntheticEvidenceSchema = z.preprocess(
  (value) => failClosedPreprocess(value, evidenceRecordIsClosed),
  SyntheticEvidenceObjectSchema,
);

const SyntheticClassifierInputObjectSchema = z
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

export const SyntheticClassifierInputSchema = z.preprocess(
  (value) => failClosedPreprocess(value, classifierCollectionsAreBounded),
  SyntheticClassifierInputObjectSchema,
);

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

const SyntheticFindingObjectSchema = z
  .object({
    code: SyntheticFindingCodeSchema,
    artifactId: ArtifactIdSchema.optional(),
  })
  .strict();

export const SyntheticFindingSchema = z.preprocess(
  (value) => failClosedPreprocess(value, findingRecordIsClosed),
  SyntheticFindingObjectSchema,
);

const GLOBAL_FINDING_CODES = new Set<z.infer<typeof SyntheticFindingCodeSchema>>([
  "METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE",
  "METHODOLOGY_FINDINGS_LIMIT",
  "METHODOLOGY_REQUEST_DUPLICATE",
]);

type SnapshotResult = { ok: true; value: unknown } | { ok: false };
type SnapshotState = { nodes: number; active: WeakSet<object> };

const INVALID_SNAPSHOT = Object.freeze({ ok: false as const });

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

function snapshotPlainData(value: unknown, depth: number, state: SnapshotState): SnapshotResult {
  const surface = snapshotSurface(value);
  if (!surface.ok) return INVALID_SNAPSHOT;
  if (value === null || typeof value !== "object") return surface;
  if (depth >= MAX_SNAPSHOT_DEPTH || state.nodes >= MAX_SNAPSHOT_NODES) {
    return INVALID_SNAPSHOT;
  }
  if (state.active.has(value)) return INVALID_SNAPSHOT;
  state.nodes += 1;
  state.active.add(value);
  try {
    if (Array.isArray(surface.value)) {
      const snapshot: unknown[] = [];
      for (let index = 0; index < surface.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(surface.value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) return INVALID_SNAPSHOT;
        const child = snapshotPlainData(descriptor.value, depth + 1, state);
        if (!child.ok) return INVALID_SNAPSHOT;
        snapshot.push(child.value);
      }
      return { ok: true, value: snapshot };
    }
    const record = recordOf(surface.value);
    if (record === undefined) return INVALID_SNAPSHOT;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) return INVALID_SNAPSHOT;
      const child = snapshotPlainData(descriptor.value, depth + 1, state);
      if (!child.ok) return INVALID_SNAPSHOT;
      snapshot[key] = child.value;
    }
    return { ok: true, value: snapshot };
  } finally {
    state.active.delete(value);
  }
}

function staticRecordOf(value: unknown): Record<string, unknown> | undefined {
  const surface = snapshotSurface(value);
  return surface.ok ? recordOf(surface.value) : undefined;
}

function recordFieldsAreOwn(value: unknown, fields: readonly string[]): boolean {
  const record = staticRecordOf(value);
  return record === undefined || fields.every((field) => Object.hasOwn(record, field));
}

function collectionIsBounded(value: unknown, maximum: number): boolean {
  if (isProxy(value)) return false;
  if (!Array.isArray(value)) return true;
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
  }
  return true;
}

function collectionRecordsSatisfy(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  if (!Array.isArray(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !predicate(descriptor.value)) {
      return false;
    }
  }
  return true;
}

function failClosedPreprocess(value: unknown, predicate: (candidate: unknown) => boolean): unknown {
  const surface = snapshotSurface(value);
  if (!surface.ok || !predicate(surface.value)) return null;
  const snapshot = snapshotPlainData(surface.value, 0, {
    nodes: 0,
    active: new WeakSet<object>(),
  });
  return snapshot.ok ? snapshot.value : null;
}

function artifactCollectionsAreBounded(value: unknown): boolean {
  const artifact = staticRecordOf(value);
  if (artifact === undefined) return true;
  return (
    recordFieldsAreOwn(artifact, [
      "id",
      "sourceLocator",
      "contentDigest",
      "contentDisposition",
      "linkDisposition",
      "licenseDisposition",
      "evidenceDigest",
      "dependencies",
    ]) && collectionIsBounded(artifact.dependencies, MAX_DEPENDENCIES_PER_ARTIFACT)
  );
}

function evidenceRecordIsClosed(value: unknown): boolean {
  return recordFieldsAreOwn(value, [
    "artifactId",
    "sourceLocator",
    "contentDigest",
    "licenseDisposition",
    "evidenceDigest",
  ]);
}

function findingRecordIsClosed(value: unknown): boolean {
  return recordFieldsAreOwn(value, ["code"]);
}

function classifierCollectionsAreBounded(value: unknown): boolean {
  const input = staticRecordOf(value);
  if (input === undefined) return true;
  return (
    recordFieldsAreOwn(input, [
      "schemaVersion",
      "requested",
      "declaredClosure",
      "artifacts",
      "evidence",
    ]) &&
    collectionIsBounded(input.requested, MAX_REQUESTED_COMPONENTS) &&
    collectionIsBounded(input.declaredClosure, MAX_ARTIFACTS) &&
    collectionIsBounded(input.artifacts, MAX_ARTIFACTS) &&
    collectionIsBounded(input.evidence, MAX_ARTIFACTS) &&
    collectionRecordsSatisfy(input.artifacts, artifactCollectionsAreBounded) &&
    collectionRecordsSatisfy(input.evidence, evidenceRecordIsClosed)
  );
}

function resultCollectionsAreBounded(value: unknown): boolean {
  const result = staticRecordOf(value);
  if (result === undefined) return true;
  return (
    recordFieldsAreOwn(result, [
      "schemaVersion",
      "disposition",
      "closure",
      "eligible",
      "findings",
    ]) &&
    collectionIsBounded(result.closure, MAX_ARTIFACTS) &&
    collectionIsBounded(result.eligible, MAX_ARTIFACTS) &&
    collectionIsBounded(result.findings, MAX_FINDINGS) &&
    collectionRecordsSatisfy(result.findings, findingRecordIsClosed)
  );
}

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

const SyntheticClassificationResultObjectSchema = z
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

export const SyntheticClassificationResultSchema = z.preprocess(
  (value) => failClosedPreprocess(value, resultCollectionsAreBounded),
  SyntheticClassificationResultObjectSchema,
);

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

function canonicalKey(parts: readonly string[]): string {
  let key = "";
  for (const part of parts) key += `${part.length}:${part};`;
  return key;
}

function canonicalArtifactKey(artifact: Artifact): string {
  return canonicalKey([
    artifact.id,
    artifact.sourceLocator,
    artifact.contentDigest,
    artifact.contentDisposition,
    artifact.linkDisposition,
    artifact.licenseDisposition,
    artifact.evidenceDigest,
    ...[...artifact.dependencies].sort(compareCodeUnits),
  ]);
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
