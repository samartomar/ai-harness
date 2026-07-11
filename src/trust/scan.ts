import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { type Posture, postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import type { Action, CommandSpec, PlanContext, ProbeAction } from "../internals/plan.js";
import { digest, dynamicDigest, plan, structuredChecksProbe } from "../internals/plan.js";
import type { Runner } from "../internals/proc.js";
import type { Check } from "../internals/verify.js";
import { evaluateMcpPolicy, mcpPolicyOptionsFromConfig } from "../mcp/policy.js";
import type { McpServer } from "../mcp/servers.js";
import { type OrgPolicy, OrgPolicyError, readOrgPolicy } from "../org-policy/schema.js";
import type { Platform } from "../platform/base.js";
import { mcpConfigSecretCheck, plaintextSecretCheck } from "../secrets/probes.js";
import { MCP_CONFIG_FILES, scanConfigSecrets, scanSecrets } from "../secrets/scan.js";
import { applyTrustAcknowledgements } from "./acknowledge.js";
import { resolveInternalScopes, scanTrustDependencyNames } from "./depnames.js";
import {
  runMcpConfigDetectors,
  runTrustDetectors,
  scanNativeMaliciousCode,
  type TrustDetectorName,
  trustRuntimeAdvisory,
} from "./detectors.js";
import {
  assertTrustTreeSafe,
  cleanupQuarantine,
  readTrustFetchMetadata,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "./fetch.js";
import { gradeTrustCheck } from "./grade.js";
import type { SkillSpectorImageApproval } from "./images.js";
import {
  buildTrustFileInventory,
  DEFAULT_TRUST_SKIP_DIRS,
  type TrustFileInventory,
  type TrustInventoryBuildOptions,
} from "./inventory.js";
import { isStrictUnicodeSurface, scanTrustDocument, scanTrustUnicodeDocument } from "./lint.js";
import { scanTrustManifests } from "./manifest.js";
import { classifyIncomingMcp } from "./mcp-classify.js";
import { isInstallScriptEvidenceFilePath, isMaliciousCodeScanFilePath } from "./script-files.js";
import { type SandboxSmokeShape, sandboxSmokeCheck } from "./smoke.js";

export const TRUST_SKIP_DIRS = DEFAULT_TRUST_SKIP_DIRS;
const ROOT_TRUST_DOCS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
export const INCOMING_MCP_CONFIG_FILES = new Set([...MCP_CONFIG_FILES, "mcp.json"]);
const HOSTED_MCP_ADVISORY =
  "hosted MCP server has no post-approval rug-pull protection; run a runtime MCP-scan with tool-pinning before first use.";
const MCP_POLICY_RULE = "incoming MCP policy";
const MCP_POLICY_DENIED = "mcp.policy-denied";
const PACKAGE_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
];
const INSTALL_SCRIPT_HOOKS = ["preinstall", "postinstall", "install"];

export interface ScanTrustTreeOptions {
  env?: NodeJS.ProcessEnv;
  internalScopes?: readonly string[];
  platform?: Platform;
  posture?: Posture;
  mcpPolicy?: OrgPolicy["mcp"];
  requiredDetectors?: readonly TrustDetectorName[];
  run?: Runner;
  sandboxSmokeShape?: SandboxSmokeShape;
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
  progress?: (message: string) => void;
  inventoryFactory?: (root: string, options?: TrustInventoryBuildOptions) => TrustFileInventory;
}

export interface TrustScanResult {
  checks: Check[];
  analyzersRun: string[];
}

interface IncomingMcpServerMap {
  key: "mcpServers" | "servers" | "mcp";
  servers: Record<string, unknown>;
}

interface TrustScanPlanOptions {
  cleanupQuarantine?: boolean;
  sandboxSmokeShape?: (root: string) => SandboxSmokeShape | undefined;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function collectFilesUnder(
  root: string,
  accept: (absolutePath: string) => boolean,
  skipDirs: ReadonlySet<string> = TRUST_SKIP_DIRS,
): string[] {
  return [
    ...buildTrustFileInventory(root, { skipDirs }).matching((entry) => accept(entry.absolutePath)),
  ].map((entry) => entry.absolutePath);
}

function shouldScanTrustDoc(root: string, absPath: string): boolean {
  const rel = toPosix(relative(root, absPath));
  const parts = rel.split("/");
  const name = parts.at(-1) ?? "";
  if (name === "SKILL.md") return true;
  if (parts.length === 1 && ROOT_TRUST_DOCS.has(name)) return true;
  return extname(name).toLowerCase() === ".md";
}

function shouldScanStrictUnicodeSurface(root: string, absPath: string): boolean {
  const rel = toPosix(relative(root, absPath));
  return isStrictUnicodeSurface(rel) || isMaliciousCodeScanFilePath(rel);
}

function collectSkillDirs(root: string, inventory?: TrustFileInventory): string[] {
  return [
    ...new Set(
      (inventory
        ? [...inventory.matching((entry) => basename(entry.absolutePath) === "SKILL.md")].map(
            (entry) => entry.absolutePath,
          )
        : collectFilesUnder(root, (abs) => basename(abs) === "SKILL.md")
      ).map((abs) => dirname(abs)),
    ),
  ].sort((a, b) => toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))));
}

