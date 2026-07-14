import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { readAihConfig } from "../config/marker.js";
import { SettingsError } from "../errors.js";
import { homeDir, resolveTargets } from "../internals/cli-detect.js";
import { type CliEntry, entry } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { upsertTextBlock } from "../internals/envfile.js";
import { readIfExists } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import type { Action, CommandSpec, PlanContext, WriteAction } from "../internals/plan.js";
import { digest, doc, plan, probe, writeJson, writeText } from "../internals/plan.js";
import { beginMarker, endMarker } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { type OrgPolicy, parseOrgPolicy } from "../org-policy/schema.js";
import { scanRepo } from "../profile/scan.js";
import { managedMcpAllowlistSettings } from "./allowlist.js";
import { type PolicyAwareMcpCatalog, policyAwareMcpCatalog } from "./catalog.js";
import {
  enterpriseMcpDoc,
  managedMcpExample,
  mcpFallbackSteering,
  stdioServers,
} from "./enterprise.js";
import { gatewayDoc, gatewayRbacConfig } from "./gateway.js";
import {
  applyMcpHygieneToEntries,
  mcpHygieneDigest,
  mcpHygieneIssues,
  mcpPackagePinDriftProbe,
} from "./hygiene.js";
import {
  asPosture,
  deniedServers,
  evaluateMcpPolicy,
  type McpPosture,
  mcpApprovalSubject,
  mcpGovernanceDoc,
  mcpPolicyOptionsFromConfig,
  type ServerPolicy,
} from "./policy.js";
import {
  existingMcpTomlNames,
  isExternalMcp,
  type McpEntry,
  mcpConfigAbs,
  mcpEntries,
  mcpTomlBody,
  removeMcpTomlServers,
} from "./render.js";
import { envPlaceholders, type GithubMcpAuth, type McpServer, N24Q02M_HOST } from "./servers.js";

/** The aih-managed block scope used for Codex's TOML `[mcp_servers.*]` region. */
const MCP_TOML_SCOPE = "mcp";

/** The aih-managed block scope for the generated `.env.example`. */
const MCP_ENV_SCOPE = "mcp-env";

