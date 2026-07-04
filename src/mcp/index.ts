import { join, posix } from "node:path";
import { homeDir, resolveTargets } from "../internals/cli-detect.js";
import { type CliEntry, entry } from "../internals/cli-registry.js";
import { upsertTextBlock } from "../internals/envfile.js";
import { readIfExists } from "../internals/fsxn.js";
import type { Action, CommandSpec, PlanContext, ProbeAction } from "../internals/plan.js";
import { doc, plan, probe, writeJson, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import { scanRepo } from "../profile/scan.js";
import { managedMcpAllowlistSettings } from "./allowlist.js";
import {
  enterpriseMcpDoc,
  managedMcpExample,
  mcpFallbackSteering,
  stdioServers,
} from "./enterprise.js";
import { gatewayDoc, gatewayRbacConfig } from "./gateway.js";
import {
  asPosture,
  deniedServers,
  evaluateMcpPolicy,
  type McpPosture,
  mcpGovernanceDoc,
} from "./policy.js";
import {
  existingMcpTomlNames,
  isExternalMcp,
  mcpConfigAbs,
  mcpEntries,
  mcpTomlBody,
} from "./render.js";
import {
  DEFAULT_GITHUB_MCP_URL,
  envPlaceholders,
  type McpServer,
  mcpServers,
  N24Q02M_HOST,
} from "./servers.js";

/** The aih-managed block scope used for Codex's TOML `[mcp_servers.*]` region. */
const MCP_TOML_SCOPE = "mcp";

/** The aih-managed block scope for the generated `.env.example`. */
const MCP_ENV_SCOPE = "mcp-env";

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

/**
 * Enterprise-posture verify probe: fail if the catalog (at this scope) contains any
 * server the enterprise policy denies — third-party egress or an unpinned supply
 * chain. Mirrors {@link offlineVendoredProbe}: aih surfaces the gap and names the fix
 * (self-host / pin / remove) instead of silently dropping the server.
 */
function mcpPolicyProbe(servers: Record<string, McpServer>, posture: McpPosture): Check {
  const denied = deniedServers(evaluateMcpPolicy(servers, posture));
  const name = "MCP servers comply with enterprise policy";
  if (denied.length === 0) {
    return {
      name,
      verdict: "pass",
      detail: "every server is allowed under the enterprise posture",
    };
  }
  return {
    name,
    verdict: "fail",
    detail: `denied — self-host, pin, or remove before an enterprise rollout: ${denied
      .map((p) => `${p.name} (${policyDetail(p)})`)
      .join("; ")}`,
    code: "mcp.policy-denied",
  };
}

function policyDetail(policy: { name: string; reason: string }): string {
  if (policy.name !== "github" || !policy.reason.includes("third-party egress")) {
    return policy.reason;
  }
  return `${policy.reason}; GitHub blocked, self-hosted GHES, or not your VCS? set host, self-host, or disable the GitHub MCP server`;
}

/** Canonical agentgateway base URL clients are pointed at in the remote scope. */
const GATEWAY_URL = "https://agentgateway.n24q02m.com";

function readMcpOrgPolicy(ctx: PlanContext): { policy?: OrgPolicy; error?: unknown } {
  try {
    return { policy: readOrgPolicy(ctx.root, ctx.env) };
  } catch (error) {
    return { error };
  }
}

function httpsOrigin(value: string, source: string): string {
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new Error(`${source} must be an https origin such as https://github.example.com`);
  }
}

function configuredGitHubHost(ctx: PlanContext, policy: OrgPolicy | undefined): string | undefined {
  const policyHost = policy?.mcp?.githubHost;
  if (policyHost !== undefined) return policyHost;
  const envHost = ctx.env.GITHUB_HOST;
  if (envHost === undefined || envHost.length === 0) return undefined;
  return httpsOrigin(envHost, "GITHUB_HOST");
}

function githubHostName(githubHost: string | undefined): string {
  return new URL(githubHost ?? DEFAULT_GITHUB_MCP_URL).host.toLowerCase();
}

function githubIsIncumbent(policy: OrgPolicy | undefined, githubHost: string | undefined): boolean {
  if (policy === undefined) return githubHostName(githubHost) === githubHostName(undefined);
  const incumbentHosts = new Set(
    (policy.mcp?.incumbentHosts ?? []).map((host) => host.toLowerCase()),
  );
  return incumbentHosts.has(githubHostName(githubHost));
}

