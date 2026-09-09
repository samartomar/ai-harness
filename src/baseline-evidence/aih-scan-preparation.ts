import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import type { PolicyAuthoringCatalog } from "../org-policy/catalog.js";
import {
  encodePackagedScannerCollectionEvidenceRecordV1,
  PackagedScannerCollectionEvidenceRecordV1Schema,
  packagedCoverageProjectionDigestV1,
  packagedReportComponentDigestV1,
} from "../org-policy/packaged-collection-evidence-v1.js";
import type { CompiledBuiltInCatalogV1 } from "../org-policy/workbench/compilers/built-in.js";
import {
  type AihScanMaterialCoreRevisionV1,
  type AihScanMaterialCoverageV1,
  materializeAihScanSubjectsV1,
} from "./aih-scan-material.js";
import { createCoreBaselineVetRequests } from "./scanner-consumer.js";
import {
  consumeScannerBaselinePublicationsV1,
  type ScannerBaselinePublicationProvenanceV1,
  type ScannerBaselinePublicationPublisherV1,
} from "./scanner-publication.js";
import {
  SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
  scannerBaselinePublicationPublisherForLocatorV1,
} from "./scanner-publication-policy.js";
import type { BaselineSourceEvidence } from "./schema.js";

const DISCOVERY_MAX_BYTES = 8 * 1024;
const PUBLICATION_MAX_BYTES = 96 * 1024 * 1024;
const TOTAL_INPUT_MAX_BYTES = 128 * 1024 * 1024;
const ATTESTATION_MAX_BYTES = 256 * 1024;
const ATTESTATION_TIMEOUT_MS = 30_000;
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

export interface AihScannerPublicationBatchV1 {
  readonly discoveryBytes: Buffer;
  readonly publicationBytes: Buffer;
}

export interface PrepareAihScannerPublicationsV1Input {
  readonly packageRoot: string;
  readonly materialOutputParent?: string;
  readonly coreRevision: AihScanMaterialCoreRevisionV1;
  readonly catalog: PolicyAuthoringCatalog;
  readonly compiled: CompiledBuiltInCatalogV1;
  readonly batches: readonly AihScannerPublicationBatchV1[];
  readonly now: string;
}

export interface ReverifyPackagedAihScannerEvidenceRecordV1Input {
  readonly packageRoot: string;
  readonly coreRevision: AihScanMaterialCoreRevisionV1;
  readonly catalog: PolicyAuthoringCatalog;
  readonly compiled: CompiledBuiltInCatalogV1;
  readonly batches: readonly AihScannerPublicationBatchV1[];
  readonly now: string;
  readonly sealed: Readonly<{ readonly bytes: string; readonly sha256: string }>;
}

/** Opaque same-process custody handle. JSON clones cannot author a release record. */
export interface PreparedAihScannerPublicationsV1 {
  readonly kind: "prepared-aih-scanner-publications/v1";
}

export interface AuthoredAihScannerPublicationV1 {
  readonly version: "aih-scanner-publication-output/v1";
  readonly authority: "none";
  readonly catalog: Readonly<{
    readonly id: "aih";
    readonly owner: "samartomar";
    readonly repository: "ai-harness";
    readonly pinnedCommit: string;
    readonly sourceTreeSha256: string;
    readonly coverageDigest: string;
    readonly source: Readonly<{
      readonly id: string;
      readonly revisionId: string;
      readonly contentDigest: string;
      readonly inputFormat: "built-in/v1";
      readonly upstreamOrigin: Readonly<{ readonly kind: "aih"; readonly locator: string }>;
    }>;
  }>;
  readonly coverage: AihScanMaterialCoverageV1;
  readonly report: BaselineSourceEvidence;
  readonly publications: readonly ScannerBaselinePublicationProvenanceV1[];
  readonly observations: readonly Readonly<{
    readonly componentId: string;
    readonly componentTreeSha256: string;
    readonly reportSignedAt: string;
    readonly reportVerificationExpiresAt: string;
    readonly requestSha256: string;
    readonly publicationSha256: string;
    readonly receiptSha256: string;
  }>[];
  readonly verification: Readonly<{
    readonly method: "gh-attestation-verify";
    /** Original Core intake timestamp, retained through later reverification. */
    readonly preparedAt: string;
  }>;
}

