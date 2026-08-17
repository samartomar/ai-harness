import { z } from "zod";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 digest");
const platform = z
  .object({ os: z.enum(["linux", "darwin"]), architecture: z.enum(["amd64", "arm64"]) })
  .strict();
const ociImage = z
  .object({ reference: z.string(), sha256 })
  .strict()
  .superRefine((value, context) => {
    const match = /^([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+)@sha256:([0-9a-f]{64})$/.exec(
      value.reference,
    );
    if (match === null || match[2] !== value.sha256)
      context.addIssue({
        code: "custom",
        message: "OCI image must be an exact immutable digest reference",
      });
  });
const adapter = z
  .object({ identity: z.string().regex(/^adapter\.[0-9a-f]{12}$/), sha256 })
  .strict();
const sbom = z.object({ mediaType: z.literal("application/spdx+json"), sha256 }).strict();
const provenance = z
  .object({ mediaType: z.literal("application/vnd.in-toto+json"), sha256 })
  .strict();
const detectorInput = z
  .object({
    detectorId: z.string().regex(/^detector\.[a-z0-9][a-z0-9.-]*$/),
    analyzerIdentity: z.string().regex(/^native\.[0-9a-f]{12}$/),
    ociImage,
    adapter,
    observationConfigurationSha256: sha256,
    executionProfileSha256: sha256,
    supportedPlatforms: z.array(platform).min(1).max(16),
    sbom,
    provenance,
  })
  .strict();
const manifestInput = z
  .object({
    protocol: z.literal("ScannerManifestV1"),
    detectors: z.array(detectorInput).min(1).max(128),
  })
  .strict();

export type ScannerManifestEntryV1 = Readonly<
  z.infer<typeof detectorInput> & { readonly scannerManifestEntrySha256: string }
>;
export interface ScannerManifestV1 {
  readonly protocol: "ScannerManifestV1";
  readonly detectors: readonly ScannerManifestEntryV1[];
  readonly scannerManifestSha256: string;
}

const manifests = new WeakMap<object, Buffer>();

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate or ambiguous ${label}: ${value}`);
    seen.add(value);
  }
}

function sortPlatforms(values: readonly z.infer<typeof platform>[]): z.infer<typeof platform>[] {
  const ordered = [...values].sort((left, right) =>
    codeUnitCompare(`${left.os}/${left.architecture}`, `${right.os}/${right.architecture}`),
  );
  assertUnique(
    ordered.map((value) => `${value.os}/${value.architecture}`),
    "supported platform",
  );
  return ordered;
}

function entryDigest(value: z.infer<typeof detectorInput>): string {
  return canonicalStrictJsonSha256V1({ domain: "aih.scanner-manifest-v1.entry", entry: value });
}

function entry(value: z.infer<typeof detectorInput>): ScannerManifestEntryV1 {
  const normalized = { ...value, supportedPlatforms: sortPlatforms(value.supportedPlatforms) };
  return { ...normalized, scannerManifestEntrySha256: entryDigest(normalized) };
}

export function createScannerManifestV1(input: unknown): ScannerManifestV1 {
  assertStrictJsonValueV1(input, "scanner manifest");
  const parsed = manifestInput.parse(structuredClone(input));
  assertUnique(
    parsed.detectors.map((value) => value.detectorId),
    "detector ID",
  );
  const detectors = parsed.detectors
    .map(entry)
    .sort((left, right) => codeUnitCompare(left.detectorId, right.detectorId));
  const scannerManifestSha256 = canonicalStrictJsonSha256V1({
    domain: "aih.scanner-manifest-v1.aggregate",
    protocol: parsed.protocol,
    detectors,
  });
  const result = deepFreezeStrictJsonV1({
    protocol: parsed.protocol,
    detectors,
    scannerManifestSha256,
  });
  manifests.set(result, canonicalStrictJsonBytesV1(result));
  return result;
}

export function parseScannerManifestV1Json(text: string): ScannerManifestV1 {
  return createScannerManifestV1(parseStrictJsonObjectV1(text, "scanner manifest"));
}

export function canonicalScannerManifestBytesV1(value: ScannerManifestV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? manifests.get(value) : undefined;
  if (bytes === undefined)
    throw new TypeError("scanner manifest canonical bytes require a validated branded manifest");
  return Buffer.from(bytes);
}

export function canonicalScannerManifestSha256V1(value: ScannerManifestV1): string {
  return canonicalStrictJsonSha256V1(
    JSON.parse(canonicalScannerManifestBytesV1(value).toString("utf8")),
  );
}
