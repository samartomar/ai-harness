import { z } from "zod";

/** Dependency-free schema so source-data envelopes cannot enter qualification cycles. */
export const SourceDataQualificationProofV1Schema = z
  .object({
    packageInput: z.unknown(),
    receiptAttestation: z.string().min(1).max(512_000),
    receiptSetAttestation: z.string().min(1).max(512_000),
  })
  .strict();
