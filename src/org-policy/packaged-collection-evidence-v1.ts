import { createHash } from "node:crypto";
import { type Node as JsonNode, parseTree } from "jsonc-parser";
import { z } from "zod";
import {
  SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
  SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1,
} from "../baseline-evidence/scanner-publication-policy.js";
import { BaselineSourceEvidenceSchema } from "../baseline-evidence/schema.js";
import {
  assertJsonTextDepthV1,
  assertJsonValueDepthV1,
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
  STRICT_JSON_MAX_DEPTH_V1,
} from "../contract/strict-json-v1.js";
import { evidenceExpiryV1, isExactUtcTimestampV1 } from "../evidence-freshness.js";
import { packagedScannerCollectionEvidenceInputV1 } from "./packaged-collection-evidence-data.js";
import { type AuthoringCatalogBundleV1, EvidenceSummaryV1Schema } from "./workbench/contracts.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const catalogId = z.enum(["aih", "mattpocock", "ponytail", "ecc", "superpowers"]);
const safePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
  );
/** Exactly the spellings the producers emit; Catalog's reader accepts the same. */
const utcTimestamp = z
  .string()
  .refine(isExactUtcTimestampV1, { message: "requires an exact UTC timestamp" });

/** A publication entry's structure. Who published it is Core's admission, checked separately. */
const publicationStructureSchema = z
  .object({
    authority: z.literal("none"),
    repository: z.string().min(1).max(256),
    workflow: z.string().min(1).max(512),
    ref: z.string().min(1).max(256),
    sourceCommit: commit,
    publicationSha256: sha,
    requestSha256: sha,
    receiptSha256: sha,
    publicationLocator: z.string().min(1).max(2_048),
    /** GitHub’s transparency-log timestamp, not the Scanner report date. */
    publishedAt: utcTimestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.publicationLocator !==
      `https://github.com/${value.repository}/releases/download/baseline-v1-${value.sourceCommit}-${value.requestSha256}/publication.json`
    )
      ctx.addIssue({
        code: "custom",
        message: "publication locator does not bind publisher and request",
      });
  });

/** Core's publisher admission: the one reviewed publisher identity (repository, workflow, ref). */
function reviewedPublisherIdentity(publication: {
  repository: string;
  workflow: string;
  ref: string;
}): boolean {
  return (
    publication.repository === SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.repository &&
    publication.workflow === SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.workflow &&
    publication.ref === SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.ref
  );
}

export const ScannerPublicationProjectionV1Schema = publicationStructureSchema.refine(
  reviewedPublisherIdentity,
  { message: "unreviewed packaged publisher" },
);
const subjectSchema = z
  .object({
    assetId: z.string().min(1).max(240),
    sourceId: z.string().min(1).max(240),
    sourceRevisionId: z.string().min(1).max(240),
    contentDigest: digest,
  })
  .strict();
const componentFields = {
  componentId: z.string().min(1).max(240),
  componentTreeSha256: sha,
  paths: z.array(safePath).min(1).max(10_000),
  files: z
    .array(z.object({ path: safePath, digest }).strict())
    .min(1)
    .max(20_000),
};
/**
 * A compiler-partition component covers exactly one compiled asset. A whole-repository
 * inventory component is scanned whatever its asset count and names the zero-to-many compiled
 * assets whose original path it scans, in asset-id order.
 */
const componentSchema = z.union([
  z.object({ ...componentFields, subject: subjectSchema }).strict(),
  z.object({ ...componentFields, subjects: z.array(subjectSchema).max(1_000) }).strict(),
]);

