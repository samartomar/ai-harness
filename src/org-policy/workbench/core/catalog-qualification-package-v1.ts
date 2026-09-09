import { createHash } from "node:crypto";
import { parseStrictJsonObjectV1 } from "../../../contract/strict-json-v1.js";
import { evidenceExpiryV1 } from "../../../evidence-freshness.js";
import { parseAihSupportedQualificationReceiptV2Bytes } from "../../supported-qualification-receipt-v2.js";
import { CatalogQualificationSummariesV1Schema } from "../contracts.js";
import { expandCatalogQualificationPackageInputV2 } from "./catalog-qualification-compact.js";
import { CATALOG_QUALIFICATION_PACKAGE_INPUT_V1 } from "./catalog-qualification-data.js";
import {
  CATALOG_RECEIPT_SET_MAX_BYTES,
  CATALOG_RECEIPT_SET_MAX_ENTRIES,
} from "./catalog-qualification-limits.js";
import type { CompilerQualificationBindingV1 } from "./catalog-qualification-v1.js";
import {
  CompilerQualificationBindingV1Schema,
  compilerQualificationBindingDigestV1,
} from "./catalog-qualification-v1.js";

export interface CatalogQualificationPublisherV1 {
  readonly repository: string;
  readonly workflow: string;
  readonly ref: string;
  readonly issuer: string;
  readonly commit: string;
  readonly subjectName: string;
}

/**
 * Package-owned qualification artifacts, admitted only after operational verification.
 */
export interface PackagedCatalogQualificationRecordV1 {
  readonly receiptBytes: Uint8Array;
  readonly receiptSetBytes: Uint8Array;
  readonly memberBytes: Uint8Array;
  readonly closureBytesByIdentity: Readonly<Record<string, Uint8Array>>;
  readonly publisher: CatalogQualificationPublisherV1;
  readonly receiptSetPublisher: CatalogQualificationPublisherV1;
}

/**
 * Minimal records consumed by the offline Studio. They are emitted only from
 * the live packaging verifier; source receipt/member/closure bytes never enter
 * the browser or the normal authoring preparation path.
 */
export interface PackagedCatalogQualificationProjectionV1 {
  readonly summary: Record<string, unknown>;
}

type ByteCache = { values: Map<string, Uint8Array>; total: number };
function bytes(value: unknown, maximum: number, cache: ByteCache): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum * 2)
    return undefined;
  const previous = cache.values.get(value);
  if (previous) return previous.length <= maximum ? previous : undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximum || decoded.toString("base64") !== value)
    return undefined;
  cache.total += decoded.length;
  if (cache.total > 32 * 1024 * 1024) return undefined;
  cache.values.set(value, decoded);
  return decoded;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function detached<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): unknown => {
    if (item === null || typeof item !== "object" || ArrayBuffer.isView(item)) return item;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone) as T;
}

function publisher(value: unknown): CatalogQualificationPublisherV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const fields = ["repository", "workflow", "ref", "issuer", "commit", "subjectName"] as const;
  if (
    Object.keys(item).length !== fields.length ||
    fields.some((field) => typeof item[field] !== "string")
  )
    return undefined;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository as string) ||
    !/^[a-f0-9]{40}$/.test(item.commit as string) ||
    fields.some(
      (field) => (item[field] as string).length === 0 || (item[field] as string).length > 1_000,
    )
  )
    return undefined;
  return detached(item) as unknown as CatalogQualificationPublisherV1;
}