const MCP_APPROVED_AT_PREVIEW = "0000-00-00T00:00:00.000Z";

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
function mcpPolicyProbe(
  servers: Record<string, McpServer>,
  posture: McpPosture,
  policy: OrgPolicy | undefined,
): Check {
  const denied = deniedServers(
    evaluateMcpPolicy(servers, posture, mcpPolicyOptionsFromConfig(policy?.mcp)),
  );
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

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidOrgPolicyError(error: unknown): SettingsError {
  return new SettingsError(`aih-org-policy.json cannot be parsed (${errorDetail(error)})`);
}

function githubAuthOption(value: unknown): GithubMcpAuth {
  if (value === undefined) return "oauth";
  if (value === "oauth" || value === "token") return value;
  throw new SettingsError("--github-auth must be one of: oauth, token");
}

function mcpCatalogError(catalog: PolicyAwareMcpCatalog): SettingsError {
  if (catalog.errorSource === "org-policy") return invalidOrgPolicyError(catalog.error);
  return new SettingsError(`MCP catalog cannot be built: ${errorDetail(catalog.error)}`);
}

function serverRemovalNames(
  policy: OrgPolicy | undefined,
  extraNames: readonly string[] = [],
): string[] {
  return [...new Set([...(policy?.mcp?.disabledServers ?? []), ...extraNames])];
}

function serverConfigRemovals(
  policy: OrgPolicy | undefined,
  configKey: string,
  extraNames: readonly string[] = [],
): Record<string, readonly string[]> | undefined {
  const names = serverRemovalNames(policy, extraNames);
  return names.length > 0 ? { [configKey]: names } : undefined;
}

function orgAllowedServers(
  servers: Record<string, McpServer>,
  policy: OrgPolicy | undefined,
  enforceAllowlist = true,
): Record<string, McpServer> {
  const disabled = new Set(policy?.mcp?.disabledServers ?? []);
  const enabled = Object.fromEntries(
    Object.entries(servers).filter(([name]) => !disabled.has(name)),
  );
  const allowed = policy?.mcp?.allowedServers ?? [];
  if (!enforceAllowlist || policy?.mcp?.allowManagedOnly !== true) return enabled;
  const allowedSet = new Set(allowed);
  return Object.fromEntries(Object.entries(enabled).filter(([name]) => allowedSet.has(name)));
}

interface DeniedGeneratedServer extends ServerPolicy {
  server: McpServer;
}

interface JsonCompliantConfigCheck {
  kind: "json";
  path: string;
  absPath: string;
  configKey: string;
  generatedEntries: Record<string, McpEntry>;
  generatedAlternates: Record<string, McpEntry>;
}

interface TomlCompliantConfigCheck {
  kind: "toml";
  path: string;
  absPath: string;
  deniedNames: readonly string[];
}

type CompliantConfigCheck = JsonCompliantConfigCheck | TomlCompliantConfigCheck;

function omitDeniedServers(
  servers: Record<string, McpServer>,
  denied: readonly ServerPolicy[],
): Record<string, McpServer> {
  if (denied.length === 0) return servers;
  const deniedNames = new Set(denied.map((p) => p.name));
  return Object.fromEntries(Object.entries(servers).filter(([name]) => !deniedNames.has(name)));
}

function deniedPolicyLines(denied: readonly ServerPolicy[]): string[] {
  return denied.map((p) => `  - ${p.name} — ${policyDetail(p)}`);
}

function enterpriseApplyWarningDoc(denied: readonly ServerPolicy[]): string {
  return [
    "Enterprise posture denies these generated MCP servers, but --mcp-compliant was not set:",
    ...deniedPolicyLines(denied),
    "",
    "The default path keeps reporting behavior unchanged and still writes the full generated server set.",
    "A same-posture default `aih mcp --verify` will keep reporting this denial until these servers are self-hosted, approved, pinned, or removed.",
    "To opt into the compliant contract, use the flag on both apply and verify:",
    "",
    "  aih mcp --posture enterprise --mcp-compliant --apply",
    "  aih mcp --posture enterprise --mcp-compliant --verify",
  ].join("\n");
}

function quarantinedMcpServersDoc(denied: readonly ServerPolicy[]): string {
  return [
    "The following generated MCP servers were quarantined by --mcp-compliant and were NOT written to MCP client configs:",
    "",
    ...denied.map((p) => `  // ${p.name}: ${policyDetail(p)}`),
    "",
    "Remediate by self-hosting, approving reviewed third-party egress in org policy, pinning supply-chain inputs, or leaving the server disabled.",
    "Verify the compliant plan with `aih mcp --posture enterprise --mcp-compliant --verify`.",
  ].join("\n");
}

function deniedGeneratedServers(
  servers: Record<string, McpServer>,
  posture: McpPosture,
  policy: OrgPolicy | undefined,
): ServerPolicy[] {
  return deniedServers(
    evaluateMcpPolicy(servers, posture, mcpPolicyOptionsFromConfig(policy?.mcp)),
  );
}

function deniedGeneratedServerDetails(
  servers: Record<string, McpServer>,
  posture: McpPosture,
  policy: OrgPolicy | undefined,
): DeniedGeneratedServer[] {
  const deniedByName = new Map(
    deniedGeneratedServers(servers, posture, policy).map((p) => [p.name, p]),
  );
  return Object.entries(servers).flatMap(([name, server]) => {
    const denied = deniedByName.get(name);
    return denied === undefined ? [] : [{ ...denied, server }];
  });
}

function uniqueDeniedGenerated(items: readonly DeniedGeneratedServer[]): DeniedGeneratedServer[] {
  const out = new Map<string, DeniedGeneratedServer>();
  for (const item of items) if (!out.has(item.name)) out.set(item.name, item);
  return [...out.values()];
}

function jsonStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonStable).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonStable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function matchingGeneratedJsonServerNames(
  absPath: string,
  configKey: string,
  generatedEntries: Record<string, McpEntry>,
  generatedAlternates: Record<string, McpEntry> = {},
  raw = readIfExists(absPath),
): string[] {
  if (raw === undefined || Object.keys(generatedEntries).length === 0) return [];
  const parsed = parseJsoncText(raw);
  if (!isPlainObject(parsed)) return [];
  const servers = parsed[configKey];
  if (!isPlainObject(servers)) return [];
  return Object.entries(generatedEntries)
    .filter(([name, generated]) =>
      [generated, generatedAlternates[name]].some(
        (variant) => variant !== undefined && jsonStable(servers[name]) === jsonStable(variant),
      ),
    )
    .map(([name]) => name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedBlockText(existing: string, scope: string): string | undefined {
  const begin = beginMarker(scope);
  const end = endMarker(scope);
  const normalized = existing.replace(/\r\n/g, "\n");
  const match = new RegExp(`${escapeRegExp(begin)}\\n([\\s\\S]*?)\\n${escapeRegExp(end)}`).exec(
    normalized,
  );
  return match?.[1];
}

function matchingManagedTomlServerNames(absPath: string, deniedNames: readonly string[]): string[] {
  if (deniedNames.length === 0) return [];
  const block = managedBlockText(readIfExists(absPath) ?? "", MCP_TOML_SCOPE);
  if (block === undefined) return [];
  const present = existingMcpTomlNames(block, "__aih-no-managed-block__");
  return deniedNames.filter((name) => present.has(name));
}

function compliantConfigProbe(
  checks: readonly CompliantConfigCheck[],
  policiesByName: ReadonlyMap<string, ServerPolicy>,
): Check {
  const name = "MCP configs contain no quarantined generated servers";
  const stale: string[] = [];
  try {
    for (const check of checks) {
      const names =
        check.kind === "json"
          ? matchingGeneratedJsonServerNames(
              check.absPath,
              check.configKey,
              check.generatedEntries,
              check.generatedAlternates,
            )
          : matchingManagedTomlServerNames(check.absPath, check.deniedNames);
      for (const server of names) {
        const detail = policiesByName.get(server)?.reason ?? "policy-denied generated server";
        stale.push(`${check.path}:${server} (${detail})`);
      }
    }
  } catch (error) {
    return {
      name,
      verdict: "fail",
      detail: `could not inspect MCP config for quarantined servers: ${errorDetail(error)}`,
      code: "mcp.compliant-config-read",
    };
  }
  if (stale.length === 0) {
    return {
      name,
      verdict: "pass",
      detail: "no exact generated denied MCP server entries remain in targeted configs",
    };
  }
  return {
    name,
    verdict: "fail",
    detail: `rerun with --apply or remove quarantined generated entries: ${stale.join("; ")}`,
    code: "mcp.compliant-stale-denied",
  };
}

function approvalText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SettingsError(`${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new SettingsError(`${label} is required`);
  if (trimmed.length > 500 || hasControlCharacter(trimmed)) {
    throw new SettingsError(`${label} must be a single line of 500 characters or fewer`);
  }
  return trimmed;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function readLocalOrgPolicyForApproval(ctx: PlanContext): {
  policy: OrgPolicy;
  exists: boolean;
  raw: string | undefined;
} {
  const override = ctx.env.AIH_ORG_POLICY?.trim();
  if (override !== undefined && override.length > 0) {
    throw new SettingsError(
      "AIH_ORG_POLICY is active; org policy wins over local approvals, so update that policy instead of writing a repo-local approval",
    );
  }
  const raw = readIfExists(join(ctx.root, AIH_ORG_POLICY_FILE));
  if (raw === undefined) {
    return {
      policy: {
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: posix.join(ctx.contextDir, "project.json") },
      },
      exists: false,
      raw: undefined,
    };
  }
  try {
    return { policy: parseOrgPolicy(JSON.parse(raw)), exists: true, raw };
  } catch (error) {
    throw invalidOrgPolicyError(error);
  }
}

function uniquePreservingOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Bind each generated MCP write to the target bytes observed while planning. */
function guardMcpWrites(ctx: PlanContext, actions: readonly Action[]): Action[] {
  return actions.map((action) => {
    if (action.kind !== "write") return action;
    if (action.expect !== undefined) return action;
    const absPath = action.external ? action.path : join(ctx.root, action.path);
    const existing = readIfExists(absPath);
    const expect: WriteAction["expect"] =
      existing === undefined
        ? { absent: true }
        : { sha256: createHash("sha256").update(existing, "utf8").digest("hex") };
    return { ...action, expect };
  });
}

function withExpectedContents(action: WriteAction, contents: string | undefined): WriteAction {
  return {
    ...action,
    expect:
      contents === undefined
        ? { absent: true }
        : { sha256: createHash("sha256").update(contents, "utf8").digest("hex") },
  };
}

function guardMcpPlan(ctx: PlanContext, planned: ReturnType<typeof plan>): ReturnType<typeof plan> {
  return { ...planned, actions: guardMcpWrites(ctx, planned.actions) };
}

function approveMcpPlan(ctx: PlanContext): ReturnType<typeof plan> {
  const server = approvalText(ctx.options.server, "server");
  if (ctx.options.acceptEgress !== true) {
    throw new SettingsError("--accept-egress is required to approve third-party MCP egress");
  }
  const reason = approvalText(ctx.options.reason, "--reason");
  const reviewer =
    typeof ctx.options.reviewer === "string" && ctx.options.reviewer.trim().length > 0
      ? approvalText(ctx.options.reviewer, "--reviewer")
      : "local-operator";
  const { policy, exists: policyExists, raw: policyRaw } = readLocalOrgPolicyForApproval(ctx);
  if ((policy.mcp?.disabledServers ?? []).includes(server)) {
    throw new SettingsError(
      `${server} is listed in mcp.disabledServers; remove that org-policy denial before approving it`,
    );
  }
  const catalog = policyAwareMcpCatalog(ctx, { scope: "project" });
  if (catalog.error !== undefined || catalog.servers === undefined) {
    throw mcpCatalogError(catalog);
  }
  const approvedServer = catalog.servers[server];
  if (approvedServer === undefined) {
    throw new SettingsError(`${server} is not in the current MCP catalog; cannot bind approval`);
  }
  const approval = {
    server,
    subject: mcpApprovalSubject(approvedServer),
    acceptEgress: true as const,
    reason,
    reviewer,
    approvedAt: ctx.apply ? new Date().toISOString() : MCP_APPROVED_AT_PREVIEW,
  };
  const mcp: NonNullable<OrgPolicy["mcp"]> = {
    allowedServers: policy.mcp?.allowedServers ?? [],
    approvals: policy.mcp?.approvals ?? [],
    allowManagedOnly: policy.mcp?.allowManagedOnly ?? false,
    incumbentHosts: policy.mcp?.incumbentHosts ?? [],
    disabledServers: policy.mcp?.disabledServers ?? [],
    ...(policy.mcp?.githubHost !== undefined ? { githubHost: policy.mcp.githubHost } : {}),
  };
  const next: OrgPolicy = {
    ...policy,
    mcp: {
      ...mcp,
      allowedServers: uniquePreservingOrder([...mcp.allowedServers, server]),
      approvals: [...mcp.approvals.filter((entry) => entry.server !== server), approval],
    },
  };
  return guardMcpPlan(
    ctx,
    plan(
      "mcp approve",
      withExpectedContents(
        writeJson(
          AIH_ORG_POLICY_FILE,
          next,
          ctx.apply
            ? policyExists
              ? `Record reviewed MCP egress approval for ${server} in local org policy`
              : `Create local org policy and record reviewed MCP egress approval for ${server}`
            : policyExists
              ? `Preview reviewed MCP egress approval for ${server}; approvedAt is set when rerun with --apply`
              : `Preview creating local org policy for ${server}; approvedAt is set when rerun with --apply`,
        ),
        policyRaw,
      ),
    ),
  );
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
  const catalog = policyAwareMcpCatalog(ctx, {
    scope,
    stack,
    includeDisabledServers: true,
  });
  if (catalog.error !== undefined || catalog.servers === undefined) {
    throw mcpCatalogError(catalog);
  }
  const allowed = orgAllowedServers(catalog.servers, catalog.policy);
  const stdio = stdioServers(allowed);
  const denied = Object.fromEntries(
    Object.entries(catalog.servers).filter(([name]) => !(name in stdio)),
  );
  const mcpPath = join(ctx.root, ".mcp.json");
  const source = readIfExists(mcpPath);
  const stale = matchingGeneratedJsonServerNames(
    mcpPath,
    "mcpServers",
    mcpEntries("claude", denied),
    {},
    source,
  );
  return plan(
    "mcp",
    withExpectedContents(
      writeJson(
        ".mcp.json",
        { mcpServers: stdio },
        "local stdio MCP servers (offline) — mirror/vendor these; some still resolve packages at runtime until vendored (see the offline verify probe)",
        { merge: true, removeJsonKeys: serverConfigRemovals(undefined, "mcpServers", stale) },
      ),
      source,
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

function hasExplicitTargetSelection(ctx: PlanContext): boolean {
  return (
    ctx.targets !== undefined ||
    (typeof ctx.options.cli === "string" && ctx.options.cli.trim().length > 0) ||
    ctx.options.allTools === true ||
    ctx.options.detect === true
  );
}

function defaultTargetSelectionNotice(ctx: PlanContext, clis: readonly Cli[]): string | undefined {
  if (hasExplicitTargetSelection(ctx)) return undefined;
  const marker = readAihConfig(ctx.root);
  if (marker !== undefined && marker.targets.length > 0) return undefined;
  const globalTargets = clis
    .map((cli) => entry(cli))
    .filter((e) => {
      const path = e.mcp.configPath;
      return e.mcp.support === "native" && path !== undefined && isExternalMcp(path);
    })
    .map((e) => `  - ${e.label}: ${e.mcp.configPath}`);
  if (globalTargets.length === 0) return undefined;
  return [
    "No --cli, --all-tools, --detect, or committed .aih-config.json targets were provided.",
    "For a first run, aih mcp targets runnable installed AI CLIs. These selected targets use global MCP config files, so --apply can affect that CLI in every project:",
    ...globalTargets,
    "",
    "Pass --cli <list> to narrow the target set, or commit .aih-config.json through aih init/bootstrap-ai so later runs use the repo's recorded targets.",
  ].join("\n");
}

async function planMcp(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const githubAuth = githubAuthOption(ctx.options.githubAuth);
  const mode = String(ctx.options.mode ?? "standard");
  if (mode === "none") return planMcpNone(ctx);
  if (mode === "offline") return planMcpOffline(ctx);

  // Honor --cli/--all-tools/--detect, a committed marker, or the first-run
  // runnable-CLI default. Previously mcp ignored the selection and wrote Claude's
  // `.mcp.json` for every tool — a real bug for Codex (config.toml), Copilot
  // (.vscode/mcp.json), OpenCode, Zed, etc.
  const { clis } = await resolveTargets(ctx);
  const scope = String(ctx.options.scope ?? "project");
  const selfHost = ctx.options.selfHost === true;
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const actions: Action[] = [];
  const catalog = policyAwareMcpCatalog(ctx, {
    scope,
    selfHost,
    githubAuth,
    stack,
    includeDisabledServers: true,
  });
  if (catalog.error !== undefined || catalog.servers === undefined) {
    throw mcpCatalogError(catalog);
  }
  const servers = orgAllowedServers(catalog.servers, catalog.policy, false);
  const posture = ctx.posture ?? asPosture(ctx.options.posture);
  const policyOptions = mcpPolicyOptionsFromConfig(catalog.policy?.mcp);
  const policies =
    posture === "enterprise" ? evaluateMcpPolicy(servers, posture, policyOptions) : [];
  const denied = posture === "enterprise" ? deniedServers(policies) : [];
  const mcpCompliant = posture === "enterprise" && ctx.options.mcpCompliant === true;
  const currentDeniedGenerated =
    posture === "enterprise" ? deniedGeneratedServerDetails(servers, posture, catalog.policy) : [];
  const remoteCatalog =
    mcpCompliant && scope !== "remote"
      ? policyAwareMcpCatalog(ctx, { scope: "remote", selfHost, githubAuth, stack })
      : undefined;
  if (
    remoteCatalog !== undefined &&
    (remoteCatalog.error !== undefined || remoteCatalog.servers === undefined)
  ) {
    throw mcpCatalogError(remoteCatalog);
  }
  const remoteDeniedGenerated =
    remoteCatalog?.servers !== undefined
      ? deniedGeneratedServerDetails(remoteCatalog.servers, posture, catalog.policy)
      : currentDeniedGenerated;
  const deniedGenerated = mcpCompliant
    ? uniqueDeniedGenerated([...currentDeniedGenerated, ...remoteDeniedGenerated])
    : currentDeniedGenerated;
  const deniedGeneratedNames = deniedGenerated.map((item) => item.name);
  const deniedGeneratedPoliciesByName = new Map<string, ServerPolicy>(
    deniedGenerated.map(({ server: _server, ...policy }) => [policy.name, policy]),
  );
  const orgAllowed = orgAllowedServers(catalog.servers, catalog.policy);
  const orgDeniedGenerated = Object.fromEntries(
    Object.entries(catalog.servers).filter(([name]) => !(name in orgAllowed)),
  );
  const writeServers = mcpCompliant ? omitDeniedServers(orgAllowed, denied) : orgAllowed;
  const hygieneIssues = mcpHygieneIssues(writeServers, ctx.env);
  const writeServerNames = Object.keys(writeServers);
  const tailored = writeServerNames
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
  const compliantConfigChecks: CompliantConfigCheck[] = [];
  const quarantinedPolicies = new Map<string, ServerPolicy>(denied.map((p) => [p.name, p]));
  const targetSelectionNotice = defaultTargetSelectionNotice(ctx, clis);
  if (targetSelectionNotice !== undefined) {
    actions.push(digest("MCP target selection", targetSelectionNotice));
  }
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
          mcpGuidanceDoc(e, writeServerNames),
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
      const source = readIfExists(abs);
      const existing = removeMcpTomlServers(
        source ?? "",
        serverRemovalNames(undefined), // preserve operator-owned top-level tables
      );
      if (mcpCompliant) {
        compliantConfigChecks.push({
          kind: "toml",
          path: writePath,
          absPath: abs,
          deniedNames: deniedGeneratedNames,
        });
      }
      // Never redefine a server the user already declared as a top-level table — a
      // duplicate `[mcp_servers.X]` is a TOML PARSE ERROR that would break their whole
      // config. The user's own servers win; aih's block adds only what's absent.
      const have = existingMcpTomlNames(existing, MCP_TOML_SCOPE);
      const fresh = Object.fromEntries(Object.entries(writeServers).filter(([n]) => !have.has(n)));
      const merged = upsertTextBlock(existing, MCP_TOML_SCOPE, mcpTomlBody(fresh));
      actions.push(
        withExpectedContents(writeText(writePath, merged, describe, { external }), source),
      );
    } else {
      const abs = external ? writePath : join(ctx.root, p.configPath);
      const source = readIfExists(abs);
      const deniedGeneratedServerMap = Object.fromEntries([
        ...Object.entries(orgDeniedGenerated),
        ...(mcpCompliant ? deniedGenerated.map((item) => [item.name, item.server] as const) : []),
      ]);
      const generatedDeniedEntries = mcpEntries(cli, deniedGeneratedServerMap);
      const generatedDeniedAlternates = applyMcpHygieneToEntries(
        cli,
        generatedDeniedEntries,
        mcpHygieneIssues(deniedGeneratedServerMap, {}),
      );
      const renderedEntries = applyMcpHygieneToEntries(
        cli,
        mcpEntries(cli, writeServers),
        hygieneIssues,
      );
      const staleGeneratedNames = matchingGeneratedJsonServerNames(
        abs,
        p.configKey,
        generatedDeniedEntries,
        generatedDeniedAlternates,
        source,
      );
      for (const name of staleGeneratedNames) {
        const policy = deniedGeneratedPoliciesByName.get(name);
        if (policy !== undefined) quarantinedPolicies.set(name, policy);
      }
      if (mcpCompliant) {
        compliantConfigChecks.push({
          kind: "json",
          path: writePath,
          absPath: abs,
          configKey: p.configKey,
          generatedEntries: generatedDeniedEntries,
          generatedAlternates: generatedDeniedAlternates,
        });
      }
      actions.push(
        withExpectedContents(
          writeJson(writePath, { [p.configKey]: renderedEntries }, describe, {
            merge: true,
            external,
            replaceJsonChildKeys: { [p.configKey]: Object.keys(renderedEntries) },
            removeJsonKeys: serverConfigRemovals(undefined, p.configKey, staleGeneratedNames),
          }),
          source,
        ),
      );
    }
  }

  if (hygieneIssues.length > 0) {
    actions.push(digest("MCP server hygiene warnings", mcpHygieneDigest(hygieneIssues, clis)));
  }

  // Self-host changes + any secret placeholders the developer must supply out-of-band.
  if (selfHost && writeServers.github !== undefined) {
    actions.push(
      doc(
        "Self-host MCP (--self-host): GitHub runs via the pinned local Docker image",
        selfHostNote(),
      ),
    );
  }
  const placeholders = envPlaceholders(writeServers);
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
    const hosted = Object.entries(writeServers)
      .filter(([, s]) => s.type === "http" && s.url.includes(N24Q02M_HOST))
      .map(([name]) => name);
    const rbac = gatewayRbacConfig(GATEWAY_URL, writeServers, {
      orgAllowedServers: catalog.policy?.mcp?.allowedServers,
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
  // probe that fails on a policy-denied one. The default vibe posture adds nothing
  // here, so standard output stays byte-identical.
  if (posture === "enterprise") {
    const quarantined = [...quarantinedPolicies.values()];
    if (quarantined.length > 0) {
      const noticeText = mcpCompliant
        ? quarantinedMcpServersDoc(quarantined)
        : enterpriseApplyWarningDoc(quarantined);
      const noticeTitle = mcpCompliant ? "Quarantined MCP servers" : "Enterprise MCP apply warning";
      actions.push(digest(noticeTitle, noticeText), doc(noticeTitle, noticeText));
    }
    const policyProbeServers = mcpCompliant ? writeServers : servers;
    const managedServers = orgAllowedServers(writeServers, catalog.policy);
    actions.push(
      writeJson(
        ".claude/managed-settings.json",
        managedMcpAllowlistSettings(managedServers),
        "Enforce Claude managed MCP allowlist (fixed server commands from .mcp.json)",
        { merge: true, replaceJsonKeys: ["allowedMcpServers"] },
      ),
      doc(
        "MCP governance (enterprise posture) — per-server verdicts + skipped-with-reason",
        mcpGovernanceDoc(policies, posture, { compliantApply: mcpCompliant }),
      ),
    );
    if (mcpCompliant) {
      actions.push(
        probe("MCP configs contain no quarantined generated servers", () =>
          compliantConfigProbe(compliantConfigChecks, deniedGeneratedPoliciesByName),
        ),
      );
    }
    actions.push(
      probe("MCP servers comply with enterprise policy", () =>
        mcpPolicyProbe(policyProbeServers, posture, catalog.policy),
      ),
    );
  }

  actions.push(probe("uv present", probeUv));
  if (ctx.verify) {
    actions.push(
      probe("MCP package pins match resolved versions", (probeCtx) =>
        mcpPackagePinDriftProbe(writeServers, probeCtx),
      ),
    );
  }

  return plan("mcp", ...actions);
}

async function planMcpWithWriteGuards(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const planned = await planMcp(ctx);
  return guardMcpPlan(ctx, planned);
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
    {
      flags: "--github-auth <auth>",
      description:
        "hosted GitHub MCP auth: oauth (DCR-capable clients) | token (Authorization header from env)",
      default: "oauth",
    },
    {
      flags: "--mcp-compliant",
      description:
        "under Enterprise posture, omit denied generated MCP servers from targeted configs and list them in quarantined guidance",
    },
  ],
  plan: planMcpWithWriteGuards,
};

export const mcpApproveCommand: CommandSpec = {
  name: "approve",
  summary: "Record a reviewed third-party MCP egress approval in local org policy",
  positional: {
    name: "server",
    required: true,
    optionName: "server",
    description: "MCP server name to approve",
  },
  options: [
    {
      flags: "--accept-egress",
      description: "confirm reviewer acceptance of third-party MCP egress for this server",
    },
    {
      flags: "--reason <text>",
      description: "single-line review reason recorded with the approval",
    },
    {
      flags: "--reviewer <name>",
      description: "reviewer or team name recorded with the approval",
    },
  ],
  plan: approveMcpPlan,
};
