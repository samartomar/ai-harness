import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import {
  normalizeHttpsOrigin,
  type OrgPolicy,
  parseOrgPolicy,
  readOrgPolicy,
} from "../org-policy/schema.js";
import { type RepoStack, scanRepo } from "../profile/scan.js";
import {
  DEFAULT_GITHUB_MCP_URL,
  type GithubMcpAuth,
  type McpServer,
  mcpServers,
} from "./servers.js";

export interface PolicyAwareMcpCatalog {
  policy?: OrgPolicy;
  servers?: Record<string, McpServer>;
  githubHost?: string;
  error?: unknown;
  errorSource?: "org-policy" | "catalog";
}

export function readMcpOrgPolicy(ctx: PlanContext): { policy?: OrgPolicy; error?: unknown } {
  try {
    return { policy: readOrgPolicy(ctx.root, ctx.env) };
  } catch (error) {
    return { error };
  }
}

function readRootMcpOrgPolicy(ctx: PlanContext): { policy?: OrgPolicy; error?: unknown } {
  try {
    const raw = readIfExists(join(ctx.root, AIH_ORG_POLICY_FILE));
    if (raw === undefined) return {};
    return { policy: parseOrgPolicy(JSON.parse(raw)) };
  } catch (error) {
    return { error };
  }
}

function tokenHostPolicy(
  ctx: PlanContext,
  active: { policy?: OrgPolicy },
): {
  policy?: OrgPolicy;
  error?: unknown;
} {
  if ((ctx.env.AIH_ORG_POLICY ?? "").trim().length === 0) return active;
  return readRootMcpOrgPolicy(ctx);
}

export function configuredGitHubHost(
  ctx: PlanContext,
  policy: OrgPolicy | undefined,
): string | undefined {
  const policyHost = policy?.mcp?.githubHost;
  if (policyHost !== undefined) return policyHost;
  const envHost = ctx.env.GITHUB_HOST;
  if (envHost === undefined || envHost.length === 0) return undefined;
  return normalizeHttpsOrigin(envHost, "GITHUB_HOST");
}

function githubHostName(githubHost: string | undefined): string {
  return new URL(githubHost ?? DEFAULT_GITHUB_MCP_URL).host.toLowerCase();
}

export function githubIsIncumbent(
  policy: OrgPolicy | undefined,
  githubHost: string | undefined,
): boolean {
  if (policy === undefined) return githubHostName(githubHost) === githubHostName(undefined);
  const incumbentHosts = new Set(policy.mcp?.incumbentHosts ?? []);
  return incumbentHosts.has(githubHostName(githubHost));
}

function configuredGitHubHostForAuth(
  ctx: PlanContext,
  policy: OrgPolicy | undefined,
  auth: GithubMcpAuth,
): string | undefined {
  if (auth !== "token") return configuredGitHubHost(ctx, policy);
  const policyHost = policy?.mcp?.githubHost;
  if (policyHost !== undefined && githubIsIncumbent(policy, policyHost)) return policyHost;
  return undefined;
}

export function removeDisabledServers(
  servers: Record<string, McpServer>,
  policy: OrgPolicy | undefined,
): Record<string, McpServer> {
  const disabled = new Set(policy?.mcp?.disabledServers ?? []);
  if (disabled.size === 0) return servers;
  return Object.fromEntries(Object.entries(servers).filter(([name]) => !disabled.has(name)));
}

export function policyAwareMcpCatalog(
  ctx: PlanContext,
  opts: {
    scope: string;
    selfHost?: boolean;
    githubAuth?: GithubMcpAuth;
    stack?: RepoStack;
    includeHostedGitHub?: boolean;
    includeDisabledServers?: boolean;
  },
): PolicyAwareMcpCatalog {
  const policyResult = readMcpOrgPolicy(ctx);
  if (policyResult.error !== undefined) {
    return { error: policyResult.error, errorSource: "org-policy" };
  }
  try {
    const stack = opts.stack ?? scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
    const includeDisabled = opts.includeDisabledServers === true;
    const githubDisabled = policyResult.policy?.mcp?.disabledServers?.includes("github") ?? false;
    const hostedGithub =
      opts.selfHost !== true &&
      opts.includeHostedGitHub !== false &&
      (includeDisabled || !githubDisabled);
    const githubAuth = opts.githubAuth ?? "oauth";
    const hostPolicyResult =
      githubAuth === "token" ? tokenHostPolicy(ctx, policyResult) : policyResult;
    if (hostPolicyResult.error !== undefined) {
      return {
        policy: policyResult.policy,
        error: hostPolicyResult.error,
        errorSource: "org-policy",
      };
    }
    const githubHost =
      hostedGithub && !githubDisabled
        ? configuredGitHubHostForAuth(ctx, hostPolicyResult.policy, githubAuth)
        : undefined;
    const rawServers = mcpServers(opts.scope, stack, {
      selfHost: opts.selfHost,
      githubAuth,
      githubHost,
      githubIncumbent: hostedGithub
        ? githubIsIncumbent(policyResult.policy, githubHost)
        : undefined,
    });
    const servers = includeDisabled
      ? rawServers
      : removeDisabledServers(rawServers, policyResult.policy);
    return { policy: policyResult.policy, servers, githubHost };
  } catch (error) {
    return { policy: policyResult.policy, error, errorSource: "catalog" };
  }
}