interface PreparedFacts {
  readonly output: AuthoredAihScannerPublicationV1;
}

const preparedFacts = new WeakMap<PreparedAihScannerPublicationsV1, PreparedFacts>();

function fail(message: string): never {
  throw new TypeError(`AIH Scanner preparation: ${message}`);
}

function ownData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) fail(label);
  return descriptor.value;
}

function assertRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail(label);
  for (const key of Object.keys(value)) ownData(value, key, label);
}

function cloneBytes(value: unknown, maximum: number, label: string): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > maximum)
    fail(`${label} bytes`);
  return Buffer.from(value);
}

function assertInput(
  input: PrepareAihScannerPublicationsV1Input,
): asserts input is PrepareAihScannerPublicationsV1Input {
  assertRecord(
    input,
    [
      "packageRoot",
      "materialOutputParent",
      "coreRevision",
      "catalog",
      "compiled",
      "batches",
      "now",
    ],
    ["packageRoot", "coreRevision", "catalog", "compiled", "batches", "now"],
    "input",
  );
  if (
    typeof ownData(input, "packageRoot", "input") !== "string" ||
    !Array.isArray(ownData(input, "batches", "input")) ||
    typeof ownData(input, "now", "input") !== "string" ||
    (Object.hasOwn(input, "materialOutputParent") &&
      typeof ownData(input, "materialOutputParent", "input") !== "string")
  )
    fail("input");
  const batches = input.batches;
  if (batches.length === 0 || batches.length > 1_000) fail("publication batch count");
  let total = 0;
  for (const batch of batches) {
    assertRecord(
      batch,
      ["discoveryBytes", "publicationBytes"],
      ["discoveryBytes", "publicationBytes"],
      "batch",
    );
    const discovery = ownData(batch, "discoveryBytes", "batch");
    const publication = ownData(batch, "publicationBytes", "batch");
    if (!Buffer.isBuffer(discovery) || !Buffer.isBuffer(publication)) fail("batch bytes");
    total += discovery.length + publication.length;
    if (!Number.isSafeInteger(total) || total > TOTAL_INPUT_MAX_BYTES) fail("total batch bytes");
  }
}

function stagingRoot(path: string): string {
  const root = resolve(path);
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("attestation custody");
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("AIH Scanner preparation:"))
      throw error;
    fail("attestation custody");
  }
  return root;
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value.length > 0 &&
    !value.startsWith("..") &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

/** Removes only the freshly materialized private scan tree, never its caller-owned parent. */
function removeMaterializedSourceRoot(sourceRoot: string): void {
  const root = resolve(sourceRoot);
  if (!basename(root).startsWith("aih-scan-material-")) fail("materialized source custody");
  const unlock = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail("materialized source custody");
    if (!stat.isDirectory()) return;
    for (const child of readdirSync(path)) {
      const nested = join(path, child);
      if (!within(root, nested)) fail("materialized source custody");
      unlock(nested);
    }
    chmodSync(path, 0o700);
  };
  unlock(root);
  rmSync(root, { recursive: true, force: false, maxRetries: 2, retryDelay: 20 });
}