/** The compiled assets one coverage component binds. */
function componentSubjectsV1(
  component: z.infer<typeof componentSchema>,
): readonly z.infer<typeof subjectSchema>[] {
  return "subject" in component ? [component.subject] : component.subjects;
}
const observationSchema = z
  .object({
    componentId: z.string().min(1).max(240),
    /** Scanner envelope claim; this owns the ninety-day report freshness clock. */
    reportSignedAt: utcTimestamp,
    /** Original envelope verification window, retained as provenance only. */
    reportVerificationExpiresAt: utcTimestamp,
    componentTreeSha256: sha,
    requestSha256: sha,
    publicationSha256: sha,
    receiptSha256: sha,
    /** Binds the interpreted Core report, whose legal-material tree may differ from Scanner's. */
    reportComponentDigest: digest,
  })
  .strict();
const catalogSourceSchema = z
  .object({
    id: z.string().min(1).max(240),
    revisionId: z.string().min(1).max(240),
    contentDigest: digest,
    inputFormat: z.string().min(1).max(120),
    upstreamOrigin: z
      .object({
        kind: z.enum(["git", "aih"]),
        locator: z.string().min(1).max(1_000),
      })
      .strict(),
  })
  .strict();

/**
 * A record's structure, given how its publication entries are checked: everything the record
 * states about itself.
 */
