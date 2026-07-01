import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { type Posture, postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import type { Action, CommandSpec, PlanContext, ProbeAction } from "../internals/plan.js";
import { plan, probe, probeMany } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { evaluateMcpPolicy } from "../mcp/policy.js";
import type { McpServer } from "../mcp/servers.js";
import { type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import { mcpConfigSecretCheck, plaintextSecretCheck } from "../secrets/probes.js";
import { MCP_CONFIG_FILES, scanConfigSecrets, scanSecrets } from "../secrets/scan.js";
import { resolveInternalScopes, scanTrustDependencyNames } from "./depnames.js";
import {
  assertTrustTreeSafe,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "./fetch.js";
import { gradeTrustCheck } from "./grade.js";
import { scanTrustDocument } from "./lint.js";
import { scanTrustManifests } from "./manifest.js";
import { classifyIncomingMcp } from "./mcp-classify.js";

export const TRUST_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aih",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const ROOT_TRUST_DOCS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const INCOMING_MCP_CONFIG_FILES = new Set([...MCP_CONFIG_FILES, "mcp.json"]);
const HOSTED_MCP_ADVISORY =
  "hosted MCP server has no post-approval rug-pull protection; run a runtime MCP-scan with tool-pinning before first use.";
const MCP_POLICY_RULE = "incoming MCP policy";
const MCP_POLICY_DENIED = "mcp.policy-denied";
const DEFAULT_GITHUB_HOST = "github.com";

interface ScanTrustTreeOptions {
  internalScopes?: readonly string[];
  posture?: Posture;
}

interface IncomingMcpServerMap {
  key: "mcpServers" | "servers" | "mcp";
  servers: Record<string, unknown>;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function collectFilesUnder(
  root: string,
  accept: (absolutePath: string) => boolean,
  skipDirs: ReadonlySet<string> = TRUST_SKIP_DIRS,
): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      if (abs !== root && skipDirs.has(basename(abs))) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (st.isFile() && accept(abs)) out.push(abs);
  };
  visit(root);
  return out.sort((a, b) => toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))));
}

function shouldScanTrustDoc(root: string, absPath: string): boolean {
  const rel = toPosix(relative(root, absPath));
  const parts = rel.split("/");
  const name = parts.at(-1) ?? "";
  if (name === "SKILL.md") return true;
  if (parts.length === 1 && ROOT_TRUST_DOCS.has(name)) return true;
  if (extname(name).toLowerCase() !== ".md") return false;
  return parts.includes("skills") || parts.includes("agents") || parts.includes("commands");
}

function collectTrustDocs(root: string): string[] {
  return collectFilesUnder(root, (abs) => shouldScanTrustDoc(root, abs));
}

function normalizeScanOptions(options: ScanTrustTreeOptions = {}): {
  internalScopes: readonly string[];
  posture: Posture;
} {
  return {
    internalScopes: options.internalScopes ?? [],
    posture: options.posture ?? "vibe",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collectIncomingMcpConfigFiles(root: string): string[] {
  return collectFilesUnder(root, (abs) =>
    INCOMING_MCP_CONFIG_FILES.has(toPosix(relative(root, abs))),
  ).map((abs) => toPosix(relative(root, abs)));
}

function plaintextSecretChecks(root: string, posture: Posture): Check[] {
  return scanSecrets(root).matches.map((path) => plaintextSecretCheck(path, posture));
}

function mcpConfigSecretChecks(
  root: string,
  mcpConfigFiles: readonly string[],
  posture: Posture,
): Check[] {
  return scanConfigSecrets(root, mcpConfigFiles).map((hit) => mcpConfigSecretCheck(hit, posture));
}

function mcpPolicyFail(rel: string, detail: string, fingerprintTail: string): Check {
  return {
    name: MCP_POLICY_DENIED,
    verdict: "fail",
    detail,
    code: MCP_POLICY_DENIED,
    location: { uri: rel, startLine: 1 },
    fingerprint: `mcp-policy-denied:${rel}:${fingerprintTail}`,
  };
}

function malformedMcpConfigCheck(rel: string): Check {
  return mcpPolicyFail(
    rel,
    `${rel}:1 — malformed incoming MCP config; fix or remove it before promotion`,
    "malformed",
  );
}

function incomingServerMaps(parsed: unknown): IncomingMcpServerMap[] | undefined {
  if (!isRecord(parsed)) return undefined;
  const maps: IncomingMcpServerMap[] = [];
  for (const key of ["mcpServers", "servers"] as const) {
    if (!Object.hasOwn(parsed, key)) continue;
    const value = parsed[key];
    if (!isRecord(value)) return undefined;
    maps.push({ key, servers: value });
  }
  if (Object.hasOwn(parsed, "mcp")) {
    const value = parsed.mcp;
    if (!isRecord(value)) return undefined;
    maps.push({ key: "mcp", servers: openCodeServers(value) });
  }
  return maps;
}

function openCodeServers(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, openCodeServer(server)]),
  );
}

