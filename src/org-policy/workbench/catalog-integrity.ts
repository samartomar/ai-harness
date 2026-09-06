import { createHash } from "node:crypto";
import { canonicalStrictJsonSha256V1 } from "../../contract/strict-json-v1.js";
import type { AuthoringCatalogBundleV1 } from "./contracts.js";

export function authoringCatalogDigestV1(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Core-only integrity gate for prepared catalog payloads. Browser consumers read
 * the prepared bundle; they neither hash nor grant trust to it.
 */
export function verifyAuthoringCatalogBundleIntegrityV1(bundle: AuthoringCatalogBundleV1): void {
  for (const [chunkId, chunk] of Object.entries(bundle.detailChunks)) {
    if (authoringCatalogDigestV1(chunk.bytes) !== chunk.digest)
      throw new Error(`detail chunk digest mismatch: ${chunkId}`);
  }
  const { bundleDigest: declaredDigest, ...provenance } = bundle.provenance;
  const expectedDigest = `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance })}`;
  if (declaredDigest !== expectedDigest) throw new Error("bundle digest mismatch");
}