function removeDisabledServers(
  servers: Record<string, McpServer>,
  policy: OrgPolicy | undefined,
): Record<string, McpServer> {
  const disabled = new Set(policy?.mcp?.disabledServers ?? []);
  if (disabled.size === 0) return servers;
  return Object.fromEntries(Object.entries(servers).filter(([name]) => !disabled.has(name)));
}

function invalidOrgPolicyProbe(error: unknown): ProbeAction {
  return probe("org-policy parse", () => ({
    name: "org-policy parse",
    verdict: "fail",
    detail: `aih-org-policy.json cannot be parsed (${(error as Error).message})`,
    code: "org-policy.drift",
  }));
}

function orgAllowedServers(
  servers: Record<string, McpServer>,
  policy: OrgPolicy | undefined,
): Record<string, McpServer> {
  const allowed = policy?.mcp?.allowedServers ?? [];
  if (allowed.length === 0) return servers;
  const allowedSet = new Set(allowed);
  return Object.fromEntries(Object.entries(servers).filter(([name]) => allowedSet.has(name)));
}

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

/** Note for `--self-host`: what changed, plus the Context7 caveat aih can't auto-resolve. */
function selfHostNote(): string {
  return [
    "`--self-host` swaps GitHub's hosted MCP for the pinned local Docker image",
    "(ghcr.io/github/github-mcp-server), with the PAT read from $GITHUB_PERSONAL_ACCESS_TOKEN —",
    "see the generated .env.example, supply it in your untracked .env, and never commit it.",
    "",
    "Context7 stays on its hosted endpoint: a true self-host needs YOUR internal URL, which",
    "aih can't know. To drop the third-party egress, run Context7's container behind your",
    "perimeter and replace its url in .mcp.json with your internal one.",
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
  const selfHost = ctx.options.selfHost === true;
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const actions: Action[] = [];
  const orgPolicyResult = readMcpOrgPolicy(ctx);
  if (orgPolicyResult.error !== undefined) {
    return plan("mcp", invalidOrgPolicyProbe(orgPolicyResult.error));
  }
  const githubHost = configuredGitHubHost(ctx, orgPolicyResult.policy);
  const servers = removeDisabledServers(
    mcpServers(scope, stack, {
      selfHost,
      githubHost,
      githubIncumbent: githubIsIncumbent(orgPolicyResult.policy, githubHost),
    }),
    orgPolicyResult.policy,
  );
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

  const home = homeDir(ctx);
  const writtenPaths = new Set<string>();
  for (const cli of clis) {
    const e = entry(cli);
    const p = e.mcp;
    if (p.support === "absent" || !p.configPath || !p.configKey) {
      actions.push(
        doc(
          `${e.label}: no MCP config`,
          `${e.label} exposes no MCP server config (use the CLI-tool fallback).`,
        ),
      );
      continue;
    }
    if (p.support !== "native") {
      // A tool aih cannot yet render correctly — emit exact guidance, never a wrong file.
      actions.push(
        doc(
          `Configure MCP for ${e.label} (${p.configFormat}, ${p.configPath})`,
          mcpGuidanceDoc(e, serverNames),
        ),
      );
      continue;
    }
    // A writable tool: render the server map into ITS shape and write the config.
    // A `~/home` path is written external (outside the repo root); merge preserves
    // the user's other settings (Gemini/Zed settings.json carry unrelated keys).
    const external = isExternalMcp(p.configPath);
    const writePath = external ? mcpConfigAbs(home, p.configPath) : p.configPath;
    if (writtenPaths.has(writePath)) continue; // tools sharing a path (claude + kimi → .mcp.json)
    writtenPaths.add(writePath);
    const where = external
      ? ` ${p.configPath} (global — affects all your projects)`
      : ` ${p.configPath}`;
    // Preserve the exact `.mcp.json` describe (golden) for the standard path.
    const describe =
      p.configPath === ".mcp.json"
        ? scope === "remote"
          ? "Configure project-aware servers + the opt-in hosted enterprise toolset (remote scope), merged into any existing .mcp.json"
          : `Configure project-aware MCP servers (${scope} scope)${tailored ? ` — ${tailored}` : ""}, merged into any existing .mcp.json`
        : `${e.label} MCP servers (${scope} scope) →${where}, merged into any existing`;
    if (p.configFormat === "toml") {
      // Codex TOML: fold the `[mcp_servers.*]` tables into an aih-managed region of
      // config.toml, preserving the user's other config. Read existing at plan time.
      const abs = external ? writePath : join(ctx.root, p.configPath);
      const existing = readIfExists(abs) ?? "";
      // Never redefine a server the user already declared as a top-level table — a
      // duplicate `[mcp_servers.X]` is a TOML PARSE ERROR that would break their whole
      // config. The user's own servers win; aih's block adds only what's absent.
      const have = existingMcpTomlNames(existing, MCP_TOML_SCOPE);
      const fresh = Object.fromEntries(Object.entries(servers).filter(([n]) => !have.has(n)));
      const merged = upsertTextBlock(existing, MCP_TOML_SCOPE, mcpTomlBody(fresh));
      actions.push(writeText(writePath, merged, describe, { external }));
    } else {
      actions.push(
        writeJson(writePath, { [p.configKey]: mcpEntries(cli, servers) }, describe, {
          merge: true,
          external,
        }),
      );
    }
  }

  // Self-host changes + any secret placeholders the developer must supply out-of-band.
  if (selfHost && servers.github !== undefined) {
    actions.push(
      doc(
        "Self-host MCP (--self-host): GitHub runs via the pinned local Docker image",
        selfHostNote(),
      ),
    );
  }
  const placeholders = envPlaceholders(servers);
  if (placeholders.length > 0) {
    const abs = join(ctx.root, ".env.example");
    const body = [
      "# Secrets referenced by MCP servers (.mcp.json). Copy to .env (untracked) and fill",
      "# in real values — never commit them. aih manages only the block below.",
      ...placeholders.map((v) => `${v}=`),
    ].join("\n");
    actions.push(
      writeText(
        ".env.example",
        upsertTextBlock(readIfExists(abs) ?? "", MCP_ENV_SCOPE, body),
        `Document ${placeholders.length} MCP secret placeholder(s) (.env.example; real .env stays untracked)`,
      ),
    );
  }

  if (scope === "remote") {
    // The SSO gateway fronts ONLY the n24q02m hosted toolset — not GitHub (its own
    // client OAuth) or Context7 (its own endpoint), which are third-party-hosted but
    // NOT gateway-managed. Filter by the gateway host so the doc lists the right set.
    const hosted = Object.entries(servers)
      .filter(([, s]) => s.type === "http" && s.url.includes(N24Q02M_HOST))
      .map(([name]) => name);
    const rbac = gatewayRbacConfig(GATEWAY_URL, servers, {
      orgAllowedServers: orgPolicyResult.policy?.mcp?.allowedServers,
    });
    actions.push(
      writeJson(
        posix.join(ctx.contextDir, "mcp-gateway-rbac.json"),
        rbac,
        "Identity-aware MCP gateway RBAC config generated from catalog + org-policy",
      ),
    );
    actions.push(
      doc(
        "Identity-aware MCP gateway + SSO (Entra/Okta OIDC, tool-level RBAC) — run by hand, not contacted",
        gatewayDoc(rbac, hosted),
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

  // Enterprise posture (opt-in): surface a governance verdict for every server and a
  // probe that fails on a policy-denied one. The community default adds nothing here,
  // so standard output stays byte-identical.
  const posture = ctx.posture ?? asPosture(ctx.options.posture);
  if (posture === "enterprise") {
    const policies = evaluateMcpPolicy(servers, posture);
    const managedServers = orgAllowedServers(servers, orgPolicyResult.policy);
    actions.push(
      writeJson(
        ".claude/managed-settings.json",
        managedMcpAllowlistSettings(managedServers),
        "Enforce Claude managed MCP allowlist (fixed server commands from .mcp.json)",
        { merge: true },
      ),
      doc(
        "MCP governance (enterprise posture) — per-server verdicts + skipped-with-reason",
        mcpGovernanceDoc(policies, posture),
      ),
    );
    actions.push(
      probe("MCP servers comply with enterprise policy", () => mcpPolicyProbe(servers, posture)),
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
    {
      flags: "--self-host",
      description:
        "emit self-hostable server forms (GitHub via the pinned local Docker image + PAT from env) instead of hosted endpoints",
    },
  ],
  plan: planMcp,
};
