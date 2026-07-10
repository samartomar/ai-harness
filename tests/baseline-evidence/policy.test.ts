import { describe, expect, it } from "vitest";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";

function policy(override: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    minimumPosture: "team",
    references: { repoContract: "ai-coding/project.json" },
    trust: {
      baselineOverrides: [
        {
          catalog: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: "a".repeat(40),
          bundle: ".aih/org-evidence/ecc",
          signingRepository: "acme/engineering-governance",
          reason: "Reviewed newer ECC baseline for the platform team",
          reviewer: "security@example.com",
          approvedAt: "2026-07-10T12:00:00.000Z",
          ...override,
        },
      ],
    },
  };
}

describe("org policy baseline overrides", () => {
  it("parses an attributable GitHub-attested override", () => {
    expect(parseOrgPolicy(policy()).trust?.baselineOverrides?.[0]).toEqual({
      catalog: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: "a".repeat(40),
      bundle: ".aih/org-evidence/ecc",
      signingRepository: "acme/engineering-governance",
      reason: "Reviewed newer ECC baseline for the platform team",
      reviewer: "security@example.com",
      approvedAt: "2026-07-10T12:00:00.000Z",
    });
  });

  it.each([
    ["unknown catalog", { catalog: "unknown" }],
    ["short pin", { pinnedSha: "deadbeef" }],
    ["absolute bundle", { bundle: "/tmp/evidence" }],
    ["escaping bundle", { bundle: "../evidence" }],
    ["backslash bundle", { bundle: ".aih\\evidence" }],
    ["invalid signing repository", { signingRepository: "acme" }],
    ["missing attribution", { reviewer: "" }],
    ["invalid timestamp", { approvedAt: "yesterday" }],
    ["unknown field", { extra: true }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseOrgPolicy(policy(override))).toThrow(/org-policy/i);
  });
});