function collectionEvidenceRecordSchema(publication: typeof publicationStructureSchema) {
  return z
    .object({
      version: z.literal("packaged-scanner-collection-evidence/v1"),
      authority: z.literal("display-only"),
      catalog: z
        .object({
          id: z.string().min(1).max(240),
          owner: z.string().min(1).max(256),
          repository: z.string().min(1).max(256),
          pinnedCommit: commit,
          sourceTreeSha256: sha,
          /** Historical full compiler coverage digest; not revalidated from this partial projection. */
          coverageDigest: digest,
          coverageProjectionDigest: digest,
          /** Exact compiler/source identity for generic Git and AIH projections. */
          source: catalogSourceSchema,
        })
        .strict(),
      coverage: z
        .object({
          version: z.literal("workbench-scanner-coverage/v1"),
          authority: z.literal("none"),
          scope: z.literal("declared-source-files"),
          components: z.array(componentSchema).min(1).max(1_000),
          unmappedDerivedAssets: z.array(z.string().min(1).max(240)).max(1_000),
        })
        .strict(),
      report: BaselineSourceEvidenceSchema,
      publications: z.array(publication).min(1).max(1_000),
      observations: z.array(observationSchema).min(1).max(1_000),
      verification: z
        .object({
          method: z.literal("gh-attestation-verify"),
          /** Original Core intake timestamp, never refreshed by later reverification. */
          preparedAt: utcTimestamp,
        })
        .strict(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (
        value.catalog.coverageProjectionDigest !==
        packagedCoverageProjectionDigestV1(value.coverage)
      )
        ctx.addIssue({ code: "custom", message: "coverage projection digest mismatch" });
      if (
        value.catalog.id !== value.report.id ||
        value.catalog.owner !== value.report.owner ||
        value.catalog.repository !== value.report.repo ||
        value.catalog.pinnedCommit !== value.report.pinnedSha ||
        value.catalog.sourceTreeSha256 !== value.report.sourceTreeSha256
      )
        ctx.addIssue({ code: "custom", message: "catalog and report identity mismatch" });
      const components = new Map(value.coverage.components.map((item) => [item.componentId, item]));
      const reports = new Map(value.report.components.map((item) => [item.id, item]));
      const publications = new Map(
        value.publications.map((item) => [
          `${item.requestSha256}\u0000${item.publicationSha256}\u0000${item.receiptSha256}`,
          item,
        ]),
      );
      if (components.size !== value.coverage.components.length)
        ctx.addIssue({ code: "custom", message: "duplicate coverage component" });
      // Every compiled asset belongs to at most one component, named once.
      const assets = new Set<string>();
      for (const component of value.coverage.components) {
        const ids = componentSubjectsV1(component).map((subject) => subject.assetId);
        if (ids.some((id, index) => index > 0 && (ids[index - 1] as string) > id))
          ctx.addIssue({ code: "custom", message: "coverage subjects out of order" });
        for (const id of ids) {
          if (assets.has(id))
            ctx.addIssue({ code: "custom", message: "coverage asset bound twice" });
          assets.add(id);
        }
      }
      if (reports.size !== value.report.components.length || reports.size !== components.size)
        ctx.addIssue({ code: "custom", message: "report coverage cardinality mismatch" });
      const seen = new Set<string>();
      for (const observation of value.observations) {
        if (seen.has(observation.componentId))
          ctx.addIssue({ code: "custom", message: "duplicate component observation" });
        seen.add(observation.componentId);
        const component = components.get(observation.componentId);
        const report = reports.get(observation.componentId);
        if (
          report !== undefined &&
          observation.reportComponentDigest !== packagedReportComponentDigestV1(report)
        )
          ctx.addIssue({ code: "custom", message: "report component digest mismatch" });
        if (
          report !== undefined &&
          component !== undefined &&
          (new Set(report.paths).size !== report.paths.length ||
            new Set(component.paths).size !== component.paths.length ||
            !canonicalStrictJsonBytesV1([...report.paths].sort()).equals(
              canonicalStrictJsonBytesV1([...component.paths].sort()),
            ))
        )
          ctx.addIssue({ code: "custom", message: "report coverage paths mismatch" });
        const published = publications.get(
          `${observation.requestSha256}\u0000${observation.publicationSha256}\u0000${observation.receiptSha256}`,
        );
        if (component === undefined)
          ctx.addIssue({ code: "custom", message: "component observation has no coverage" });
        if (report === undefined)
          ctx.addIssue({ code: "custom", message: "component observation has no report" });
        if (
          component !== undefined &&
          component.componentTreeSha256 !== observation.componentTreeSha256
        )
          ctx.addIssue({ code: "custom", message: "component observation tree mismatch" });
        if (published === undefined)
          ctx.addIssue({ code: "custom", message: "component observation publication mismatch" });
        if (
          published !== undefined &&
          Date.parse(observation.reportSignedAt) > Date.parse(published.publishedAt)
        )
          ctx.addIssue({ code: "custom", message: "report signed after publication" });
        if (
          Date.parse(observation.reportVerificationExpiresAt) <=
          Date.parse(observation.reportSignedAt)
        )
          ctx.addIssue({ code: "custom", message: "report verification window" });
        if (
          published !== undefined &&
          Date.parse(published.publishedAt) >= Date.parse(observation.reportVerificationExpiresAt)
        )
          ctx.addIssue({
            code: "custom",
            message: "publication outside report verification window",
          });
      }
      if (value.report.components.some((component) => !seen.has(component.id)))
        ctx.addIssue({ code: "custom", message: "report component lacks observation" });
      if (
        value.publications.some(
          (publication) =>
            Date.parse(publication.publishedAt) > Date.parse(value.verification.preparedAt),
        )
      )
        ctx.addIssue({ code: "custom", message: "collection intake predates publication" });
    });
}

type IssuePath = (string | number)[];

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function ownItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The shared baseline report schema trims analyzer and finding text; Catalog's report reader
 * refuses untrimmed text instead, and under D25 the stricter rule holds on both sides. So a
 * packaged report's text must already be trimmed, and the shared schema then trims nothing.
 */
function untrimmedReportTextV1(record: unknown): IssuePath[] {
  const found: IssuePath[] = [];
  const check = (value: unknown, path: IssuePath) => {
    if (typeof value === "string" && value.trim() !== value) found.push(path);
  };
  const components = ownItems(ownField(ownField(record, "report"), "components"));
  for (const [c, component] of components.entries()) {
    const at: IssuePath = ["report", "components", c];
    for (const [a, analyzer] of ownItems(ownField(component, "analyzers")).entries())
      for (const key of ["name", "version"])
        check(ownField(analyzer, key), [...at, "analyzers", a, key]);
    for (const [f, finding] of ownItems(ownField(component, "findings")).entries()) {
      for (const key of ["code", "detail", "fingerprint"])
        check(ownField(finding, key), [...at, "findings", f, key]);
      for (const [p, fingerprint] of ownItems(ownField(finding, "fingerprints")).entries())
        check(fingerprint, [...at, "findings", f, "fingerprints", p]);
    }
  }
  return found;
}

/**
 * zod's strict objects let an own `__proto__` key through, where Catalog's reader refuses it as an
 * unsupported field; no record object has such a field.
 */
function ownProtoKeysV1(value: unknown, path: IssuePath = []): IssuePath[] {
  if (value === null || typeof value !== "object") return [];
  const found: IssuePath[] = Object.hasOwn(value, "__proto__") ? [path] : [];
  for (const [key, child] of Object.entries(value))
    found.push(...ownProtoKeysV1(child, [...path, Array.isArray(value) ? Number(key) : key]));
  return found;
}

/**
 * What Catalog's reader refuses and the shared record schema alone would accept: first the
 * nesting bound (before anything recursive), then Core's strict JSON value rule over the whole
 * record (well-formed NFC strings and keys, finite numbers other than negative zero, plain data
 * only), then the fields above.
 */
const packagedRecordInputSchema = z.unknown().superRefine((value, ctx) => {
  try {
    assertJsonValueDepthV1(value, "packaged collection evidence", STRICT_JSON_MAX_DEPTH_V1);
    assertStrictJsonValueV1(value, "packaged collection evidence");
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return;
  }
  for (const path of ownProtoKeysV1(value))
    ctx.addIssue({ code: "custom", path, message: "unsupported field __proto__" });
  for (const path of untrimmedReportTextV1(value))
    ctx.addIssue({ code: "custom", path, message: "packaged report text must already be trimmed" });
});

/** Display-only data, authored exclusively from a same-process operational witness. */
export const ScannerEvidenceProjectionRecordV1Schema = collectionEvidenceRecordSchema(
  ScannerPublicationProjectionV1Schema,
);

/**
 * A packaged record's structural validation: IDENTICAL to Catalog's reader
 * (`parsePackagedScannerCollectionEvidenceV1`; decision D25, shared acceptance fixtures in
 * `tests/fixtures/packaged-evidence-parity`), including the release-owned catalog registry.
 * It never admits a record; admission is the schema below.
 */
export const PackagedScannerCollectionEvidenceStructureV1Schema = packagedRecordInputSchema
  .pipe(collectionEvidenceRecordSchema(publicationStructureSchema))
  .refine((value) => catalogId.safeParse(value.catalog.id).success, {
    message: "unregistered packaged catalog id",
  })
  .transform((value) => ({
    ...value,
    catalog: { ...value.catalog, id: catalogId.parse(value.catalog.id) },
  }));

/**
 * Package admission, which is Core's alone and never Catalog's (Catalog is a carrier): every
 * publication is by the reviewed publisher identity at a reviewed publisher commit.
 */
export const PackagedScannerCollectionEvidenceRecordV1Schema =
  PackagedScannerCollectionEvidenceStructureV1Schema.refine(
    (value) =>
      value.publications.every(
        (publication) =>
          reviewedPublisherIdentity(publication) &&
          SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.some(
            (publisher) => publisher.commit === publication.sourceCommit,
          ),
      ),
    { message: "unreviewed packaged publisher" },
  );

export type PackagedScannerCollectionEvidenceStructureV1 = z.infer<
  typeof PackagedScannerCollectionEvidenceStructureV1Schema
>;
export type PackagedScannerCollectionEvidenceRecordV1 = z.infer<
  typeof PackagedScannerCollectionEvidenceRecordV1Schema
>;
/** Pure projection accepts registered source identities; package admission retains its own fixed registry. */
export type ScannerEvidenceProjectionRecordV1 = z.infer<
  typeof ScannerEvidenceProjectionRecordV1Schema
>;

/** Local consistency digests, never authentication or substitutes for live publication custody. */
export function packagedCoverageProjectionDigestV1(coverage: unknown): string {
  return `sha256:${canonicalStrictJsonSha256V1({ version: "packaged-coverage-projection/v1", coverage })}`;
}

export function packagedReportComponentDigestV1(component: unknown): string {
  return `sha256:${canonicalStrictJsonSha256V1({ version: "packaged-report-component/v1", component })}`;
}

function digestRecord(value: ScannerEvidenceProjectionRecordV1): string {
  return `sha256:${canonicalStrictJsonSha256V1(value)}`;
}

/** Canonically seals one source record. Parsing alone never creates custody. */
export function encodePackagedScannerCollectionEvidenceRecordV1(value: unknown): {
  bytes: string;
  sha256: string;
} {
  const record = PackagedScannerCollectionEvidenceRecordV1Schema.parse(value);
  const bytes = canonicalStrictJsonBytesV1(record).toString("utf8");
  return {
    bytes,
    sha256: `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`,
  };
}

type PackagedCollectionInputV1 = Readonly<{
  bytes: string;
  sha256: string;
}>;

type CachedPackagedCollectionEvidenceV1 = Readonly<{
  input: readonly PackagedCollectionInputV1[];
  records: readonly PackagedScannerCollectionEvidenceRecordV1[];
}>;

let cachedPackagedCollectionEvidenceV1: CachedPackagedCollectionEvidenceV1 | undefined;

function cachedInputMatchesPackageV1(cached: CachedPackagedCollectionEvidenceV1): boolean {
  if (cached.input.length !== packagedScannerCollectionEvidenceInputV1().length) return false;
  return cached.input.every(
    (item, index) =>
      item.bytes === packagedScannerCollectionEvidenceInputV1()[index]?.bytes &&
      item.sha256 === packagedScannerCollectionEvidenceInputV1()[index]?.sha256,
  );
}

/**
 * A `__proto__` member survives no JSON parse: Core's reader makes it the prototype or drops it
 * (as `assertNoProtoMember` in hook-registrar-native.ts explains). So the sealed text is read for
 * one by name, and refused as Catalog's reader refuses it.
 */
function hasProtoMemberV1(text: string): boolean {
  const walk = (node: JsonNode | undefined): boolean =>
    node !== undefined &&
    ((node.type === "property" && node.children?.[0]?.value === "__proto__") ||
      (node.children ?? []).some(walk));
  return walk(parseTree(text));
}

/** The sealed wrapper list, holes included (a hole is refused as a wrapper, never skipped). */
function sealedWrappersV1(input: unknown): unknown[] {
  if (!Array.isArray(input))
    throw new TypeError("Packaged collection evidence records must be an array.");
  return Array.from(input);
}

/**
 * One sealed wrapper, checked as Catalog's reader checks it before any field is read: an object
 * with exactly the own keys `bytes` and `sha256` (an own `__proto__` is an unsupported field),
 * both strings.
 */
function sealedWrapperV1(wrapper: unknown, label: string): PackagedCollectionInputV1 {
  if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper))
    throw new TypeError(`${label} must be an object.`);
  for (const key of ["bytes", "sha256"])
    if (!Object.hasOwn(wrapper, key)) throw new TypeError(`${label} is missing ${key}.`);
  for (const key of Object.keys(wrapper))
    if (key !== "bytes" && key !== "sha256")
      throw new TypeError(`${label} has unsupported field ${key}.`);
  const { bytes, sha256 } = wrapper as Record<"bytes" | "sha256", unknown>;
  if (typeof bytes !== "string" || typeof sha256 !== "string")
    throw new TypeError(`${label} bytes and seal must be strings.`);
  return { bytes, sha256 };
}

