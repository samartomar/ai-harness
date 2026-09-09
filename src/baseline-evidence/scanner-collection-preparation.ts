import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { assertAcquiredGithubSourceRootV1 } from "../internals/bounded-github-source-archive.js";
import { hermeticGitEnv } from "../internals/git-env.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import {
  encodePackagedScannerCollectionEvidenceRecordV1,
  PackagedScannerCollectionEvidenceRecordV1Schema,
  packagedCoverageProjectionDigestV1,
  packagedReportComponentDigestV1,
} from "../org-policy/packaged-collection-evidence-v1.js";
import { createCoreBaselineVetRequests } from "./scanner-consumer.js";
import { prepareRegisteredScannerCatalogV1 } from "./scanner-provider-catalogs.js";
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
// Matt and Ponytail currently fit one Scanner batch; this remains a hard input bound.
export const SCANNER_COLLECTION_TOTAL_INPUT_MAX_BYTES_V1 = 128 * 1024 * 1024;
const GH_ATTESTATION_MAX_BYTES = 256 * 1024;
const GH_ATTESTATION_TIMEOUT_MS = 30_000;
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

export type ScannerCollectionCatalogIdV1 = "mattpocock" | "ponytail" | "ecc" | "superpowers";
export type ScannerCollectionCoverageV1 = NonNullable<
  ReturnType<typeof prepareRegisteredScannerCatalogV1>["coverage"]
>;

export interface ScannerCollectionPublicationBatchV1 {
  readonly discoveryBytes: Buffer;
  readonly publicationBytes: Buffer;
}

export interface PrepareScannerCollectionPublicationsV1Input {
  readonly sourceRoot: string;
  readonly catalogId: ScannerCollectionCatalogIdV1;
  readonly batches: readonly ScannerCollectionPublicationBatchV1[];
  readonly now: string;
  /** Test seam only. An injected runner can never produce an operational witness. */
  readonly run?: Runner;
  /** Test seam for the owner-only attestation staging directory. */
  readonly tempRoot?: string;
}

/** Opaque in-process result. JSON clones never carry the retained custody witness. */
export interface PreparedScannerCollectionPublicationsV1 {
  readonly kind: "prepared-scanner-collection-publications/v1";
}

export interface AuthoredScannerCollectionPublicationV1 {
  readonly version: "scanner-collection-publication-output/v1";
  readonly authority: "none";
  readonly catalog: Readonly<{
    readonly id: ScannerCollectionCatalogIdV1;
    readonly owner: string;
    readonly repository: string;
    readonly pinnedCommit: string;
    readonly sourceTreeSha256: string;
    readonly coverageDigest: string;
  }>;
  /** Core-recomputed declared-file mapping; never an uploaded coverage map. */
  readonly coverage: ScannerCollectionCoverageV1;
  /** Immutable historical Scanner report facts, including blocked outcomes. */
  readonly report: BaselineSourceEvidence;
  /** Exact publisher and batch request/publication/receipt provenance. */
  readonly publications: readonly ScannerBaselinePublicationProvenanceV1[];
  /** Every component joins the authenticated Scanner envelope of its batch. */
  readonly observations: readonly Readonly<{
    componentId: string;
    componentTreeSha256: string;
    reportSignedAt: string;
    reportVerificationExpiresAt: string;
    requestSha256: string;
    publicationSha256: string;
    receiptSha256: string;
  }>[];
  readonly verification: Readonly<{
    readonly method: "gh-attestation-verify";
    /** Immutable original Core intake time, not a later reverification time. */
    readonly preparedAt: string;
  }>;
}

interface PreparedFacts {
  readonly output: AuthoredScannerCollectionPublicationV1;
  readonly discoveryBytes: readonly Buffer[];
  readonly publicationBytes: readonly Buffer[];
  readonly attestationResultBytes: readonly Buffer[];
}

const preparedFacts = new WeakMap<PreparedScannerCollectionPublicationsV1, PreparedFacts>();

function fail(message: string): never {
  throw new TypeError(`Scanner collection preparation: ${message}`);
}

function assertDataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail(label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(label);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) fail(label);
  }
}

function ownValue(value: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) fail(label);
  return descriptor.value;
}

function assertBytes(bytes: unknown, label: string, maximum: number): asserts bytes is Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum)
    fail(`${label} bytes`);
}

function cloneBytes(bytes: unknown, label: string, maximum: number): Buffer {
  assertBytes(bytes, label, maximum);
  return Buffer.from(bytes);
}

function assertInput(
  input: PrepareScannerCollectionPublicationsV1Input,
): asserts input is PrepareScannerCollectionPublicationsV1Input {
  assertDataRecord(
    input,
    ["sourceRoot", "catalogId", "batches", "now", "run", "tempRoot"],
    ["sourceRoot", "catalogId", "batches", "now"],
    "input",
  );
  const sourceRoot = ownValue(input, "sourceRoot", "input");
  const catalogId = ownValue(input, "catalogId", "input");
  const batches = ownValue(input, "batches", "input");
  const now = ownValue(input, "now", "input");
  const run = Object.hasOwn(input, "run") ? ownValue(input, "run", "input") : undefined;
  const tempRoot = Object.hasOwn(input, "tempRoot")
    ? ownValue(input, "tempRoot", "input")
    : undefined;
  if (
    typeof sourceRoot !== "string" ||
    sourceRoot.length === 0 ||
    (catalogId !== "mattpocock" &&
      catalogId !== "ponytail" &&
      catalogId !== "ecc" &&
      catalogId !== "superpowers") ||
    !Array.isArray(batches) ||
    batches.length === 0 ||
    batches.length > 1_000 ||
    typeof now !== "string" ||
    (run !== undefined && typeof run !== "function") ||
    (tempRoot !== undefined && (typeof tempRoot !== "string" || tempRoot.length === 0))
  )
    fail("input");
  let totalBytes = 0;
  for (const batch of batches) {
    assertDataRecord(
      batch,
      ["discoveryBytes", "publicationBytes"],
      ["discoveryBytes", "publicationBytes"],
      "batch",
    );
    const discoveryBytes = ownValue(batch, "discoveryBytes", "batch");
    const publicationBytes = ownValue(batch, "publicationBytes", "batch");
    assertBytes(discoveryBytes, "discovery", DISCOVERY_MAX_BYTES);
    assertBytes(publicationBytes, "publication", PUBLICATION_MAX_BYTES);
    totalBytes += discoveryBytes.length + publicationBytes.length;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > SCANNER_COLLECTION_TOTAL_INPUT_MAX_BYTES_V1
    )
      fail("total batch bytes");
  }
}

function containedStagingRoot(tempRoot: string): string {
  const root = resolve(tempRoot);
  try {
    const info = lstatSync(root);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("attestation custody");
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Scanner collection preparation:"))
      throw error;
    fail("attestation custody");
  }
  return root;
}

function isContainedStagingPath(root: string, staging: string): boolean {
  const relation = relative(root, staging);
  return (
    relation.length > 0 &&
    !relation.startsWith("..") &&
    !isAbsolute(relation) &&
    !relation.split(/[\\/]/).includes("..")
  );
}
async function assertPinnedCheckout(
  run: Runner,
  sourceRoot: string,
  repository: string,
  pinnedCommit: string,
): Promise<void> {
  if (assertAcquiredGithubSourceRootV1(sourceRoot, repository, pinnedCommit)) return;
  const result = await run(["git", "-C", sourceRoot, "rev-parse", "HEAD"], {
    env: hermeticGitEnv(),
    maxBufferBytes: 256,
    timeoutMs: 10_000,
  });
  if (
    result.code !== 0 ||
    result.spawnError === true ||
    result.truncated === true ||
    result.stdout.trim() !== pinnedCommit
  )
    fail("pinned checkout");
}

