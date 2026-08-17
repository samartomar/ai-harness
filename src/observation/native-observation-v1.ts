import { createHash } from "node:crypto";
import { z } from "zod";
import { hashComponentTree, hashSourceTree } from "../baseline-evidence/hash.js";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
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
  })
  .strict();
const PlatformSchema = z
  .object({
    os: z.enum(["linux", "darwin"]),
    architecture: z.enum(["amd64", "arm64"]),
    relevantFactsSha256: Sha256Schema,
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
    facts: z.array(FactSchema).min(1).max(4_096),
    coverage: z.array(CoverageSchema).min(1).max(4_096),
  })
  .strict();

export interface SourceSealV1 {
  readonly protocol: "SourceSealV1";
  readonly sourceTreeSha256: string;
  readonly selectedClosureSha256: string;
}

export interface NativeObservationV1 {
  readonly protocol: "NativeObservationV1";
  readonly sourceSeal: SourceSealV1;
  readonly nativeAnalyzerIdentity: string;
  readonly observationConfigurationSha256: string;
  readonly platform: {
    readonly os: "linux" | "darwin";
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
        | "invalid-observation";
    };

const observations = new WeakMap<object, Buffer>();

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

function sealFromHashes(sourceTreeSha256: string, selectedClosureSha256: string): SourceSealV1 {
  return deepFreezeStrictJsonV1({
    protocol: "SourceSealV1" as const,
    sourceTreeSha256,
    selectedClosureSha256,
  });
}

export function sealNativeObservationSourceV1(input: {
  readonly sourceRoot: string;
  readonly selectedClosurePaths: readonly string[];
}): SourceSealV1 {
  const sourceTreeSha256 = hashSourceTree(input.sourceRoot).treeSha256;
  const selectedClosureSha256 = hashComponentTree(
    input.sourceRoot,
    input.selectedClosurePaths,
  ).treeSha256;
  return sealFromHashes(sourceTreeSha256, selectedClosureSha256);
}

function keyMaterial(input: z.infer<typeof NativeObservationInputSchema>): unknown {
  return {
    domain: "aih.native-observation-v1.key",
    protocol: input.protocol,
    sourceTreeSha256: input.sourceSeal.sourceTreeSha256,
    selectedClosureSha256: input.sourceSeal.selectedClosureSha256,
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

export function assessNativeObservationReuseV1(input: {
  readonly observation: unknown;
  readonly sourceRoot: string;
  readonly selectedClosurePaths: readonly string[];
}): NativeObservationReuseV1 {
  if (
    typeof input.observation !== "object" ||
    input.observation === null ||
    !observations.has(input.observation)
  ) {
    return required("invalid-observation");
  }
  const observation = input.observation as NativeObservationV1;
  let actual: SourceSealV1;
  try {
    actual = sealNativeObservationSourceV1({
      sourceRoot: input.sourceRoot,
      selectedClosurePaths: input.selectedClosurePaths,
    });
  } catch {
    return required("source-bytes-unavailable");
  }
  if (actual.selectedClosureSha256 !== observation.sourceSeal.selectedClosureSha256) {
    return required("selected-closure-mismatch");
  }
  if (actual.sourceTreeSha256 !== observation.sourceSeal.sourceTreeSha256) {
    return required("source-tree-mismatch");
  }
  return { kind: "reusable-local" };
}
