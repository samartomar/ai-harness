import type { RepoStack } from "../profile/scan.js";

/**
 * The `.mcp.json` server set is assembled from the DETECTED stack, not a fixed
 * boilerplate list:
 *  - `code-review-graph` + `codebase-memory-mcp` + `sequential-thinking` (local, stdio) —
 *    code intelligence (impact/blast radius), codebase memory (search/trace/ADR), and
 *    structured reasoning; useful in any repo, zero egress, zero credentials;
 *  - `github` + `context7` — on-by-default remote servers (GitHub via the client's
 *    OAuth by default, or an env-sourced token header when requested; Context7 hosted docs). Each names its
 *    egress in its own description so it is visible in `.mcp.json` at a glance;
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
 * Kept for back-compat and at-a-glance reading; the finer axes below
 * (egress / credentials / supplyChain) are what policy, drift, and the report read.
 */
export type McpClassification = "local" | "third-party-hosted";

/**
 * Where the server sends your data — the axis enterprises actually gate on:
 *  - `none`             — no network egress (pure local compute).
 *  - `local-only`       — runs locally; any network is user-directed (e.g. a browser
 *                         it drives), not a fixed backend it reports to.
 *  - `vendor-incumbent` — a specific vendor backend orgs typically already trust
 *                         (GitHub, the user's own AWS account).
 *  - `third-party`      — a non-incumbent vendor backend; needs explicit vetting.
 */
export type McpEgress = "none" | "local-only" | "vendor-incumbent" | "third-party";

/**
 * What the server needs to authenticate — so a reviewer knows whether a secret is
 * involved and where it lives:
 *  - `none`  — no credential required.
 *  - `oauth` — interactive OAuth handled by the client; NO secret is written here.
 *  - `token` — a token / API key, sourced from env, never hardcoded into config.
 */
export type McpCredentials = "none" | "oauth" | "token";

/**
 * How the server's code is sourced — the supply-chain surface:
 *  - `pinned`        — a pinned package version launched locally (reproducible).
 *  - `unpinned`      — a floating / `@latest` launch (aih's own set never uses this).
 *  - `hosted-remote` — code runs on the vendor's infrastructure (an HTTP endpoint).
 */
export type McpSupplyChain = "pinned" | "unpinned" | "hosted-remote";

/** Risk axes every server entry carries (see the per-type docs above). */
interface McpRisk {
  classification: McpClassification;
  egress: McpEgress;
  credentials: McpCredentials;
  supplyChain: McpSupplyChain;
}

export interface StdioServer extends McpRisk {
  type: "stdio";
  command: string;
  args: string[];
  description: string;
  /** Process environment for the launched server. Values must be ${ENV} refs, never literals. */
  env?: Readonly<Record<string, string>>;
}
export interface HttpServer extends McpRisk {
  type: "http";
  url: string;
  description: string;
  /** HTTP headers for clients that support them. Values must be env refs, never literals. */
  headers?: Readonly<Record<string, string>>;
}
export type McpServer = StdioServer | HttpServer;

/** Base host for the n24q02m hosted enterprise toolset. */
export const N24Q02M_HOST = "n24q02m.com";

/** Frameworks that warrant a browser-automation (Playwright) MCP server. */
const WEB_FRAMEWORKS = new Set(["Next.js", "React", "Vue", "Svelte", "Angular"]);

/** Pinned GitHub MCP Docker image for the `--self-host` opt-out (bump deliberately). */
const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server:v1.5.0";

/** Hosted GitHub MCP endpoint used when no org-specific host is configured. */
export const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

export type GithubMcpAuth = "oauth" | "token";

/** Options that tune the GitHub catalog entry from committed org policy. */
export interface McpServersOptions {
  selfHost?: boolean;
  githubAuth?: GithubMcpAuth;
  githubHost?: string;
  githubIncumbent?: boolean;
}

function githubMcpUrl(host: string | undefined): string {
  if (host === undefined) return DEFAULT_GITHUB_MCP_URL;
  return `${host}/mcp/`;
}

/**
 * Build the `mcpServers` map for `scope`, tailored to `stack`. Deterministic
 * insertion order (local stdio first, then stack-specific, then on-by-default
 * remote, then the opt-in hosted set) so golden assertions and deep-merge output
 * stay stable.
 */
