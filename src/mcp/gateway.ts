import { lines } from "../internals/render.js";
import type {
  McpClassification,
  McpCredentials,
  McpEgress,
  McpServer,
  McpSupplyChain,
} from "./servers.js";

const OAUTH_SCOPE = "api://agentgateway/mcp_access";

export interface GatewayRbacRole {
  idpGroup: string;
  allowedServers: string[];
  source: "catalog" | "org-policy" | "admin";
  criteria: string;
}

export interface GatewayRbacServer {
  type: McpServer["type"];
  classification: McpClassification;
  egress: McpEgress;
  credentials: McpCredentials;
  supplyChain: McpSupplyChain;
}

export interface GatewayRbacConfig {
  schemaVersion: 1;
  gateway: {
    baseUrl: string;
    oauthScope: typeof OAUTH_SCOPE;
  };
  boundary: "config-only";
  roles: GatewayRbacRole[];
  catalog: Record<string, GatewayRbacServer>;
  generatedFrom: {
    catalogServers: string[];
    orgPolicyAllowedServers: string[];
    orgPolicyIgnoredServers: string[];
  };
}

interface GatewayRbacOptions {
  orgAllowedServers?: readonly string[];
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function serverNames(
  servers: Record<string, McpServer>,
  accept: (server: McpServer) => boolean,
): string[] {
  return sorted(
    Object.entries(servers)
      .filter(([, server]) => accept(server))
      .map(([name]) => name),
  );
}

function role(
  idpGroup: string,
  allowedServers: string[],
  source: GatewayRbacRole["source"],
  criteria: string,
): GatewayRbacRole {
  return { idpGroup, allowedServers, source, criteria };
}

function catalogSummary(servers: Record<string, McpServer>): Record<string, GatewayRbacServer> {
  const out: Record<string, GatewayRbacServer> = {};
  for (const name of sorted(Object.keys(servers))) {
    const server = servers[name];
    if (server === undefined) continue;
    out[name] = {
      type: server.type,
      classification: server.classification,
      egress: server.egress,
      credentials: server.credentials,
      supplyChain: server.supplyChain,
    };
  }
  return out;
}

export function gatewayRbacConfig(
  gateway: string,
  servers: Record<string, McpServer>,
  options: GatewayRbacOptions = {},
): GatewayRbacConfig {
  const catalogServers = sorted(Object.keys(servers));
  const catalogSet = new Set(catalogServers);
  const orgPolicyAllowedServers = sorted(options.orgAllowedServers ?? []);
  const orgAllowed = orgPolicyAllowedServers.filter((name) => catalogSet.has(name));
  const orgIgnored = orgPolicyAllowedServers.filter((name) => !catalogSet.has(name));
  const roles: GatewayRbacRole[] = [
    role(
      "mcp-local",
      serverNames(servers, (server) => server.egress === "none" && server.credentials === "none"),
      "catalog",
      "catalog.egress=none and catalog.credentials=none",
    ),
    role(
      "mcp-vendor-incumbent",
      serverNames(servers, (server) => server.egress === "vendor-incumbent"),
      "catalog",
      "catalog.egress=vendor-incumbent",
    ),
    role(
      "mcp-third-party-reviewed",
      serverNames(servers, (server) => server.egress === "third-party"),
      "catalog",
      "catalog.egress=third-party; enable only after vendor-risk review",
    ),
  ];
  if (orgPolicyAllowedServers.length > 0) {
    roles.push(
      role(
        "mcp-org-default",
        orgAllowed,
        "org-policy",
        "aih-org-policy.json mcp.allowedServers intersected with current catalog",
      ),
    );
  }
  roles.push(role("mcp-admins", catalogServers, "admin", "all current catalog servers"));
  return {
    schemaVersion: 1,
    gateway: { baseUrl: gateway, oauthScope: OAUTH_SCOPE },
    boundary: "config-only",
    roles,
    catalog: catalogSummary(servers),
    generatedFrom: {
      catalogServers,
      orgPolicyAllowedServers,
      orgPolicyIgnoredServers: orgIgnored,
    },
  };
}

function roleRows(config: GatewayRbacConfig): string[] {
  return config.roles.map((role) => {
    const allowed =
      role.allowedServers.length > 0 ? role.allowedServers.join(", ") : "(no current servers)";
    return `   | ${role.idpGroup} | ${allowed} | ${role.criteria} |`;
  });
}

/**
 * Identity-aware MCP gateway setup, emitted as a `doc` action for the `remote`
 * scope. Every line here is guidance for a human operator: the harness never
 * registers an OIDC app, never mints a token, never dials the gateway. The
 * BOUNDARY keeps all of this as text so an autonomous run cannot provision SSO.
 *
 * `gateway` is the canonical agentgateway base URL clients are pointed at; it is
 * interpolated into copy-paste commands only — it is not contacted.
 */
export function gatewayDoc(config: GatewayRbacConfig, hostedServers: string[] = []): string {
  // Vendor-risk checklist for the third-party-hosted servers the remote scope adds
  // — they are external endpoints your data is sent to, so they get an explicit
  // "vet before enabling" callout rather than being treated as a default-on set.
  const hostedSection =
    hostedServers.length > 0
      ? [
          "",
          "4. Third-party-hosted servers — vendor-risk review (before you enable them):",
          "",
          "   These remote-scope servers are HOSTED endpoints your data is sent to, not",
          "   local processes. Treat each as a vendor-risk decision, not a default:",
          "",
          ...hostedServers.map((name) => `     - ${name}  (third-party-hosted)`),
          "",
          "   Vet first: who operates the endpoint and where data is processed; whether",
          "   per-user tokens are isolated; SOC 2 / ISO 27001 evidence; whether it can be",
          "   self-hosted; whether the endpoint/package can be pinned. Until cleared, treat",
          "   these as demo/evaluation only and keep `.mcp.json` under CODEOWNERS review.",
        ]
      : [];
  return lines(
    "Centralized, identity-aware MCP gateway (remote scope)",
    "======================================================",
    "",
    "Point every MCP client at the gateway instead of dialing servers directly, so",
    "tool calls are authenticated per-user and authorized per-tool. Run these steps",
    "by hand against your IdP and gateway — aih does NOT contact the gateway.",
    "",
    `Gateway base URL: ${config.gateway.baseUrl}`,
    `OAuth scope:      ${config.gateway.oauthScope}`,
    "RBAC config:      <context-dir>/mcp-gateway-rbac.json",
    "",
    "1. Register the gateway as an OIDC confidential client in your IdP:",
    "",
    "   Microsoft Entra ID:",
    "     az ad app create --display-name 'AgentGateway MCP' \\",
    "       --sign-in-audience AzureADMyOrg",
    "     az ad app permission add --id <APP_ID> \\",
    "       --api <RESOURCE_APP_ID> \\",
    "       --api-permissions <PERMISSION_ID>=Scope",
    "     # Expose the API scope clients request:",
    "     #   Application ID URI: api://agentgateway",
    "     #   Scope name:         mcp_access",
    "",
    "   Okta (OIDC):",
    "     # Applications -> Create App Integration -> OIDC, Web application.",
    "     # Add a custom authorization-server scope 'mcp_access' and grant it.",
    "     #   Audience:    api://agentgateway",
    `     #   Login redirect URI: ${config.gateway.baseUrl}/oauth/callback`,
    "",
    "2. Apply the generated IdP-group to tool-level RBAC config on the gateway:",
    "",
    "   The machine-readable source is `<context-dir>/mcp-gateway-rbac.json`; the",
    "   table below is rendered from the same config, not maintained separately.",
    "",
    "   | IdP group | Allowed MCP tools | Source/criteria |",
    "   | --- | --- | --- |",
    ...roleRows(config),
    "",
    "   Each client's per-user token is exchanged at the gateway; the gateway",
    "   enforces these mappings before forwarding to a backing MCP server.",
    "",
    "3. Verify your session against the gateway (read-only; you run this, not aih):",
    "",
    "     agentgateway login --check",
    "",
    "   A 0 exit confirms a valid identity-aware session; non-zero means re-auth.",
    ...hostedSection,
  );
}
