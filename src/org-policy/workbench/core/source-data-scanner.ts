import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BaselineCatalogSchema } from "../../../baseline-evidence/catalog.js";
import { hashComponentTree } from "../../../baseline-evidence/hash.js";
import { componentIdentityPaths } from "../../../baseline-evidence/license.js";
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
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../../../contract/strict-json-v1.js";
import {
  assertEccRuntimeDescriptorCustodyV1,
  currentEccRuntimeAdapterCompatibilityV1,
  type EccRuntimeDescriptorV1,
  EccRuntimeDescriptorV1Schema,
  type PreparedEccRuntimeDescriptorV1,
} from "../../../ecc/runtime-descriptor.js";
import { deriveEccRuntimeDeclaredEvaluationV1 } from "../../../ecc/runtime-descriptor-evaluation.js";
import { evidenceExpiryV1 } from "../../../evidence-freshness.js";
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
import { verifyScannerComponentContainmentV1 } from "./source-data-containment.js";
import {
  readSourceDataProofBlobV1,
  SOURCE_DATA_RAW_PROOF_BUDGET_V1,
  SourceDataCompilerBlobV1Schema,
  SourceDataScannerBlobBatchV1Schema,
} from "./source-data-proof-blobs.js";
import { verifySourceDataArtifactWithGithubV1 } from "./source-data-qualification.js";
import { mintPreparedEccRuntimeDescriptorV1 } from "./source-data-runtime-descriptor-custody.js";

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
function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function decode(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail();
  return bytes;
}

export { sealPreparedEccRuntimeDescriptorV1 } from "./source-data-runtime-descriptor-custody.js";

/** Reject stale authenticated report facts before they can mint runtime custody. */
export function assertCurrentRuntimeDescriptorEvidenceV1(validUntil: string, now: string): void {
  const expiry = Date.parse(validUntil);
  const current = Date.parse(now);
  if (!Number.isFinite(expiry) || !Number.isFinite(current) || expiry <= current) fail();
}

