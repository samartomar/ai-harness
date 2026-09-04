import { createHash, createPublicKey } from "node:crypto";
import {
  parseBaselineVetAttestationEnvelopeV1Json,
  parseBaselineVetReceiptV1Json,
  parseBaselineVetRequestV1Json,
} from "@aihq/scan";
import { z } from "zod";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import type { BaselineCatalog } from "./catalog.js";
import {
  consumeVerifiedScannerBaseline,
  consumeVerifiedScannerBaselineBatches,
} from "./scanner-consumer.js";
import type { BaselineSourceEvidence } from "./schema.js";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PUBLICATION_LIMIT = 96 * 1024 * 1024;
const DISCOVERY_LIMIT = 8 * 1024;
const ATTESTATION_LIMIT = 256 * 1024;
const ANNEX_LIMIT = 16 * 1024 * 1024;

export const SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1 = 7 * 24 * 60 * 60;
export const SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 = Object.freeze({
  repository: "samartomar/aih-scan",
  workflow: "samartomar/aih-scan/.github/workflows/baseline-publication.yml",
  ref: "refs/heads/main",
  commit: "ba0f0bfc46f2634da71e125bf3bbcefb3493389c",
} satisfies ScannerBaselinePublicationPublisherV1);

const signerWire = z
  .object({
    identity: z.string().min(1).max(256),
    class: z.enum(["test-ephemeral", "organization"]),
    keyId: z.string().regex(/^ed25519:[0-9a-f]{64}$/),
  })
  .strict();
const publicationWire = z
  .object({
    protocol: z.literal("BaselineVetPublicationV1"),
    request: z.record(z.string(), z.unknown()),
    receipt: z.record(z.string(), z.unknown()),
    annexes: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1_024),
            bytesBase64: z
              .string()
              .min(4)
              .max(Math.ceil(ANNEX_LIMIT / 3) * 4),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    envelope: z.record(z.string(), z.unknown()),
    verification: z
      .object({
        root: signerWire.extend({ publicKeySpkiBase64: z.string().min(4).max(1_024) }).strict(),
        expected: z.object({ now: z.string(), signer: signerWire }).strict(),
      })
      .strict(),
  })
  .strict();
const discoveryWire = z
  .object({
    protocol: z.literal("BaselineVetDiscoveryV1"),
    authority: z.literal("none"),
    requestSha256: z.string().regex(SHA256),
    receiptSha256: z.string().regex(SHA256),
    evidenceDigestSha256: z.string().regex(SHA256),
    publicationSha256: z.string().regex(SHA256),
    locator: z.string().min(1).max(2_048),
  })
  .strict();

export interface ScannerBaselinePublicationPublisherV1 {
  readonly repository: string;
  readonly workflow: string;
  readonly ref: string;
  readonly commit: string;
}

export interface ConsumeScannerBaselinePublicationV1Input {
  readonly sourceRoot: string;
  readonly catalog: BaselineCatalog;
  readonly expectedRequestSha256: string;
  readonly discoveryBytes: Buffer;
  readonly publicationBytes: Buffer;
  readonly attestationResultBytes: Buffer;
  readonly publisher: ScannerBaselinePublicationPublisherV1;
  readonly now: string;
  readonly maxAgeSeconds: number;
  readonly seenEvidenceDigests?: readonly string[];
  readonly seenReceiptBindings?: readonly Readonly<{
    requestSha256: string;
    receiptSha256: string;
  }>[];
}

export interface ConsumedScannerBaselinePublicationV1 {
  readonly evidence: BaselineSourceEvidence;
  readonly provenance: ScannerBaselinePublicationProvenanceV1;
}

export interface ScannerBaselinePublicationBatchV1 {
  readonly expectedRequestSha256: string;
  readonly discoveryBytes: Buffer;
  readonly publicationBytes: Buffer;
  readonly attestationResultBytes: Buffer;
}

export interface ConsumeScannerBaselinePublicationsV1Input {
  readonly sourceRoot: string;
  readonly catalog: BaselineCatalog;
  readonly publications: readonly ScannerBaselinePublicationBatchV1[];
  readonly publisher: ScannerBaselinePublicationPublisherV1;
  readonly now: string;
  readonly maxAgeSeconds: number;
  readonly seenEvidenceDigests?: readonly string[];
  readonly seenReceiptBindings?: readonly Readonly<{
    requestSha256: string;
    receiptSha256: string;
  }>[];
}