/**
 * Reads sealed records structurally, IDENTICALLY to Catalog's
 * `parsePackagedScannerCollectionEvidenceV1` (decision D25): a wrapper list with exact wrapper
 * keys, byte budget, matching seal, the nesting bound (an iterative scan before any recursive
 * parse), Core's strict JSON reader, no `__proto__` member, the structural schema, canonical bytes
 * and one record per catalog id. It never admits a record; admission is
 * `PackagedScannerCollectionEvidenceRecordV1Schema`.
 */
export function readPackagedScannerCollectionEvidenceStructureV1(
  input: unknown,
): PackagedScannerCollectionEvidenceStructureV1[] {
  const records: PackagedScannerCollectionEvidenceStructureV1[] = [];
  const sourceIds = new Set<string>();
  for (const [index, wrapper] of sealedWrappersV1(input).entries()) {
    const item = sealedWrapperV1(wrapper, `Packaged collection evidence record ${String(index)}`);
    if (
      Buffer.byteLength(item.bytes, "utf8") > 4 * 1024 * 1024 ||
      !digest.safeParse(item.sha256).success
    )
      throw new TypeError("Packaged collection evidence seal mismatch.");
    const actual = `sha256:${createHash("sha256").update(item.bytes, "utf8").digest("hex")}`;
    if (actual !== item.sha256) throw new TypeError("Packaged collection evidence seal mismatch.");
    assertJsonTextDepthV1(item.bytes, "Packaged collection evidence", STRICT_JSON_MAX_DEPTH_V1);
    const value = parseStrictJsonObjectV1(item.bytes, "Packaged collection evidence");
    if (hasProtoMemberV1(item.bytes))
      throw new TypeError("Packaged collection evidence has an unsupported field __proto__.");
    const parsed = PackagedScannerCollectionEvidenceStructureV1Schema.parse(value);
    if (!canonicalStrictJsonBytesV1(parsed).equals(Buffer.from(item.bytes, "utf8")))
      throw new TypeError("Packaged collection evidence must use canonical bytes.");
    if (sourceIds.has(parsed.catalog.id))
      throw new TypeError("Duplicate packaged collection source.");
    sourceIds.add(parsed.catalog.id);
    records.push(parsed);
  }
  return records;
}

