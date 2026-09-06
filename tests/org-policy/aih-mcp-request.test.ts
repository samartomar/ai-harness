import { describe, expect, it } from "vitest";
import { AIH_OWNED_ECC_MCP_EXCLUSIONS } from "../../src/org-policy/ecc-mcp-catalog.js";
import { OrgPolicySchema, parseOrgPolicy } from "../../src/org-policy/schema.js";

function policy(requests: unknown[], overrides: Record<string, unknown> = {}) {
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
      aihMcpRequests: requests,
      ...overrides,
    },
  };
}

const request = (id: string) => ({ id, clarification: "Requested by: administrator" });

function issues(value: unknown): string[] {
  const parsed = OrgPolicySchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

function issuePaths(value: unknown, message: string): string[] {
  const parsed = OrgPolicySchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues
        .filter((issue) => issue.message === message)
        .map((issue) => issue.path.join("."));
}

const customCandidate = (id: string) => ({
  id,
  kind: "mcp",
  description: "Organization-pinned stdio MCP",
  capabilities: [],
  risks: [],
  source: {
    type: "stdio",
    resolver: "npx",
    registry: "https://registry.npmjs.org",
    package: `${id}-mcp`,
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
  },
  targets: ["claude"],
  projector: "mcp-managed-settings",
  lifecycle: "supported",
  evidence: { record: "organization-evidence" },
});

const COLLISION = (id: string) =>
  `${id} is recorded as both an AIH MCP request and a policy candidate; one identity keeps one record — remove either the request or the candidate`;

describe("requested intent over gated AIH-owned MCP identities", () => {
  it("accepts requests in the pinned AIH-owned declaration order without creating a candidate", () => {
    const parsed = parseOrgPolicy(policy([request("context7"), request("playwright")]));
    expect(parsed.governance?.aihMcpRequests).toEqual([request("context7"), request("playwright")]);
    expect(parsed.governance?.catalog.reviewed).toEqual([]);
    expect(parsed.governance?.catalog.custom).toEqual([]);
    expect(parsed.governance?.activations).toEqual([]);
  });

  it("keeps the array absent rather than defaulting it, so a policy that requests nothing is unchanged", () => {
    const value = policy([]);
    const governance = value.governance as Record<string, unknown>;
    delete governance.aihMcpRequests;
    const parsed = parseOrgPolicy(value);
    expect(parsed.governance === undefined || "aihMcpRequests" in parsed.governance).toBe(false);
  });

  it("still accepts an allow-list-only governance object", () => {
    const parsed = parseOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: { supportedClis: ["claude"] },
    });
    expect(parsed.governance?.supportedClis).toEqual(["claude"]);
  });

  it.each([
    ["an id outside the pinned AIH-owned declarations", [request("vercel")]],
    [
      "a clarification other than the recorded requesting origin",
      [{ id: "context7", clarification: "Requested by: vibe profile" }],
    ],
    ["a missing clarification", [{ id: "context7" }]],
    ["an extra key", [{ ...request("context7"), gap: "no-projector" }]],
  ])("rejects %s", (_label, requests) => {
    expect(OrgPolicySchema.safeParse(policy(requests)).success).toBe(false);
  });

  it("refuses an empty request array, so absence stays the only not-requested encoding", () => {
    expect(OrgPolicySchema.safeParse(policy([])).success).toBe(false);
  });

  it("refuses a duplicated request", () => {
    const value = policy([request("context7"), request("context7")]);
    expect(issues(value)).toContain("AIH MCP request context7 is duplicated");
    expect(issuePaths(value, "AIH MCP request context7 is duplicated")).toEqual([
      "governance.aihMcpRequests",
    ]);
  });

  it("refuses requests that do not follow the pinned AIH-owned declaration order", () => {
    const value = policy([request("playwright"), request("context7")]);
    const message = "AIH MCP requests must follow the pinned AIH-owned MCP declaration order";
    expect(issues(value)).toContain(message);
    expect(issuePaths(value, message)).toEqual(["governance.aihMcpRequests"]);
    expect(AIH_OWNED_ECC_MCP_EXCLUSIONS.indexOf("context7")).toBeLessThan(
      AIH_OWNED_ECC_MCP_EXCLUSIONS.indexOf("playwright"),
    );
  });

  it("reports only the duplicate when the duplicate is also out of order", () => {
    expect(issues(policy([request("playwright"), request("playwright")]))).not.toContain(
      "AIH MCP requests must follow the pinned AIH-owned MCP declaration order",
    );
  });

  it("refuses an identity recorded as both a request and a policy candidate", () => {
    const candidate = {
      id: "sequential-thinking",
      kind: "mcp",
      description: "AIH-provided governed control",
      capabilities: [],
      risks: [],
      source: {
        type: "mcp",
        server: "sequential-thinking",
        subject: `mcp-server-sha256:${"a".repeat(64)}`,
      },
      targets: ["claude"],
      projector: "mcp-managed-settings",
      lifecycle: "supported",
      evidence: { record: "aih-sequential-thinking" },
    };
    const value = policy([request("sequential-thinking")], {
      catalog: { reviewed: [candidate], custom: [] },
    });
    expect(issues(value)).toContain(COLLISION("sequential-thinking"));
    expect(issuePaths(value, COLLISION("sequential-thinking"))).toEqual([
      "governance.aihMcpRequests.0",
    ]);
  });

  it("refuses an identity recorded as both a request and a custom candidate, per index", () => {
    const value = policy([request("github"), request("context7")], {
      catalog: { reviewed: [], custom: [customCandidate("context7")] },
    });
    expect(issues(value)).toContain(COLLISION("context7"));
    expect(issues(value)).not.toContain(COLLISION("github"));
    expect(issuePaths(value, COLLISION("context7"))).toEqual(["governance.aihMcpRequests.1"]);
  });
});