export function mcpServers(
  scope: string,
  stack: RepoStack,
  opts: McpServersOptions = {},
): Record<string, McpServer> {
  const servers: Record<string, McpServer> = {
    "code-review-graph": {
      type: "stdio",
      command: "uvx",
      // Pinned (not @latest) for reproducible installs; bump deliberately. `uvx`
      // runs offline so locked-down sandboxes never fetch while starting the MCP.
      args: [
        "--offline",
        "--no-python-downloads",
        "--no-env-file",
        "code-review-graph@2.3.6",
        "serve",
      ],
      description:
        "Local code-review knowledge graph (impact radius, affected flows) served over stdio via uvx.",
      classification: "local",
      egress: "none",
      credentials: "none",
      supplyChain: "pinned",
    },
    "codebase-memory-mcp": {
      type: "stdio",
      command: "uvx",
      // Pinned (not @latest); bump deliberately. Bare invocation runs the stdio MCP
      // server. Keep uvx offline/no-env so locked-down sandboxes never fetch or read
      // project .env files while starting the local memory companion.
      args: ["--offline", "--no-python-downloads", "--no-env-file", "codebase-memory-mcp@0.8.1"],
      description:
        "Local codebase memory/knowledge graph (index_repository, search_graph, query_graph, trace_path) — memory companion to code-review-graph, served over stdio via uvx.",
      classification: "local",
      egress: "none",
      credentials: "none",
      supplyChain: "pinned",
    },
    "sequential-thinking": {
      type: "stdio",
      command: "npx",
      // Pinned (not @latest) for reproducible installs; bump deliberately.
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.12.18"],
      description:
        "Structured step-by-step reasoning scratchpad — no network, no filesystem, no credentials. Safe in any repo.",
      classification: "local",
      egress: "none",
      credentials: "none",
      supplyChain: "pinned",
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
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
    };
  }
  if (stack.frameworks.some((f) => WEB_FRAMEWORKS.has(f))) {
    servers.playwright = {
      type: "stdio",
      command: "npx",
      // Pinned (not @latest) for reproducible installs; bump deliberately.
      args: ["@playwright/mcp@0.0.76"],
      description:
        "Playwright browser automation MCP (navigate, snapshot, interact). Added for a web frontend. The browser it drives can reach any URL — point it at trusted origins.",
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
    };
  }

  // On-by-default, secret-free remote servers — useful in any repo. GitHub defaults to
  // the client's interactive OAuth (no token written into this file); `--self-host`
  // swaps it for the pinned local Docker image with the PAT sourced from env (the
  // air-gap / no-hosted-endpoint opt-out). Context7 is a hosted docs endpoint whose
  // third-party egress is named in its description. Enterprise policy can filter these;
  // the default posture is on + clearly labeled.
  const githubAuth = opts.githubAuth ?? "oauth";
  servers.github = opts.selfHost
    ? {
        type: "stdio",
        command: "docker",
        args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", GITHUB_MCP_IMAGE],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${ENV} reference is the literal config value, not a template
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
        description:
          "GitHub's official MCP via the pinned local Docker image (self-host opt-out of the hosted endpoint). PAT sourced from $GITHUB_PERSONAL_ACCESS_TOKEN — never written here.",
        classification: "local",
        egress: "vendor-incumbent",
        credentials: "token",
        supplyChain: "pinned",
      }
    : {
        type: "http",
        url: githubMcpUrl(opts.githubHost),
        description:
          githubAuth === "token"
            ? "GitHub's official remote MCP (repos, issues, PRs, Actions). Token auth via Authorization header sourced from $GITHUB_PERSONAL_ACCESS_TOKEN — never written here."
            : opts.githubIncumbent === false
              ? "GitHub's official remote MCP (repos, issues, PRs, Actions). OAuth via the client — no token stored in this file. Egress to GitHub, but this org policy has not declared that host incumbent/reachable."
              : "GitHub's official remote MCP (repos, issues, PRs, Actions). OAuth via the client — no token stored in this file. Egress to GitHub (vendor-incumbent).",
        ...(githubAuth === "token"
          ? {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: ${ENV} reference is the literal config value, not a template
              headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
            }
          : {}),
        classification: "third-party-hosted",
        egress: opts.githubIncumbent === false ? "third-party" : "vendor-incumbent",
        credentials: githubAuth,
        supplyChain: "hosted-remote",
      };
  servers.context7 = {
    type: "http",
    url: "https://mcp.context7.com/mcp",
    description:
      "Up-to-date, version-matched library docs. THIRD-PARTY hosted endpoint (Upstash) — your queries leave the host; an optional CONTEXT7_API_KEY raises rate limits. Self-host or fall back to vendor docs where third-party egress is disallowed.",
    classification: "third-party-hosted",
    egress: "third-party",
    credentials: "none",
    supplyChain: "hosted-remote",
  };

  if (scope === "remote") Object.assign(servers, hostedServers());
  return servers;
}

/**
 * The unique `${VAR}` names referenced by any server's `env` block — the secrets a
 * user must supply out-of-band. Drives `.env.example` generation so the placeholders
 * are documented without ever writing a value. Only `${VAR}` refs count (a literal
 * would be a hardcoded secret — see the `aih secrets` MCP-config scan).
 */
export function envPlaceholders(servers: Record<string, McpServer>): string[] {
  const vars = new Set<string>();
  const collect = (value: string): void => {
    for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (m[1]) vars.add(m[1]);
    }
  };
  for (const s of Object.values(servers)) {
    if (s.type === "stdio" && s.env) for (const value of Object.values(s.env)) collect(value);
    if (s.type === "http" && s.headers)
      for (const value of Object.values(s.headers)) collect(value);
  }
  return [...vars].sort();
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
      egress: "third-party",
      credentials: "oauth",
      supplyChain: "hosted-remote",
    },
    "better-notion": {
      type: "http",
      url: `https://better-notion-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted Notion workspace toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; workspace content is sent off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
      egress: "third-party",
      credentials: "oauth",
      supplyChain: "hosted-remote",
    },
    "better-telegram": {
      type: "http",
      url: `https://better-telegram-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted Telegram messaging toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; messages are sent off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
      egress: "third-party",
      credentials: "oauth",
      supplyChain: "hosted-remote",
    },
    "mnemo-mcp": {
      type: "http",
      url: `https://mnemo-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted long-term memory / recall toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; stored memories are sent off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
      egress: "third-party",
      credentials: "oauth",
      supplyChain: "hosted-remote",
    },
    "wet-mcp": {
      type: "http",
      url: `https://wet-mcp.${N24Q02M_HOST}/mcp`,
      description: `Hosted web extraction / transform toolset — THIRD-PARTY endpoint at ${N24Q02M_HOST}; fetched content is processed off-host. Vet vendor risk before enabling.`,
      classification: "third-party-hosted",
      egress: "third-party",
      credentials: "oauth",
      supplyChain: "hosted-remote",
    },
  };
}
