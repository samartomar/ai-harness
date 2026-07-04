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
  opts: { scope: string; selfHost?: boolean; stack?: RepoStack },
): PolicyAwareMcpCatalog {
  const policyResult = readMcpOrgPolicy(ctx);
  if (policyResult.error !== undefined) return { error: policyResult.error };
  try {
    const stack = opts.stack ?? scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
    const githubHost = configuredGitHubHost(ctx, policyResult.policy);
    const servers = removeDisabledServers(
      mcpServers(opts.scope, stack, {
        selfHost: opts.selfHost,
        githubHost,
        githubIncumbent: githubIsIncumbent(policyResult.policy, githubHost),
      }),
      policyResult.policy,
    );
    return { policy: policyResult.policy, servers, githubHost };
  } catch (error) {
    return { policy: policyResult.policy, error };
  }
}