/** Structural decoding only; external callers still require independent signature verification. */
export function decodeCatalogQualificationPackageInputV1(input: unknown) {
  try {
    input = expandCatalogQualificationPackageInputV2(input);
  } catch {
    throw new TypeError("Catalog qualification package input is malformed.");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Catalog qualification package input is malformed.");
  const value = input as Record<string, unknown>;
  const topLevel = ["version", "records", "bindings", "projections"];
  if (
    value.version !== 1 ||
    Object.keys(value).length !== topLevel.length ||
    topLevel.some((key) => !Object.hasOwn(value, key)) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.bindings) ||
    !Array.isArray(value.projections) ||
    value.records.length > CATALOG_RECEIPT_SET_MAX_ENTRIES ||
    value.bindings.length > CATALOG_RECEIPT_SET_MAX_ENTRIES ||
    value.projections.length > 1
  )
    throw new TypeError("Catalog qualification package input is malformed.");
  const records: PackagedCatalogQualificationRecordV1[] = [];
  if (value.records.length !== 0 && (value.bindings.length === 0 || value.projections.length !== 1))
    throw new TypeError(
      "Catalog qualification package lacks raw record, binding, or projection coverage.",
    );
  const byteCache: ByteCache = { values: new Map(), total: 0 };
  for (const raw of value.records) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new TypeError("Catalog qualification package record is malformed.");
    const item = raw as Record<string, unknown>;
    const fields = [
      "receiptBytesBase64",
      "receiptSetBytesBase64",
      "memberBytesBase64",
      "closureBytesByIdentityBase64",
      "publisher",
      "receiptSetPublisher",
    ];
    if (
      Object.keys(item).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(item, field))
    )
      throw new TypeError("Catalog qualification package record has unexpected fields.");
    const receiptBytes = bytes(item.receiptBytesBase64, 6_000, byteCache);
    const receiptSetBytes = bytes(
      item.receiptSetBytesBase64,
      CATALOG_RECEIPT_SET_MAX_BYTES,
      byteCache,
    );
    const memberBytes = bytes(item.memberBytesBase64, 64_000, byteCache);
    const closures = item.closureBytesByIdentityBase64;
    if (
      !receiptBytes ||
      !receiptSetBytes ||
      !memberBytes ||
      closures === null ||
      typeof closures !== "object" ||
      Array.isArray(closures) ||
      Object.keys(closures).length !== 1
    )
      throw new TypeError("Catalog qualification package record bytes are malformed.");
    const member = parseStrictJsonObjectV1(
      Buffer.from(memberBytes).toString("utf8"),
      "Catalog member",
    );
    const memberClosure = member.closure;
    if (
      !memberClosure ||
      typeof memberClosure !== "object" ||
      Array.isArray(memberClosure) ||
      !("identity" in memberClosure) ||
      typeof memberClosure.identity !== "string" ||
      !Object.hasOwn(closures, memberClosure.identity)
    )
      throw new TypeError("Catalog qualification package closure does not match its member.");
    const closureBytesByIdentity: Record<string, Uint8Array> = {};
    for (const [identity, encoded] of Object.entries(closures as Record<string, unknown>)) {
      const closure = bytes(encoded, 1_000_000, byteCache);
      if (
        !identity ||
        identity.length > 500 ||
        identity.normalize("NFC") !== identity ||
        /\p{C}/u.test(identity) ||
        !closure ||
        closureBytesByIdentity[identity] !== undefined
      )
        throw new TypeError("Catalog qualification package closure bytes are malformed.");
      closureBytesByIdentity[identity] = closure;
    }
    if (Object.keys(closureBytesByIdentity).length === 0)
      throw new TypeError("Catalog qualification package has no closure bytes.");
    const receiptPublisher = publisher(item.publisher);
    const receiptSetPublisher = publisher(item.receiptSetPublisher);
    if (!receiptPublisher || !receiptSetPublisher)
      throw new TypeError("Malformed package publisher.");
    records.push({
      receiptBytes,
      receiptSetBytes,
      memberBytes,
      closureBytesByIdentity,
      publisher: receiptPublisher,
      receiptSetPublisher,
    });
  }
  if (records.length === 0 && (value.bindings.length !== 0 || value.projections.length !== 0))
    throw new TypeError("Catalog qualification package must be wholly empty or complete.");
  if (records.length !== 0 && (value.bindings.length === 0 || value.projections.length !== 1))
    throw new TypeError(
      "Catalog qualification package lacks raw record, binding, or projection coverage.",
    );
  if (records.length === 0)
    return {
      records: Object.freeze([]),
      bindings: Object.freeze([]),
      projections: Object.freeze([]),
    };
  const bindings = value.bindings.map((binding) => {
    const parsed = CompilerQualificationBindingV1Schema.safeParse(binding);
    if (!parsed.success) throw new TypeError("Catalog qualification package binding is malformed.");
    return detached(parsed.data);
  });
  const bindingByAsset = new Map(bindings.map((binding) => [binding.asset.assetId, binding]));
  if (bindingByAsset.size !== bindings.length)
    throw new TypeError("Catalog qualification package has duplicate bindings.");
  const parsedSummaries = CatalogQualificationSummariesV1Schema.safeParse(value.projections[0]);
  if (!parsedSummaries.success || Object.keys(parsedSummaries.data).length !== records.length)
    throw new TypeError("Catalog qualification package projection coverage is malformed.");
  const seenReceipts = new Set<string>();
  for (const record of records) {
    const receipt = parseAihSupportedQualificationReceiptV2Bytes(record.receiptBytes);
    const receiptDigest = sha256(record.receiptBytes);
    const summary = Object.values(parsedSummaries.data).find(
      (item) => item.receiptDigest === receiptDigest,
    );
    const binding = summary === undefined ? undefined : bindingByAsset.get(summary.assetId);
    if (
      receipt === undefined ||
      summary === undefined ||
      binding === undefined ||
      seenReceipts.has(receiptDigest) ||
      summary.receiptSetDigest !== sha256(record.receiptSetBytes) ||
      summary.catalogMemberDigest !== receipt.qualificationBasis.catalogMemberDigest ||
      summary.catalogDigest !== receipt.qualificationBasis.catalogDigest ||
      summary.catalogHeadDigest !== receipt.qualificationBasis.catalogHeadDigest ||
      summary.subjectDigest !== receipt.subject.subjectDigest ||
      summary.originalIssuedAt !== receipt.issuedAt ||
      summary.notBefore !== receipt.notBefore ||
      summary.validUntil !== evidenceExpiryV1(receipt.issuedAt, receipt.expiresAt) ||
      summary.publisher.repository !== record.publisher.repository ||
      summary.publisher.workflow !== record.publisher.workflow ||
      summary.publisher.ref !== record.publisher.ref ||
      summary.publisher.issuer !== record.publisher.issuer ||
      summary.publisher.commit !== record.publisher.commit ||
      summary.compilerBindingDigest !== compilerQualificationBindingDigestV1(binding) ||
      binding.asset.assetId !== summary.assetId ||
      binding.asset.sourceId !== summary.sourceId ||
      binding.asset.sourceRevisionId !== summary.sourceRevisionId ||
      binding.asset.contentDigest !== summary.contentDigest ||
      binding.sourceContentDigest !== summary.sourceContentDigest ||
      binding.subject.subjectDigest !== summary.subjectDigest
    )
      throw new TypeError("Catalog qualification package raw records do not cover its projection.");
    seenReceipts.add(receiptDigest);
  }
  if (bindingByAsset.size !== Object.keys(parsedSummaries.data).length)
    throw new TypeError("Catalog qualification package has unprojected bindings.");
  return {
    records: Object.freeze(records),
    bindings: Object.freeze(bindings),
    projections: Object.freeze([{ summary: detached(parsedSummaries.data) }]),
  };
}
// Resolve after module initialization: the operational verifier also consumes this loader.
// Empty development data used to hide the schema initialization cycle.
let loaded: ReturnType<typeof decodeCatalogQualificationPackageInputV1> | undefined;
function packageData() {
  loaded ??= decodeCatalogQualificationPackageInputV1(CATALOG_QUALIFICATION_PACKAGE_INPUT_V1);
  return loaded;
}