export interface ConsumedScannerBaselinePublicationsV1 {
  readonly evidence: BaselineSourceEvidence;
  readonly provenance: readonly ScannerBaselinePublicationProvenanceV1[];
}

export type ScannerBaselinePublicationProvenanceV1 = Readonly<{
  authority: "none";
  repository: string;
  workflow: string;
  ref: string;
  sourceCommit: string;
  publicationSha256: string;
  requestSha256: string;
  receiptSha256: string;
  attestedAt: string;
  ageSeconds: number;
}>;

function fail(reason: string): never {
  throw new AihError(
    `Scanner baseline publication rejected: ${reason}; obtain a fresh publication for the exact Core request`,
    "AIH_SCANNER_BASELINE_PUBLICATION",
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedUtf8(bytes: Buffer, maximum: number, label: string): string {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum)
    fail(`${label} size`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${label} UTF-8`);
  }
}

function parseCanonicalObject<T>(
  bytes: Buffer,
  maximum: number,
  label: string,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.parse(parseStrictJsonObjectV1(boundedUtf8(bytes, maximum, label), label));
  if (!canonicalStrictJsonBytesV1(parsed).equals(bytes)) fail(`${label} canonical wire`);
  return parsed;
}

function decodeBase64(value: string, maximum: number, label: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    fail(`${label} base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maximum || bytes.toString("base64") !== value)
    fail(`${label} base64`);
  return bytes;
}

function timestamp(value: string, label: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) fail(label);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) fail(label);
  return epoch;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(label);
  return value as Record<string, unknown>;
}

function verifiedPublicationAttestation(input: {
  bytes: Buffer;
  publisher: ScannerBaselinePublicationPublisherV1;
  publicationSha256: string;
  now: string;
  maxAgeSeconds: number;
}): { attestedAt: string; ageSeconds: number } {
  const { publisher } = input;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(publisher.repository) ||
    publisher.workflow !== `${publisher.repository}/.github/workflows/baseline-publication.yml` ||
    publisher.ref !== "refs/heads/main" ||
    !COMMIT.test(publisher.commit) ||
    !Number.isSafeInteger(input.maxAgeSeconds) ||
    input.maxAgeSeconds <= 0
  )
    fail("publisher policy");
  let results: unknown;
  try {
    results = JSON.parse(boundedUtf8(input.bytes, ATTESTATION_LIMIT, "attestation"));
  } catch (error) {
    if (error instanceof AihError) throw error;
    return fail("attestation JSON");
  }
  if (!Array.isArray(results) || results.length !== 1) fail("attestation result count");
  const result = record(results[0], "attestation result");
  if (!Object.hasOwn(result, "attestation") || !Object.hasOwn(result, "verificationResult"))
    fail("attestation result");
  const verification = record(result.verificationResult, "attestation verification");
  if (verification.mediaType !== "application/vnd.dev.sigstore.verificationresult+json;version=0.1")
    fail("attestation media type");
  const signature = record(verification.signature, "attestation signature");
  const certificate = record(signature.certificate, "attestation certificate");
  const workflowUri = `https://github.com/${publisher.workflow}@${publisher.ref}`;
  const sourceDigest = certificate.sourceRepositoryDigest;
  if (
    certificate.subjectAlternativeName !== workflowUri ||
    certificate.buildSignerURI !== workflowUri ||
    certificate.buildConfigURI !== workflowUri ||
    certificate.issuer !== "https://token.actions.githubusercontent.com" ||
    certificate.sourceRepositoryURI !== `https://github.com/${publisher.repository}` ||
    certificate.sourceRepositoryRef !== publisher.ref ||
    (sourceDigest !== publisher.commit && sourceDigest !== `sha1:${publisher.commit}`) ||
    certificate.runnerEnvironment !== "github-hosted"
  )
    fail("publisher provenance");
  const statement = record(verification.statement, "attestation statement");
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    !Array.isArray(statement.subject) ||
    statement.subject.length === 0 ||
    statement.subject.length > 1_000
  )
    fail("attestation statement");
  const subjectDigests = new Set<string>();
  let matchingSubjects = 0;
  for (const entry of statement.subject) {
    const subject = record(entry, "attestation subject");
    const digest = record(subject.digest, "attestation subject digest");
    if (
      subject.name !== "publication.json" ||
      Object.keys(digest).length !== 1 ||
      typeof digest.sha256 !== "string" ||
      !SHA256.test(digest.sha256) ||
      subjectDigests.has(digest.sha256)
    )
      fail("attestation subject digest");
    subjectDigests.add(digest.sha256);
    if (digest.sha256 === input.publicationSha256) matchingSubjects += 1;
  }
  if (matchingSubjects !== 1) fail("attestation subject digest");
  if (
    !Array.isArray(verification.verifiedTimestamps) ||
    verification.verifiedTimestamps.length === 0 ||
    verification.verifiedTimestamps.length > 16
  )
    fail("attestation timestamp");
  const moments = verification.verifiedTimestamps.map((entry) => {
    const value = record(entry, "attestation timestamp");
    if (
      typeof value.type !== "string" ||
      typeof value.uri !== "string" ||
      typeof value.timestamp !== "string"
    )
      fail("attestation timestamp");
    return timestamp(value.timestamp, "attestation timestamp");
  });
  const now = timestamp(input.now, "clock");
  const earliest = Math.min(...moments);
  const ageMilliseconds = now - earliest;
  if (
    !Number.isSafeInteger(ageMilliseconds) ||
    ageMilliseconds < 0 ||
    ageMilliseconds > input.maxAgeSeconds * 1000
  )
    fail("publication freshness");
  const ageSeconds = Math.floor(ageMilliseconds / 1000);
  return { attestedAt: new Date(earliest).toISOString(), ageSeconds };
}