/**
 * Reads one sealed `{ bytes, sha256 }` record through the structural reader, then admits it: the
 * single boundary for a record that live reverification compares with a fresh publication.
 */
export function readPackagedScannerCollectionEvidenceRecordV1(
  sealed: unknown,
): PackagedScannerCollectionEvidenceRecordV1 {
  const [record] = readPackagedScannerCollectionEvidenceStructureV1([sealed]);
  return PackagedScannerCollectionEvidenceRecordV1Schema.parse(record);
}

/** Inputless loader for independent source records shipped by the release process. */
export function packagedScannerCollectionEvidenceV1(): readonly PackagedScannerCollectionEvidenceRecordV1[] {
  const cached = cachedPackagedCollectionEvidenceV1;
  if (cached !== undefined && cachedInputMatchesPackageV1(cached))
    return deepFreezeStrictJsonV1(structuredClone(cached.records));

  const records = readPackagedScannerCollectionEvidenceStructureV1(
    packagedScannerCollectionEvidenceInputV1(),
  ).map((record) => PackagedScannerCollectionEvidenceRecordV1Schema.parse(record));
  const input = packagedScannerCollectionEvidenceInputV1().map((item) =>
    Object.freeze({ bytes: item.bytes, sha256: item.sha256 }),
  );
  const immutable = deepFreezeStrictJsonV1(records);
  cachedPackagedCollectionEvidenceV1 = Object.freeze({
    input: Object.freeze(input),
    records: immutable,
  });
  return deepFreezeStrictJsonV1(structuredClone(immutable));
}