/** Inputless package loader; no caller can provide a qualification artifact. */
export function packagedCatalogQualificationRecordsV1(): readonly PackagedCatalogQualificationRecordV1[] {
  const copies = new Map<Uint8Array, Uint8Array>();
  const copy = (bytes: Uint8Array) => {
    let result = copies.get(bytes);
    if (!result) {
      result = new Uint8Array(bytes);
      copies.set(bytes, result);
    }
    return result;
  };
  return Object.freeze(
    packageData().records.map((record) =>
      Object.freeze({
        receiptBytes: copy(record.receiptBytes),
        receiptSetBytes: copy(record.receiptSetBytes),
        memberBytes: copy(record.memberBytes),
        closureBytesByIdentity: Object.freeze(
          Object.fromEntries(
            Object.entries(record.closureBytesByIdentity).map(([identity, value]) => [
              identity,
              copy(value),
            ]),
          ),
        ),
        publisher: detached(record.publisher),
        receiptSetPublisher: detached(record.receiptSetPublisher),
      }),
    ),
  );
}

/** Inputless offline loader; caller JSON cannot nominate a display projection. */
export function packagedCatalogQualificationProjectionsV1(): readonly PackagedCatalogQualificationProjectionV1[] {
  return Object.freeze(
    packageData().projections.map((projection) =>
      Object.freeze({ summary: detached(projection.summary) }),
    ),
  );
}

/** Inputless Core-owned bindings used to rejoin a packaged display projection. */
export function packagedCatalogQualificationBindingsV1(): readonly CompilerQualificationBindingV1[] {
  return Object.freeze(packageData().bindings.map((binding) => detached(binding)));
}
