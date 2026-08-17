import { createHash } from "node:crypto";
import { z } from "zod";
import { hashComponentTree, hashSourceTree } from "../baseline-evidence/hash.js";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertSafeRelativePosixPathV1,
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";

const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase 64-hex SHA-256 digest");
const RawOccurrenceFingerprintSchema = z
  .string()
  .regex(/^raw-occurrence-v1:[0-9a-f]{64}$/, "must be a raw occurrence v1 fingerprint");
const SourceSealSchema = z
  .object({
    protocol: z.literal("SourceSealV1"),
    sourceTreeSha256: Sha256Schema,
    selectedClosureSha256: Sha256Schema,
    sealedSnapshotSha256: Sha256Schema,
  })
  .strict();
const PlatformSchema = z
  .object({
    os: z.enum(["linux", "darwin", "windows"]),
    architecture: z.enum(["amd64", "arm64"]),
    relevantFactsSha256: Sha256Schema,
  })
  .strict();
const ExpectedKeyContextSchema = z
  .object({
    protocol: z.string(),
    nativeAnalyzerIdentity: z.string(),
    observationConfigurationSha256: z.string(),
    platform: z
      .object({
        os: z.string(),
        architecture: z.string(),
        relevantFactsSha256: z.string(),
      })
      .strict(),
  })
  .strict();
const FactSchema = z
  .object({
    rawOccurrenceFingerprint: RawOccurrenceFingerprintSchema,
    multiplicity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const CoverageSchema = z
  .object({
    coverageKind: z.enum(["selected-closure", "source-tree"]),
    coverageSha256: Sha256Schema,
  })
  .strict();
const NativeObservationInputSchema = z
  .object({
    protocol: z.literal("NativeObservationV1"),
    sourceSeal: SourceSealSchema,
    nativeAnalyzerIdentity: z.string().regex(/^native\.[0-9a-f]{12}$/),
    observationConfigurationSha256: Sha256Schema,
    platform: PlatformSchema,
    facts: z.array(FactSchema).max(4_096),
    coverage: z.array(CoverageSchema).min(1).max(4_096),
  })
  .strict();

export interface SourceSealV1 {
  readonly protocol: "SourceSealV1";
  readonly sourceTreeSha256: string;
  readonly selectedClosureSha256: string;
  readonly sealedSnapshotSha256: string;
}

const SnapshotFileSchema = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
  })
  .strict();
const SealedSourceSnapshotSchema = z
  .object({
    protocol: z.literal("SealedSourceSnapshotV1"),
    sourceTreeSha256: Sha256Schema,
    selectedClosureSha256: Sha256Schema,
    sourceFiles: z.array(SnapshotFileSchema).min(1).max(100_000),
    selectedClosureFiles: z.array(SnapshotFileSchema).min(1).max(100_000),
  })
  .strict();
export interface SealedSourceSnapshotV1 {
  readonly protocol: "SealedSourceSnapshotV1";
  readonly sourceTreeSha256: string;
  readonly selectedClosureSha256: string;
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly selectedClosureFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly sealedSnapshotSha256: string;
}

export interface NativeObservationV1 {
  readonly protocol: "NativeObservationV1";
  readonly sourceSeal: SourceSealV1;
  readonly nativeAnalyzerIdentity: string;
  readonly observationConfigurationSha256: string;
  readonly platform: {
    readonly os: "linux" | "darwin" | "windows";
    readonly architecture: "amd64" | "arm64";
    readonly relevantFactsSha256: string;
  };
  readonly facts: readonly {
    readonly rawOccurrenceFingerprint: string;
    readonly multiplicity: number;
  }[];
  readonly coverage: readonly {
    readonly coverageKind: "selected-closure" | "source-tree";
    readonly coverageSha256: string;
  }[];
  readonly reuseScope: "local-optimization-only";
  readonly observationKeySha256: string;
  readonly resultSha256: string;
}

export type NativeObservationReuseV1 =
  | { readonly kind: "reusable-local" }
  | {
      readonly kind: "required";
      readonly code: "NATIVE_OBSERVATION_REQUIRED";
      readonly reason:
        | "source-bytes-unavailable"
        | "source-tree-mismatch"
        | "selected-closure-mismatch"
        | "invalid-observation"
        | "sealed-snapshot-required"
        | "sealed-snapshot-mismatch"
        | "expected-key-context-required"
        | "expected-key-context-mismatch";
    };

