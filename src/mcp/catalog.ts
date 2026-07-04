import type { PlanContext } from "../internals/plan.js";
import { normalizeHttpsOrigin, type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import { type RepoStack, scanRepo } from "../profile/scan.js";
import { DEFAULT_GITHUB_MCP_URL, type McpServer, mcpServers } from "./servers.js";

export interface PolicyAwareMcpCatalog {
  policy?: OrgPolicy;
  servers?: Record<string, McpServer>;
  githubHost?: string;
  error?: unknown;
}

export function readMcpOrgPolicy(ctx: PlanContext): { policy?: OrgPolicy; error?: unknown } {
  try {
    return { policy: readOrgPolicy(ctx.root, ctx.env) };
  } catch (error) {
    return { error };
  }
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
    stack?: RepoStack;
    includeHostedGitHub?: boolean;
    includeDisabledServers?: boolean;
  },
): PolicyAwareMcpCatalog {
  const policyResult = readMcpOrgPolicy(ctx);
  if (policyResult.error !== undefined) return { error: policyResult.error };
  try {
    const stack = opts.stack ?? scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
    const includeDisabled = opts.includeDisabledServers === true;
    const githubDisabled = policyResult.policy?.mcp?.disabledServers?.includes("github") ?? false;
    const hostedGithub =
      opts.selfHost !== true &&
      opts.includeHostedGitHub !== false &&
      (includeDisabled || !githubDisabled);
    const githubHost = hostedGithub ? configuredGitHubHost(ctx, policyResult.policy) : undefined;
    const rawServers = mcpServers(opts.scope, stack, {
      selfHost: opts.selfHost,
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
    return { policy: policyResult.policy, error };
  }
}
