import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { evaluateMcpPolicy } from "../mcp/policy.js";
import { mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";

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
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const policies = evaluateMcpPolicy(mcpServers("project", stack), "enterprise");
  const denied = policies.filter((p) => p.verdict === "deny");
  const warned = policies.filter((p) => p.verdict === "warn");
  const allowed = policies.filter((p) => p.verdict === "allow");
  const body = lines(
    "aih's curated MCP set, judged under the ENTERPRISE posture (the strict gate) so you",
    "can see what an enterprise rollout would flag. The community default blocks nothing;",
    "aih reports these verdicts, it never silently drops a server from .mcp.json.",
    "",
    `  ${denied.length} denied · ${warned.length} warn · ${allowed.length} allowed`,
    "",
    ...(denied.length > 0
      ? [
          "Denied — self-host, pin, or remove before an enterprise rollout:",
          ...denied.map((p) => `  ✗ ${p.name} — ${p.reason}`),
          "",
        ]
      : []),
    ...(warned.length > 0
      ? ["Warn — allowed, but review:", ...warned.map((p) => `  ! ${p.name} — ${p.reason}`), ""]
      : []),
    `Allowed: ${allowed.map((p) => p.name).join(", ") || "(none)"}`,
  );
  return digest(
    `MCP governance — ${allowed.length} allowed · ${warned.length} warn · ${denied.length} denied (enterprise posture)`,
    body,
    {
      posture: "enterprise",
      denied: denied.map((p) => ({ name: p.name, reason: p.reason })),
      warned: warned.map((p) => ({ name: p.name, reason: p.reason })),
      allowed: allowed.map((p) => p.name),
      counts: { denied: denied.length, warned: warned.length, allowed: allowed.length },
    },
  );
}
