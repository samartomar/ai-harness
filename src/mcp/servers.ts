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

/**
 * Data-handling risk class for an MCP server, surfaced in `.mcp.json` and the
 * remote-scope gateway doc so a reviewer can see the egress surface at a glance:
 *  - `local`              — runs as a local process (stdio); data stays on the box.
 *  - `third-party-hosted` — an external HTTP endpoint a vendor operates; your data
 *                           leaves the machine, so it needs vendor-risk review.
 */
export type McpClassification = "local" | "third-party-hosted";

export interface StdioServer {
  type: "stdio";
  command: string;
  args: string[];
  description: string;
  classification: McpClassification;
}
export interface HttpServer {
  type: "http";
  url: string;
  description: string;
  classification: McpClassification;
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
      // `uv run` executes the version installed in the project's OWN uv environment
      // (governed by its lockfile) — it does not fetch latest from upstream the way
      // `uvx <pkg>` would, so the running version is already reproducible. AWS /
      // Playwright below use `uvx|npx <pkg>@<ver>` explicit pins.
      args: ["run", "better-code-review-graph", "serve"],
      description:
        "Local code-review knowledge graph (impact radius, affected flows) served over stdio via uv.",
      classification: "local",
    },
  };

  // Stack-specific, real, current servers.
  if (stack.cloud.includes("AWS")) {
    servers["awslabs.core-mcp-server"] = {
      type: "stdio",
      command: "uvx",
      // Pinned (not @latest) for reproducible installs; bump deliberately.
      args: ["awslabs.core-mcp-server@1.0.27"],
      description:
        "AWS Labs core MCP server (AWS docs, service guidance). Added because the repo targets AWS.",
      classification: "local",
    };
  }
  if (stack.frameworks.some((f) => WEB_FRAMEWORKS.has(f))) {
    servers.playwright = {
      type: "stdio",
      command: "npx",
      // Pinned (not @latest) for reproducible installs; bump deliberately.
      args: ["@playwright/mcp@0.0.76"],
      description:
        "Playwright browser automation MCP (navigate, snapshot, interact). Added for a web frontend.",
      classification: "local",
    };
  }

  if (scope === "remote") Object.assign(servers, hostedServers());
  return servers;
}

/**
 * The opt-in hosted n24q02m toolset — only written under the `remote` scope.
 * Every entry is `third-party-hosted`: a vendor-operated HTTP endpoint your data
 * is sent to. Each description names that egress so it is visible in `.mcp.json`
 * itself; the gateway doc adds the vendor-risk checklist to vet before enabling.
 */
function hostedServers(): Record<string, McpServer> {
  return {
    "better-email": {
      type: "http",
      url: `https://better-email-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted email toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; email data is sent off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
    },
    "better-notion": {
      type: "http",
      url: `https://better-notion-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted Notion workspace toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; workspace content is sent off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
    },
    "better-telegram": {
      type: "http",
      url: `https://better-telegram-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted Telegram messaging toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; messages are sent off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
    },
    "mnemo-mcp": {
      type: "http",
      url: `https://mnemo-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted long-term memory / recall toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; stored memories are sent off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
    },
    "wet-mcp": {
      type: "http",
      url: `https://wet-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted web extraction / transform toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; fetched content is processed off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
    },
  };
}
