import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import type { Action, PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { captured, type HealShared, type HealStep } from "./common.js";

const CHECK = "mcp: npx launcher";

/** Does this repo configure MCP servers that shell out to `npx`? */
function mcpNeedsNpx(ctx: PlanContext): { configured: boolean; usesNpx: boolean } {
  const raw = readIfExists(join(ctx.root, ".mcp.json"));
  if (raw === undefined) return { configured: false, usesNpx: false };
  return { configured: true, usesNpx: raw.includes("npx") };
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
    check = { name: CHECK, verdict: "skip", detail: "no .mcp.json (no MCP servers configured)" };
    return [captured(check)];
  }
  if (!usesNpx) {
    check = { name: CHECK, verdict: "skip", detail: ".mcp.json servers don't launch via npx" };
    return [captured(check)];
  }

  const res = await ctx.run(["npx", "--version"]);
  const npxOk = !res.spawnError && res.code === 0;
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
    };
  } else {
    check = {
      name: CHECK,
      verdict: "fail",
      detail: "npx unavailable — root cause: npm is broken (see the npm step)",
    };
  }
  return [captured(check)];
}

export const mcpStep: HealStep = {
  key: "mcp",
  title: "MCP pre-flight",
  plan: planMcpProbe,
};
