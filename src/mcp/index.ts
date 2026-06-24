import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "mcp",
  summary: "Generate .mcp.json for local/project/remote MCP scopes and document the SSO gateway",
  options: [
    {
      flags: "--scope <scope>",
      description: "server scope: local|project|remote",
      default: "project",
    },
  ],
  plan: pendingPlan(
    "mcp",
    "Generate .mcp.json (better-code-review-graph stdio, better-email http, etc.) merged into any existing config, and document the SSO MCP gateway (Entra/Okta OIDC, tool-level RBAC) without contacting it.",
  ),
};