const observations = new WeakMap<object, Buffer>();
const snapshots = new WeakMap<object, Buffer>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function duplicate(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertSnapshotFiles(
  sourceFiles: readonly z.infer<typeof SnapshotFileSchema>[],
  selectedClosureFiles: readonly z.infer<typeof SnapshotFileSchema>[],
): void {
  const sourceByPath = new Map<string, z.infer<typeof SnapshotFileSchema>>();
  for (const source of sourceFiles) {
    assertSafeRelativePosixPathV1(source.path, "sealed source file path");
    if (sourceByPath.has(source.path))
      throw new TypeError(`duplicate sealed source file: ${source.path}`);
    sourceByPath.set(source.path, source);
  }
  const selectedPaths = new Set<string>();
  for (const selected of selectedClosureFiles) {
    assertSafeRelativePosixPathV1(selected.path, "selected closure file path");
    if (selectedPaths.has(selected.path))
      throw new TypeError(`duplicate selected closure file: ${selected.path}`);
    selectedPaths.add(selected.path);
    const source = sourceByPath.get(selected.path);
    if (
      source === undefined ||
      source.bytes !== selected.bytes ||
      source.sha256 !== selected.sha256
    ) {
      throw new TypeError(
        `selected closure file is inconsistent with source inventory: ${selected.path}`,
      );
    }
  }
}

function sortSnapshotFiles(values: readonly z.infer<typeof SnapshotFileSchema>[]) {
  return [...values].sort((left, right) => codeUnitCompare(left.path, right.path));
}

export function createSealedSourceSnapshotV1(input: unknown): SealedSourceSnapshotV1 {
  assertStrictJsonValueV1(input, "sealed source snapshot");
  const parsed = SealedSourceSnapshotSchema.parse(clone(input));
  assertSnapshotFiles(parsed.sourceFiles, parsed.selectedClosureFiles);
  const sourceFiles = sortSnapshotFiles(parsed.sourceFiles);
  const selectedClosureFiles = sortSnapshotFiles(parsed.selectedClosureFiles);
  const result = deepFreezeStrictJsonV1({
    protocol: parsed.protocol,
    sourceTreeSha256: parsed.sourceTreeSha256,
    selectedClosureSha256: parsed.selectedClosureSha256,
    sourceFiles,
    selectedClosureFiles,
    sealedSnapshotSha256: canonicalStrictJsonSha256V1({
      domain: "aih.sealed-source-snapshot-v1",
      protocol: parsed.protocol,
      sourceTreeSha256: parsed.sourceTreeSha256,
      selectedClosureSha256: parsed.selectedClosureSha256,
      sourceFiles,
      selectedClosureFiles,
    }),
  });
  snapshots.set(result, canonicalStrictJsonBytesV1(result));
  return result;
}

export function describeNativeObservationSourceV1(input: {
  readonly sourceRoot: string;
  readonly selectedClosurePaths: readonly string[];
}): SealedSourceSnapshotV1 {
  const tree = hashSourceTree(input.sourceRoot);
  const closure = hashComponentTree(input.sourceRoot, input.selectedClosurePaths);
  return createSealedSourceSnapshotV1({
    protocol: "SealedSourceSnapshotV1",
    sourceTreeSha256: tree.treeSha256,
    selectedClosureSha256: closure.treeSha256,
    sourceFiles: tree.files,
    selectedClosureFiles: closure.files,
  });
}

export function canonicalSealedSourceSnapshotBytesV1(value: SealedSourceSnapshotV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? snapshots.get(value) : undefined;
  if (bytes === undefined)
    throw new TypeError(
      "sealed source snapshot canonical bytes require a validated branded snapshot",
    );
  return Buffer.from(bytes);
}

function sealFromHashes(
  sourceTreeSha256: string,
  selectedClosureSha256: string,
  sealedSnapshotSha256: string,
): SourceSealV1 {
  return deepFreezeStrictJsonV1({
    protocol: "SourceSealV1" as const,
    sourceTreeSha256,
    selectedClosureSha256,
    sealedSnapshotSha256,
  });
}

export function sealNativeObservationSourceV1(input: {
  readonly sourceRoot: string;
  readonly selectedClosurePaths: readonly string[];
}): SourceSealV1 {
  const snapshot = describeNativeObservationSourceV1(input);
  return sealFromHashes(
    snapshot.sourceTreeSha256,
    snapshot.selectedClosureSha256,
    snapshot.sealedSnapshotSha256,
  );
}

function keyMaterial(input: z.infer<typeof NativeObservationInputSchema>): unknown {
  return {
    domain: "aih.native-observation-v1.key",
    protocol: input.protocol,
    sourceTreeSha256: input.sourceSeal.sourceTreeSha256,
    selectedClosureSha256: input.sourceSeal.selectedClosureSha256,
    sealedSnapshotSha256: input.sourceSeal.sealedSnapshotSha256,
    nativeAnalyzerIdentity: input.nativeAnalyzerIdentity,
    observationConfigurationSha256: input.observationConfigurationSha256,
    platform: input.platform,
  };
}

export function createNativeObservationV1(input: unknown): NativeObservationV1 {
  assertStrictJsonValueV1(input, "native observation");
  const parsed = NativeObservationInputSchema.parse(clone(input));
  duplicate(
    parsed.facts.map((fact) => fact.rawOccurrenceFingerprint),
    "raw occurrence fingerprint",
  );
  duplicate(
    parsed.coverage.map((coverage) => coverage.coverageKind),
    "coverage kind",
  );
  const facts = [...parsed.facts].sort((left, right) =>
    codeUnitCompare(left.rawOccurrenceFingerprint, right.rawOccurrenceFingerprint),
  );
  const coverage = [...parsed.coverage].sort((left, right) =>
    codeUnitCompare(left.coverageKind, right.coverageKind),
  );
  const observationKeySha256 = canonicalStrictJsonSha256V1(keyMaterial(parsed));
  const resultSha256 = canonicalStrictJsonSha256V1({
    domain: "aih.native-observation-v1.result",
    observationKeySha256,
    facts,
    coverage,
  });
  const observation = deepFreezeStrictJsonV1({
    protocol: parsed.protocol,
    sourceSeal: sealFromHashes(
      parsed.sourceSeal.sourceTreeSha256,
      parsed.sourceSeal.selectedClosureSha256,
      parsed.sourceSeal.sealedSnapshotSha256,
    ),
    nativeAnalyzerIdentity: parsed.nativeAnalyzerIdentity,
    observationConfigurationSha256: parsed.observationConfigurationSha256,
    platform: clone(parsed.platform),
    facts: clone(facts),
    coverage: clone(coverage),
    reuseScope: "local-optimization-only" as const,
    observationKeySha256,
    resultSha256,
  });
  observations.set(observation, canonicalStrictJsonBytesV1(observation));
  return observation;
}

export function parseNativeObservationV1Json(text: string): NativeObservationV1 {
  return createNativeObservationV1(parseStrictJsonObjectV1(text, "native observation"));
}

export function canonicalNativeObservationBytesV1(value: NativeObservationV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? observations.get(value) : undefined;
  if (bytes === undefined) {
    throw new TypeError(
      "native observation canonical bytes require a validated branded observation",
    );
  }
  return Buffer.from(bytes);
}

export function canonicalNativeObservationSha256V1(value: NativeObservationV1): string {
  return createHash("sha256").update(canonicalNativeObservationBytesV1(value)).digest("hex");
}

function required(
  reason: Extract<NativeObservationReuseV1, { readonly kind: "required" }>["reason"],
): NativeObservationReuseV1 {
  return { kind: "required", code: "NATIVE_OBSERVATION_REQUIRED", reason };
}

type ExpectedKeyContextV1 = z.infer<typeof ExpectedKeyContextSchema>;

function isExpectedKeyContextV1(value: unknown): value is ExpectedKeyContextV1 {
  try {
    assertStrictJsonValueV1(value, "expected native observation key context");
    ExpectedKeyContextSchema.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function assessNativeObservationReuseV1(input: {
  readonly observation: unknown;
  readonly sourceRoot: string;
  readonly selectedClosurePaths: readonly string[];
  readonly sealedSnapshot: SealedSourceSnapshotV1;
  readonly expectedKeyContext: ExpectedKeyContextV1;
}): NativeObservationReuseV1 {
  if (
    typeof input.observation !== "object" ||
    input.observation === null ||
    !observations.has(input.observation)
  ) {
    return required("invalid-observation");
  }
  const observation = input.observation as NativeObservationV1;
  if (
    typeof input.sealedSnapshot !== "object" ||
    input.sealedSnapshot === null ||
    !snapshots.has(input.sealedSnapshot)
  ) {
    return required("sealed-snapshot-required");
  }
  if (!isExpectedKeyContextV1(input.expectedKeyContext))
    return required("expected-key-context-required");
  const expected = input.expectedKeyContext;
  if (
    expected.protocol !== observation.protocol ||
    expected.nativeAnalyzerIdentity !== observation.nativeAnalyzerIdentity ||
    expected.observationConfigurationSha256 !== observation.observationConfigurationSha256 ||
    expected.platform.os !== observation.platform.os ||
    expected.platform.architecture !== observation.platform.architecture ||
    expected.platform.relevantFactsSha256 !== observation.platform.relevantFactsSha256
  )
    return required("expected-key-context-mismatch");
  const sealedSnapshot = input.sealedSnapshot;
  let actualSnapshot: SealedSourceSnapshotV1;
  try {
    actualSnapshot = describeNativeObservationSourceV1({
      sourceRoot: input.sourceRoot,
      selectedClosurePaths: input.selectedClosurePaths,
    });
  } catch {
    return required("source-bytes-unavailable");
  }
  if (sealedSnapshot.sealedSnapshotSha256 !== actualSnapshot.sealedSnapshotSha256)
    return required("sealed-snapshot-mismatch");
  if (actualSnapshot.selectedClosureSha256 !== observation.sourceSeal.selectedClosureSha256) {
    return required("selected-closure-mismatch");
  }
  if (actualSnapshot.sourceTreeSha256 !== observation.sourceSeal.sourceTreeSha256) {
    return required("source-tree-mismatch");
  }
  if (observation.sourceSeal.sealedSnapshotSha256 !== sealedSnapshot.sealedSnapshotSha256)
    return required("sealed-snapshot-mismatch");
  return { kind: "reusable-local" };
}
