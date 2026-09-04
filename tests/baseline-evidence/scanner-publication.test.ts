import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaselineVetBatchResultV1,
  canonicalBaselineVetAttestationEnvelopeV1Bytes,
  ed25519KeyIdV2,
  signBaselineVetBundleV1,
} from "@aihq/scan";
import { afterEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { createCoreBaselineVetRequest } from "../../src/baseline-evidence/scanner-consumer.js";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "../../src/baseline-evidence/scanner-profile.js";
import {
  consumeScannerBaselinePublicationsV1,
  consumeScannerBaselinePublicationV1,
} from "../../src/baseline-evidence/scanner-publication.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";

const temporaryRoots: string[] = [];
const publisher = {
  repository: "samartomar/aih-scan",
  workflow: "samartomar/aih-scan/.github/workflows/baseline-publication.yml",
  ref: "refs/heads/main",
  commit: "4".repeat(40),
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const sourceRoot = mkdtempSync(join(tmpdir(), "aih-core-publication-"));
  temporaryRoots.push(sourceRoot);
  mkdirSync(join(sourceRoot, "rules"));
  writeFileSync(join(sourceRoot, "rules", "base.md"), "# Rule\n", "utf8");
  const catalog = defineBaselineCatalog({
    id: "fixture",
    owner: "example",
    repo: "fixture",
    pinnedSha: "a".repeat(40),
    components: [{ id: "rules", paths: ["rules"] }],
  });
  const request = createCoreBaselineVetRequest(sourceRoot, catalog);
  const annexArtifacts = request.components[0]?.analyzers.map((analyzer) => {
    const bytes = canonicalStrictJsonBytesV1(
      analyzer === "aih-native"
        ? { protocol: "BaselineNativeObservationV1", files: [] }
        : {
            version: "2.1.0",
            runs: [{ tool: { driver: { name: analyzer } }, results: [] }],
          },
    );
    return { path: `annex/${analyzer}.json`, bytes };
  });
  if (annexArtifacts === undefined) throw new Error("fixture component missing");
  const version = {
    "aih-native": SCANNER_BASELINE_ANALYZER_VERSIONS["aih-native"],
    skillspector: SCANNER_BASELINE_ANALYZER_VERSIONS["skillspector@docker"],
    semgrep: SCANNER_BASELINE_ANALYZER_VERSIONS["semgrep@uv:1.173.0"],
  } as const;
  const observations = annexArtifacts.map((artifact) => {
    const analyzer = artifact.path.slice(6, -5) as keyof typeof version;
    return {
      analyzer,
      analyzerVersion: version[analyzer],
      annex: {
        path: artifact.path,
        mediaType:
          analyzer === "aih-native"
            ? ("application/vnd.aih.baseline-native+json" as const)
            : ("application/sarif+json" as const),
        sha256: sha256(artifact.bytes),
        byteLength: artifact.bytes.byteLength,
      },
    };
  });
  const authoring = {
    protocol: "BaselineVetReceiptV1" as const,
    profile: request.profile,
    requestSha256: request.requestSha256,
    source: request.source,
    observations,
    components: request.components.map((component) => ({
      id: component.id,
      content: component.content,
      paths: component.paths,
      treeSha256: component.treeSha256,
      observations: component.analyzers.map((analyzer) => ({
        analyzer,
        annexSha256: observations.find((entry) => entry.analyzer === analyzer)?.annex.sha256 ?? "",
      })),
    })),
  };
  const result = {
    receipt: {
      ...authoring,
      receiptSha256: sha256(
        canonicalStrictJsonBytesV1({ domain: "aih.baseline-vet-receipt-v1", receipt: authoring }),
      ),
    },
    annexArtifacts,
  } as BaselineVetBatchResultV1;
  const keys = generateKeyPairSync("ed25519");
  const keyId = ed25519KeyIdV2(keys.publicKey);
  const signer = { identity: "scanner-publication", class: "test-ephemeral" as const, keyId };
  const expected = { now: "2026-09-03T13:00:00.000Z", signer };
  const signed = signBaselineVetBundleV1({
    request,
    result,
    signer: { ...signer, privateKey: keys.privateKey },
    claims: {
      signedAt: "2026-09-03T12:45:00.000Z",
      expiresAt: "2026-09-03T13:30:00.000Z",
    },
  });
  const envelope = JSON.parse(
    canonicalBaselineVetAttestationEnvelopeV1Bytes(signed).toString("utf8"),
  );
  const publication = {
    protocol: "BaselineVetPublicationV1",
    request,
    receipt: result.receipt,
    annexes: result.annexArtifacts.map((annex) => ({
      path: annex.path,
      bytesBase64: annex.bytes.toString("base64"),
    })),
    envelope,
    verification: {
      root: {
        ...signer,
        publicKeySpkiBase64: Buffer.from(
          keys.publicKey.export({ type: "spki", format: "der" }),
        ).toString("base64"),
      },
      expected,
    },
  };
  const publicationBytes = canonicalStrictJsonBytesV1(publication);
  const discovery = {
    protocol: "BaselineVetDiscoveryV1",
    authority: "none",
    requestSha256: request.requestSha256,
    receiptSha256: result.receipt.receiptSha256,
    evidenceDigestSha256: sha256(canonicalStrictJsonBytesV1(envelope)),
    publicationSha256: sha256(publicationBytes),
    locator: `https://github.com/${publisher.repository}/releases/download/baseline-v1-${publisher.commit}-${request.requestSha256}/publication.json`,
  };
  const workflowUri = `https://github.com/${publisher.workflow}@${publisher.ref}`;
  const attestation = [
    {
      attestation: {},
      verificationResult: {
        mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
        signature: {
          certificate: {
            subjectAlternativeName: workflowUri,
            buildSignerURI: workflowUri,
            buildConfigURI: workflowUri,
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryURI: `https://github.com/${publisher.repository}`,
            sourceRepositoryRef: publisher.ref,
            sourceRepositoryDigest: publisher.commit,
            runnerEnvironment: "github-hosted",
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ name: "publication.json", digest: { sha256: sha256(publicationBytes) } }],
        },
        verifiedTimestamps: [
          {
            type: "transparency-log",
            uri: "https://rekor.sigstore.dev",
            timestamp: "2026-09-03T13:05:00Z",
          },
        ],
      },
    },
  ];
  return {
    sourceRoot,
    catalog,
    request,
    signed,
    discovery,
    publication,
    publicationBytes,
    attestation,
  };
}

