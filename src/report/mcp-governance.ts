import type { Posture } from "../config/posture.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { policyAwareMcpCatalog } from "../mcp/catalog.js";
import { evaluateMcpPolicy } from "../mcp/policy.js";
import { mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";

export interface McpGovernanceSummary {
  posture: Posture;
  denied: { name: string; reason: string }[];
  warned: { name: string; reason: string }[];
  allowed: string[];
  counts: { denied: number; warned: number; allowed: number };
}

/** Shared MCP governance spine: one catalog scan and policy engine for every report consumer. */
export function mcpGovernanceSummary(
  ctx: PlanContext,
  posture: Posture = "enterprise",
): McpGovernanceSummary {
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const catalog = policyAwareMcpCatalog(ctx, { scope: "project", stack });
  const policies = evaluateMcpPolicy(catalog.servers ?? mcpServers("project", stack), posture);
  const denied = policies.filter((p) => p.verdict === "deny");
  const warned = policies.filter((p) => p.verdict === "warn");
  const allowed = policies.filter((p) => p.verdict === "allow");
  return {
    posture,
    denied: denied.map((p) => ({ name: p.name, reason: p.reason })),
    warned: warned.map((p) => ({ name: p.name, reason: p.reason })),
    allowed: allowed.map((p) => p.name),
    counts: { denied: denied.length, warned: warned.length, allowed: allowed.length },
  };
}

/**
 * MCP governance panel — aih's curated server set (at project scope) judged under the
 * ENTERPRISE posture, the strict gate, so a reviewer sees at a glance what an
 * enterprise rollout would flag. Reuses the policy engine ({@link evaluateMcpPolicy}):
 * reads only the risk axes, contacts nothing. The community default blocks nothing —
 * aih REPORTS these verdicts, it never silently drops a server from `.mcp.json`. This
 * is the "would it survive enterprise friction?" answer in the local dashboard.
 *
 * Renders as a clean note panel (HTML) / fenced section (markdown) today; the planned
 * report v4 restyle reuses this digest's `data`, so building it now is forward-safe.
 */
export function mcpGovernanceDigest(ctx: PlanContext): DigestAction {
  const summary = mcpGovernanceSummary(ctx, "enterprise");
  const body = lines(
    "aih's curated MCP set, judged under the ENTERPRISE posture (the strict gate) so you",
    "can see what an enterprise rollout would flag. The community default blocks nothing;",
    "aih reports these verdicts, it never silently drops a server from .mcp.json.",
    "",
    `  ${summary.counts.denied} denied · ${summary.counts.warned} warn · ${summary.counts.allowed} allowed`,
    "",
    ...(summary.denied.length > 0
      ? [
          "Denied — self-host, pin, or remove before an enterprise rollout:",
          ...summary.denied.map((p) => `  ✗ ${p.name} — ${p.reason}`),
          "",
        ]
      : []),
    ...(summary.warned.length > 0
      ? [
          "Warn — allowed, but review:",
          ...summary.warned.map((p) => `  ! ${p.name} — ${p.reason}`),
          "",
        ]
      : []),
    `Allowed: ${summary.allowed.join(", ") || "(none)"}`,
  );
  return digest(
    `MCP governance — ${summary.counts.allowed} allowed · ${summary.counts.warned} warn · ${summary.counts.denied} denied (enterprise posture)`,
    body,
    summary,
  );
}