async function attestPublicationBytes(
  run: Runner,
  tempRoot: string,
  publicationBytes: Buffer,
  publisher: ScannerBaselinePublicationPublisherV1,
): Promise<Buffer> {
  let root: string | undefined;
  let staging: string | undefined;
  try {
    root = stagingRoot(tempRoot);
    staging = mkdtempSync(join(root, "aih-scanner-publication-"));
    if (!within(root, staging)) fail("attestation custody");
    const stat = lstatSync(staging);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("attestation custody");
    const path = join(staging, "publication.json");
    writeFileSync(path, publicationBytes, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    const result = await run(
      [
        "gh",
        "attestation",
        "verify",
        path,
        "--repo",
        publisher.repository,
        "--signer-workflow",
        publisher.workflow,
        "--source-ref",
        publisher.ref,
        "--source-digest",
        publisher.commit,
        "--cert-oidc-issuer",
        GITHUB_OIDC_ISSUER,
        "--predicate-type",
        SLSA_PROVENANCE_V1,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
      { cwd: staging, maxBufferBytes: ATTESTATION_MAX_BYTES, timeoutMs: ATTESTATION_TIMEOUT_MS },
    );
    if (
      result.code !== 0 ||
      result.spawnError === true ||
      result.truncated === true ||
      typeof result.stdout !== "string"
    )
      fail("attestation rejected");
    return cloneBytes(Buffer.from(result.stdout, "utf8"), ATTESTATION_MAX_BYTES, "attestation");
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("AIH Scanner preparation:"))
      throw error;
    fail("attestation rejected");
  } finally {
    if (root !== undefined && staging !== undefined && within(root, staging)) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        fail("attestation custody");
      }
    }
  }
  fail("attestation rejected");
}

/**
 * Verify published Scanner reports over a source tree freshly materialized from
 * an exact Core checkout. The synthetic tree is intentionally never sent to
 * generic checkout preparation: only the original Core checkout owns the Git pin.
 */
export async function prepareAihScannerPublicationsV1(
  input: PrepareAihScannerPublicationsV1Input,
): Promise<PreparedAihScannerPublicationsV1> {
  assertInput(input);
  const materialized = materializeAihScanSubjectsV1({
    packageRoot: input.packageRoot,
    ...(input.materialOutputParent === undefined
      ? {}
      : { outputParent: input.materialOutputParent }),
    coreRevision: input.coreRevision,
    catalog: input.catalog,
    compiled: input.compiled,
  });
  try {
    const requests = createCoreBaselineVetRequests(materialized.sourceRoot, materialized.catalog);
    if (requests.length !== input.batches.length) fail("publication batch count");
    const discovery = parseStrictJsonObjectV1(
      cloneBytes(
        input.batches[0]?.discoveryBytes ?? fail("missing discovery"),
        DISCOVERY_MAX_BYTES,
        "discovery",
      ).toString("utf8"),
      "publication discovery",
    );
    const publisher =
      scannerBaselinePublicationPublisherForLocatorV1(discovery.locator) ??
      fail("unreviewed publisher");
    const run = defaultRunner;
    const publications = [] as {
      expectedRequestSha256: string;
      discoveryBytes: Buffer;
      publicationBytes: Buffer;
      attestationResultBytes: Buffer;
    }[];
    for (const [index, batch] of input.batches.entries()) {
      const publicationBytes = cloneBytes(
        batch.publicationBytes,
        PUBLICATION_MAX_BYTES,
        "publication",
      );
      publications.push({
        expectedRequestSha256: requests[index]?.requestSha256 ?? fail("request batch"),
        discoveryBytes: cloneBytes(batch.discoveryBytes, DISCOVERY_MAX_BYTES, "discovery"),
        publicationBytes,
        attestationResultBytes: await attestPublicationBytes(
          run,
          tmpdir(),
          publicationBytes,
          publisher,
        ),
      });
    }
    const consumed = await consumeScannerBaselinePublicationsV1({
      sourceRoot: materialized.sourceRoot,
      catalog: materialized.catalog,
      publications,
      publisher,
      now: input.now,
      maxAgeSeconds: SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
    });
    const provenanceByComponent = new Map<
      string,
      { provenance: ScannerBaselinePublicationProvenanceV1; componentTreeSha256: string }
    >();
    for (const [index, request] of requests.entries()) {
      const provenance = consumed.provenance[index];
      if (provenance === undefined) fail("publication provenance");
      for (const component of request.components) {
        if (provenanceByComponent.has(component.id)) fail("duplicate component provenance");
        provenanceByComponent.set(component.id, {
          provenance,
          componentTreeSha256: component.treeSha256,
        });
      }
    }
    const observations = consumed.evidence.components
      .map((component) => {
        const joined = provenanceByComponent.get(component.id);
        if (joined === undefined) fail("missing component provenance");
        return {
          componentId: component.id,
          componentTreeSha256: joined.componentTreeSha256,
          reportSignedAt: joined.provenance.reportSignedAt,
          reportVerificationExpiresAt: joined.provenance.reportVerificationExpiresAt,
          requestSha256: joined.provenance.requestSha256,
          publicationSha256: joined.provenance.publicationSha256,
          receiptSha256: joined.provenance.receiptSha256,
        };
      })
      .sort((left, right) => left.componentId.localeCompare(right.componentId));
    const output = deepFreezeStrictJsonV1({
      version: "aih-scanner-publication-output/v1" as const,
      authority: "none" as const,
      catalog: {
        id: "aih" as const,
        owner: "samartomar" as const,
        repository: "ai-harness" as const,
        pinnedCommit: materialized.catalog.pinnedSha,
        sourceTreeSha256: materialized.coverage.sourceTreeSha256,
        coverageDigest: materialized.coverageDigest,
        source: {
          id: materialized.coverage.source.id,
          revisionId: materialized.coverage.source.revisionId,
          contentDigest: materialized.coverage.source.contentDigest,
          inputFormat: "built-in/v1" as const,
          upstreamOrigin: {
            kind: "aih" as const,
            locator: materialized.coverage.source.locator,
          },
        },
      },
      coverage: materialized.coverage,
      report: consumed.evidence,
      publications: consumed.provenance,
      observations,
      verification: { method: "gh-attestation-verify" as const, preparedAt: input.now },
    }) as AuthoredAihScannerPublicationV1;
    const prepared: PreparedAihScannerPublicationsV1 = Object.freeze({
      kind: "prepared-aih-scanner-publications/v1",
    });
    preparedFacts.set(prepared, { output });
    return prepared;
  } finally {
    removeMaterializedSourceRoot(materialized.sourceRoot);
  }
}

