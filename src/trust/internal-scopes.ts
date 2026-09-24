import type { PlanContext } from "../internals/plan.js";
import { OrgPolicyError, readOrgPolicy } from "../org-policy/schema.js";

// The organization's internal npm scopes: Core's policy input to Scan's trust
// lint (`detectorOptions.internalScopes`), which decides dependency confusion
// against them. Sources: `AIH_TRUST_INTERNAL_SCOPES` (comma-separated) and the
// org policy's `trust.internalScopes`. Each is trimmed, `@`-prefixed and
// lowercased; the result is deduplicated and sorted, the normalized form Scan
// requires. A malformed scope is not repaired here: the org-policy schema
// rejects it, and Scan refuses one that arrives through the environment.

function normalizeScope(scope: string): string | undefined {
  const trimmed = scope.trim();
  if (trimmed.length === 0) return undefined;
  const prefixed = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  return prefixed.toLowerCase();
}

function addScopes(scopes: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    const normalized = normalizeScope(value);
    if (normalized !== undefined) scopes.add(normalized);
  }
}

export function resolveInternalScopes(
  ctx: Pick<PlanContext, "env"> & Partial<Pick<PlanContext, "root">>,
): string[] {
  const scopes = new Set<string>();
  addScopes(scopes, (ctx.env.AIH_TRUST_INTERNAL_SCOPES ?? "").split(","));
  if (ctx.root !== undefined) {
    try {
      addScopes(scopes, readOrgPolicy(ctx.root, ctx.env)?.trust?.internalScopes ?? []);
    } catch (error) {
      if (!(error instanceof OrgPolicyError)) throw error;
    }
  }
  return [...scopes].sort((a, b) => a.localeCompare(b));
}