function internalPublication(input: ConsumeScannerBaselinePublicationV1Input) {
  if (!SHA256.test(input.expectedRequestSha256)) fail("expected request digest");
  const discovery = parseCanonicalObject(
    input.discoveryBytes,
    DISCOVERY_LIMIT,
    "discovery",
    discoveryWire,
  );
  if (discovery.requestSha256 !== input.expectedRequestSha256) fail("request digest");
  const expectedLocator = `https://github.com/${input.publisher.repository}/releases/download/baseline-v1-${input.publisher.commit}-${input.expectedRequestSha256}/publication.json`;
  if (discovery.locator !== expectedLocator) fail("mutable or unexpected locator");
  const publicationSha256 = sha256(input.publicationBytes);
  if (publicationSha256 !== discovery.publicationSha256) fail("publication digest");
  const publication = parseCanonicalObject(
    input.publicationBytes,
    PUBLICATION_LIMIT,
    "publication",
    publicationWire,
  );
  const request = parseBaselineVetRequestV1Json(
    canonicalStrictJsonBytesV1(publication.request).toString("utf8"),
  );
  const receipt = parseBaselineVetReceiptV1Json(
    canonicalStrictJsonBytesV1(publication.receipt).toString("utf8"),
  );
  const envelope = parseBaselineVetAttestationEnvelopeV1Json(
    canonicalStrictJsonBytesV1(publication.envelope).toString("utf8"),
  );
  if (
    request.requestSha256 !== discovery.requestSha256 ||
    receipt.receiptSha256 !== discovery.receiptSha256 ||
    sha256(canonicalStrictJsonBytesV1(envelope)) !== discovery.evidenceDigestSha256
  )
    fail("discovery binding");
  const annexArtifacts = publication.annexes.map((annex) => ({
    path: annex.path,
    bytes: decodeBase64(annex.bytesBase64, ANNEX_LIMIT, "annex"),
  }));
  const publicKey = createPublicKey({
    key: decodeBase64(publication.verification.root.publicKeySpkiBase64, 4_096, "public key"),
    format: "der",
    type: "spki",
  });
  const attestation = verifiedPublicationAttestation({
    bytes: input.attestationResultBytes,
    publisher: input.publisher,
    publicationSha256,
    now: input.now,
    maxAgeSeconds: input.maxAgeSeconds,
  });
  return {
    discovery,
    publicationSha256,
    request,
    result: { receipt, annexArtifacts },
    envelope,
    roots: [
      {
        identity: publication.verification.root.identity,
        class: publication.verification.root.class,
        keyId: publication.verification.root.keyId,
        publicKey,
      },
    ],
    expected: publication.verification.expected,
    attestation,
  };
}