function skillDirLabel(root: string, skillDir: string): string {
  const rel = toPosix(relative(root, skillDir));
  return rel.length === 0 ? basename(root) : rel;
}

function readTextSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function hasInstallScriptHooks(root: string): boolean {
  const text = readTextSafe(join(root, "package.json"));
  if (text === undefined) return false;
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    const scripts = parsed.scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return false;
    return INSTALL_SCRIPT_HOOKS.some((hook) => Object.hasOwn(scripts, hook));
  } catch {
    return false;
  }
}

function isInstallScriptFile(name: string): boolean {
  return isInstallScriptEvidenceFilePath(name);
}

function fileNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isFile()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return statSync(join(dir, entry.name)).isFile();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function hasInstallScripts(root: string): boolean {
  if (hasInstallScriptHooks(root)) return true;
  return [root, join(root, "scripts")].some((dir) => fileNames(dir).some(isInstallScriptFile));
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function runtimeShapeRoots(root: string, skillDirs: readonly string[]): string[] {
  return [root, ...skillDirs];
}

function collectPackageManifestRels(root: string, skillDirs: readonly string[]): string[] {
  return uniqueValues(
    runtimeShapeRoots(root, skillDirs).flatMap((dir) =>
      PACKAGE_MANIFESTS.filter((name) => existsSync(join(dir, name))).map((name) =>
        toPosix(relative(root, join(dir, name))),
      ),
    ),
  );
}

function collectInstallScriptFileRels(root: string, skillDirs: readonly string[]): string[] {
  return uniqueValues(
    runtimeShapeRoots(root, skillDirs).flatMap((dir) => {
      const packageJson = join(dir, "package.json");
      const hookFiles = hasInstallScriptHooks(dir) ? [toPosix(relative(root, packageJson))] : [];
      const scriptFiles = [dir, join(dir, "scripts")].flatMap((scriptDir) =>
        fileNames(scriptDir)
          .filter(isInstallScriptFile)
          .map((name) => toPosix(relative(root, join(scriptDir, name)))),
      );
      return [...hookFiles, ...scriptFiles];
    }),
  );
}

function collectMcpConfigFileRels(root: string, skillDirs: readonly string[]): string[] {
  return uniqueValues(
    runtimeShapeRoots(root, skillDirs).flatMap((dir) =>
      [...INCOMING_MCP_CONFIG_FILES]
        .filter((name) => existsSync(join(dir, name)))
        .map((name) => toPosix(relative(root, join(dir, name)))),
    ),
  );
}

function sandboxSmokeShapeForTrustScan(
  root: string,
  inventory?: TrustFileInventory,
): SandboxSmokeShape {
  const skillDirs = collectSkillDirs(root, inventory);
  if (skillDirs.length === 0) {
    return {
      skillDirs: [],
      installScripts: false,
      installScriptFiles: [],
      mcpConfig: false,
      mcpConfigFiles: [],
      packageManifests: [],
    };
  }
  const installScriptFiles = collectInstallScriptFileRels(root, skillDirs);
  const mcpConfigFiles = collectMcpConfigFileRels(root, skillDirs);
  return {
    skillDirs: skillDirs.map((dir) => skillDirLabel(root, dir)),
    installScripts: installScriptFiles.length > 0 || hasInstallScripts(root),
    installScriptFiles,
    mcpConfig: mcpConfigFiles.length > 0,
    mcpConfigFiles,
    packageManifests: collectPackageManifestRels(root, skillDirs),
  };
}

function normalizeScanOptions(options: ScanTrustTreeOptions = {}): {
  env?: NodeJS.ProcessEnv;
  internalScopes: readonly string[];
  mcpPolicy?: OrgPolicy["mcp"];
  platform?: Platform;
  posture: Posture;
  requiredDetectors: readonly TrustDetectorName[];
  run?: Runner;
  sandboxSmokeShape?: SandboxSmokeShape;
  skillspectorImageApprovals: readonly SkillSpectorImageApproval[];
  progress?: (message: string) => void;
  inventoryFactory: NonNullable<ScanTrustTreeOptions["inventoryFactory"]>;
} {
  return {
    env: options.env,
    internalScopes: options.internalScopes ?? [],
    mcpPolicy: options.mcpPolicy,
    platform: options.platform,
    posture: options.posture ?? "vibe",
    requiredDetectors: options.requiredDetectors ?? [],
    run: options.run,
    sandboxSmokeShape: options.sandboxSmokeShape,
    skillspectorImageApprovals: options.skillspectorImageApprovals ?? [],
    progress: options.progress,
    inventoryFactory: options.inventoryFactory ?? buildTrustFileInventory,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collectIncomingMcpConfigFiles(root: string, inventory?: TrustFileInventory): string[] {
  return collectMcpConfigFileRels(root, collectSkillDirs(root, inventory));
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

function mcpServerConfigFingerprint(server: McpServer): string {
  const normalized =
    server.type === "stdio"
      ? {
          command: server.command,
          args: server.args,
          url: null,
          env: server.env ?? {},
          skillsProvider: server.skillsProvider ?? null,
        }
      : {
          command: null,
          args: [],
          url: server.url,
          env: {},
          skillsProvider: server.skillsProvider ?? null,
        };
  return contentHash(normalized).slice(0, 8);
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
  mcpPolicy: OrgPolicy["mcp"] | undefined,
): Check[] {
  const classifiedEntries = Object.entries(rawServers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, raw]) => [name, classifyIncomingMcp(raw)] as const);
  const classified: Record<string, McpServer> = Object.fromEntries(classifiedEntries);
  const policies = evaluateMcpPolicy(
    classified,
    posture,
    mcpPolicyOptionsFromConfig(mcpPolicy, { includeEgressApprovals: false }),
  );
  return policies.flatMap((policy) => {
    const server = classified[policy.name];
    if (server === undefined || policy.verdict === "allow") return [];
    const advisory = server.supplyChain === "hosted-remote" ? ` ${HOSTED_MCP_ADVISORY}` : "";
    const skillsAdvisory =
      server.skillsProvider === undefined || server.supplyChain !== "unpinned"
        ? ""
        : server.skillsProvider.hotReload
          ? " skills-over-MCP hot-reload drift risk is treated like @latest; disable reload and restart after approval changes."
          : " skills-over-MCP server version is unpinned; pin an exact FastMCP version.";
    const detail = `${rel} → ${mapKey}.${policy.name}: ${policy.reason}${advisory}${skillsAdvisory}`;
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
    return [
      mcpPolicyFail(
        rel,
        detail,
        `${mapKey}.${safeMcpName(policy.name)}:${mcpServerConfigFingerprint(server)}`,
      ),
    ];
  });
}

function skillsProviderEvidenceChecks(
  rel: string,
  mapKey: string,
  name: string,
  server: McpServer,
): Check[] {
  const evidence = server.skillsProvider;
  if (evidence === undefined) return [];
  const location = { uri: rel, startLine: 1 };
  const label = `${rel} → ${mapKey}.${name}`;
  if (evidence.manifestSha256 === undefined) {
    return [
      mcpPolicyFail(
        rel,
        `${label}: skills-over-MCP _manifest sha256 missing; record the _manifest SHA256 before promotion`,
        `${mapKey}.${safeMcpName(name)}:${mcpServerConfigFingerprint(server)}:manifest-missing`,
      ),
    ];
  }
  return [
    {
      name: "skills-over-MCP evidence",
      verdict: "pass",
      detail: [
        `${label}: skills-over-MCP provider=${evidence.provider}`,
        `server=${evidence.serverVersion === undefined ? "unpinned" : `fastmcp==${evidence.serverVersion}`}`,
        `egress=${server.egress}`,
        `_manifest=${evidence.manifestSha256}`,
        `reload=${evidence.hotReload ? "hot-reload drift risk" : "disabled"}`,
      ].join("; "),
      location,
    },
  ];
}

function incomingMcpChecks(
  root: string,
  mcpConfigFiles: readonly string[],
  posture: Posture,
  mcpPolicy: OrgPolicy["mcp"] | undefined,
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
        checks.push(
          ...skillsProviderEvidenceChecks(rel, map.key, name, classifyIncomingMcp(rawServer)),
        );
      }
      checks.push(...mcpPolicyChecks(rel, map.key, map.servers, posture, mcpPolicy));
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

function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function resolvedSourceSha(source: TrustSource): string | undefined {
  if (source.kind !== "github") return undefined;
  if (source.pin !== undefined) return source.pin.toLowerCase();
  try {
    return readTrustFetchMetadata(source).pinnedSha.toLowerCase();
  } catch {
    return undefined;
  }
}

function approvedSourceMatches(source: TrustSource, approved: ApprovedTrustSource): boolean {
  if (source.kind !== "github") return false;
  if (approved.owner.toLowerCase() !== source.owner.toLowerCase()) return false;
  if (approved.repo.toLowerCase() !== source.repo.toLowerCase()) return false;
  if (approved.pinnedSha === undefined) return true;
  return resolvedSourceSha(source) === approved.pinnedSha;
}

function sourceOriginFingerprint(
  code: "trust.untrusted-publisher" | "trust.unsigned-source",
  source: TrustSource,
  policy: NonNullable<OrgPolicy["trust"]>,
): string {
  const sourceName =
    source.kind === "github" ? `${source.owner}/${source.repo}`.toLowerCase() : source.id;
  const hash = contentHash({
    code,
    source:
      source.kind === "github"
        ? {
            owner: source.owner.toLowerCase(),
            repo: source.repo.toLowerCase(),
            ref: source.ref,
            pin: source.pin?.toLowerCase(),
            resolvedSha: resolvedSourceSha(source),
          }
        : { id: source.id, root: source.root },
    policy: {
      approvedSources: policy.approvedSources,
      requireSignedSource: policy.requireSignedSource,
    },
  }).slice(0, 8);
  return `${code.replace(/\./g, "-")}:${sourceName}:${hash}`;
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

function orgPolicyDriftCheck(error: unknown): Check {
  return {
    name: "org-policy drift",
    verdict: "fail",
    detail: `org-policy drift: aih-org-policy.json cannot be parsed (${(error as Error).message})`,
    code: "org-policy.drift",
    fingerprint: "org-policy-drift:policy-parse",
  };
}

export function trustSourceOriginChecks(ctx: PlanContext, source: TrustSource): Check[] {
  if (source.kind !== "github") return [];
  let policy: OrgPolicy["trust"] | undefined;
  try {
    policy = readOrgPolicy(ctx.root, ctx.env)?.trust;
  } catch (error) {
    if (error instanceof OrgPolicyError) return [orgPolicyDriftCheck(error)];
    throw error;
  }
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
        sourceOriginFingerprint("trust.untrusted-publisher", source, policy),
      ),
    );
  }
  if (policy.requireSignedSource && source.pin === undefined) {
    checks.push(
      sourceOriginCheck(
        "trust.unsigned-source",
        `${sourceName}@${source.ref} was acquired without an explicit --pin under trust.requireSignedSource`,
        posture,
        sourceOriginFingerprint("trust.unsigned-source", source, policy),
      ),
    );
  }
  return checks;
}

