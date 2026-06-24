/**
 * The enterprise MCP server blueprint emitted into `.mcp.json`.
 *
 * Two flavours, both pure configuration the user opts into — never a call:
 *  - `better-code-review-graph` runs LOCALLY over stdio via `uv run`;
 *  - the `n24q02m` hosted toolset (`better-email`, `better-notion`,
 *    `better-telegram`, `mnemo-mcp`, `wet-mcp`) is reached by HTTP URL. The URL
 *    is a string a client dials on the user's behalf later; emitting it here
 *    contacts nothing.
 *
 * JSON has no comments, so every entry carries a `description` field to keep the
 * generated file self-documenting.
 */

/** A stdio MCP server launched by a local command. */
export interface StdioServer {
  type: "stdio";
  command: string;
  args: string[];
  description: string;
}

/** An HTTP MCP server addressed by URL (a config endpoint, not a request). */
export interface HttpServer {
  type: "http";
  url: string;
  description: string;
}

export type McpServer = StdioServer | HttpServer;

/** Base host for the n24q02m hosted enterprise toolset. */
export const N24Q02M_HOST = "n24q02m.com";

/**
 * The canonical `mcpServers` map. Deterministic insertion order (local graph
 * server first, then the hosted toolset alphabetically) so golden assertions and
 * deep-merge output stay stable across runs.
 */
export function mcpServers(): Record<string, McpServer> {
  return {
    "better-code-review-graph": {
      type: "stdio",
      command: "uv",
      args: ["run", "better-code-review-graph", "serve"],
      description:
        "Local code-review knowledge graph (impact radius, affected flows) served over stdio via uv.",
    },
    "better-email": {
      type: "http",
      url: `https://better-email-mcp.${N24Q02M_HOST}/mcp`,
      description: "Hosted email toolset (n24q02m). Opt-in HTTP endpoint behind the SSO gateway.",
    },
    "better-notion": {
      type: "http",
      url: `https://better-notion-mcp.${N24Q02M_HOST}/mcp`,
      description: "Hosted Notion workspace toolset (n24q02m). Opt-in HTTP endpoint.",
    },
    "better-telegram": {
      type: "http",
      url: `https://better-telegram-mcp.${N24Q02M_HOST}/mcp`,
      description: "Hosted Telegram messaging toolset (n24q02m). Opt-in HTTP endpoint.",
    },
    "mnemo-mcp": {
      type: "http",
      url: `https://mnemo-mcp.${N24Q02M_HOST}/mcp`,
      description: "Hosted long-term memory / recall toolset (n24q02m). Opt-in HTTP endpoint.",
    },
    "wet-mcp": {
      type: "http",
      url: `https://wet-mcp.${N24Q02M_HOST}/mcp`,
      description: "Hosted web extraction / transform toolset (n24q02m). Opt-in HTTP endpoint.",
    },
  };
}
