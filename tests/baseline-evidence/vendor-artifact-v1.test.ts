import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
  BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
  BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
  buildVendorBaselineEvidenceArtifactV1,
  verifyVendorBaselineEvidenceArtifactV1,
} from "../../src/baseline-evidence/vendor-artifact-v1.js";

const publisher = {
  environment: "baseline-evidence-publish",
  repository: "samartomar/ai-harness",
};

const attestationPolicy = {
  environment: publisher.environment,
  issuer: "https://token.actions.githubusercontent.com",
  ref: "refs/heads/main",
  repository: publisher.repository,
  workflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lockBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sources: [
          {
            components: [
              {
                analyzers: [{ name: "aih-native", version: "1" }],
                findings: [],
                id: "skill:review",
                paths: ["skills/review"],
                treeSha256: "a".repeat(64),
                verdict: "pass",
              },
            ],
            id: "ecc",
            owner: "affaan-m",
            pinnedSha: "b".repeat(40),
            repo: "ecc",
          },
        ],
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function built() {
  return buildVendorBaselineEvidenceArtifactV1({ lockBytes: lockBytes(), publisher });
}

function verifiedClaims(subjectSha256: string, overrides: Record<string, unknown> = {}) {
  return { ...attestationPolicy, subjectSha256, verified: true as const, ...overrides };
}

describe("VendorBaselineEvidenceArtifactV1", () => {
  it("builds a deterministic, exact-pin/schema-bound subject with every file checksummed", () => {
    const first = built();
    const second = built();

    expect(first.files).toEqual(second.files);
    expect(first.subject.path).toBe(BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1);
    expect(first.files.map((file) => file.path)).toEqual([
      BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
      "evidence.json",
      `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`,
      "manifest.json",
      BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
    ]);
    expect(first.files.at(2)?.bytes).toEqual(lockBytes());
    expect(first.subject.bytes).toEqual(first.files.at(-1)?.bytes);
    expect(first.subject.sha256).toBe(sha256(first.subject.bytes));
  });

  it("verifies exact bytes, checksums, source pins, schema, and a caller-owned GitHub claim", () => {
    const artifact = built();
    const seen: unknown[] = [];
    const verified = verifyVendorBaselineEvidenceArtifactV1({
      artifact,
      policy: {
        ...attestationPolicy,
        sources: [{ id: "ecc", owner: "affaan-m", pinnedSha: "b".repeat(40), repo: "ecc" }],
      },
      verifyGithubAttestation: (request) => {
        seen.push(request);
        return verifiedClaims(request.subjectSha256);
      },
    });

    expect(verified.lock).toEqual(JSON.parse(lockBytes().toString("utf8")));
    expect(seen).toEqual([
      {
        policy: attestationPolicy,
        subjectBytes: artifact.subject.bytes,
        subjectSha256: artifact.subject.sha256,
      },
    ]);
  });

  it.each([
    ["duplicate path", (artifact: ReturnType<typeof built>) => ({ ...artifact, files: [...artifact.files, artifact.files[0]!] })],
    ["unsafe path", (artifact: ReturnType<typeof built>) => ({ ...artifact, files: [{ path: "../SHA256SUMS", bytes: artifact.subject.bytes }] })],
    ["checksum drift", (artifact: ReturnType<typeof built>) => ({ ...artifact, files: artifact.files.map((file) => file.path === `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}` ? { ...file, bytes: Buffer.from("tampered\n") } : file) })],
    ["wrong source pin", (artifact: ReturnType<typeof built>) => artifact],
    ["wrong workflow claim", (artifact: ReturnType<typeof built>) => artifact],
    ["wrong environment claim", (artifact: ReturnType<typeof built>) => artifact],
  ])("fails closed on %s", (_label, mutate) => {
    const artifact = mutate(built());
    const expectedPin = _label === "wrong source pin" ? "c".repeat(40) : "b".repeat(40);
    const claims =
      _label === "wrong workflow claim"
        ? { workflow: "samartomar/ai-harness/.github/workflows/other.yml" }
        : _label === "wrong environment claim"
          ? { environment: "other" }
          : {};
    expect(() =>
      verifyVendorBaselineEvidenceArtifactV1({
        artifact,
        policy: {
          ...attestationPolicy,
          sources: [{ id: "ecc", owner: "affaan-m", pinnedSha: expectedPin, repo: "ecc" }],
        },
        verifyGithubAttestation: (request) => verifiedClaims(request.subjectSha256, claims),
      }),
    ).toThrow(/baseline evidence artifact/i);
  });

  it("does not call the attestation boundary until all local bytes have passed", () => {
    const artifact = built();
    const calls: unknown[] = [];
    expect(() =>
      verifyVendorBaselineEvidenceArtifactV1({
        artifact: {
          ...artifact,
          files: artifact.files.map((file) =>
            file.path === `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`
              ? { ...file, bytes: Buffer.from("not json\n") }
              : file,
          ),
        },
        policy: {
          ...attestationPolicy,
          sources: [{ id: "ecc", owner: "affaan-m", pinnedSha: "b".repeat(40), repo: "ecc" }],
        },
        verifyGithubAttestation: (request) => {
          calls.push(request);
          return verifiedClaims(request.subjectSha256);
        },
      }),
    ).toThrow();
    expect(calls).toEqual([]);
  });
});