function exactAsset(
  bundle: AuthoringCatalogBundleV1,
  subject: z.infer<typeof subjectSchema>,
  record: ScannerEvidenceProjectionRecordV1,
): boolean {
  const asset = bundle.assets[subject.assetId];
  const source = bundle.sources[subject.sourceId];
  return (
    asset !== undefined &&
    source !== undefined &&
    source.id === record.catalog.source.id &&
    source.revision.id === record.catalog.source.revisionId &&
    source.revision.contentDigest === record.catalog.source.contentDigest &&
    source.inputFormat === record.catalog.source.inputFormat &&
    source.upstreamOrigin.kind === record.catalog.source.upstreamOrigin.kind &&
    source.upstreamOrigin.locator === record.catalog.source.upstreamOrigin.locator &&
    source.id === subject.sourceId &&
    asset.id === subject.assetId &&
    asset.sourceId === subject.sourceId &&
    asset.sourceRevisionId === subject.sourceRevisionId &&
    asset.contentDigest === subject.contentDigest &&
    asset.derivation ===
      (record.catalog.source.upstreamOrigin.kind === "aih" ? "built-in" : "upstream")
  );
}

/** Projects exact sealed report facts; currentness is decided by the consumer/display boundary. */
export function packagedScannerCollectionOverlayV1(
  bundle: AuthoringCatalogBundleV1,
): AuthoringCatalogBundleV1["evidence"] {
  return projectScannerCollectionEvidenceV1(bundle, packagedScannerCollectionEvidenceV1());
}