export async function scanTrustTree(
  root: string,
  options: ScanTrustTreeOptions = {},
): Promise<Check[]> {
  return (await scanTrustTreeWithAnalyzers(root, options)).checks;
}

export async function scanTrustTreeWithAnalyzers(
  root: string,
  options: ScanTrustTreeOptions = {},
): Promise<TrustScanResult> {
  const safeRoot = assertTrustTreeSafe(root, { skipDirs: TRUST_SKIP_DIRS });
  const {
    env,
    internalScopes,
    mcpPolicy,
    platform,
    posture,
    requiredDetectors,
    run,
    sandboxSmokeShape,
    skillspectorImageApprovals,
    progress,
    inventoryFactory,
  } = normalizeScanOptions(options);
  progress?.("trust scan: inventory started");
  const inventory = inventoryFactory(safeRoot, {
    skipDirs: TRUST_SKIP_DIRS,
    onProgress: (processed) =>
      progress?.(`trust scan: inventory ${processed.toLocaleString("en-US")} files`),
  });
  progress?.(
    `trust scan: inventory complete (${inventory.files.length.toLocaleString("en-US")} files)`,
  );
  const mcpConfigFiles = collectIncomingMcpConfigFiles(safeRoot, inventory);
  const nativeLintChecks: Check[] = [];
  let trustDocumentCount = 0;
  for (const entry of inventory.files) {
    if (shouldScanTrustDoc(safeRoot, entry.absolutePath)) {
      trustDocumentCount++;
      nativeLintChecks.push(
        ...scanTrustDocument(entry.relativePath, readFileSync(entry.absolutePath, "utf8")).map(
          (check) => gradeTrustCheck(check, posture),
        ),
      );
    } else if (shouldScanStrictUnicodeSurface(safeRoot, entry.absolutePath)) {
      nativeLintChecks.push(
        ...scanTrustUnicodeDocument(
          entry.relativePath,
          readFileSync(entry.absolutePath, "utf8"),
        ).map((check) => gradeTrustCheck(check, posture)),
      );
    }
  }
  const checks = [
    ...nativeLintChecks,
    ...scanTrustManifests(safeRoot, inventory),
    ...scanTrustDependencyNames(safeRoot, internalScopes, posture, inventory),
    ...plaintextSecretChecks(safeRoot, posture),
    ...mcpConfigSecretChecks(safeRoot, mcpConfigFiles, posture),
    ...incomingMcpChecks(safeRoot, mcpConfigFiles, posture, mcpPolicy),
    ...scanNativeMaliciousCode(safeRoot, inventory),
  ];
  const hasDetectorRuntime = run !== undefined && platform !== undefined && env !== undefined;
  const detectorResult = hasDetectorRuntime
    ? await runTrustDetectors(safeRoot, {
        env,
        platform,
        posture,
        requiredDetectors,
        run,
        skillspectorImageApprovals,
        inventory,
        progress,
      })
    : {
        checks: missingDetectorRuntimeChecks(requiredDetectors ?? [], posture),
        analyzersRun: [],
      };
  const mcpDetectorResult =
    mcpConfigFiles.length > 0 && hasDetectorRuntime
      ? await runMcpConfigDetectors(safeRoot, {
          env,
          platform,
          posture,
          requiredDetectors,
          run,
          skillspectorImageApprovals,
          inventory,
          progress,
        })
      : { checks: [], analyzersRun: [] };
  const effectiveSandboxSmokeShape =
    sandboxSmokeShape ?? sandboxSmokeShapeForTrustScan(safeRoot, inventory);
  const sandboxSmokeChecks = [
    await sandboxSmokeCheck(safeRoot, effectiveSandboxSmokeShape, {
      env,
      platform,
      run,
      skillspectorImageApprovals,
    }),
  ];
  const nonSmokeChecks = [...checks, ...detectorResult.checks, ...mcpDetectorResult.checks];
  const allChecks =
    nonSmokeChecks.length > 0
      ? [...nonSmokeChecks, ...sandboxSmokeChecks]
      : [passCheck(safeRoot, trustDocumentCount), ...sandboxSmokeChecks];
  return {
    analyzersRun: ["aih-native", ...detectorResult.analyzersRun, ...mcpDetectorResult.analyzersRun],
    checks: allChecks,
  };
}

