import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BaselineCatalogSchema } from "../../../baseline-evidence/catalog.js";
import { createCoreBaselineVetRequests } from "../../../baseline-evidence/scanner-consumer.js";
import { prepareCollectionScannerCoverageV1 } from "../../../baseline-evidence/scanner-provider-catalogs.js";
import { consumeScannerBaselinePublicationsV1 } from "../../../baseline-evidence/scanner-publication.js";
import {
  SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
  SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
  SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1,
} from "../../../baseline-evidence/scanner-publication-policy.js";
import {
  prepareSourceDataBaselineCoverageV1,
  type SourceDataBaselineInputV1Schema,
} from "../../../baseline-evidence/source-data-baseline-preparation.js";
import {
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../../../contract/strict-json-v1.js";
import {
  packagedCoverageProjectionDigestV1,
  packagedReportComponentDigestV1,
  projectScannerCollectionEvidenceV1,
  type ScannerEvidenceProjectionRecordV1,
  ScannerEvidenceProjectionRecordV1Schema,
} from "../../packaged-collection-evidence-v1.js";
import type { PinnedComponentCollectionInputV1 } from "../compilers/pinned-component-collection.js";
import type { PinnedSkillCollectionInputV1 } from "../compilers/pinned-skill-collection.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
import { projectContainedScannerEvidenceV1 } from "./source-data-contained-projection.js";
import {
  readSourceDataProofBlobV1,
  SOURCE_DATA_RAW_PROOF_BUDGET_V1,
  SourceDataCompilerBlobV1Schema,
  SourceDataScannerBlobBatchV1Schema,
} from "./source-data-proof-blobs.js";
import { verifySourceDataArtifactWithGithubV1 } from "./source-data-qualification.js";

export const SourceDataScannerProofV1Schema = z
  .object({
    version: z.literal("source-data-scanner-proof/v1"),
    compilerInput: z.unknown(),
    /** Original published component inventory, when broader than compiler closures. */
    publishedCatalog: BaselineCatalogSchema.refine(
      (value) =>
        value.components.length <= 4_096 &&
        value.components.every((component) => component.paths.length <= 10_000),
    ).optional(),
    preparedAt: z.string().datetime(),
    publisherCommit: z.string().regex(/^[a-f0-9]{40}$/),
    batches: z
      .array(
        z.union([
          z
            .object({
              discoveryBytesBase64: z.string().min(1).max(12_000),
              publicationBytesBase64: z.string().min(1).max(16_000_000),
              attestation: z.string().min(1).max(512_000),
            })
            .strict(),
          SourceDataScannerBlobBatchV1Schema,
        ]),
      )
      .min(1)
      .max(16),
  })
  .strict();

function fail(): never {
  throw new TypeError(
    "Workbench source data: independent Scanner proof or source binding rejected",
  );
}
function decode(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail();
  return bytes;
}

/** Replays authenticated raw results against exact source bytes; never executes external analyzers. */
export async function prepareSourceDataScannerEvidenceV1(
  bundle: AuthoringCatalogBundleV1,
  input: unknown,
  sourceRoot: string,
  issuedAt: string,
  authorizedCommits: readonly string[] = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.map(
    (item) => item.commit,
  ),
  now = new Date().toISOString(),
  proofRoot?: string,
): Promise<AuthoringCatalogBundleV1["evidence"]> {
  assertStrictJsonValueV1(input, "Scanner source proof");
  const proof = SourceDataScannerProofV1Schema.parse(input);
  const compilerBlob =
    (proof.compilerInput as { version?: unknown })?.version === "source-compiler-input-blob/v1"
      ? SourceDataCompilerBlobV1Schema.parse(proof.compilerInput)
      : undefined;
  const declaredProofBytes =
    (compilerBlob?.bytes ?? canonicalStrictJsonBytesV1(proof.compilerInput).length) +
    proof.batches.reduce(
      (sum, batch) =>
        sum +
        ("version" in batch
          ? batch.discovery.bytes + batch.publication.bytes + batch.attestation.bytes
          : Math.ceil(
              ((batch.discoveryBytesBase64.length + batch.publicationBytesBase64.length) * 3) / 4,
            ) + Buffer.byteLength(batch.attestation)),
      0,
    );
  if (declaredProofBytes > SOURCE_DATA_RAW_PROOF_BUDGET_V1) fail();
  if (
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(proof.preparedAt) > Date.parse(issuedAt) ||
    Date.parse(issuedAt) > Date.parse(now) ||
    !authorizedCommits.includes(proof.publisherCommit)
  )
    fail();
  // The compiler performs strict byte/schema validation before these typed values
  // can become coverage. Inventory signatures cannot manufacture file identity.
  const compilerInput = (
    compilerBlob
      ? parseStrictJsonObjectV1(
          readSourceDataProofBlobV1(
            { sha256: compilerBlob.sha256, bytes: compilerBlob.bytes },
            proofRoot,
            64 * 1024 * 1024,
          ).toString("utf8"),
          "Scanner compiler input blob",
        )
      : proof.compilerInput
  ) as
    | PinnedSkillCollectionInputV1
    | PinnedComponentCollectionInputV1
    | z.infer<typeof SourceDataBaselineInputV1Schema>;
  if (
    compilerInput?.version !== "pinned-skill-collection/v1" &&
    compilerInput?.version !== "pinned-component-collection/v1" &&
    compilerInput?.version !== "pinned-baseline/v1"
  )
    fail();
  if (compilerInput.version === "pinned-baseline/v1" && proof.publishedCatalog === undefined)
    fail();
  const prepare = () =>
    compilerInput.version === "pinned-baseline/v1"
      ? prepareSourceDataBaselineCoverageV1(sourceRoot, compilerInput)
      : prepareCollectionScannerCoverageV1(sourceRoot, compilerInput);
  const prepared = prepare();
  const source = bundle.sources[prepared.coverage.source.id];
  if (
    !source ||
    Object.keys(bundle.sources).length !== 1 ||
    source.revision.id !== prepared.coverage.source.revisionId ||
    source.revision.contentDigest !== prepared.coverage.source.contentDigest ||
    source.inputFormat !== prepared.coverage.source.inputFormat ||
    source.upstreamOrigin.locator !== prepared.coverage.source.repository
  )
    fail();
  for (const component of prepared.coverage.components) {
    const asset = bundle.assets[component.subject.assetId];
    if (
      !asset ||
      asset.sourceId !== component.subject.sourceId ||
      asset.sourceRevisionId !== component.subject.sourceRevisionId ||
      asset.contentDigest !== component.subject.contentDigest
    )
      fail();
  }
  const publishedCatalog = proof.publishedCatalog ?? prepared.catalog;
  if (
    publishedCatalog.owner !== prepared.catalog.owner ||
    publishedCatalog.repo !== prepared.catalog.repo ||
    publishedCatalog.pinnedSha !== prepared.catalog.pinnedSha
  )
    fail();
  const requests = createCoreBaselineVetRequests(sourceRoot, publishedCatalog);
  if (requests.length !== proof.batches.length) fail();
  const publisher = { ...SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1, commit: proof.publisherCommit };
  const directory = mkdtempSync(join(tmpdir(), "aih-source-scanner-proof-"));
  try {
    const batches = proof.batches.map((batch, index) => {
      const publicationBytes =
        "version" in batch
          ? readSourceDataProofBlobV1(batch.publication, proofRoot, 12_000_000)
          : decode(batch.publicationBytesBase64);
      const discoveryBytes =
        "version" in batch
          ? readSourceDataProofBlobV1(batch.discovery, proofRoot, 8_192)
          : decode(batch.discoveryBytesBase64);
      const attestation =
        "version" in batch
          ? readSourceDataProofBlobV1(batch.attestation, proofRoot, 512_000).toString("utf8")
          : batch.attestation;
      const request = requests[index];
      if (!request) fail();
      // Decode only to reject malformed transport before launching the verifier.
      parseStrictJsonObjectV1(publicationBytes.toString("utf8"), "Scanner publication");
      const attestationResultBytes = Buffer.from(
        verifySourceDataArtifactWithGithubV1(
          publicationBytes,
          attestation,
          {
            ...publisher,
            issuer: "https://token.actions.githubusercontent.com",
            subjectName: "publication.json",
          },
          directory,
          `publication-${index}`,
        ),
        "utf8",
      );
      return {
        discoveryBytes,
        publicationBytes,
        attestationResultBytes,
        expectedRequestSha256: request.requestSha256,
      };
    });
    // The consumer authenticates publication.verification.expected.now as part
    // of the GH-attested bytes for original intake. Actual now bounds report
    // freshness separately; proof.preparedAt cannot change either clock.
    const consumed = await consumeScannerBaselinePublicationsV1({
      sourceRoot,
      catalog: publishedCatalog,
      publications: batches,
      publisher,
      now,
      maxAgeSeconds: SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
    });
    if (
      consumed.provenance.some((item) => Date.parse(item.attestedAt) > Date.parse(proof.preparedAt))
    )
      fail();
    if (prepare().coverageDigest !== prepared.coverageDigest) fail();
    if (proof.publishedCatalog !== undefined) {
      return projectContainedScannerEvidenceV1({
        bundle,
        sourceRoot,
        declared: prepared.coverage.components,
        declaredCatalog: prepared.catalog,
        catalog: publishedCatalog,
        requests,
        consumed,
        preparedAt: proof.preparedAt,
      });
    }
    const coverage = {
      version: prepared.coverage.version,
      authority: prepared.coverage.authority,
      scope: prepared.coverage.scope,
      components: prepared.coverage.components,
      unmappedDerivedAssets: prepared.coverage.unmappedDerivedAssets,
    };
    const record: ScannerEvidenceProjectionRecordV1 = {
      version: "packaged-scanner-collection-evidence/v1",
      authority: "display-only",
      catalog: {
        id: prepared.catalog.id,
        owner: prepared.catalog.owner,
        repository: prepared.catalog.repo,
        pinnedCommit: prepared.catalog.pinnedSha,
        sourceTreeSha256: prepared.coverage.sourceTreeSha256,
        coverageDigest: prepared.coverageDigest,
        coverageProjectionDigest: packagedCoverageProjectionDigestV1(coverage),
        source: {
          id: prepared.coverage.source.id,
          revisionId: prepared.coverage.source.revisionId,
          contentDigest: prepared.coverage.source.contentDigest,
          inputFormat: prepared.coverage.source.inputFormat,
          upstreamOrigin: { kind: "git", locator: prepared.coverage.source.repository },
        },
      },
      coverage,
      report: consumed.evidence,
      publications: consumed.provenance.map((item) => ({
        authority: item.authority,
        repository: item.repository,
        workflow: item.workflow,
        ref: item.ref,
        sourceCommit: item.sourceCommit,
        publicationSha256: item.publicationSha256,
        requestSha256: item.requestSha256,
        receiptSha256: item.receiptSha256,
        publicationLocator: item.publicationLocator,
        publishedAt: item.attestedAt,
      })),
      observations: requests
        .flatMap((request, index) =>
          request.components.map((component) => {
            const publication = consumed.provenance[index];
            const report = consumed.evidence.components.find((item) => item.id === component.id);
            if (!publication || !report) fail();
            return {
              componentId: component.id,
              componentTreeSha256: component.treeSha256,
              reportSignedAt: publication.reportSignedAt,
              reportVerificationExpiresAt: publication.reportVerificationExpiresAt,
              requestSha256: publication.requestSha256,
              publicationSha256: publication.publicationSha256,
              receiptSha256: publication.receiptSha256,
              reportComponentDigest: packagedReportComponentDigestV1(report),
            };
          }),
        )
        .sort((left, right) =>
          left.componentId < right.componentId ? -1 : left.componentId > right.componentId ? 1 : 0,
        ),
      verification: { method: "gh-attestation-verify", preparedAt: proof.preparedAt },
    };
    const verifiedRecord = ScannerEvidenceProjectionRecordV1Schema.parse(record);
    const evidence = projectScannerCollectionEvidenceV1(bundle, [verifiedRecord]);
    if (Object.keys(evidence).length !== prepared.coverage.components.length) fail();
    return evidence;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Imported claims must exactly equal independently rederived summaries before local receipt creation. */
export async function verifySourceDataScannerV1(
  bundle: AuthoringCatalogBundleV1,
  input: unknown,
  sourceRoot: string,
  issuedAt: string,
  authorizedCommits?: readonly string[],
  now = new Date().toISOString(),
  proofRoot?: string,
): Promise<AuthoringCatalogBundleV1["evidence"]> {
  const evidence = await prepareSourceDataScannerEvidenceV1(
    bundle,
    input,
    sourceRoot,
    issuedAt,
    authorizedCommits,
    now,
    proofRoot,
  );
  if (canonicalStrictJsonSha256V1(evidence) !== canonicalStrictJsonSha256V1(bundle.evidence))
    fail();
  return evidence;
}
