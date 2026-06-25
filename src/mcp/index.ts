import { posix } from "node:path";
import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { doc, plan, probe, writeJson, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { scanRepo } from "../profile/scan.js";
import {
  enterpriseMcpDoc,
  managedMcpExample,
  mcpFallbackSteering,
  stdioServers,
} from "./enterprise.js";
import { gatewayDoc } from "./gateway.js";
import { mcpServers } from "./servers.js";

/** Canonical agentgateway base URL clients are pointed at in the remote scope. */
const GATEWAY_URL = "https://agentgateway.n24q02m.com";

/** Honest DB-server guidance (datastore MCP packages vary, so we suggest, not pin). */
function dbMcpNote(databases: string[]): string {
  return [
    `This repo uses ${databases.join(", ")}. Database MCP servers vary by vendor and`,
    "change often, so aih does not pin one into .mcp.json. Add the one you trust:",
    "",
    "  PostgreSQL — crystaldba/postgres-mcp, or an official pg MCP server",
    "  MongoDB    — mongodb-js/mongodb-mcp-server",
    "  Redis      — redis/mcp-redis",
    "  DynamoDB   — awslabs/mcp (the dynamodb server)",
    "",
    "Configure it under mcpServers with a READ-ONLY connection string sourced from env.",
  ].join("\n");
}

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
/**
 * Enterprise-blocked MCP (`--mode none`): emit no live servers + a CLI-tool
 * fallback (the agent keeps each capability without the MCP wrapper), plus the
 * admin `managed-mcp.json` template that disables MCP org-wide.
 */
function planMcpNone(ctx: PlanContext): ReturnType<typeof plan> {
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  return plan(
    "mcp",
    writeText(
      posix.join(ctx.contextDir, "mcp-fallback.md"),
      mcpFallbackSteering(stack),
      "no-MCP fallback: the CLI tool for each MCP capability",
    ),
    writeJson(
      "managed-mcp.json.example",
      managedMcpExample({}),
      "org admin: managed-mcp.json that DISABLES all MCP (deploy to the system path)",
    ),
    doc("enterprise MCP control (disabled — agent uses CLI tools)", enterpriseMcpDoc("none", {})),
  );
}

/**
 * Egress-blocked but spawn-allowed (`--mode offline`): keep only local stdio
 * servers (drop http/remote that need egress) for vendoring by exact command, and
 * emit the admin fixed-set template + the allowlist playbook.
 */
function planMcpOffline(ctx: PlanContext): ReturnType<typeof plan> {
  const scope = String(ctx.options.scope ?? "project");
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const stdio = stdioServers(mcpServers(scope, stack));
  return plan(
    "mcp",
    writeJson(
      ".mcp.json",
      { mcpServers: stdio },
      "local stdio MCP servers (offline) — vendor them; no runtime download",
      { merge: true },
    ),
    writeJson(
      "managed-mcp.json.example",
      managedMcpExample(stdio),
      "org admin: fixed approved MCP set (deploy to the system path)",
    ),
    writeText(
      posix.join(ctx.contextDir, "mcp-fallback.md"),
      mcpFallbackSteering(stack),
      "CLI fallback for when even local MCP is blocked",
    ),
    doc("enterprise MCP control (offline / vendored)", enterpriseMcpDoc("offline", stdio)),
    probe("uv present", probeUv),
  );
}

function planMcp(ctx: PlanContext): ReturnType<typeof plan> {
  const mode = String(ctx.options.mode ?? "standard");
  if (mode === "none") return planMcpNone(ctx);
  if (mode === "offline") return planMcpOffline(ctx);

  const scope = String(ctx.options.scope ?? "project");
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const servers = mcpServers(scope, stack);
  const tailored = Object.keys(servers)
    .filter(
      (name) =>
        name !== "better-code-review-graph" &&
        !name.startsWith("better-") &&
        name !== "mnemo-mcp" &&
        name !== "wet-mcp",
    )
    .join(", ");
  const describe =
    scope === "remote"
      ? "Configure project-aware servers + the opt-in hosted enterprise toolset (remote scope), merged into any existing .mcp.json"
      : `Configure project-aware MCP servers (${scope} scope)${tailored ? ` — ${tailored}` : ""}, merged into any existing .mcp.json`;

  const actions: Action[] = [
    writeJson(".mcp.json", { mcpServers: servers }, describe, { merge: true }),
  ];

  if (scope === "remote") {
    const hosted = Object.entries(servers)
      .filter(([, s]) => s.classification === "third-party-hosted")
      .map(([name]) => name);
    actions.push(
      doc(
        "Identity-aware MCP gateway + SSO (Entra/Okta OIDC, tool-level RBAC) — run by hand, not contacted",
        gatewayDoc(GATEWAY_URL, hosted),
      ),
    );
  }

  // Datastore servers vary by vendor — suggest (don't pin) when a DB is detected.
  if (stack.databases.length > 0) {
    actions.push(
      doc(
        `Add a database MCP server (${stack.databases.join(", ")} detected)`,
        dbMcpNote(stack.databases),
      ),
    );
  }

  actions.push(probe("uv present", probeUv));

  return plan("mcp", ...actions);
}

export const command: CommandSpec = {
  name: "mcp",
  summary:
    "Generate .mcp.json (scopes) or enterprise-blocked MCP fallback (--mode offline|none) + managed-mcp template",
  options: [
    {
      flags: "--scope <scope>",
      description: "server scope: local|project|remote",
      default: "project",
    },
    {
      flags: "--mode <mode>",
      description:
        "standard | offline (vendored local-command servers) | none (no MCP; CLI-tool fallback)",
      default: "standard",
    },
  ],
  plan: planMcp,
};