export function projectPreparedAihScannerEvidenceForDisplayV1(
  prepared: PreparedAihScannerPublicationsV1,
): BaselineSourceEvidence | undefined {
  const facts = preparedFacts.get(prepared);
  return facts === undefined ? undefined : structuredClone(facts.output.report);
}

/** Detached release-authoring output from operational same-process custody only. */
export function authorPreparedAihScannerPublicationV1(
  prepared: PreparedAihScannerPublicationsV1,
): AuthoredAihScannerPublicationV1 | undefined {
  const facts = preparedFacts.get(prepared);
  return facts === undefined ? undefined : structuredClone(facts.output);
}

/**
 * Seal the common display-only package record from an opaque operational witness.
 */
export function authorPackagedAihScannerEvidenceRecordV1(
  prepared: PreparedAihScannerPublicationsV1,
): { bytes: string; sha256: string } | undefined {
  const output = authorPreparedAihScannerPublicationV1(prepared);
  if (output === undefined) return undefined;
  const coverage = {
    version: output.coverage.version,
    authority: output.coverage.authority,
    scope: output.coverage.scope,
    components: output.coverage.components,
    unmappedDerivedAssets: output.coverage.unmappedDerivedAssets,
  };
  return encodePackagedScannerCollectionEvidenceRecordV1({
    version: "packaged-scanner-collection-evidence/v1" as const,
    authority: "display-only" as const,
    catalog: {
      ...output.catalog,
      coverageProjectionDigest: packagedCoverageProjectionDigestV1(coverage),
    },
    coverage,
    report: output.report,
    publications: output.publications.map((publication) => ({
      authority: publication.authority,
      repository: publication.repository,
      workflow: publication.workflow,
      ref: publication.ref,
      sourceCommit: publication.sourceCommit,
      publicationSha256: publication.publicationSha256,
      requestSha256: publication.requestSha256,
      receiptSha256: publication.receiptSha256,
      publicationLocator: publication.publicationLocator,
      publishedAt: publication.attestedAt,
    })),
    observations: output.observations.map((observation) => ({
      ...observation,
      reportComponentDigest: packagedReportComponentDigestV1(
        output.report.components.find((component) => component.id === observation.componentId),
      ),
    })),
    verification: {
      method: output.verification.method,
      preparedAt: output.verification.preparedAt,
    },
  });
}

