import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
  BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
  BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
  buildVendorBaselineEvidenceArtifactV1,
  verifyVendorBaselineEvidenceArtifactV1,
} from "../../src/baseline-evidence/vendor-artifact-v1.js";
import { writeVendorBaselineEvidenceArtifactV1 } from "../../src/baseline-evidence/vendor-artifact.js";

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
            id: "ecc",
            owner: "affaan-m",
            repo: "ecc",
            pinnedSha: "b".repeat(40),
            components: [
              {
                id: "skill:review",
                paths: ["skills/review"],
                treeSha256: "a".repeat(64),
                verdict: "pass",
                analyzers: [{ name: "aih-native", version: "1" }],
                findings: [],
              },
            ],
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
    [
      "duplicate path",
      (artifact: ReturnType<typeof built>) => {
        const first = artifact.files[0];
        if (first === undefined) throw new Error("expected artifact file");
        return { ...artifact, files: [...artifact.files, first] };
      },
    ],
    [
      "unsafe path",
      (artifact: ReturnType<typeof built>) => ({
        ...artifact,
        files: [{ path: "../SHA256SUMS", bytes: artifact.subject.bytes }],
      }),
    ],
    [
      "checksum drift",
      (artifact: ReturnType<typeof built>) => ({
        ...artifact,
        files: artifact.files.map((file) =>
          file.path === `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`
            ? { ...file, bytes: Buffer.from("tampered\n") }
            : file,
        ),
      }),
    ],
    ["wrong source pin", (artifact: ReturnType<typeof built>) => artifact],
    ["wrong repository claim", (artifact: ReturnType<typeof built>) => artifact],
    ["wrong workflow claim", (artifact: ReturnType<typeof built>) => artifact],
    ["wrong issuer claim", (artifact: ReturnType<typeof built>) => artifact],
    ["wrong ref claim", (artifact: ReturnType<typeof built>) => artifact],
    ["wrong environment claim", (artifact: ReturnType<typeof built>) => artifact],
  ])("fails closed on %s", (_label, mutate) => {
    const artifact = mutate(built());
    const expectedPin = _label === "wrong source pin" ? "c".repeat(40) : "b".repeat(40);
    const claims =
      _label === "wrong repository claim"
        ? { repository: "other/repository" }
        : _label === "wrong workflow claim"
          ? { workflow: "samartomar/ai-harness/.github/workflows/other.yml" }
          : _label === "wrong issuer claim"
            ? { issuer: "https://issuer.example" }
            : _label === "wrong ref claim"
              ? { ref: "refs/heads/other" }
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
    ).toThrow(/BASELINE_EVIDENCE_ARTIFACT_V1/);
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

  it.each([
    ["too many files", (artifact: ReturnType<typeof built>) => ({ ...artifact, files: [...artifact.files, artifact.files[0]!] })],
    [
      "oversized lock bytes",
      (artifact: ReturnType<typeof built>) => ({
        ...artifact,
        files: artifact.files.map((file) =>
          file.path === `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`
            ? { ...file, bytes: Buffer.alloc(1_048_577) }
            : file,
        ),
      }),
    ],
  ])("rejects bounded hostile artifact input before attestation: %s", (_label, mutate) => {
    const calls: unknown[] = [];
    expect(() =>
      verifyVendorBaselineEvidenceArtifactV1({
        artifact: mutate(built()),
        policy: {
          ...attestationPolicy,
          sources: [{ id: "ecc", owner: "affaan-m", pinnedSha: "b".repeat(40), repo: "ecc" }],
        },
        verifyGithubAttestation: (request) => {
          calls.push(request);
          return verifiedClaims(request.subjectSha256);
        },
      }),
    ).toThrow(/BASELINE_EVIDENCE_ARTIFACT_V1: artifact bounds/);
    expect(calls).toEqual([]);
  });

  it.each([
    ["missing subject digest", { bytes: Buffer.from("x"), path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1 }],
    ["extra subject key", { ...built().subject, extra: true }],
    ["non-buffer subject bytes", { bytes: "x", path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1, sha256: "a".repeat(64) }],
    ["invalid subject digest", { bytes: Buffer.from("x"), path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1, sha256: "invalid" }],
  ])("rejects malformed subject wrappers locally: %s", (_label, subject) => {
    const calls: unknown[] = [];
    expect(() =>
      verifyVendorBaselineEvidenceArtifactV1({
        artifact: { ...built(), subject } as ReturnType<typeof built>,
        policy: {
          ...attestationPolicy,
          sources: [{ id: "ecc", owner: "affaan-m", pinnedSha: "b".repeat(40), repo: "ecc" }],
        },
        verifyGithubAttestation: (request) => {
          calls.push(request);
          return verifiedClaims(request.subjectSha256);
        },
      }),
    ).toThrow(/BASELINE_EVIDENCE_ARTIFACT_V1/);
    expect(calls).toEqual([]);
  });
});

describe("writeVendorBaselineEvidenceArtifactV1", () => {
  it("claims a new output directory and refuses to merge into an existing directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "aih-vendor-artifact-"));
    try {
      const output = join(parent, "artifact");
      writeVendorBaselineEvidenceArtifactV1(output, publisher);

      expect(lstatSync(output).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(output, BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1)).length).toBeGreaterThan(0);
      expect(() => writeVendorBaselineEvidenceArtifactV1(output, publisher)).toThrow();
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("refuses a symlink or junction parent without writing outside the output custody", (ctx) => {
    const parent = mkdtempSync(join(tmpdir(), "aih-vendor-artifact-parent-"));
    const outside = mkdtempSync(join(tmpdir(), "aih-vendor-artifact-outside-"));
    try {
      const linkedParent = join(parent, "linked-parent");
      try {
        symlinkSync(outside, linkedParent, "junction");
      } catch {
        ctx.skip();
        return;
      }

      expect(() =>
        writeVendorBaselineEvidenceArtifactV1(join(linkedParent, "artifact"), publisher),
      ).toThrow();
      expect(existsSync(join(outside, "artifact"))).toBe(false);
    } finally {
      rmSync(parent, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });
});
