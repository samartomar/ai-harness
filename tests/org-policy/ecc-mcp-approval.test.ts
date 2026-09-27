import { describe, expect, it } from "vitest";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import {
  ECC_EXTERNAL_MCP_APPROVAL_IDS,
  resolveEccMcpApproval,
} from "../../src/org-policy/ecc-mcp-approval.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";
import { OrgPolicySchema, parseOrgPolicy } from "../../src/org-policy/schema.js";

function policy(approvals: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026.08",
      supportedClis: ["claude"],
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      eccMcpApprovals: approvals,
    },
  };
}

const approval = {
  id: "vercel",
  sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
  state: "approved",
  approvedBy: "approver@example.com",
  authenticationMode: "oauth",
  allowedDataClasses: ["deployment-metadata"],
};

describe("declarative ECC external MCP approvals", () => {
  it("keeps the pinned source digest paired with the existing external-MCP inventory", () => {
    const catalog = policyAuthoringCatalog();
    expect(catalog.eccMcpApproval.sourceContentSha256).toBe(
      ECC_MCP_CATALOG_PROVENANCE.contentSha256,
    );
    expect(catalog.externalMcp).toHaveLength(31);
  });
  it("accepts an exact approval record without creating an activation or projector", () => {
    const parsed = parseOrgPolicy(policy([approval]));
    expect(parsed.governance?.eccMcpApprovals).toEqual([approval]);
    expect(ECC_EXTERNAL_MCP_APPROVAL_IDS).toContain("vercel");
    expect(resolveEccMcpApproval(parsed.governance?.eccMcpApprovals ?? [], "vercel")).toEqual({
      state: "approved",
      approval,
    });
  });

  it("keeps existing stable approver identifiers readable while new approvals use email", () => {
    const legacyApproval = { ...approval, approvedBy: "security-admin" };
    const parsed = parseOrgPolicy(policy([legacyApproval]));
    expect(parsed.governance?.eccMcpApprovals).toEqual([legacyApproval]);
    expect(resolveEccMcpApproval([legacyApproval], "vercel")).toEqual({
      state: "approved",
      approval: legacyApproval,
    });
  });

  it.each([
    ["AIH-owned id", { ...approval, id: "github" }],
    ["unknown id", { ...approval, id: "not-in-pinned-ecc" }],
    ["malformed source digest", { ...approval, sourceContentSha256: "0".repeat(63) }],
    ["prefixed source digest", { ...approval, sourceContentSha256: `sha256:${"0".repeat(64)}` }],
    ["empty allowed data", { ...approval, allowedDataClasses: [] }],
    ["unverifiable approver identity", { ...approval, approvedBy: "Samar" }],
    ["extra field", { ...approval, extra: true }],
  ])("rejects %s", (_label, invalid) => {
    expect(OrgPolicySchema.safeParse(policy([invalid])).success).toBe(false);
  });

  it("keeps an approval recorded for other ECC content as a stale label that authorizes nothing (D74)", () => {
    // A 0.6.2 policy saved its approvals against the v2.2.0-1 ECC MCP content.
    const previous = "a4426254c55a5352db2672bc86a87f10b0029f5e4ae1b74817841e87d9ab1e57";
    const saved = { ...approval, sourceContentSha256: previous };
    const current = { ...approval, id: "supabase" };
    const parsed = parseOrgPolicy(policy([saved, current]));
    const approvals = parsed.governance?.eccMcpApprovals ?? [];

    expect(approvals).toEqual([saved, current]);
    expect(resolveEccMcpApproval(approvals, "vercel")).toEqual({
      state: "stale",
      approval: saved,
      label: `recorded for ECC content ${previous}; current is ${ECC_MCP_CATALOG_PROVENANCE.contentSha256}; re-approve`,
    });
    expect(resolveEccMcpApproval(approvals, "supabase")).toEqual({
      state: "approved",
      approval: current,
    });
    // A revocation stays a revocation whatever content it was recorded for.
    expect(resolveEccMcpApproval([{ ...saved, state: "revoked" }], "vercel")).toEqual({
      state: "revoked",
      approval: { ...saved, state: "revoked" },
    });
  });

  it("rejects duplicate IDs and resolves malformed records fail-closed", () => {
    expect(
      OrgPolicySchema.safeParse(policy([approval, { ...approval, state: "revoked" }])).success,
    ).toBe(false);
    expect(resolveEccMcpApproval([{ ...approval }, { ...approval }], "vercel")).toEqual({
      state: "source-mismatch",
    });
    expect(resolveEccMcpApproval([], "vercel")).toEqual({ state: "unapproved" });
    expect(resolveEccMcpApproval([{ ...approval, state: "revoked" }], "vercel")).toEqual({
      state: "revoked",
      approval: { ...approval, state: "revoked" },
    });
    expect(
      resolveEccMcpApproval([{ ...approval, authenticationMode: "oauth\u0000hidden" }], "vercel"),
    ).toEqual({ state: "source-mismatch" });
    expect(
      resolveEccMcpApproval([{ ...approval, authenticationMode: "x".repeat(501) }], "vercel"),
    ).toEqual({ state: "source-mismatch" });
    expect(
      resolveEccMcpApproval(
        [{ ...approval, allowedDataClasses: Array.from({ length: 21 }, (_, i) => `class-${i}`) }],
        "vercel",
      ),
    ).toEqual({ state: "source-mismatch" });
  });
});
