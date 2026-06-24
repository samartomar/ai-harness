import type { RepoStack } from "../profile/scan.js";

/**
 * The `.mcp.json` server set is assembled from the DETECTED stack, not a fixed
 * boilerplate list:
 *  - `better-code-review-graph` (local, stdio) — code intelligence, useful in any repo;
 *  - real, current servers added per stack: AWS (`awslabs.core-mcp-server`) when
 *    the repo targets AWS, Playwright (`@playwright/mcp`) for a web frontend;
 *  - the hosted `n24q02m` toolset ONLY under `scope === "remote"` (opt-in gateway).
 * Every entry is configuration the client dials later — emitting it contacts nothing.
 */

export interface StdioServer {
  type: "stdio";
  command: string;
  args: string[];
  description: string;
}
export interface HttpServer {
  type: "http";
  url: string;
  description: string;
}
export type McpServer = StdioServer | HttpServer;

/** Base host for the n24q02m hosted enterprise toolset. */
export const N24Q02M_HOST = "n24q02m.com";

/** Frameworks that warrant a browser-automation (Playwright) MCP server. */
const WEB_FRAMEWORKS = new Set(["Next.js", "React", "Vue", "Svelte", "Angular"]);

/**
 * Build the `mcpServers` map for `scope`, tailored to `stack`. Deterministic
 * insertion order (local graph first, then stack-specific, then hosted) so golden
 * assertions and deep-merge output stay stable.
 */
export function mcpServers(scope: string, stack: RepoStack): Record<string, McpServer> {
  const servers: Record<string, McpServer> = {
    "better-code-review-graph": {
      type: "stdio",
      command: "uv",
      args: ["run", "better-code-review-graph", "serve"],
      description:
        "Local code-review knowledge graph (impact radius, affected flows) served over stdio via uv.",
    },
  };

  // Stack-specific, real, current servers.
  if (stack.cloud.includes("AWS")) {
    servers["awslabs.core-mcp-server"] = {
      type: "stdio",
      command: "uvx",
      args: ["awslabs.core-mcp-server@latest"],
      description:
        "AWS Labs core MCP server (AWS docs, service guidance). Added because the repo targets AWS.",
    };
  }
  if (stack.frameworks.some((f) => WEB_FRAMEWORKS.has(f))) {
    servers.playwright = {
      type: "stdio",
      command: "npx",
      args: ["@playwright/mcp@latest"],
      description:
        "Playwright browser automation MCP (navigate, snapshot, interact). Added for a web frontend.",
    };
  }

  if (scope === "remote") Object.assign(servers, hostedServers());
  return servers;
}

/** The opt-in hosted n24q02m toolset — only written under the `remote` scope. */
function hostedServers(): Record<string, McpServer> {
  return {
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
