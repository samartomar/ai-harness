import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { readWorkbenchSourceDataFileV1 } from "./source-data.js";

export const SourceDataProofBlobV1Schema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024),
  })
  .strict();
export const SourceDataCompilerBlobV1Schema = SourceDataProofBlobV1Schema.extend({
  version: z.literal("source-compiler-input-blob/v1"),
}).strict();
export const SourceDataScannerBlobBatchV1Schema = z
  .object({
    version: z.literal("scanner-proof-blobs/v1"),
    discovery: SourceDataProofBlobV1Schema.refine((value) => value.bytes <= 8_192),
    publication: SourceDataProofBlobV1Schema.refine((value) => value.bytes <= 12_000_000),
    attestation: SourceDataProofBlobV1Schema.refine((value) => value.bytes <= 512_000),
  })
  .strict();
export const SOURCE_DATA_RAW_PROOF_BUDGET_V1 = 128 * 1024 * 1024;

/** Transport integrity only. Cryptographic publication verification remains mandatory. */
export function readSourceDataProofBlobV1(
  input: unknown,
  root: string | undefined,
  max: number,
): Buffer {
  const reference = SourceDataProofBlobV1Schema.parse(input);
  if (!root || !isAbsolute(root) || !Number.isSafeInteger(max) || max < 1 || reference.bytes > max)
    throw new TypeError(
      "Source proof blob requires an explicit absolute --proof-root and bounded size",
    );
  const bytes = Buffer.from(
    readWorkbenchSourceDataFileV1(join(root, `${reference.sha256}.blob`), reference.bytes),
    "utf8",
  );
  if (
    bytes.length !== reference.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== reference.sha256
  )
    throw new TypeError("Source proof blob size or digest mismatch");
  return bytes;
}
