import { createHash } from "node:crypto";
import { z } from "zod";
import { CATALOG_RECEIPT_SET_MAX_ENTRIES } from "./catalog-qualification-limits.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const encoded = z.string().min(1).max(1_400_000);
const publisher = z.unknown();
const common = {
  bindings: z.array(z.unknown()).max(CATALOG_RECEIPT_SET_MAX_ENTRIES),
  projections: z.array(z.unknown()).max(1),
};
const legacyRecord = z
  .object({
    receiptBytesBase64: encoded,
    receiptSetBytesBase64: encoded,
    memberBytesBase64: encoded,
    closureBytesByIdentityBase64: z
      .record(z.string().max(500), encoded)
      .refine((value) => Object.keys(value).length === 1),
    publisher,
    receiptSetPublisher: publisher,
  })
  .strict();
const compactRecord = z
  .object({
    receipt: sha,
    receiptSet: sha,
    member: sha,
    closures: z.record(z.string().max(500), sha).refine((value) => Object.keys(value).length === 1),
    publisher,
    receiptSetPublisher: publisher,
  })
  .strict();
const compactSchema = z
  .object({
    version: z.literal(2),
    artifacts: z.record(sha, encoded),
    records: z.array(compactRecord).max(CATALOG_RECEIPT_SET_MAX_ENTRIES),
    ...common,
  })
  .strict();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Transport decoding only: signatures, membership, bindings and dates remain independently checked. */
export function expandCatalogQualificationPackageInputV2(input: unknown): unknown {
  if (!input || typeof input !== "object" || !("version" in input) || input.version !== 2)
    return input;
  const parsed = compactSchema.parse(input);
  const entries = Object.entries(parsed.artifacts);
  if (entries.length > 4096) throw new TypeError("Too many Catalog proof artifacts");
  let total = 0;
  for (const [digest, value] of entries) {
    const bytes = Buffer.from(value, "base64");
    total += bytes.length;
    if (
      bytes.length > 1_000_000 ||
      total > 32 * 1024 * 1024 ||
      bytes.toString("base64") !== value ||
      hash(bytes) !== digest
    )
      throw new TypeError("Catalog proof artifact identity or byte bound mismatch");
  }
  const used = new Set<string>();
  const get = (digest: string) => {
    const value = parsed.artifacts[digest];
    if (value === undefined) throw new TypeError("Missing Catalog proof artifact");
    used.add(digest);
    return value;
  };
  const records = parsed.records.map((record) => ({
    receiptBytesBase64: get(record.receipt),
    receiptSetBytesBase64: get(record.receiptSet),
    memberBytesBase64: get(record.member),
    closureBytesByIdentityBase64: Object.fromEntries(
      Object.entries(record.closures).map(([identity, digest]) => [identity, get(digest)]),
    ),
    publisher: record.publisher,
    receiptSetPublisher: record.receiptSetPublisher,
  }));
  if (used.size !== entries.length) throw new TypeError("Unreferenced Catalog proof artifact");
  return { version: 1, records, bindings: parsed.bindings, projections: parsed.projections };
}

/** Stores shared raw proofs once; this encoding grants no verification authority. */
export function encodeCatalogQualificationPackageInputV2(input: unknown) {
  const parsed = z
    .object({
      version: z.literal(1),
      records: z.array(legacyRecord).max(CATALOG_RECEIPT_SET_MAX_ENTRIES),
      ...common,
    })
    .strict()
    .parse(input);
  const artifacts: Record<string, string> = {};
  const put = (value: string) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value)
      throw new TypeError("Noncanonical Catalog artifact bytes");
    const digest = hash(bytes);
    artifacts[digest] = value;
    return digest;
  };
  const records = parsed.records.map((record) => ({
    receipt: put(record.receiptBytesBase64),
    receiptSet: put(record.receiptSetBytesBase64),
    member: put(record.memberBytesBase64),
    closures: Object.fromEntries(
      Object.entries(record.closureBytesByIdentityBase64).map(([identity, value]) => [
        identity,
        put(value),
      ]),
    ),
    publisher: record.publisher,
    receiptSetPublisher: record.receiptSetPublisher,
  }));
  const result = {
    version: 2 as const,
    artifacts,
    records,
    bindings: parsed.bindings,
    projections: parsed.projections,
  };
  expandCatalogQualificationPackageInputV2(result);
  return result;
}
