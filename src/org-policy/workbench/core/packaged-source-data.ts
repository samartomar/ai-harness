import { SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 } from "../../../baseline-evidence/scanner-publication-policy.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../../../contract/strict-json-v1.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../catalog-integrity.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
import type {
  PreparedWorkbenchCatalogV1,
  PrepareWorkbenchCatalogOptionsV1,
} from "../prepared-catalog.js";
import { PACKAGED_WORKBENCH_SOURCE_DATA_V1 } from "./packaged-source-data-data.js";
import {
  type PackagedSourceDataRecordV1,
  PackagedSourceDataRecordV1Schema,
} from "./packaged-source-data-record.js";
import { applyPackagedWorkbenchSourceBundlesV1 } from "./source-data.js";

let cached: readonly PackagedSourceDataRecordV1[] | undefined;
const sealedIdentityByRecord = new WeakMap<PackagedSourceDataRecordV1, string>();
const PREPARED_OVERLAY_CACHE_LIMIT_V1 = 4;
type PreparedOverlayV1 = Readonly<Pick<PreparedWorkbenchCatalogV1, "bundle" | "bindings">>;
const preparedOverlays = new Map<string, PreparedOverlayV1>();
/** Only this package's literal sealed records can enter the offline bootstrap path. */
export function packagedWorkbenchSourceDataRecordsV1(): readonly PackagedSourceDataRecordV1[] {
  return structuredClone(verifiedPackagedWorkbenchSourceDataRecordsV1());
}

function verifiedPackagedWorkbenchSourceDataRecordsV1(): readonly PackagedSourceDataRecordV1[] {
  if (cached === undefined) {
    if (
      PACKAGED_WORKBENCH_SOURCE_DATA_V1.length > 64 ||
      PACKAGED_WORKBENCH_SOURCE_DATA_V1.reduce(
        (total, item) => total + Buffer.byteLength(item.bytes),
        0,
      ) >
        64 * 1024 * 1024
    )
      throw new TypeError("Packaged source inventory exceeds its byte budget");
    const seen = new Set<string>();
    const records = PACKAGED_WORKBENCH_SOURCE_DATA_V1.map((sealed) => {
      if (Buffer.byteLength(sealed.bytes) > 16 * 1024 * 1024)
        throw new TypeError("Packaged source data exceeds its byte budget");
      const value = parseStrictJsonObjectV1(sealed.bytes, "Packaged source data");
      if (
        canonicalStrictJsonBytesV1(value).toString("utf8") !== sealed.bytes ||
        canonicalStrictJsonSha256V1(value) !== sealed.sha256
      )
        throw new TypeError("Packaged source data seal mismatch");
      const record = PackagedSourceDataRecordV1Schema.parse(value);
      verifyAuthoringCatalogBundleIntegrityV1(record.sourceBundle);
      const sources = Object.values(record.sourceBundle.sources);
      const source = sources[0];
      if (sources.length !== 1 || !source || seen.has(source.id))
        throw new TypeError("Packaged source identity is ambiguous");
      if (
        source.upstreamOrigin.kind !== "aih" &&
        (source.upstreamOrigin.locator.replace(/^https:\/\/github\.com\//, "") !==
          record.source.repository ||
          source.revision.id !== record.source.commit)
      )
        throw new TypeError("Packaged source archive identity mismatch");
      seen.add(source.id);
      return record;
    });
    cached = deepFreezeStrictJsonV1(records) as readonly PackagedSourceDataRecordV1[];
    for (const [index, record] of cached.entries()) {
      const sealed = PACKAGED_WORKBENCH_SOURCE_DATA_V1[index];
      if (!sealed) throw new TypeError("Packaged source data identity is missing");
      sealedIdentityByRecord.set(record, sealed.sha256);
    }
  }
  return cached;
}

/** Package data is applied before independently authenticated user updates. */
export function applyPackagedWorkbenchSourceDataV1(
  base: PreparedWorkbenchCatalogV1,
  pins: PrepareWorkbenchCatalogOptionsV1["sourceDataPins"] = [],
): PreparedWorkbenchCatalogV1 {
  const records = verifiedPackagedWorkbenchSourceDataRecordsV1().filter((record) => {
    const sourceId = Object.keys(record.sourceBundle.sources)[0];
    if (!sourceId) throw new TypeError("Packaged source identity is missing");
    return pins
      .filter((pin) => pin.sourceId === sourceId)
      .every((pin) => {
        const asset = record.sourceBundle.assets[pin.assetId];
        return (
          asset?.sourceRevisionId === pin.sourceRevisionId &&
          asset.contentDigest === pin.contentDigest
        );
      });
  });
  if (records.length === 0) return base;
  const recordIdentities = records.map((record) => {
    const identity = sealedIdentityByRecord.get(record);
    if (!identity) throw new TypeError("Packaged source data identity is missing");
    return identity;
  });
  const key = canonicalStrictJsonSha256V1({
    bundle: base.bundle,
    bindings: base.bindings,
    pins,
    recordIdentities,
  });
  const hit = preparedOverlays.get(key);
  if (hit !== undefined) {
    preparedOverlays.delete(key);
    preparedOverlays.set(key, hit);
    return detachedPreparedOverlay(base, hit);
  }
  const applied = applyPackagedWorkbenchSourceBundlesV1(base, records);
  const overlay = Object.freeze({
    bundle: deepFreezeStrictJsonV1(
      structuredClone(applied.bundle),
    ) as PreparedWorkbenchCatalogV1["bundle"],
    bindings: deepFreezeStrictJsonV1(
      structuredClone(applied.bindings),
    ) as PreparedWorkbenchCatalogV1["bindings"],
  });
  preparedOverlays.set(key, overlay);
  if (preparedOverlays.size > PREPARED_OVERLAY_CACHE_LIMIT_V1) {
    const oldest = preparedOverlays.keys().next().value;
    if (oldest === undefined) throw new TypeError("Prepared package overlay cache eviction");
    preparedOverlays.delete(oldest);
  }
  return detachedPreparedOverlay(base, overlay);
}

function detachedPreparedOverlay(
  base: PreparedWorkbenchCatalogV1,
  overlay: PreparedOverlayV1,
): PreparedWorkbenchCatalogV1 {
  return {
    ...base,
    bundle: structuredClone(overlay.bundle),
    bindings: structuredClone(overlay.bindings),
  };
}

/** Publication identities for package reports actually present in the displayed catalog. */
export function packagedWorkbenchSourcePublicationsV1(bundle: AuthoringCatalogBundleV1) {
  return packagedWorkbenchSourceDataRecordsV1().flatMap((record) => {
    const included = Object.values(record.sourceBundle.evidence).some(
      (evidence) =>
        canonicalStrictJsonSha256V1(bundle.evidence[evidence.id] ?? null) ===
        canonicalStrictJsonSha256V1(evidence),
    );
    if (!included) return [];
    const proof = record.scannerProof;
    if (!proof || typeof proof !== "object" || !("publisherCommit" in proof))
      throw new TypeError("Packaged Scanner publisher is missing");
    const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.find(
      (candidate) => candidate.commit === proof.publisherCommit,
    );
    if (!publisher) throw new TypeError("Unknown packaged Scanner publisher");
    return record.publicationBlobs.map((publication) => ({
      source: record.source.repository,
      publisher: publisher.repository,
      commit: publisher.commit,
      digest: `sha256:${publication.sha256}`,
    }));
  });
}
