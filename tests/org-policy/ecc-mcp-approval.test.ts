import { describe, expect, it } from "vitest";
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
  approvedBy: "security-admin",
  authenticationMode: "oauth",
  allowedDataClasses: ["deployment-metadata"],
};

describe("declarative ECC external MCP approvals", () => {
  it("accepts an exact approval record without creating an activation or projector", () => {
    const parsed = parseOrgPolicy(policy([approval]));
    expect(parsed.governance?.eccMcpApprovals).toEqual([approval]);
    expect(ECC_EXTERNAL_MCP_APPROVAL_IDS).toContain("vercel");
    expect(resolveEccMcpApproval(parsed.governance?.eccMcpApprovals ?? [], "vercel")).toEqual({
      state: "approved",
      approval,
    });
  });

  it.each([
    ["AIH-owned id", { ...approval, id: "github" }],
    ["unknown id", { ...approval, id: "not-in-pinned-ecc" }],
    ["source digest mismatch", { ...approval, sourceContentSha256: "0".repeat(64) }],
    ["empty allowed data", { ...approval, allowedDataClasses: [] }],
    ["extra field", { ...approval, extra: true }],
  ])("rejects %s", (_label, invalid) => {
    expect(OrgPolicySchema.safeParse(policy([invalid])).success).toBe(false);
  });

  it("rejects duplicate IDs and resolves malformed records fail-closed", () => {
    expect(
      OrgPolicySchema.safeParse(policy([approval, { ...approval, state: "revoked" }])).success,
    ).toBe(false);
    expect(
      resolveEccMcpApproval([{ ...approval, sourceContentSha256: "0".repeat(64) }], "vercel"),
    ).toEqual({ state: "source-mismatch" });
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
