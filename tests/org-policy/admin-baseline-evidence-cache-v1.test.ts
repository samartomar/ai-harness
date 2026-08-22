import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorBaselineLockBytes } from "../../src/baseline-evidence/vendor.js";
import { buildVendorBaselineEvidenceArtifactV1 } from "../../src/baseline-evidence/vendor-artifact-v1.js";
import type { AdminBaselineEvidenceBootstrapV1 } from "../../src/org-policy/admin-baseline-evidence-bootstrap-v1.js";
import {
  adminBaselineEvidenceCacheSlotPathV1,
  commitAdminBaselineEvidenceCacheV1,
  createAdminBaselineEvidenceCacheRecordV1,
  parseAdminBaselineEvidenceCacheRecordV1Json,
  readAdminBaselineEvidenceCacheV1,
} from "../../src/org-policy/admin-baseline-evidence-cache-v1.js";

const bootstrap: AdminBaselineEvidenceBootstrapV1 = {
  protocol: "AdminBaselineEvidenceBootstrapV1",
  artifactUrl: "https://evidence.example.test/artifact/",
  attestationUrl: "https://evidence.example.test/attestation",
  cacheMaxAgeSeconds: 3600,
  expectedEnvironment: "baseline-evidence-publish",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedRepository: "samartomar/ai-harness",
  expectedWorkflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
  minSchemaVersion: 1,
  maxSchemaVersion: 1,
  sources: [
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
  ],
};
const artifact = buildVendorBaselineEvidenceArtifactV1({
  lockBytes: vendorBaselineLockBytes(),
  publisher: {
    environment: bootstrap.expectedEnvironment,
    repository: bootstrap.expectedRepository,
  },
});
const evidence = {
  artifact,
  attestationBytes: Buffer.from("attestation"),
  downloadedAt: "2026-08-21T00:00:00Z",
};
const refreshedEvidence = {
  ...evidence,
  attestationBytes: Buffer.from("refreshed-attestation"),
  downloadedAt: "2026-08-21T00:01:00Z",
};

describe("admin baseline evidence cache v1", () => {
  it("round-trips only a canonical complete raw artifact and binds its subject", () => {
    const bytes = createAdminBaselineEvidenceCacheRecordV1(evidence);
    expect(parseAdminBaselineEvidenceCacheRecordV1Json(bytes)).toEqual(evidence);
    expect(() =>
      parseAdminBaselineEvidenceCacheRecordV1Json(Buffer.from(`${bytes.toString("utf8")} `)),
    ).toThrow();
  });

  it("rejects an impossible Gregorian downloaded-at day before cache custody", () => {
    expect(() =>
      createAdminBaselineEvidenceCacheRecordV1({
        ...evidence,
        downloadedAt: "2026-02-31T00:00:00Z",
      }),
    ).toThrow(/admin baseline evidence cache/);
  });

  it("rejects proxy and revoked-proxy byte inputs with the fixed parser error", () => {
    const bytes = createAdminBaselineEvidenceCacheRecordV1(evidence);
    let traps = 0;
    const proxied = new Proxy(bytes, {
      get() {
        traps += 1;
        throw new Error("trap");
      },
    });
    const revoked = Proxy.revocable(bytes, {});
    revoked.revoke();
    for (const value of [proxied, revoked.proxy]) {
      expect(() => parseAdminBaselineEvidenceCacheRecordV1Json(value)).toThrow(
        /admin baseline evidence cache: bytes/,
      );
    }
    expect(traps).toBe(0);
  });

  it("claims one contained cache slot and treats present invalid bytes as terminal", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-baseline-cache-"));
    try {
      expect(readAdminBaselineEvidenceCacheV1(root, bootstrap)).toBeUndefined();
      expect(commitAdminBaselineEvidenceCacheV1(root, bootstrap, evidence)).toBe(true);
      expect(readAdminBaselineEvidenceCacheV1(root, bootstrap)).toEqual(evidence);
      const slot = adminBaselineEvidenceCacheSlotPathV1(root, bootstrap);
      expect(slot).toContain("cache");
      expect(commitAdminBaselineEvidenceCacheV1(root, bootstrap, refreshedEvidence)).toBe(true);
      expect(readAdminBaselineEvidenceCacheV1(root, bootstrap)).toEqual(refreshedEvidence);
      writeFileSync(`${slot}.lock`, "claimed", "utf8");
      expect(commitAdminBaselineEvidenceCacheV1(root, bootstrap, evidence)).toBe(false);
      expect(readAdminBaselineEvidenceCacheV1(root, bootstrap)).toEqual(refreshedEvidence);
      rmSync(`${slot}.lock`);
      writeFileSync(slot, "{}", "utf8");
      expect(() => readAdminBaselineEvidenceCacheV1(root, bootstrap)).toThrow(
        /admin baseline evidence cache/,
      );
      rmSync(slot);
      mkdirSync(slot);
      expect(commitAdminBaselineEvidenceCacheV1(root, bootstrap, evidence)).toBe(false);
      expect(existsSync(`${slot}.lock`)).toBe(false);
      expect(() => readAdminBaselineEvidenceCacheV1(root, bootstrap)).toThrow(
        /admin baseline evidence cache/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
