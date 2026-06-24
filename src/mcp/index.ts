import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { doc, plan, probe, writeJson } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { gatewayDoc } from "./gateway.js";
import { mcpServers } from "./servers.js";

/** Canonical agentgateway base URL clients are pointed at in the remote scope. */
const GATEWAY_URL = "https://agentgateway.n24q02m.com";

/** Read-only probe: is `uv` (the stdio server launcher) on PATH? Absent → skip. */
async function probeUv(ctx: PlanContext): Promise<Check> {
  const res = await ctx.run(["uv", "--version"]);
  if (res.spawnError) {
    return { name: "uv present", verdict: "skip", detail: "uv not found on PATH" };
  }
  if (res.code === 0) {
    return { name: "uv present", verdict: "pass", detail: res.stdout.trim() || "uv --version ok" };
  }
  return { name: "uv present", verdict: "fail", detail: res.stderr.trim() || `exit ${res.code}` };
}

/**
 * Plan `.mcp.json` for the requested scope, merging the enterprise server
 * blueprint into any existing user config (deep-merge preserves user-only
 * servers). For `scope === "remote"`, additionally emit the identity-aware SSO
 * gateway setup as a `doc` — that cloud guidance is text only; the harness never
 * registers an OIDC app nor contacts the gateway.
 */
function planMcp(ctx: PlanContext): ReturnType<typeof plan> {
  const scope = String(ctx.options.scope ?? "project");
  const actions: Action[] = [
    writeJson(
      ".mcp.json",
      { mcpServers: mcpServers() },
      `Configure enterprise MCP servers (${scope} scope), merging into any existing .mcp.json`,
      { merge: true },
    ),
  ];

  if (scope === "remote") {
    actions.push(
      doc(
        "Identity-aware MCP gateway + SSO (Entra/Okta OIDC, tool-level RBAC) — run by hand, not contacted",
        gatewayDoc(GATEWAY_URL),
      ),
    );
  }

  actions.push(probe("uv present", probeUv));

  return plan("mcp", ...actions);
}

export const command: CommandSpec = {
  name: "mcp",
  summary: "Generate .mcp.json for local/project/remote MCP scopes and document the SSO gateway",
  options: [
    {
      flags: "--scope <scope>",
      description: "server scope: local|project|remote",
      default: "project",
    },
  ],
  plan: planMcp,
};
