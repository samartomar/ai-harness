import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 } from "../baseline-evidence/scanner-publication-policy.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../contract/strict-json-v1.js";
import { inspectEccRuntimeDescriptorSealV1 } from "../ecc/runtime-descriptor.js";
import { packagedWorkbenchSourceDataRecordsV1 } from "../org-policy/workbench/core/packaged-source-data.js";
import { readSourceDataProofBlobV1 } from "../org-policy/workbench/core/source-data-proof-blobs.js";
import {
  prepareSourceDataScannerEvidenceV1,
  prepareSourceDataScannerRuntimeFactsV1,
  SourceDataScannerProofV1Schema,
  sealPreparedEccRuntimeDescriptorV1,
} from "../org-policy/workbench/core/source-data-scanner.js";
import {
  acquireBoundedGithubSourceArchiveV1,
  forgetAcquiredGithubSourceArchiveV1,
} from "./bounded-github-source-archive.js";
import { restoreSourceCompilerTemplateV1 } from "./workbench-source-data-material.js";

export function writePackagedSourceProofBlobV1(
  root: string,
  reference: { sha256: string; bytes: number },
  bytes: Buffer,
) {
  if (
    bytes.length === 0 ||
    bytes.length !== reference.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== reference.sha256
  )
    throw new TypeError("Packaged original proof identity mismatch");
  const path = join(root, `${reference.sha256}.blob`);
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    const existing = readSourceDataProofBlobV1(
      { sha256: reference.sha256, bytes: reference.bytes },
      root,
      reference.bytes,
    );
    if (!existing.equals(bytes)) throw new TypeError("Packaged original proof identity mismatch");
  }
}
async function download(url: string, maximum: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error("Original package publication unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error("Original package publication exceeds bounds");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

/** Connected release gate; the offline package loader never calls this function. */
export async function verifyPackagedWorkbenchSourceDataV1(
  progress?: (source: string, phase: "start" | "verified") => void,
): Promise<void> {
  for (const record of packagedWorkbenchSourceDataRecordsV1()) {
    if (record.runtimeDescriptor !== undefined)
      inspectEccRuntimeDescriptorSealV1(record.runtimeDescriptor);
    progress?.(record.source.repository, "start");
    const proof = SourceDataScannerProofV1Schema.parse(record.scannerProof);
    const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.find(
      (item) => item.commit === proof.publisherCommit,
    );
    if (!publisher) throw new TypeError("Unregistered package Scanner publisher");
    const root = mkdtempSync(join(tmpdir(), "aih-packaged-source-proof-"));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error("Unsafe packaged proof directory");
    const sourceRoot = join(root, "source"),
      proofRoot = join(root, "proof");
    mkdirSync(proofRoot);
    let stage = "source archive";
    try {
      await acquireBoundedGithubSourceArchiveV1({ ...record.source, destination: sourceRoot });
      stage = "compiler input reconstruction";
      const compilerBytes = canonicalStrictJsonBytesV1(
        restoreSourceCompilerTemplateV1(record.compilerTemplate, sourceRoot),
      );
      const compiler = proof.compilerInput as { version: string; sha256: string; bytes: number };
      if (compiler.version !== "source-compiler-input-blob/v1")
        throw new TypeError("Packaged compiler reference missing");
      writePackagedSourceProofBlobV1(proofRoot, compiler, compilerBytes);
      for (const blob of record.inlineBlobs) {
        const bytes = Buffer.from(blob.bytesBase64, "base64");
        if (bytes.toString("base64") !== blob.bytesBase64)
          throw new TypeError("Noncanonical packaged proof bytes");
        writePackagedSourceProofBlobV1(proofRoot, blob, bytes);
      }
      let total = compilerBytes.length;
      for (const blob of record.publicationBlobs) {
        stage = `publication ${blob.sha256}`;
        const prefix = `https://github.com/${publisher.repository}/releases/download/baseline-v1-${publisher.commit}-`;
        if (
          !blob.url.startsWith(prefix) ||
          !/^[a-f0-9]{64}(?:-r[0-9]{8})?\/publication\.json$/.test(blob.url.slice(prefix.length)) ||
          blob.bytes > 12_000_000
        )
          throw new TypeError("Invalid immutable package publication locator");
        total += blob.bytes;
        if (total > 128 * 1024 * 1024) throw new TypeError("Packaged source proof budget exceeded");
        writePackagedSourceProofBlobV1(proofRoot, blob, await download(blob.url, blob.bytes));
      }
      stage = "original report verification";
      const preparedRuntime =
        record.runtimeDescriptor === undefined
          ? undefined
          : await prepareSourceDataScannerRuntimeFactsV1(
              record.sourceBundle,
              proof,
              sourceRoot,
              proof.preparedAt,
              undefined,
              new Date().toISOString(),
              proofRoot,
            );
      const verified =
        preparedRuntime?.evidence ??
        (await prepareSourceDataScannerEvidenceV1(
          record.sourceBundle,
          proof,
          sourceRoot,
          proof.preparedAt,
          undefined,
          new Date().toISOString(),
          proofRoot,
        ));
      if (
        canonicalStrictJsonSha256V1(verified) !==
        canonicalStrictJsonSha256V1(record.sourceBundle.evidence)
      )
        throw new TypeError("Packaged source summaries differ from original verified reports");
      if (record.runtimeDescriptor !== undefined) {
        const sealed =
          preparedRuntime?.descriptor === undefined
            ? undefined
            : sealPreparedEccRuntimeDescriptorV1(preparedRuntime.descriptor);
        if (
          sealed === undefined ||
          sealed.sha256 !== record.runtimeDescriptor.sha256 ||
          sealed.bytesBase64 !== record.runtimeDescriptor.bytesBase64
        )
          throw new TypeError("Packaged runtime descriptor differs from original verified reports");
      }
      if (Object.keys(record.sourceBundle.qualifications ?? {}).length)
        throw new TypeError(
          "Package source qualifications require their independent Catalog preparation path",
        );
      progress?.(record.source.repository, "verified");
    } catch (error) {
      throw new Error(
        `Packaged original-proof verification failed for ${record.source.repository} during ${stage}`,
        { cause: error },
      );
    } finally {
      forgetAcquiredGithubSourceArchiveV1(sourceRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