function openCodeServer(server: unknown): unknown {
  if (!isRecord(server)) return server;
  if (server.type === "remote") {
    return { ...server, url: stringValue(server.url) };
  }
  const command = Array.isArray(server.command) ? server.command : [];
  const executable = command[0];
  return {
    ...server,
    command: typeof executable === "string" ? executable : undefined,
    args: command.slice(1).filter((item): item is string => typeof item === "string"),
    env: server.environment ?? server.env,
  };
}

function safeMcpName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "server";
}

function descriptionChecks(rel: string, mapKey: string, name: string, rawServer: unknown): Check[] {
  if (!isRecord(rawServer) || typeof rawServer.description !== "string") return [];
  return scanTrustDocument(
    `${rel}#${mapKey}.${safeMcpName(name)}.description`,
    rawServer.description,
  );
}

function mcpPolicyChecks(
  rel: string,
  mapKey: string,
  rawServers: Record<string, unknown>,
  posture: Posture,
): Check[] {
  const classifiedEntries = Object.entries(rawServers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, raw]) => [name, classifyIncomingMcp(raw)] as const);
  const classified: Record<string, McpServer> = Object.fromEntries(classifiedEntries);
  const policies = evaluateMcpPolicy(classified, posture);
  return policies.flatMap((policy) => {
    const server = classified[policy.name];
    if (server === undefined || policy.verdict === "allow") return [];
    const advisory = server.supplyChain === "hosted-remote" ? ` ${HOSTED_MCP_ADVISORY}` : "";
    const detail = `${rel} → ${mapKey}.${policy.name}: ${policy.reason}${advisory}`;
    if (policy.verdict === "warn") {
      return [
        {
          name: MCP_POLICY_RULE,
          verdict: "pass",
          detail: `warning-only (${posture}): ${detail}`,
          location: { uri: rel, startLine: 1 },
        } satisfies Check,
      ];
    }
    return [mcpPolicyFail(rel, detail, `${mapKey}.${safeMcpName(policy.name)}`)];
  });
}

function incomingMcpChecks(
  root: string,
  mcpConfigFiles: readonly string[],
  posture: Posture,
): Check[] {
  const checks: Check[] = [];
  for (const rel of mcpConfigFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, rel), "utf8")) as unknown;
    } catch {
      checks.push(malformedMcpConfigCheck(rel));
      continue;
    }
    const maps = incomingServerMaps(parsed);
    if (maps === undefined) {
      checks.push(malformedMcpConfigCheck(rel));
      continue;
    }
    for (const map of maps) {
      for (const [name, rawServer] of Object.entries(map.servers).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        checks.push(...descriptionChecks(rel, map.key, name, rawServer));
      }
      checks.push(...mcpPolicyChecks(rel, map.key, map.servers, posture));
    }
  }
  return checks;
}

function passCheck(root: string, scanned: number): Check {
  return {
    name: "trust scan",
    verdict: "pass",
    detail: `scanned ${scanned} trust document(s) in ${root}`,
  };
}

type ApprovedTrustSource = NonNullable<NonNullable<OrgPolicy["trust"]>["approvedSources"]>[number];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostMatchesPattern(pattern: string | undefined, host: string): boolean {
  if (pattern === undefined || pattern.trim().length === 0) return true;
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedHost = host.toLowerCase();
  if (!normalizedPattern.includes("*")) return normalizedPattern === normalizedHost;
  const wildcard = new RegExp(`^${escapeRegExp(normalizedPattern).replace(/\\\*/g, ".*")}$`, "i");
  return wildcard.test(normalizedHost);
}

function approvedSourceMatches(source: TrustSource, approved: ApprovedTrustSource): boolean {
  if (source.kind !== "github") return false;
  return (
    approved.owner.toLowerCase() === source.owner.toLowerCase() &&
    approved.repo.toLowerCase() === source.repo.toLowerCase() &&
    hostMatchesPattern(approved.hostPattern, DEFAULT_GITHUB_HOST)
  );
}

function sourceOriginCheck(
  code: "trust.untrusted-publisher" | "trust.unsigned-source",
  detail: string,
  posture: Posture,
  fingerprint: string,
): Check {
  return gradeTrustCheck(
    {
      name: code,
      verdict: "fail",
      detail,
      code,
      fingerprint,
    },
    posture,
  );
}