function preparedEccRuntimeDescriptorV1(
  sourceRoot: string,
  compilerInput: z.infer<typeof SourceDataBaselineInputV1Schema>,
  prepared: ReturnType<typeof prepareSourceDataBaselineCoverageV1>,
  requestedComponents: readonly {
    readonly id: string;
    readonly paths: readonly string[];
    readonly treeSha256: string;
  }[],
  consumed: Awaited<ReturnType<typeof consumeScannerBaselinePublicationsV1>>,
  now: string,
): PreparedEccRuntimeDescriptorV1 | undefined {
  if (compilerInput.framework.id !== "ecc") return undefined;
  for (const asset of compilerInput.framework.assets) {
    const dependencies = asset.dependencies ?? [];
    const riders = asset.riders ?? [];
    if (
      new Set(dependencies).size !== dependencies.length ||
      new Set(riders).size !== riders.length
    )
      fail();
  }
  const prefix = `${compilerInput.framework.id}/`;
  const componentIds = new Set(
    prepared.coverage.components.map((component) => component.componentId),
  );
  const containment = verifyScannerComponentContainmentV1(
    sourceRoot,
    prepared.coverage.components,
    requestedComponents,
  );
  const signedAt = Math.min(
    ...consumed.provenance.map((publication) => Date.parse(publication.reportSignedAt)),
  );
  if (!Number.isFinite(signedAt)) fail();
  // A Scanner envelope's short verification window proves the original
  // attestation was observed in time. It is not a report TTL: report freshness
  // is the fixed policy interval from the earliest original signing date.
  const expiresAt = Date.parse(evidenceExpiryV1(new Date(signedAt).toISOString()));
  if (!Number.isFinite(expiresAt)) fail();
  assertCurrentRuntimeDescriptorEvidenceV1(new Date(expiresAt).toISOString(), now);
  if (
    consumed.evidence.id !== "ecc" ||
    `${consumed.evidence.owner}/${consumed.evidence.repo}` !== compilerInput.framework.repository ||
    consumed.evidence.pinnedSha !== compilerInput.framework.commit ||
    consumed.evidence.sourceTreeSha256 !== prepared.coverage.sourceTreeSha256
  )
    fail();
  const components = prepared.coverage.components
    .map((component) => {
      const kind = component.componentId.slice(0, component.componentId.indexOf(":"));
      if (!kind || component.primaryPath === undefined) fail();
      return {
        id: component.componentId,
        kind,
        primaryPath: component.primaryPath,
        paths: [...component.paths].sort(),
        files: component.files
          .map((file) => ({ path: file.path, digest: file.digest }))
          .sort((left, right) => codePointOrder(left.path, right.path)),
        treeSha256: component.componentTreeSha256,
        identityTreeSha256: hashComponentTree(
          sourceRoot,
          componentIdentityPaths(sourceRoot, component.paths),
        ).treeSha256,
      };
    })
    .sort((left, right) => codePointOrder(left.id, right.id));
  const mappings = containment
    .map((item) => ({
      componentId: item.componentId,
      rawComponentIds: [...item.publishedComponentIds].sort(),
    }))
    .sort((left, right) => codePointOrder(left.componentId, right.componentId));
  const evaluation = deriveEccRuntimeDeclaredEvaluationV1({
    rawReport: consumed.evidence,
    mappings,
    components,
  });
  const descriptor = deepFreezeStrictJsonV1(
    EccRuntimeDescriptorV1Schema.parse({
      version: "ecc-runtime-descriptor/v1",
      source: {
        repository: compilerInput.framework.repository,
        commit: compilerInput.framework.commit,
        treeSha256: prepared.coverage.sourceTreeSha256,
      },
      compilerInputDigest: prepared.coverage.compilerInputDigest,
      evidence: {
        rawReport: consumed.evidence,
        rawReportDigest: `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(consumed.evidence)).digest("hex")}`,
        custodyPublications: consumed.provenance
          .map((publication) => ({
            publicationSha256: publication.publicationSha256,
            requestSha256: publication.requestSha256,
            receiptSha256: publication.receiptSha256,
            reportSignedAt: publication.reportSignedAt,
            reportVerificationExpiresAt: publication.reportVerificationExpiresAt,
            attestedAt: publication.attestedAt,
          }))
          .sort((left, right) =>
            codePointOrder(
              `${left.requestSha256}\0${left.receiptSha256}\0${left.publicationSha256}`,
              `${right.requestSha256}\0${right.receiptSha256}\0${right.publicationSha256}`,
            ),
          ),
        validUntil: new Date(expiresAt).toISOString(),
        coreDerivedEvaluationDigest: evaluation.coreDerivedEvaluationDigest,
        projectionContractDigest: evaluation.projectionContractDigest,
        mappings,
      },
      components,
      revisionRelations: prepared.coverage.components
        .map((component) => ({
          componentId: component.componentId,
          sourceId: component.subject.sourceId,
          sourceRevisionId: component.subject.sourceRevisionId,
          contentDigest: component.subject.contentDigest,
        }))
        .sort((left, right) => codePointOrder(left.componentId, right.componentId)),
      relations: prepared.compiled.relations
        .map((relation) => {
          if (!relation.fromAssetId.startsWith(prefix) || !relation.toAssetId.startsWith(prefix))
            fail();
          const from = relation.fromAssetId.slice(prefix.length);
          const to = relation.toAssetId.slice(prefix.length);
          if (!componentIds.has(from) || !componentIds.has(to)) fail();
          return {
            from,
            to,
            kind: relation.kind,
            ...(relation.membership === undefined ? {} : { membership: relation.membership }),
          };
        })
        .sort((left, right) =>
          codePointOrder(
            `${left.from}\0${left.to}\0${left.kind}\0${left.membership ?? ""}`,
            `${right.from}\0${right.to}\0${right.kind}\0${right.membership ?? ""}`,
          ),
        ),
      riderRelations: compilerInput.framework.assets
        .flatMap((asset) =>
          (asset.riders ?? [])
            // A dependency is mandatory. If a legacy compiler template names the
            // same item as a rider, retain the mandatory interpretation.
            .filter((to) => !(asset.dependencies ?? []).includes(to))
            .map((to) => ({
              from: asset.id,
              to,
            })),
        )
        .map((relation) => {
          if (!componentIds.has(relation.from) || !componentIds.has(relation.to)) fail();
          return relation;
        })
        .sort((left, right) =>
          codePointOrder(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`),
        ),
      adapterCompatibility: currentEccRuntimeAdapterCompatibilityV1(components),
    }),
  ) as EccRuntimeDescriptorV1;
  assertEccRuntimeDescriptorCustodyV1(descriptor, now);
  return mintPreparedEccRuntimeDescriptorV1(descriptor);
}

interface RuntimeDescriptorCollectorV1 {
  value?: PreparedEccRuntimeDescriptorV1;
}

/** Replays authenticated raw results against exact source bytes; never executes external analyzers. */
async function prepareSourceDataScannerEvidenceOperationalV1(
  bundle: AuthoringCatalogBundleV1,
  input: unknown,
  sourceRoot: string,
  issuedAt: string,
  authorizedCommits: readonly string[] = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.map(
    (item) => item.commit,
  ),
  now = new Date().toISOString(),
  proofRoot?: string,
  runtimeCollector?: RuntimeDescriptorCollectorV1,
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
      const evidence = projectContainedScannerEvidenceV1({
        bundle,
        sourceRoot,
        declared: prepared.coverage.components,
        declaredCatalog: prepared.catalog,
        catalog: publishedCatalog,
        requests,
        consumed,
        preparedAt: proof.preparedAt,
      });
      if (compilerInput.version === "pinned-baseline/v1") {
        const runtime = preparedEccRuntimeDescriptorV1(
          sourceRoot,
          compilerInput,
          prepareSourceDataBaselineCoverageV1(sourceRoot, compilerInput),
          requests.flatMap((request) => request.components),
          consumed,
          now,
        );
        if (runtime !== undefined && runtimeCollector !== undefined)
          runtimeCollector.value = runtime;
      }
      return evidence;
    }
    const coverage = {
      version: prepared.coverage.version,
      authority: prepared.coverage.authority,
      scope: prepared.coverage.scope,
      components: prepared.coverage.components.map(
        ({ primaryPath: _primaryPath, ...component }) => component,
      ),
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
  return prepareSourceDataScannerEvidenceOperationalV1(
    bundle,
    input,
    sourceRoot,
    issuedAt,
    authorizedCommits,
    now,
    proofRoot,
  );
}

/** The only live preparation route for raw evidence and a historical ECC runtime descriptor. */
export async function prepareSourceDataScannerRuntimeFactsV1(
  bundle: AuthoringCatalogBundleV1,
  input: unknown,
  sourceRoot: string,
  issuedAt: string,
  authorizedCommits: readonly string[] = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.map(
    (item) => item.commit,
  ),
  now = new Date().toISOString(),
  proofRoot?: string,
): Promise<
  Readonly<{
    evidence: AuthoringCatalogBundleV1["evidence"];
    descriptor?: PreparedEccRuntimeDescriptorV1;
  }>
> {
  const collector: RuntimeDescriptorCollectorV1 = {};
  const evidence = await prepareSourceDataScannerEvidenceOperationalV1(
    bundle,
    input,
    sourceRoot,
    issuedAt,
    authorizedCommits,
    now,
    proofRoot,
    collector,
  );
  return Object.freeze({
    evidence,
    ...(collector.value === undefined ? {} : { descriptor: collector.value }),
  });
}

/** The only live preparation route for a historical ECC runtime descriptor. */
export async function prepareSourceDataScannerRuntimeDescriptorV1(
  bundle: AuthoringCatalogBundleV1,
  input: unknown,
  sourceRoot: string,
  issuedAt: string,
  authorizedCommits: readonly string[] = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.map(
    (item) => item.commit,
  ),
  now = new Date().toISOString(),
  proofRoot?: string,
): Promise<PreparedEccRuntimeDescriptorV1 | undefined> {
  return (
    await prepareSourceDataScannerRuntimeFactsV1(
      bundle,
      input,
      sourceRoot,
      issuedAt,
      authorizedCommits,
      now,
      proofRoot,
    )
  ).descriptor;
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
