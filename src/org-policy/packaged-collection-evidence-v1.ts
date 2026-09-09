import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
  SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1,
} from "../baseline-evidence/scanner-publication-policy.js";
import { BaselineSourceEvidenceSchema } from "../baseline-evidence/schema.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { evidenceExpiryV1 } from "../evidence-freshness.js";
import { PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1 } from "./packaged-collection-evidence-data.js";
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
export const ScannerPublicationProjectionV1Schema = z
  .object({
    authority: z.literal("none"),
    repository: z.literal(SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.repository),
    workflow: z.literal(SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.workflow),
    ref: z.literal(SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.ref),
    sourceCommit: commit,
    publicationSha256: sha,
    requestSha256: sha,
    receiptSha256: sha,
    publicationLocator: z.string().url().max(2_048),
    /** GitHub’s transparency-log timestamp, not the Scanner report date. */
    publishedAt: z.string().datetime(),
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
const componentSchema = z
  .object({
    componentId: z.string().min(1).max(240),
    componentTreeSha256: sha,
    paths: z.array(safePath).min(1).max(10_000),
    files: z
      .array(z.object({ path: safePath, digest }).strict())
      .min(1)
      .max(20_000),
    subject: z
      .object({
        assetId: z.string().min(1).max(240),
        sourceId: z.string().min(1).max(240),
        sourceRevisionId: z.string().min(1).max(240),
        contentDigest: digest,
      })
      .strict(),
  })
  .strict();
const observationSchema = z
  .object({
    componentId: z.string().min(1).max(240),
    /** Scanner envelope claim; this owns the ninety-day report freshness clock. */
    reportSignedAt: z.string().datetime(),
    /** Original envelope verification window, retained as provenance only. */
    reportVerificationExpiresAt: z.string().datetime(),
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

/** Display-only data, authored exclusively from a same-process operational witness. */
export const ScannerEvidenceProjectionRecordV1Schema = z
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
    publications: z.array(ScannerPublicationProjectionV1Schema).min(1).max(1_000),
    observations: z.array(observationSchema).min(1).max(1_000),
    verification: z
      .object({
        method: z.literal("gh-attestation-verify"),
        /** Original Core intake timestamp, never refreshed by later reverification. */
        preparedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.catalog.coverageProjectionDigest !== packagedCoverageProjectionDigestV1(value.coverage)
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
        ctx.addIssue({ code: "custom", message: "publication outside report verification window" });
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

/** Package admission additionally restricts the catalog to the release-owned registry. */
export const PackagedScannerCollectionEvidenceRecordV1Schema =
  ScannerEvidenceProjectionRecordV1Schema.refine(
    (value) => catalogId.safeParse(value.catalog.id).success,
    { message: "unregistered packaged catalog id" },
  )
    .refine(
      (value) =>
        value.publications.every((publication) =>
          SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.some(
            (publisher) => publisher.commit === publication.sourceCommit,
          ),
        ),
      { message: "unreviewed packaged publisher" },
    )
    .transform((value) => ({
      ...value,
      catalog: { ...value.catalog, id: catalogId.parse(value.catalog.id) },
    }));

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
  if (cached.input.length !== PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1.length) return false;
  return cached.input.every(
    (item, index) =>
      item.bytes === PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1[index]?.bytes &&
      item.sha256 === PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1[index]?.sha256,
  );
}

/** Inputless loader for independent source records shipped by the release process. */
export function packagedScannerCollectionEvidenceV1(): readonly PackagedScannerCollectionEvidenceRecordV1[] {
  const cached = cachedPackagedCollectionEvidenceV1;
  if (cached !== undefined && cachedInputMatchesPackageV1(cached))
    return deepFreezeStrictJsonV1(structuredClone(cached.records));

  const records: PackagedScannerCollectionEvidenceRecordV1[] = [];
  const sourceIds = new Set<string>();
  for (const item of PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1) {
    if (
      Buffer.byteLength(item.bytes, "utf8") > 4 * 1024 * 1024 ||
      !digest.safeParse(item.sha256).success
    )
      throw new TypeError("Packaged collection evidence seal mismatch.");
    const actual = `sha256:${createHash("sha256").update(item.bytes, "utf8").digest("hex")}`;
    if (actual !== item.sha256) throw new TypeError("Packaged collection evidence seal mismatch.");
    const parsed = PackagedScannerCollectionEvidenceRecordV1Schema.parse(
      parseStrictJsonObjectV1(item.bytes, "Packaged collection evidence"),
    );
    if (!canonicalStrictJsonBytesV1(parsed).equals(Buffer.from(item.bytes, "utf8")))
      throw new TypeError("Packaged collection evidence must use canonical bytes.");
    if (sourceIds.has(parsed.catalog.id))
      throw new TypeError("Duplicate packaged collection source.");
    sourceIds.add(parsed.catalog.id);
    records.push(parsed);
  }
  const input = PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1.map((item) =>
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
  component: PackagedScannerCollectionEvidenceRecordV1["coverage"]["components"][number],
  record: ScannerEvidenceProjectionRecordV1,
): boolean {
  const asset = bundle.assets[component.subject.assetId];
  const source = bundle.sources[component.subject.sourceId];
  return (
    asset !== undefined &&
    source !== undefined &&
    source.id === record.catalog.source.id &&
    source.revision.id === record.catalog.source.revisionId &&
    source.revision.contentDigest === record.catalog.source.contentDigest &&
    source.inputFormat === record.catalog.source.inputFormat &&
    source.upstreamOrigin.kind === record.catalog.source.upstreamOrigin.kind &&
    source.upstreamOrigin.locator === record.catalog.source.upstreamOrigin.locator &&
    source.id === component.subject.sourceId &&
    asset.id === component.subject.assetId &&
    asset.sourceId === component.subject.sourceId &&
    asset.sourceRevisionId === component.subject.sourceRevisionId &&
    asset.contentDigest === component.subject.contentDigest &&
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
      if (
        report === undefined ||
        observation === undefined ||
        !exactAsset(bundle, component, record)
      )
        continue;
      const validUntil = evidenceExpiryV1(observation.reportSignedAt);
      const published = record.publications.find(
        (item) =>
          item.requestSha256 === observation.requestSha256 &&
          item.publicationSha256 === observation.publicationSha256 &&
          item.receiptSha256 === observation.receiptSha256,
      );
      if (published === undefined) continue;
      const id = `evidence:${component.subject.assetId}`;
      result[id] = EvidenceSummaryV1Schema.parse({
        id,
        projectionVersion: "evidence-summary/v1",
        subjects: [component.subject],
        evidenceDigest: `sha256:${canonicalStrictJsonSha256V1({ record: recordDigest, component, observation })}`,
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
  return result;
}