function consume(input = fixture(), now = "2026-09-03T13:10:00.000Z") {
  return consumeScannerBaselinePublicationV1({
    sourceRoot: input.sourceRoot,
    catalog: input.catalog,
    expectedRequestSha256: input.request.requestSha256,
    discoveryBytes: canonicalStrictJsonBytesV1(input.discovery),
    publicationBytes: input.publicationBytes,
    attestationResultBytes: canonicalStrictJsonBytesV1(input.attestation),
    publisher,
    now,
    maxAgeSeconds: 3600,
    seenEvidenceDigests: [],
    seenReceiptBindings: [],
  });
}

describe("independently published Scanner baseline consumption", () => {
  it("verifies discovery, immutable bytes, workflow provenance, freshness, and Scanner custody", async () => {
    await expect(consume()).resolves.toMatchObject({
      evidence: { id: "fixture", pinnedSha: "a".repeat(40) },
      provenance: {
        authority: "none",
        repository: publisher.repository,
        workflow: publisher.workflow,
        sourceCommit: publisher.commit,
        ageSeconds: 300,
      },
    });
  });

  it("accepts a fresh CLI verification when the consumer clock has subsecond precision", async () => {
    await expect(consume(fixture(), "2026-09-03T13:10:00.751Z")).resolves.toMatchObject({
      provenance: { ageSeconds: 300 },
    });
  });

  it("verifies the complete publication-set boundary before returning batch provenance", async () => {
    const value = fixture();
    await expect(
      consumeScannerBaselinePublicationsV1({
        sourceRoot: value.sourceRoot,
        catalog: value.catalog,
        publications: [
          {
            expectedRequestSha256: value.request.requestSha256,
            discoveryBytes: canonicalStrictJsonBytesV1(value.discovery),
            publicationBytes: value.publicationBytes,
            attestationResultBytes: canonicalStrictJsonBytesV1(value.attestation),
          },
        ],
        publisher,
        now: "2026-09-03T13:10:00.751Z",
        maxAgeSeconds: 3600,
      }),
    ).resolves.toMatchObject({
      evidence: { id: "fixture" },
      provenance: [{ requestSha256: value.request.requestSha256, ageSeconds: 300 }],
    });
  });

  it("accepts a bounded multi-subject workflow attestation that uniquely covers this publication", async () => {
    const value = fixture();
    const result = value.attestation[0];
    if (result === undefined) throw new Error("fixture attestation missing");
    result.verificationResult.statement.subject.unshift({
      name: "publication.json",
      digest: { sha256: "b".repeat(64) },
    });
    await expect(consume(value)).resolves.toMatchObject({ evidence: { id: "fixture" } });
  });

  it.each([
    [
      "substituted publication",
      (value: ReturnType<typeof fixture>) => {
        value.publicationBytes = Buffer.concat([value.publicationBytes, Buffer.from("\n")]);
      },
    ],
    [
      "mutable locator",
      (value: ReturnType<typeof fixture>) => {
        value.discovery.locator += "?latest=1";
      },
    ],
    [
      "wrong request",
      (value: ReturnType<typeof fixture>) => {
        value.discovery.requestSha256 = "f".repeat(64);
      },
    ],
    [
      "unknown publication schema",
      (value: ReturnType<typeof fixture>) => {
        value.publication.protocol = "BaselineVetPublicationV2";
        value.publicationBytes = canonicalStrictJsonBytesV1(value.publication);
      },
    ],
    [
      "wrong publisher",
      (value: ReturnType<typeof fixture>) => {
        const attestation = value.attestation[0];
        if (attestation === undefined) throw new Error("fixture attestation missing");
        attestation.verificationResult.signature.certificate.sourceRepositoryDigest = "e".repeat(
          40,
        );
      },
    ],
    [
      "unexpected attestation subject name",
      (value: ReturnType<typeof fixture>) => {
        const subject = value.attestation[0]?.verificationResult.statement.subject[0];
        if (subject === undefined) throw new Error("fixture subject missing");
        subject.name = "other.json";
      },
    ],
    [
      "duplicate attestation subject digest",
      (value: ReturnType<typeof fixture>) => {
        const subject = value.attestation[0]?.verificationResult.statement.subject[0];
        if (subject === undefined) throw new Error("fixture subject missing");
        value.attestation[0]?.verificationResult.statement.subject.push(structuredClone(subject));
      },
    ],
    [
      "stale publication",
      (value: ReturnType<typeof fixture>) => {
        const attestation = value.attestation[0];
        const verifiedAt = attestation?.verificationResult.verifiedTimestamps[0];
        if (verifiedAt === undefined) throw new Error("fixture timestamp missing");
        verifiedAt.timestamp = "2026-09-03T11:00:00Z";
      },
    ],
    [
      "missing annex",
      (value: ReturnType<typeof fixture>) => {
        value.publication.annexes.pop();
        value.publicationBytes = canonicalStrictJsonBytesV1(value.publication);
        value.discovery.publicationSha256 = sha256(value.publicationBytes);
        const attestation = value.attestation[0];
        const subject = attestation?.verificationResult.statement.subject[0];
        if (subject === undefined) throw new Error("fixture subject missing");
        subject.digest.sha256 = sha256(value.publicationBytes);
      },
    ],
  ])("fails closed with typed remediation for %s", async (_label, mutate) => {
    const value = fixture();
    mutate(value);
    await expect(consume(value)).rejects.toMatchObject({
      code: "AIH_SCANNER_BASELINE_PUBLICATION",
    });
  });

  it("rejects evidence replay and conflicting receipt continuity", async () => {
    const value = fixture();
    await expect(
      consumeScannerBaselinePublicationV1({
        sourceRoot: value.sourceRoot,
        catalog: value.catalog,
        expectedRequestSha256: value.request.requestSha256,
        discoveryBytes: canonicalStrictJsonBytesV1(value.discovery),
        publicationBytes: value.publicationBytes,
        attestationResultBytes: canonicalStrictJsonBytesV1(value.attestation),
        publisher,
        now: "2026-09-03T13:10:00.000Z",
        maxAgeSeconds: 3600,
        seenEvidenceDigests: [value.signed.evidenceDigestSha256],
        seenReceiptBindings: [
          {
            requestSha256: value.request.requestSha256,
            receiptSha256: "f".repeat(64),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "AIH_SCANNER_BASELINE_PUBLICATION" });
  });
});