/** Pure display projection only. Callers must independently authenticate records before using it. */
export function projectScannerCollectionEvidenceV1(
  bundle: AuthoringCatalogBundleV1,
  records: readonly ScannerEvidenceProjectionRecordV1[],
): AuthoringCatalogBundleV1["evidence"] {
  const result: AuthoringCatalogBundleV1["evidence"] = {};
  for (const record of records) {
    const recordDigest = digestRecord(record);
    const reports = new Map(record.report.components.map((item) => [item.id, item]));
    const observations = new Map(record.observations.map((item) => [item.componentId, item]));
    for (const component of record.coverage.components) {
      const report = reports.get(component.componentId);
      const observation = observations.get(component.componentId);
      if (report === undefined || observation === undefined) continue;
      const validUntil = evidenceExpiryV1(observation.reportSignedAt);
      const published = record.publications.find(
        (item) =>
          item.requestSha256 === observation.requestSha256 &&
          item.publicationSha256 === observation.publicationSha256 &&
          item.receiptSha256 === observation.receiptSha256,
      );
      if (published === undefined) continue;
      // Each compiled asset the component's scan covers gets that scan's evidence.
      for (const subject of componentSubjectsV1(component)) {
        if (!exactAsset(bundle, subject, record)) continue;
        const id = `evidence:${subject.assetId}`;
        result[id] = EvidenceSummaryV1Schema.parse({
          id,
          projectionVersion: "evidence-summary/v1",
          subjects: [subject],
          evidenceDigest: `sha256:${canonicalStrictJsonSha256V1({ record: recordDigest, component, observation, ...("subject" in component ? {} : { subject }) })}`,
          coveredPaths: [...component.paths].sort(),
          verification: {
            state: "verified",
            verifiedAt: record.verification.preparedAt,
            validUntil,
            contextDigest: `sha256:${canonicalStrictJsonSha256V1({ record: recordDigest, publication: observation.publicationSha256, receipt: observation.receiptSha256 })}`,
          },
          scan: {
            outcome: report.verdict === "blocked" ? "failed" : "pass",
            coverage: "complete",
            analyzers: [...report.analyzers].sort((left, right) => {
              const leftKey = `${left.name}\u0000${left.version}`;
              const rightKey = `${right.name}\u0000${right.version}`;
              return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
            }),
            reportSignedAt: observation.reportSignedAt,
            reportVerificationExpiresAt: observation.reportVerificationExpiresAt,
            publishedAt: published.publishedAt,
          },
          qualification: { state: "unknown" },
          findings: report.findings
            .slice(0, 50)
            .map((finding) => `${finding.code}: ${finding.detail}`.slice(0, 1000)),
        });
      }
    }
  }
  return result;
}