function missingDetectorRuntimeChecks(
  requiredDetectors: readonly TrustDetectorName[],
  posture: Posture,
): Check[] {
  if (requiredDetectors.length === 0) return [];
  return requiredDetectors.map((detector) => ({
    name: `trust detector ${detector}`,
    verdict: posture === "enterprise" ? "fail" : "skip",
    // The verdict controls blocking behavior; the code keeps one diagnostic
    // identity for unavailable detectors across skip and fail postures.
    code: "trust.detector-unavailable",
    detail:
      posture === "enterprise"
        ? `required detector ${detector} unavailable: detector runtime is missing (run/platform/env).`
        : `DEGRADED-COVERAGE: deep scan SKIPPED - ${detector} not available (detector runtime missing); coverage is GREEN-tier only.`,
  }));
}

function acknowledgeChecks(checks: readonly Check[], ctx: PlanContext): Check[] {
  return applyTrustAcknowledgements(checks, ctx).checks;
}

function probesForStaticChecks(checks: Check[]): ProbeAction[] {
  return [structuredChecksProbe("trust scan", () => [...checks])];
}

function orgPolicyTrustChecks(error: unknown): Check[] {
  if (error instanceof OrgPolicyError) return [orgPolicyDriftCheck(error)];
  throw error;
}

