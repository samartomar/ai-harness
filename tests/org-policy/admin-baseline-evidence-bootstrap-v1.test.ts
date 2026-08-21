import { describe, expect, it } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  type AdminBaselineEvidenceBootstrapV1,
  parseAdminBaselineEvidenceBootstrapV1Json,
} from "../../src/org-policy/admin-baseline-evidence-bootstrap-v1.js";

const record: AdminBaselineEvidenceBootstrapV1 = {
  artifactUrl: "https://artifacts.example.test/vendor-evidence/SHA256SUMS",
  attestationUrl: "https://artifacts.example.test/vendor-evidence/attestation.json",
  cacheMaxAgeSeconds: 3600,
  expectedEnvironment: "baseline-evidence-publish",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedRepository: "samartomar/ai-harness",
  expectedWorkflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
  maxSchemaVersion: 1,
  minSchemaVersion: 1,
  protocol: "AdminBaselineEvidenceBootstrapV1",
  sources: [
    { id: "ecc", owner: "affaan-m", pinnedSha: "623f2c020f052319657674e4e6c29ab5d0ad566b", repo: "ecc" },
    { id: "superpowers", owner: "obra", pinnedSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9", repo: "Superpowers" },
  ],
};

describe("admin baseline evidence bootstrap V1", () => {
  it("accepts only canonical credential-free HTTPS authority bound to exact #815 identity", () => {
    const parsed = parseAdminBaselineEvidenceBootstrapV1Json(canonicalStrictJsonBytesV1(record));
    expect(parsed).toEqual(record);
  });

  it.each([
    ["credential locator", { ...record, artifactUrl: "https://token@artifacts.example.test/a" }],
    ["schema range", { ...record, maxSchemaVersion: 0 }],
    ["untrusted ref", { ...record, expectedRef: "refs/heads/feature..unsafe" }],
    ["wrong source pin", { ...record, sources: [{ ...record.sources[0], pinnedSha: "A".repeat(40) }, record.sources[1]] }],
    ["incomplete sources", { ...record, sources: [record.sources[0]] }],
    ["unordered sources", { ...record, sources: [record.sources[1], record.sources[0]] }],
  ])("fails closed on %s", (_label, value) => {
    expect(() =>
      parseAdminBaselineEvidenceBootstrapV1Json(canonicalStrictJsonBytesV1(value)),
    ).toThrow(/admin baseline evidence bootstrap/);
  });
});