/**
 * Reconsumes raw Scanner publications over the actual pinned Core checkout and
 * requires all sealed record facts to match. The original intake timestamp is
 * immutable display provenance, so it is restored only after fresh verification.
 */
export async function reverifyPackagedAihScannerEvidenceRecordV1(
  input: ReverifyPackagedAihScannerEvidenceRecordV1Input,
): Promise<PreparedAihScannerPublicationsV1> {
  assertRecord(
    input,
    ["packageRoot", "coreRevision", "catalog", "compiled", "batches", "now", "sealed"],
    ["packageRoot", "coreRevision", "catalog", "compiled", "batches", "now", "sealed"],
    "reverify input",
  );
  const packageRoot = ownData(input, "packageRoot", "reverify input");
  const coreRevision = ownData(input, "coreRevision", "reverify input");
  const catalog = ownData(input, "catalog", "reverify input");
  const compiled = ownData(input, "compiled", "reverify input");
  const batches = ownData(input, "batches", "reverify input");
  const now = ownData(input, "now", "reverify input");
  const sealedInput = ownData(input, "sealed", "reverify input");
  if (
    typeof packageRoot !== "string" ||
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now))
  )
    fail("sealed AIH record");
  assertRecord(sealedInput, ["bytes", "sha256"], ["bytes", "sha256"], "sealed AIH record");
  const bytes = ownData(sealedInput, "bytes", "sealed AIH record");
  const sha256 = ownData(sealedInput, "sha256", "sealed AIH record");
  if (typeof bytes !== "string" || typeof sha256 !== "string") fail("sealed AIH record");
  const sealedBytes = Buffer.from(bytes, "utf8");
  if (
    sealedBytes.length === 0 ||
    sealedBytes.length > 4 * 1024 * 1024 ||
    `sha256:${createHash("sha256").update(sealedBytes).digest("hex")}` !== sha256
  )
    fail("sealed AIH record");
  const sealed = PackagedScannerCollectionEvidenceRecordV1Schema.parse(
    parseStrictJsonObjectV1(bytes, "Sealed AIH record"),
  );
  if (
    !canonicalStrictJsonBytesV1(sealed).equals(sealedBytes) ||
    sealed.catalog.id !== "aih" ||
    Date.parse(sealed.verification.preparedAt) > Date.parse(now)
  )
    fail("sealed AIH record");
  assertRecord(coreRevision, ["pinnedSha"], ["pinnedSha"], "core revision");
  const pinnedSha = ownData(coreRevision, "pinnedSha", "core revision");
  if (typeof pinnedSha !== "string" || pinnedSha !== sealed.catalog.pinnedCommit)
    fail("sealed AIH record");
  const prepared = await prepareAihScannerPublicationsV1({
    packageRoot,
    coreRevision: { pinnedSha },
    catalog: catalog as PolicyAuthoringCatalog,
    compiled: compiled as CompiledBuiltInCatalogV1,
    batches: batches as readonly AihScannerPublicationBatchV1[],
    now,
  });
  const reverified = authorPackagedAihScannerEvidenceRecordV1(prepared);
  if (reverified === undefined) fail("reverified AIH custody");
  const current = PackagedScannerCollectionEvidenceRecordV1Schema.parse(
    parseStrictJsonObjectV1(reverified.bytes, "Reverified AIH record"),
  );
  const encoded = encodePackagedScannerCollectionEvidenceRecordV1({
    ...current,
    verification: { ...current.verification, preparedAt: sealed.verification.preparedAt },
  });
  if (encoded.bytes !== bytes || encoded.sha256 !== sha256)
    fail("packaged AIH record differs from reverified publication");
  return prepared;
}