function requiredDetectorsFromPolicy(ctx: PlanContext): {
  requiredDetectors: readonly TrustDetectorName[];
  skillspectorImageApprovals: readonly SkillSpectorImageApproval[];
  mcpPolicy?: OrgPolicy["mcp"];
  checks: Check[];
} {
  try {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    return {
      requiredDetectors: policy?.trust?.requiredDetectors ?? [],
      skillspectorImageApprovals: policy?.trust?.skillspector?.approvedDigests ?? [],
      mcpPolicy: policy?.mcp,
      checks: [],
    };
  } catch (error) {
    return {
      requiredDetectors: [],
      skillspectorImageApprovals: [],
      checks: orgPolicyTrustChecks(error),
    };
  }
}

export function scanOptionsFromContext(
  ctx: PlanContext,
  base: ScanTrustTreeOptions = {},
): ScanTrustTreeOptions {
  const policy = requiredDetectorsFromPolicy(ctx);
  return {
    ...base,
    env: ctx.env,
    platform: ctx.host.platform,
    posture: base.posture ?? postureFromContext(ctx),
    mcpPolicy: base.mcpPolicy ?? policy.mcpPolicy,
    requiredDetectors: policy.requiredDetectors,
    run: ctx.run,
    progress: ctx.progress,
    skillspectorImageApprovals: [
      ...policy.skillspectorImageApprovals,
      ...(base.skillspectorImageApprovals ?? []),
    ],
  };
}