async function attestPublicationBytes(
  run: Runner,
  tempRoot: string,
  publicationBytes: Buffer,
  publisher: ScannerBaselinePublicationPublisherV1,
): Promise<Buffer> {
  let staging: string | undefined;
  let root: string | undefined;
  try {
    root = containedStagingRoot(tempRoot);
    staging = mkdtempSync(join(root, "aih-scanner-publication-"));
    if (!isContainedStagingPath(root, staging)) fail("attestation custody");
    const stagingInfo = lstatSync(staging);
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) fail("attestation custody");
    const publicationPath = join(staging, "publication.json");
    writeFileSync(publicationPath, publicationBytes, { flag: "wx", mode: 0o600 });
    chmodSync(publicationPath, 0o600);
    const result = await run(
      [
        "gh",
        "attestation",
        "verify",
        publicationPath,
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
      {
        cwd: staging,
        maxBufferBytes: GH_ATTESTATION_MAX_BYTES,
        timeoutMs: GH_ATTESTATION_TIMEOUT_MS,
      },
    );
    if (
      result.code !== 0 ||
      result.spawnError === true ||
      result.truncated === true ||
      typeof result.stdout !== "string"
    )
      fail("attestation rejected");
    const bytes = Buffer.from(result.stdout, "utf8");
    assertBytes(bytes, "attestation result", GH_ATTESTATION_MAX_BYTES);
    return bytes;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Scanner collection preparation:"))
      throw error;
    fail("attestation rejected");
  } finally {
    if (staging !== undefined && root !== undefined && isContainedStagingPath(root, staging)) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        fail("attestation custody");
      }
    }
  }
  fail("attestation rejected");
}
function freezeOutput(
  value: AuthoredScannerCollectionPublicationV1,
): AuthoredScannerCollectionPublicationV1 {
  return deepFreezeStrictJsonV1(value) as AuthoredScannerCollectionPublicationV1;
}

/**
 * Recomputes registered declared-source coverage from a pinned checkout, obtains
 * fresh GitHub attestation verification for each exact publication byte sequence,
 * then consumes the already-verified Scanner reports. Uploaded coverage maps and
 * caller-supplied attestation output are deliberately not part of this boundary.
 */
