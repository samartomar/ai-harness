import { z } from "zod";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertSafeRelativePosixPathV1,
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 digest");
const sourceSeal = z
  .object({
    protocol: z.literal("SourceSealV1"),
    sourceTreeSha256: sha256,
    selectedClosureSha256: sha256,
  })
  .strict();
const platform = z
  .object({
    os: z.enum(["linux", "darwin"]),
    architecture: z.enum(["amd64", "arm64"]),
    relevantFactsSha256: sha256,
  })
  .strict();
const keyInput = z
  .object({
    protocol: z.literal("ObservationKeyV1"),
    sourceSeal,
    nativeAnalyzerIdentity: z.string().regex(/^native\.[0-9a-f]{12}$/),
    observationConfigurationSha256: sha256,
    platform,
    scannerManifestEntrySha256: sha256,
  })
  .strict();
const fact = z
  .object({
    rawOccurrenceFingerprint: z.string().regex(/^raw-occurrence-v1:[0-9a-f]{64}$/),
    multiplicity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const coverage = z
  .object({ coverageKind: z.enum(["selected-closure", "source-tree"]), coverageSha256: sha256 })
  .strict();
const setInput = z
  .object({
    protocol: z.literal("ObservationSetV1"),
    observationKey: keyInput,
    facts: z.array(fact).min(1).max(4096),
    coverage: z.array(coverage).min(1).max(16),
  })
  .strict();
const annexDescriptor = z
  .object({
    descriptorId: z.string().regex(/^annex\.[a-z0-9][a-z0-9.-]*$/),
    mediaType: z.enum(["application/json", "application/spdx+json"]),
    sha256,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    uri: z.string(),
  })
  .strict();
const annexInput = z
  .object({
    protocol: z.literal("EvidenceAnnexV1"),
    descriptors: z.array(annexDescriptor).min(1).max(128),
  })
  .strict();

export interface ObservationKeyV1 extends Readonly<z.infer<typeof keyInput>> {
  readonly observationKeySha256: string;
}
export interface ObservationSetV1 {
  readonly protocol: "ObservationSetV1";
  readonly observationKey: ObservationKeyV1;
  readonly facts: readonly z.infer<typeof fact>[];
  readonly coverage: readonly z.infer<typeof coverage>[];
  readonly observationSetSha256: string;
}
export interface EvidenceAnnexV1 {
  readonly protocol: "EvidenceAnnexV1";
  readonly descriptors: readonly z.infer<typeof annexDescriptor>[];
  readonly evidenceAnnexSha256: string;
}

const keys = new WeakMap<object, Buffer>();
const sets = new WeakMap<object, Buffer>();
const annexes = new WeakMap<object, Buffer>();

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate or ambiguous ${label}: ${value}`);
    seen.add(value);
  }
}

function createKey(parsed: z.infer<typeof keyInput>): ObservationKeyV1 {
  const result = deepFreezeStrictJsonV1({
    ...parsed,
    observationKeySha256: canonicalStrictJsonSha256V1({
      domain: "aih.observation-key-v1",
      key: parsed,
    }),
  });
  keys.set(result, canonicalStrictJsonBytesV1(result));
  return result;
}

export function createObservationKeyV1(input: unknown): ObservationKeyV1 {
  assertStrictJsonValueV1(input, "observation key");
  return createKey(keyInput.parse(structuredClone(input)));
}

export function parseObservationKeyV1Json(text: string): ObservationKeyV1 {
  return createObservationKeyV1(parseStrictJsonObjectV1(text, "observation key"));
}

export function canonicalObservationKeyBytesV1(value: ObservationKeyV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? keys.get(value) : undefined;
  if (bytes === undefined)
    throw new TypeError("observation key canonical bytes require a validated branded key");
  return Buffer.from(bytes);
}

function sortedFacts(values: readonly z.infer<typeof fact>[]): z.infer<typeof fact>[] {
  assertUnique(
    values.map((value) => value.rawOccurrenceFingerprint),
    "raw occurrence fingerprint",
  );
  return [...values].sort((left, right) =>
    codeUnitCompare(left.rawOccurrenceFingerprint, right.rawOccurrenceFingerprint),
  );
}

function sortedCoverage(values: readonly z.infer<typeof coverage>[]): z.infer<typeof coverage>[] {
  assertUnique(
    values.map((value) => value.coverageKind),
    "coverage kind",
  );
  return [...values].sort((left, right) => codeUnitCompare(left.coverageKind, right.coverageKind));
}

export function createObservationSetV1(input: unknown): ObservationSetV1 {
  assertStrictJsonValueV1(input, "observation set");
  const parsed = setInput.parse(structuredClone(input));
  const observationKey = createKey(parsed.observationKey);
  const facts = sortedFacts(parsed.facts);
  const coverage = sortedCoverage(parsed.coverage);
  const result = deepFreezeStrictJsonV1({
    protocol: parsed.protocol,
    observationKey,
    facts,
    coverage,
    observationSetSha256: canonicalStrictJsonSha256V1({
      domain: "aih.observation-set-v1",
      observationKeySha256: observationKey.observationKeySha256,
      facts,
      coverage,
    }),
  });
  sets.set(result, canonicalStrictJsonBytesV1(result));
  return result;
}

export function parseObservationSetV1Json(text: string): ObservationSetV1 {
  return createObservationSetV1(parseStrictJsonObjectV1(text, "observation set"));
}

export function canonicalObservationSetBytesV1(value: ObservationSetV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? sets.get(value) : undefined;
  if (bytes === undefined)
    throw new TypeError("observation set canonical bytes require a validated branded set");
  return Buffer.from(bytes);
}

function sortedDescriptors(
  values: readonly z.infer<typeof annexDescriptor>[],
): z.infer<typeof annexDescriptor>[] {
  for (const descriptor of values) assertSafeRelativePosixPathV1(descriptor.uri, "annex URI");
  assertUnique(
    values.map((value) => value.descriptorId),
    "annex descriptor ID",
  );
  return [...values].sort((left, right) => codeUnitCompare(left.descriptorId, right.descriptorId));
}

export function createEvidenceAnnexV1(input: unknown): EvidenceAnnexV1 {
  assertStrictJsonValueV1(input, "evidence annex");
  const parsed = annexInput.parse(structuredClone(input));
  const descriptors = sortedDescriptors(parsed.descriptors);
  const result = deepFreezeStrictJsonV1({
    protocol: parsed.protocol,
    descriptors,
    evidenceAnnexSha256: canonicalStrictJsonSha256V1({
      domain: "aih.evidence-annex-v1",
      descriptors,
    }),
  });
  annexes.set(result, canonicalStrictJsonBytesV1(result));
  return result;
}

export function parseEvidenceAnnexV1Json(text: string): EvidenceAnnexV1 {
  return createEvidenceAnnexV1(parseStrictJsonObjectV1(text, "evidence annex"));
}

export function canonicalEvidenceAnnexBytesV1(value: EvidenceAnnexV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? annexes.get(value) : undefined;
  if (bytes === undefined)
    throw new TypeError("evidence annex canonical bytes require a validated branded annex");
  return Buffer.from(bytes);
}