export async function trustScanProbes(
  source: TrustSource,
  options: ScanTrustTreeOptions = {},
  ctx?: PlanContext,
): Promise<ProbeAction[]> {
  if (source.kind === "local") {
    const scan = await scanTrustTreeWithAnalyzers(
      source.root,
      ctx ? scanOptionsFromContext(ctx, options) : options,
    );
    return probesForStaticChecks(ctx ? acknowledgeChecks(scan.checks, ctx) : scan.checks);
  }
  return [
    structuredChecksProbe(`trust scan ${source.display}`, async (probeCtx) => {
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
      const scan = await scanTrustTreeWithAnalyzers(
        source.treePath,
        scanOptionsFromContext(probeCtx, options),
      );
      return acknowledgeChecks(scan.checks, probeCtx);
    }),
  ];
}

export async function trustScanPlanForSource(
  ctx: PlanContext,
  source: TrustSource,
  options: TrustScanPlanOptions = {},
): Promise<ReturnType<typeof plan>> {
  const actions: Action[] = [];
  const keepQuarantine = ctx.options.keepQuarantine === true;
  if (source.kind === "github" && keepQuarantine) {
    ctx.progress?.(`retained quarantine: ${source.quarantineRoot}`);
  } else if (source.kind === "github" && ctx.deferCleanup !== undefined) {
    ctx.deferCleanup(() => {
      const error = cleanupQuarantine(source);
      if (error !== undefined) throw error;
    });
  }
  const sandboxSmokeShape = options.sandboxSmokeShape ?? sandboxSmokeShapeForTrustScan;
  const policy = requiredDetectorsFromPolicy(ctx);
  const scanOptions = {
    internalScopes: resolveInternalScopes(ctx),
    posture: postureFromContext(ctx),
    requiredDetectors: policy.requiredDetectors,
  } satisfies ScanTrustTreeOptions;
  if (source.kind === "github") actions.push(trustFetchExec(source, ctx));
  actions.push(
    structuredChecksProbe("trust source origin", (probeCtx) =>
      acknowledgeChecks(
        policy.checks.length > 0 ? policy.checks : trustSourceOriginChecks(probeCtx, source),
        probeCtx,
      ),
    ),
  );
  if (source.kind === "local") {
    const scan = await scanTrustTreeWithAnalyzers(
      source.root,
      scanOptionsFromContext(ctx, {
        ...scanOptions,
        sandboxSmokeShape: sandboxSmokeShape(source.root),
      }),
    );
    actions.push(
      ...probesForStaticChecks(acknowledgeChecks(scan.checks, ctx)),
      digest("trust runtime advisory", trustRuntimeAdvisory(scan.analyzersRun)),
    );
  } else {
    let githubScan: Promise<TrustScanResult> | undefined;
    const scanGithubSource = (probeCtx: PlanContext): Promise<TrustScanResult> => {
      githubScan ??= scanTrustTreeWithAnalyzers(
        source.treePath,
        scanOptionsFromContext(probeCtx, {
          ...scanOptions,
          sandboxSmokeShape: sandboxSmokeShape(source.treePath),
        }),
      );
      return githubScan;
    };
    actions.push(
      structuredChecksProbe(`trust scan ${source.display}`, async (probeCtx) => {
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
        const scan = await scanGithubSource(probeCtx);
        return acknowledgeChecks(scan.checks, probeCtx);
      }),
      dynamicDigest("trust runtime advisory", async (digestCtx) => {
        try {
          if (!digestCtx.apply) return trustRuntimeAdvisory(["aih-native"]);
          const scan = await scanGithubSource(digestCtx);
          return trustRuntimeAdvisory(scan.analyzersRun);
        } catch {
          return trustRuntimeAdvisory(["aih-native"]);
        } finally {
          if (options.cleanupQuarantine && ctx.deferCleanup === undefined && !keepQuarantine) {
            cleanupQuarantine(source);
          }
        }
      }),
    );
  }
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
  return trustScanPlanForSource(ctx, source, { cleanupQuarantine: source.kind === "github" });
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
      flags: "--keep-quarantine",
      description: "retain the owned GitHub quarantine and print its path to stderr",
    },
    {
      flags: "--sarif <file>",
      description: "write verification results as SARIF (or - for stdout)",
    },
    {
      flags: "--acknowledge <fingerprints>",
      description:
        "skip exact trust-origin fingerprint(s) for this invocation only; use aih workspace add --acknowledge --reason to persist",
    },
    {
      flags: "--acknowledge-all",
      description:
        "skip every current trust-origin finding for this invocation only (requires --reason); use aih workspace add to persist",
    },
    {
      flags: "--reason <text>",
      description:
        "reason for a trust-origin acknowledgement; aih workspace add persists it to org-policy",
    },
  ],
  plan: trustScanPlan,
  alwaysVerify: true,
};