function trustSourceOriginChecks(ctx: PlanContext, source: TrustSource): Check[] {
  if (source.kind !== "github") return [];
  const policy = readOrgPolicy(ctx.root, ctx.env)?.trust;
  if (policy === undefined) return [];

  const posture = postureFromContext(ctx);
  const checks: Check[] = [];
  const sourceName = `${source.owner}/${source.repo}`;
  if (
    policy.approvedSources !== undefined &&
    !policy.approvedSources.some((approved) => approvedSourceMatches(source, approved))
  ) {
    checks.push(
      sourceOriginCheck(
        "trust.untrusted-publisher",
        `${sourceName} is not listed in org-policy trust.approvedSources`,
        posture,
        `trust-untrusted-publisher:${sourceName.toLowerCase()}`,
      ),
    );
  }
  if (policy.requireSignedSource && source.pin === undefined) {
    checks.push(
      sourceOriginCheck(
        "trust.unsigned-source",
        `${sourceName}@${source.ref} was acquired without an explicit --pin under trust.requireSignedSource`,
        posture,
        `trust-unsigned-source:${sourceName.toLowerCase()}:${source.ref}`,
      ),
    );
  }
  return checks;
}

export async function scanTrustTree(
  root: string,
  options: ScanTrustTreeOptions = {},
): Promise<Check[]> {
  const safeRoot = assertTrustTreeSafe(root, { skipDirs: TRUST_SKIP_DIRS });
  const { internalScopes, posture } = normalizeScanOptions(options);
  const docs = collectTrustDocs(safeRoot);
  const mcpConfigFiles = collectIncomingMcpConfigFiles(safeRoot);
  const checks = [
    ...docs.flatMap((abs) =>
      scanTrustDocument(toPosix(relative(safeRoot, abs)), readFileSync(abs, "utf8")),
    ),
    ...scanTrustManifests(safeRoot),
    ...scanTrustDependencyNames(safeRoot, internalScopes, posture),
    ...plaintextSecretChecks(safeRoot, posture),
    ...mcpConfigSecretChecks(safeRoot, mcpConfigFiles, posture),
    ...incomingMcpChecks(safeRoot, mcpConfigFiles, posture),
  ];
  return checks.length > 0 ? checks : [passCheck(safeRoot, docs.length)];
}

function probesForStaticChecks(checks: Check[]): ProbeAction[] {
  return checks.map((check) => probe(check.detail ?? check.name, () => check));
}

export async function trustScanProbes(
  source: TrustSource,
  options: ScanTrustTreeOptions = {},
): Promise<ProbeAction[]> {
  if (source.kind === "local") {
    return probesForStaticChecks(await scanTrustTree(source.root, options));
  }
  return [
    probeMany(`trust scan ${source.display}`, async (probeCtx) => {
      if (!probeCtx.apply) {
        return [
          {
            name: "trust scan",
            verdict: "skip",
            code: "trust.fetch-blocked",
            detail:
              "remote source fetch is skipped in dry-run; pass --apply to download into quarantine",
          },
        ];
      }
      return scanTrustTree(source.treePath, options);
    }),
  ];
}

export async function trustScanPlanForSource(
  ctx: PlanContext,
  source: TrustSource,
): Promise<ReturnType<typeof plan>> {
  const actions: Action[] = [];
  if (source.kind === "github") actions.push(trustFetchExec(source, ctx));
  actions.push(...probesForStaticChecks(trustSourceOriginChecks(ctx, source)));
  actions.push(
    ...(await trustScanProbes(source, {
      internalScopes: resolveInternalScopes(ctx),
      posture: postureFromContext(ctx),
    })),
  );
  return plan("trust scan", ...actions);
}

async function trustScanPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const target = ctx.options.target;
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new AihError("trust scan requires a path or owner/repo target", "AIH_TRUST");
  }
  const source = resolveTrustSource(target, {
    root: ctx.root,
    ref: typeof ctx.options.ref === "string" ? ctx.options.ref : undefined,
    pin: typeof ctx.options.pin === "string" ? ctx.options.pin : undefined,
    skipDirs: TRUST_SKIP_DIRS,
  });
  if (source.kind === "local" && !isAbsolute(target)) {
    return trustScanPlanForSource(ctx, {
      ...source,
      display: toPosix(relative(ctx.root, resolve(ctx.root, target))) || source.display,
    });
  }
  return trustScanPlanForSource(ctx, source);
}

export const trustScanCommand: CommandSpec = {
  name: "scan",
  summary: "Scan a local trust source or GitHub owner/repo before promotion",
  options: [
    {
      flags: "--pin <sha>",
      description: "fetch exactly this Git commit SHA for owner/repo sources",
    },
    { flags: "--ref <ref>", description: "GitHub ref to resolve before downloading the tarball" },
    {
      flags: "--sarif <file>",
      description: "write verification results as SARIF (or - for stdout)",
    },
  ],
  plan: trustScanPlan,
  alwaysVerify: true,
};