function provenanceFor(
  publisher: ScannerBaselinePublicationPublisherV1,
  verified: ReturnType<typeof internalPublication>,
): ScannerBaselinePublicationProvenanceV1 {
  return Object.freeze({
    authority: "none" as const,
    repository: publisher.repository,
    workflow: publisher.workflow,
    ref: publisher.ref,
    sourceCommit: publisher.commit,
    publicationSha256: verified.publicationSha256,
    requestSha256: verified.discovery.requestSha256,
    receiptSha256: verified.discovery.receiptSha256,
    attestedAt: verified.attestation.attestedAt,
    ageSeconds: verified.attestation.ageSeconds,
  });
}

/**
 * Consume a complete ordered set of independently published Scanner batches.
 * Each transport and GitHub provenance result is verified independently before
 * the already-verified annexes are joined by the multi-batch Core consumer.
 */
export async function consumeScannerBaselinePublicationsV1(
  input: ConsumeScannerBaselinePublicationsV1Input,
): Promise<ConsumedScannerBaselinePublicationsV1> {
  try {
    if (input.publications.length === 0 || input.publications.length > 1_000)
      fail("publication batch count");
    const verified = input.publications.map((publication) =>
      internalPublication({
        sourceRoot: input.sourceRoot,
        catalog: input.catalog,
        ...publication,
        publisher: input.publisher,
        now: input.now,
        maxAgeSeconds: input.maxAgeSeconds,
        seenEvidenceDigests: input.seenEvidenceDigests,
        seenReceiptBindings: input.seenReceiptBindings,
      }),
    );
    const first = verified[0];
    if (first === undefined) fail("publication batch count");
    const expectedSigningPolicy = canonicalStrictJsonBytesV1(first.expected);
    const requests = new Set<string>();
    const receipts = new Set<string>();
    const evidence = new Set<string>();
    const publications = new Set<string>();
    for (const batch of verified) {
      if (!canonicalStrictJsonBytesV1(batch.expected).equals(expectedSigningPolicy))
        fail("mixed batch signing policy");
      const bindings = [
        [requests, batch.discovery.requestSha256],
        [receipts, batch.discovery.receiptSha256],
        [evidence, batch.discovery.evidenceDigestSha256],
        [publications, batch.publicationSha256],
      ] as const;
      for (const [seen, digest] of bindings) {
        if (seen.has(digest)) fail("duplicate publication batch");
        seen.add(digest);
      }
    }
    const sourceEvidence = await consumeVerifiedScannerBaselineBatches({
      sourceRoot: input.sourceRoot,
      catalog: input.catalog,
      batches: verified.map((batch) => ({
        request: batch.request,
        result: batch.result,
        envelope: batch.envelope,
      })),
      roots: first.roots,
      expected: first.expected,
      seenEvidenceDigests: input.seenEvidenceDigests,
      seenReceiptBindings: input.seenReceiptBindings,
    });
    return Object.freeze({
      evidence: sourceEvidence,
      provenance: Object.freeze(verified.map((batch) => provenanceFor(input.publisher, batch))),
    });
  } catch (error) {
    if (error instanceof AihError && error.code === "AIH_SCANNER_BASELINE_PUBLICATION") throw error;
    fail("content or Scanner verification");
  }
}

/**
 * Consume one independently published Scanner result after every transport,
 * provenance, custody, replay, source, and analyzer identity join succeeds.
 * This function performs no network request and executes no analyzer.
 */
export async function consumeScannerBaselinePublicationV1(
  input: ConsumeScannerBaselinePublicationV1Input,
): Promise<ConsumedScannerBaselinePublicationV1> {
  try {
    const verified = internalPublication(input);
    const evidence = await consumeVerifiedScannerBaseline({
      sourceRoot: input.sourceRoot,
      catalog: input.catalog,
      request: verified.request,
      result: verified.result,
      envelope: verified.envelope,
      roots: verified.roots,
      expected: verified.expected,
      seenEvidenceDigests: input.seenEvidenceDigests,
      seenReceiptBindings: input.seenReceiptBindings,
    });
    return Object.freeze({ evidence, provenance: provenanceFor(input.publisher, verified) });
  } catch (error) {
    if (error instanceof AihError && error.code === "AIH_SCANNER_BASELINE_PUBLICATION") throw error;
    fail("content or Scanner verification");
  }
}
