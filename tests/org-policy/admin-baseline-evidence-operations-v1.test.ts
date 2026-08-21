import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { vendorBaselineLockBytes } from "../../src/baseline-evidence/vendor.js";
import { buildVendorBaselineEvidenceArtifactV1 } from "../../src/baseline-evidence/vendor-artifact-v1.js";
import type { AdminBaselineEvidenceBootstrapV1 } from "../../src/org-policy/admin-baseline-evidence-bootstrap-v1.js";
import {
  parseGithubBaselineEvidenceAttestationV1,
  resolveAdminBaselineEvidenceV1,
} from "../../src/org-policy/admin-baseline-evidence-operations-v1.js";

const sources = [
  {
    id: "ecc",
    owner: "affaan-m",
    repo: "ecc",
    pinnedSha: "623f2c020f052319657674e4e6c29ab5d0ad566b",
  },
  {
    id: "superpowers",
    owner: "obra",
    repo: "Superpowers",
    pinnedSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
  },
];
const bootstrap: AdminBaselineEvidenceBootstrapV1 = {
  protocol: "AdminBaselineEvidenceBootstrapV1",
  artifactUrl: "https://evidence.example.test/artifact",
  attestationUrl: "https://evidence.example.test/attestation",
  cacheMaxAgeSeconds: 3600,
  expectedEnvironment: "baseline-evidence-publish",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedRepository: "samartomar/ai-harness",
  expectedWorkflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
  minSchemaVersion: 1,
  maxSchemaVersion: 1,
  sources,
};
const artifact = buildVendorBaselineEvidenceArtifactV1({
  lockBytes: vendorBaselineLockBytes(),
  publisher: {
    environment: bootstrap.expectedEnvironment,
    repository: bootstrap.expectedRepository,
  },
});
const verify = ({
  policy,
  subjectSha256,
}: {
  policy: {
    environment: string;
    issuer: string;
    ref: string;
    repository: string;
    workflow: string;
  };
  subjectSha256: string;
}) => ({ ...policy, subjectSha256, verified: true as const });

describe("admin baseline evidence resolution v1", () => {
  it("accepts only one real nested gh JSON SLSA result, never an echoed policy", () => {
    const subjectSha256 = "a".repeat(64);
    const realShape = [{
      attestation: { bundle: {} },
      verificationResult: {
        mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
        signature: { certificate: {
          subjectAlternativeName: `https://github.com/${bootstrap.expectedWorkflow}@${bootstrap.expectedRef}`,
          issuer: bootstrap.expectedIssuer,
          buildSignerURI: `https://github.com/${bootstrap.expectedWorkflow}@${bootstrap.expectedRef}`,
          buildConfigURI: `https://github.com/${bootstrap.expectedWorkflow}@${bootstrap.expectedRef}`,
          runnerEnvironment: "github-hosted",
          sourceRepositoryURI: `https://github.com/${bootstrap.expectedRepository}`,
          sourceRepositoryRef: bootstrap.expectedRef,
        } },
        verifiedTimestamps: [{ type: "signed", uri: "https://rekor.sigstore.dev", timestamp: "2026-08-20T18:59:00-05:00" }],
        statement: { _type: "https://in-toto.io/Statement/v1", subject: [{ name: "SHA256SUMS", digest: { sha256: subjectSha256 } }], predicateType: "https://slsa.dev/provenance/v1", predicate: {} },
      },
    }];
    expect(
      parseGithubBaselineEvidenceAttestationV1(
        Buffer.from(JSON.stringify(realShape)),
        { ...bootstrap, subjectSha256, now: "2026-08-21T00:00:00Z" },
      ),
    ).toMatchObject({ verified: true, signedAt: "2026-08-20T23:59:00Z" });
    expect(() =>
      parseGithubBaselineEvidenceAttestationV1(
        Buffer.from(JSON.stringify({ subjectSha256 })),
        { ...bootstrap, subjectSha256, now: "2026-08-21T00:00:00Z" },
      ),
    ).toThrow(/admin baseline evidence/);
  });
  it("uses fresh evidence before cache and only falls through on literal unavailable", async () => {
    const calls: string[] = [];
    const result = await resolveAdminBaselineEvidenceV1({
      bootstrap,
      now: "2026-08-21T00:00:00Z",
      fetchFresh: async () => {
        calls.push("fresh");
        return { kind: "available", artifact, attestationBytes: Buffer.from("attestation") };
      },
      readLastDownloaded: () => {
        calls.push("cache");
        return undefined;
      },
      commitLastDownloaded: () => {
        calls.push("commit");
        return true;
      },
      verifyGithubAttestation: verify,
    });
    expect(result.provenance.tier).toBe("fresh");
    expect(calls).toEqual(["fresh", "commit"]);
  });

  it.each([false, undefined])("treats cache commit %j as terminal", async (commit) => {
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({
          kind: "available",
          artifact,
          attestationBytes: Buffer.from("attestation"),
        }),
        readLastDownloaded: () => undefined,
        commitLastDownloaded: () => commit as never,
        verifyGithubAttestation: verify,
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
  });

  it("reverifies cache after literal unavailable and never masks malformed fresh input", async () => {
    const cached = {
      artifact,
      attestationBytes: Buffer.from("attestation"),
      downloadedAt: "2026-08-20T23:59:00Z",
    };
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({ kind: "unavailable" }),
        readLastDownloaded: () => cached,
        commitLastDownloaded: () => true,
        verifyGithubAttestation: verify,
      }),
    ).resolves.toMatchObject({ provenance: { tier: "last-downloaded", ageSeconds: 60 } });
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({
          kind: "available",
          artifact: {} as never,
          attestationBytes: Buffer.from("x"),
        }),
        readLastDownloaded: () => cached,
        commitLastDownloaded: () => true,
        verifyGithubAttestation: verify,
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
  });

  it("uses packaged evidence only after unavailable fresh and absent cache", async () => {
    const result = await resolveAdminBaselineEvidenceV1({
      bootstrap,
      now: "2026-08-21T00:00:00Z",
      fetchFresh: async () => ({ kind: "unavailable" }),
      readLastDownloaded: () => undefined,
      commitLastDownloaded: () => true,
      verifyGithubAttestation: verify,
    });
    expect(result.provenance).toMatchObject({
      tier: "packaged",
      ageSeconds: null,
      sourceIds: ["ecc", "superpowers"],
      schemaVersion: 1,
      digest: createHash("sha256").update(vendorBaselineLockBytes()).digest("hex"),
    });
  });
});
