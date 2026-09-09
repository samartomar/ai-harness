import { z } from "zod";
import { AuthoringCatalogBundleV1Schema } from "../contracts.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const blob = z.object({
  sha256: sha,
  bytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024 * 1024),
});
const runtimeDescriptor = z
  .object({
    bytesBase64: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
/** Package-owned preparation inputs; original proof verification is a connected release gate. */
export const PackagedSourceDataRecordV1Schema = z
  .object({
    version: z.literal("packaged-workbench-source-data/v1"),
    sourceBundle: AuthoringCatalogBundleV1Schema,
    updateKind: z.literal("evidence-only").optional(),
    source: z
      .object({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict(),
    scannerProof: z.unknown(),
    compilerTemplate: z.unknown(),
    runtimeDescriptor: runtimeDescriptor.optional(),
    inlineBlobs: z.array(blob.extend({ bytesBase64: z.string().max(700_000) }).strict()).max(32),
    publicationBlobs: z
      .array(blob.extend({ url: z.string().max(1_000) }).strict())
      .min(1)
      .max(16),
  })
  .strict();
export type PackagedSourceDataRecordV1 = z.infer<typeof PackagedSourceDataRecordV1Schema>;