export async function prepareScannerCollectionPublicationsV1(
  input: PrepareScannerCollectionPublicationsV1Input,
): Promise<PreparedScannerCollectionPublicationsV1> {
  assertInput(input);
  const prepared = prepareRegisteredScannerCatalogV1(input.sourceRoot, input.catalogId);
  if (prepared.coverage === undefined || prepared.coverageDigest === undefined)
    fail("collection coverage");
  const operational = !Object.hasOwn(input, "run") && !Object.hasOwn(input, "tempRoot");
  const run = input.run ?? defaultRunner;
  await assertPinnedCheckout(
    run,
    input.sourceRoot,
    `${prepared.catalog.owner}/${prepared.catalog.repo}`,
    prepared.catalog.pinnedSha,
  );
  const requests = createCoreBaselineVetRequests(input.sourceRoot, prepared.catalog);
  if (requests.length !== input.batches.length) fail("publication batch count");
  const discovery = parseStrictJsonObjectV1(
    cloneBytes(
      input.batches[0]?.discoveryBytes ?? fail("missing discovery"),
      "discovery",
      DISCOVERY_MAX_BYTES,
    ).toString("utf8"),
    "publication discovery",
  );
  const publisher =
    scannerBaselinePublicationPublisherForLocatorV1(discovery.locator) ??
    fail("unreviewed publisher");

  const batches = [] as {
    expectedRequestSha256: string;
    discoveryBytes: Buffer;
    publicationBytes: Buffer;
    attestationResultBytes: Buffer;
  }[];
  for (const [index, batch] of input.batches.entries()) {
    const discoveryBytes = cloneBytes(batch.discoveryBytes, "discovery", DISCOVERY_MAX_BYTES);
    const publicationBytes = cloneBytes(
      batch.publicationBytes,
      "publication",
      PUBLICATION_MAX_BYTES,
    );
    batches.push({
      expectedRequestSha256: requests[index]?.requestSha256 ?? fail("request batch"),
      discoveryBytes,
      publicationBytes,
      attestationResultBytes: await attestPublicationBytes(
        run,
        input.tempRoot ?? tmpdir(),
        publicationBytes,
        publisher,
      ),
    });
  }
  const consumed = await consumeScannerBaselinePublicationsV1({
    sourceRoot: input.sourceRoot,
    catalog: prepared.catalog,
    publications: batches,
    publisher,
    now: input.now,
    maxAgeSeconds: SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
  });
  const componentProvenance = new Map<
    string,
    { provenance: ScannerBaselinePublicationProvenanceV1; componentTreeSha256: string }
  >();
  for (const [index, request] of requests.entries()) {
    const provenance = consumed.provenance[index];
    if (provenance === undefined) fail("publication provenance");
    for (const component of request.components) {
      if (componentProvenance.has(component.id)) fail("duplicate component provenance");
      componentProvenance.set(component.id, {
        provenance,
        componentTreeSha256: component.treeSha256,
      });
    }
  }
  const observations = consumed.evidence.components
    .map((component) => {
      const matched = componentProvenance.get(component.id);
      if (matched === undefined) fail("missing component provenance");
      const { provenance, componentTreeSha256 } = matched;
      return {
        componentId: component.id,
        reportSignedAt: provenance.reportSignedAt,
        reportVerificationExpiresAt: provenance.reportVerificationExpiresAt,
        componentTreeSha256,
        requestSha256: provenance.requestSha256,
        publicationSha256: provenance.publicationSha256,
        receiptSha256: provenance.receiptSha256,
      };
    })
    .sort((left, right) =>
      left.componentId < right.componentId ? -1 : left.componentId > right.componentId ? 1 : 0,
    );
  const output = freezeOutput({
    version: "scanner-collection-publication-output/v1",
    authority: "none",
    catalog: {
      id: input.catalogId,
      owner: prepared.catalog.owner,
      repository: prepared.catalog.repo,
      pinnedCommit: prepared.catalog.pinnedSha,
      sourceTreeSha256: prepared.coverage.sourceTreeSha256,
      coverageDigest: prepared.coverageDigest,
    },
    coverage: prepared.coverage,
    report: consumed.evidence,
    publications: consumed.provenance,
    observations,
    verification: {
      method: "gh-attestation-verify",
      preparedAt: input.now,
    },
  });
  const result: PreparedScannerCollectionPublicationsV1 = Object.freeze({
    kind: "prepared-scanner-collection-publications/v1",
  });
  // An injected test seam validates the whole parser chain but cannot author
  // release or display custody. Raw material is retained only in this private
  // same-process witness and never exported.
  if (operational && run === defaultRunner) {
    preparedFacts.set(result, {
      output,
      discoveryBytes: Object.freeze(batches.map((batch) => batch.discoveryBytes)),
      publicationBytes: Object.freeze(batches.map((batch) => batch.publicationBytes)),
      attestationResultBytes: Object.freeze(batches.map((batch) => batch.attestationResultBytes)),
    });
  }
  return result;
}

/** A detached report projection, available only to an operationally witnessed preparation. */
export function projectPreparedScannerCollectionEvidenceForDisplayV1(
  prepared: PreparedScannerCollectionPublicationsV1,
): BaselineSourceEvidence | undefined {
  const facts = preparedFacts.get(prepared);
  return facts === undefined ? undefined : structuredClone(facts.output.report);
}

/**
 * A detached, minimal release-authoring output. It retains report outcome,
 * recomputed coverage, publisher attestation facts and verification time, but
 * never raw publication, scan annex, discovery, or attestation bytes.
 */
export function authorPreparedScannerCollectionPublicationV1(
  prepared: PreparedScannerCollectionPublicationsV1,
): AuthoredScannerCollectionPublicationV1 | undefined {
  const facts = preparedFacts.get(prepared);
  return facts === undefined ? undefined : structuredClone(facts.output);
}

/**
 * Encodes one detached display-only source record from an operational witness.
 * This is release preparation only: caller-supplied JSON and injected seams do
 * not have a WeakMap witness and therefore cannot mint a package record.
 */
