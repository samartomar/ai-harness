import { lines } from "../internals/render.js";

/**
 * Identity-aware MCP gateway setup, emitted as a `doc` action for the `remote`
 * scope. Every line here is guidance for a human operator: the harness never
 * registers an OIDC app, never mints a token, never dials the gateway. The
 * BOUNDARY keeps all of this as text so an autonomous run cannot provision SSO.
 *
 * `gateway` is the canonical agentgateway base URL clients are pointed at; it is
 * interpolated into copy-paste commands only — it is not contacted.
 */
export function gatewayDoc(gateway: string, hostedServers: string[] = []): string {
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
    `Gateway base URL: ${gateway}`,
    "OAuth scope:      api://agentgateway/mcp_access",
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
    `     #   Login redirect URI: ${gateway}/oauth/callback`,
    "",
    "2. Map IdP groups to tool-level RBAC on the gateway (least privilege):",
    "",
    "   | IdP group            | Allowed MCP tools                         |",
    "   |----------------------|-------------------------------------------|",
    "   | mcp-readers          | code-review-graph                         |",
    "   | mcp-comms            | better-email, better-telegram             |",
    "   | mcp-knowledge        | better-notion, mnemo-mcp, wet-mcp         |",
    "   | mcp-admins           | * (all tools)                             |",
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
