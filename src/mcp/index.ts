import { posix } from "node:path";
import { resolveTargets } from "../internals/cli-detect.js";
import { type CliEntry, entry } from "../internals/cli-registry.js";
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
import { type McpServer, mcpServers } from "./servers.js";

/** Commands that resolve/download a package at runtime — unsafe for a true air-gap. */
const NETWORK_RESOLVERS = new Set(["npx", "uvx", "uv", "bunx", "pnpm", "yarn", "pipx"]);

/**
 * Offline-mode verify probe: fail if any generated stdio server launches through a
 * network package resolver. `--mode offline` promises no runtime download, so an
 * unvendored `npx`/`uvx` launcher is a real gap an operator must close (mirror the
 * package, or pin an absolute vendored command) before air-gapping.
 */
function offlineVendoredProbe(stdio: Record<string, McpServer>): Check {
  const runtime = Object.entries(stdio)
    .filter(([, s]) => s.type === "stdio" && NETWORK_RESOLVERS.has(s.command))
    .map(([name, s]) => `${name} (${s.type === "stdio" ? s.command : ""})`);
  const name = "offline MCP servers are vendored";
  if (runtime.length === 0) {
    return { name, verdict: "pass", detail: "no runtime package resolvers in the generated set" };
  }
  return {
    name,
    verdict: "fail",
    detail: `still resolve packages at runtime — mirror/vendor or pin an absolute command before air-gapping: ${runtime.join(", ")}`,
    code: "mcp.unvendored-offline",
  };
}

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
    return {
      name: "uv present",
      verdict: "skip",
      detail: "uv not found on PATH",
      code: "mcp.uv-missing",
    };
  }
  if (res.code === 0) {
    return { name: "uv present", verdict: "pass", detail: res.stdout.trim() || "uv --version ok" };
  }
  return {
    name: "uv present",
    verdict: "fail",
    detail: res.stderr.trim() || `exit ${res.code}`,
    code: "mcp.uv-missing",
  };
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
      "local stdio MCP servers (offline) — mirror/vendor these; some still resolve packages at runtime until vendored (see the offline verify probe)",
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
    probe("offline MCP servers are vendored", () => offlineVendoredProbe(stdio)),
    probe("uv present", probeUv),
  );
}

/**
 * Guidance for a CLI whose MCP config aih does NOT write directly — it uses TOML,
 * a global/home path, or a different server-object shape than aih's standard
 * `mcpServers` set. Rather than write a file it would get wrong, aih names the
 * exact location + key and lists the servers to add in the tool's native shape.
 */
function mcpGuidanceDoc(e: CliEntry, serverNames: string[]): string {
  const p = e.mcp;
  return [
    `${e.label} reads MCP servers from \`${p.configPath}\` (${p.configFormat}, top-level key \`${p.configKey}\`).`,
    "aih does not write this file directly (different format / key / shape, or a global path),",
    "so add these servers there in the tool's native shape — see the generated `.mcp.json`",
    "for the canonical command/args of each:",
    "",
    ...serverNames.map((n) => `  • ${n}`),
    "",
    p.configFormat === "toml"
      ? `In TOML, each server is a \`[${p.configKey}.<name>]\` table.`
      : `Copy each entry from \`.mcp.json\` and place it under the \`${p.configKey}\` key.`,
  ].join("\n");
}

async function planMcp(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const mode = String(ctx.options.mode ?? "standard");
  if (mode === "none") return planMcpNone(ctx);
  if (mode === "offline") return planMcpOffline(ctx);

  // Honor --cli/--all-tools/--detect (default: claude). Previously mcp ignored the
  // selection and wrote Claude's `.mcp.json` for every tool — a real bug for Codex
  // (config.toml), Copilot (.vscode/mcp.json), OpenCode, Zed, etc.
  const { clis } = await resolveTargets(ctx);
  const scope = String(ctx.options.scope ?? "project");
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const servers = mcpServers(scope, stack);
  const serverNames = Object.keys(servers);
  const tailored = serverNames
    .filter(
      (name) =>
        name !== "code-review-graph" &&
        !name.startsWith("better-") &&
        name !== "mnemo-mcp" &&
        name !== "wet-mcp",
    )
    .join(", ");

  const actions: Action[] = [];
  const writtenPaths = new Set<string>();
  for (const cli of clis) {
    const e = entry(cli);
    const p = e.mcp;
    if (p.support === "absent" || !p.configPath) {
      actions.push(
        doc(
          `${e.label}: no MCP config`,
          `${e.label} exposes no MCP server config (use the CLI-tool fallback).`,
        ),
      );
      continue;
    }
    if (p.support === "native" && p.configKey) {
      if (writtenPaths.has(p.configPath)) continue; // tools sharing a path (claude + kimi → .mcp.json)
      writtenPaths.add(p.configPath);
      // Preserve the exact `.mcp.json` describe (golden) for the standard path.
      const describe =
        p.configPath === ".mcp.json"
          ? scope === "remote"
            ? "Configure project-aware servers + the opt-in hosted enterprise toolset (remote scope), merged into any existing .mcp.json"
            : `Configure project-aware MCP servers (${scope} scope)${tailored ? ` — ${tailored}` : ""}, merged into any existing .mcp.json`
          : `${e.label} MCP servers (${scope} scope) → ${p.configPath}, merged into any existing`;
      actions.push(writeJson(p.configPath, { [p.configKey]: servers }, describe, { merge: true }));
    } else {
      actions.push(
        doc(
          `Configure MCP for ${e.label} (${p.configFormat}, ${p.configPath})`,
          mcpGuidanceDoc(e, serverNames),
        ),
      );
    }
  }

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