export function authorPackagedScannerCollectionEvidenceRecordV1(
  prepared: PreparedScannerCollectionPublicationsV1,
): { bytes: string; sha256: string } | undefined {
  const output = authorPreparedScannerCollectionPublicationV1(prepared);
  if (output === undefined) return undefined;
  const coverage = {
    version: output.coverage.version,
    authority: output.coverage.authority,
    scope: output.coverage.scope,
    components: output.coverage.components.map((component) => ({
      componentId: component.componentId,
      componentTreeSha256: component.componentTreeSha256,
      paths: component.paths,
      files: component.files,
      subject: component.subject,
    })),
    unmappedDerivedAssets: output.coverage.unmappedDerivedAssets,
  };
  return encodePackagedScannerCollectionEvidenceRecordV1({
    version: "packaged-scanner-collection-evidence/v1",
    authority: "display-only",
    catalog: {
      ...output.catalog,
      coverageProjectionDigest: packagedCoverageProjectionDigestV1(coverage),
      source: {
        id: output.coverage.source.id,
        revisionId: output.coverage.source.revisionId,
        contentDigest: output.coverage.source.contentDigest,
        inputFormat:
          "inputFormat" in output.coverage.source
            ? output.coverage.source.inputFormat
            : "pinned-baseline/v1",
        upstreamOrigin: { kind: "git", locator: output.coverage.source.repository },
      },
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
 * Live release boundary: reconsumes retained raw publications with the actual
 * Scanner verifier and requires canonical equality with an already sealed
 * package record. The package record alone is display data and cannot mint
 * this result; modified bytes, source, report facts, or attestation all fail.
 */
export async function reverifyPackagedScannerCollectionEvidenceRecordV1(
  input: Readonly<{
    sourceRoot: string;
    catalogId: ScannerCollectionCatalogIdV1;
    batches: readonly ScannerCollectionPublicationBatchV1[];
    now: string;
    sealed: Readonly<{ bytes: string; sha256: string }>;
  }>,
): Promise<PreparedScannerCollectionPublicationsV1> {
  if (
    typeof input.sealed.bytes !== "string" ||
    typeof input.sealed.sha256 !== "string" ||
    !Number.isFinite(Date.parse(input.now))
  )
    fail("sealed collection record");
  const sealedBytes = Buffer.from(input.sealed.bytes, "utf8");
  const sealedDigest = `sha256:${createHash("sha256").update(sealedBytes).digest("hex")}`;
  if (
    sealedBytes.length === 0 ||
    sealedBytes.length > 4 * 1024 * 1024 ||
    sealedDigest !== input.sealed.sha256
  )
    fail("sealed collection record");
  const sealed = PackagedScannerCollectionEvidenceRecordV1Schema.parse(
    parseStrictJsonObjectV1(input.sealed.bytes, "Sealed collection record"),
  );
  if (
    !canonicalStrictJsonBytesV1(sealed).equals(sealedBytes) ||
    sealed.catalog.id !== input.catalogId ||
    Date.parse(sealed.verification.preparedAt) > Date.parse(input.now)
  )
    fail("sealed collection record");
  const prepared = await prepareScannerCollectionPublicationsV1({
    sourceRoot: input.sourceRoot,
    catalogId: input.catalogId,
    batches: input.batches,
    now: input.now,
  });
  const reverified = authorPackagedScannerCollectionEvidenceRecordV1(prepared);
  if (reverified === undefined) fail("reverified collection custody");
  const current = PackagedScannerCollectionEvidenceRecordV1Schema.parse(
    parseStrictJsonObjectV1(reverified.bytes, "Reverified collection record"),
  );
  const encoded = encodePackagedScannerCollectionEvidenceRecordV1({
    ...current,
    verification: { ...current.verification, preparedAt: sealed.verification.preparedAt },
  });
  if (encoded.sha256 !== input.sealed.sha256 || encoded.bytes !== input.sealed.bytes)
    fail("packaged collection record differs from reverified publication");
  return prepared;
}
