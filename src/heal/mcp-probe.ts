import { join } from "node:path";
import { readRegularFile } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import type { Action, PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { captured, classifyTool, type HealShared, type HealStep, versionArgv } from "./common.js";

const CHECK = "mcp: npx launcher";

/** Does this repo configure MCP servers that shell out to `npx`? */
function mcpNeedsNpx(ctx: PlanContext): { configured: boolean; usesNpx: boolean } {
  const raw = readRegularFile(join(ctx.root, ".mcp.json"))?.toString("utf8");
  if (raw === undefined) return { configured: false, usesNpx: false };
  try {
    const parsed = parseJsoncText(raw) as { mcpServers?: unknown };
    const servers = parsed.mcpServers;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      return { configured: true, usesNpx: false };
    }
    return {
      configured: true,
      usesNpx: Object.values(servers).some(
        (server) =>
          server !== null &&
          typeof server === "object" &&
          (server as { command?: unknown }).command === "npx",
      ),
    };
  } catch {
    return { configured: true, usesNpx: false };
  }
}

/**
 * MCP pre-flight — strictly read-only. It surfaces the ROOT CAUSE rather than a
 * bare "MCP failed": if `npx` can't run, was it the cert/TLS layer (fix certs) or
 * a broken npm (fix npm)? The chain reuses the shared TLS result, so it adds no
 * extra network probe.
 */
async function planMcpProbe(ctx: PlanContext, shared: HealShared): Promise<Action[]> {
  const { configured, usesNpx } = mcpNeedsNpx(ctx);

  let check: Check;
  if (!configured) {
    check = {
      name: CHECK,
      verdict: "skip",
      detail: "no .mcp.json (no MCP servers configured)",
      code: "mcp.config-missing",
    };
    return [captured(check)];
  }
  if (!usesNpx) {
    check = { name: CHECK, verdict: "skip", detail: ".mcp.json servers don't launch via npx" };
    return [captured(check)];
  }

  const res = await ctx.run(versionArgv(ctx.host.platform, "npx"));
  const npxOk = classifyTool(res, ctx.host.platform === "windows") === "ok";
  if (npxOk) {
    check = {
      name: CHECK,
      verdict: "pass",
      detail: `npx ${res.stdout.trim()} — MCP servers can launch`,
    };
  } else if (shared.tlsRegistry.verdict === "fail") {
    check = {
      name: CHECK,
      verdict: "fail",
      detail: "npx can't reach the registry — root cause: certs/TLS (heal the certs step first)",
      code: "mcp.blocked",
    };
  } else {
    check = {
      name: CHECK,
      verdict: "fail",
      detail: "npx unavailable — root cause: npm is broken (see the npm step)",
      code: "mcp.blocked",
    };
  }
  return [captured(check)];
}

export const mcpStep: HealStep = {
  key: "mcp",
  title: "MCP pre-flight",
  plan: planMcpProbe,
};
