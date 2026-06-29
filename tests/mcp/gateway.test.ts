import { describe, expect, it } from "vitest";
import { gatewayDoc, gatewayRbacConfig } from "../../src/mcp/gateway.js";
import type { McpServer } from "../../src/mcp/servers.js";

const servers = {
  "local-code": {
    type: "stdio",
    command: "node",
    args: ["local-code.js"],
    description: "Local code intelligence.",
    classification: "local",
    egress: "none",
    credentials: "none",
    supplyChain: "pinned",
  },
  "vendor-docs": {
    type: "http",
    url: "https://vendor.example/mcp",
    description: "Vendor-incumbent docs.",
    classification: "third-party-hosted",
    egress: "vendor-incumbent",
    credentials: "oauth",
    supplyChain: "hosted-remote",
  },
  "hosted-knowledge": {
    type: "http",
    url: "https://knowledge.example/mcp",
    description: "Third-party knowledge host.",
    classification: "third-party-hosted",
    egress: "third-party",
    credentials: "oauth",
    supplyChain: "hosted-remote",
  },
} satisfies Record<string, McpServer>;

function allowed(config: ReturnType<typeof gatewayRbacConfig>, group: string): string[] {
  return config.roles.find((role) => role.idpGroup === group)?.allowedServers ?? [];
}

describe("gateway RBAC config", () => {
  it("generates per-role allowlists from catalog risk axes plus org-policy grants", () => {
    const config = gatewayRbacConfig("https://agentgateway.example", servers, {
      orgAllowedServers: ["hosted-knowledge", "missing-server", "local-code"],
    });

    expect(allowed(config, "mcp-local")).toEqual(["local-code"]);
    expect(allowed(config, "mcp-vendor-incumbent")).toEqual(["vendor-docs"]);
    expect(allowed(config, "mcp-third-party-reviewed")).toEqual(["hosted-knowledge"]);
    expect(allowed(config, "mcp-org-default")).toEqual(["hosted-knowledge", "local-code"]);
    expect(allowed(config, "mcp-admins")).toEqual([
      "hosted-knowledge",
      "local-code",
      "vendor-docs",
    ]);
    expect(config.generatedFrom.orgPolicyIgnoredServers).toEqual(["missing-server"]);
  });

  it("renders the doc RBAC table from the structured config, not a static tool list", () => {
    const config = gatewayRbacConfig("https://agentgateway.example", servers, {
      orgAllowedServers: ["hosted-knowledge"],
    });
    const text = gatewayDoc(config, ["hosted-knowledge"]);

    expect(text).toContain("mcp-gateway-rbac.json");
    expect(text).toContain("mcp-org-default");
    expect(text).toContain("hosted-knowledge");
    expect(text).not.toContain("better-email, better-telegram");
    expect(text).toContain("aih does NOT contact the gateway");
  });
});
