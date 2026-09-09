import { createHash } from "node:crypto";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../contract/strict-json-v1.js";
import type { PreparedEccRuntimeDescriptorV1 } from "../ecc/runtime-descriptor.js";
import type { AuthoringCatalogBundleV1 } from "../org-policy/workbench/contracts.js";
import { PackagedSourceDataRecordV1Schema } from "../org-policy/workbench/core/packaged-source-data-record.js";
import { readSourceDataProofBlobV1 } from "../org-policy/workbench/core/source-data-proof-blobs.js";
import {
  SourceDataScannerProofV1Schema,
  sealPreparedEccRuntimeDescriptorV1,
} from "../org-policy/workbench/core/source-data-scanner.js";
import { sourceCompilerTemplateV1 } from "./workbench-source-data-material.js";

/** Encode already verified preparation for the mandatory connected release replay. */
export function preparePackagedWorkbenchSourceDataV1(input: {
  sourceBundle: AuthoringCatalogBundleV1;
  proof: unknown;
  compilerInput: unknown;
  proofRoot: string;
  source: { repository: string; commit: string };
  updateKind?: "evidence-only";
  runtimeDescriptor?: PreparedEccRuntimeDescriptorV1;
}) {
  const proof = SourceDataScannerProofV1Schema.parse(input.proof);
  const compilerBytes = canonicalStrictJsonBytesV1(input.compilerInput);
  const compilerDigest = createHash("sha256").update(compilerBytes).digest("hex");
  const compilerReference = proof.compilerInput as {
    version?: string;
    sha256?: string;
    bytes?: number;
  };
  if (
    compilerReference.version !== "source-compiler-input-blob/v1" ||
    compilerReference.sha256 !== compilerDigest ||
    compilerReference.bytes !== compilerBytes.length
  )
    throw new TypeError("Packaged compiler input does not match its original proof");
  const inlineBlobs: { sha256: string; bytes: number; bytesBase64: string }[] = [];
  const publicationBlobs: { sha256: string; bytes: number; url: string }[] = [];
  for (const batch of proof.batches) {
    if (!("version" in batch))
      throw new TypeError("Package preparation requires bounded proof blob references");
    const discoveryBytes = readSourceDataProofBlobV1(batch.discovery, input.proofRoot, 8_192);
    const attestationBytes = readSourceDataProofBlobV1(batch.attestation, input.proofRoot, 512_000);
    readSourceDataProofBlobV1(batch.publication, input.proofRoot, 12_000_000);
    const discovery = JSON.parse(discoveryBytes.toString("utf8"));
    if (typeof discovery.locator !== "string")
      throw new TypeError("Original publication locator missing");
    inlineBlobs.push(
      {
        sha256: batch.discovery.sha256,
        bytes: batch.discovery.bytes,
        bytesBase64: discoveryBytes.toString("base64"),
      },
      {
        sha256: batch.attestation.sha256,
        bytes: batch.attestation.bytes,
        bytesBase64: attestationBytes.toString("base64"),
      },
    );
    publicationBlobs.push({
      sha256: batch.publication.sha256,
      bytes: batch.publication.bytes,
      url: discovery.locator,
    });
  }
  const record = PackagedSourceDataRecordV1Schema.parse({
    version: "packaged-workbench-source-data/v1",
    sourceBundle: input.sourceBundle,
    ...(input.updateKind ? { updateKind: input.updateKind } : {}),
    source: input.source,
    scannerProof: proof,
    compilerTemplate: sourceCompilerTemplateV1(input.compilerInput),
    ...(input.runtimeDescriptor === undefined
      ? {}
      : { runtimeDescriptor: sealPreparedEccRuntimeDescriptorV1(input.runtimeDescriptor) }),
    inlineBlobs,
    publicationBlobs,
  });
  return {
    bytes: canonicalStrictJsonBytesV1(record).toString("utf8"),
    sha256: canonicalStrictJsonSha256V1(record),
  };
}
