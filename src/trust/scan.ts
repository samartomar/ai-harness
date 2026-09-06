import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { hashSourceTree } from "../baseline-evidence/hash.js";
import { nativeAnalyzerIdentity } from "../baseline-evidence/native-identity.js";
import { type Posture, postureFromContext } from "../config/posture.js";
import {
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { assertArtifactOutputPath, executePlan, writeArtifact } from "../internals/execute.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { Action, CommandSpec, PlanContext, ProbeAction } from "../internals/plan.js";
import { digest, dynamicDigest, plan, structuredChecksProbe } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import type { Check } from "../internals/verify.js";
import { evaluateMcpPolicy, mcpPolicyOptionsFromConfig } from "../mcp/policy.js";
import type { McpServer } from "../mcp/servers.js";
import { candidateIdentityDigest, stableJson } from "../org-policy/effective.js";
import { type OrgPolicy, OrgPolicyError, readOrgPolicy } from "../org-policy/schema.js";
import type { Platform } from "../platform/base.js";
import { mcpConfigSecretCheck, plaintextSecretCheck } from "../secrets/probes.js";
import { MCP_CONFIG_FILES, scanConfigSecrets, scanSecrets } from "../secrets/scan.js";
import { VERSION } from "../version.js";
import { applyTrustAcknowledgements } from "./acknowledge.js";
import {
  type ArtifactDirectoryResolutionRecordV2,
  type ArtifactEvidenceRecordInputV1,
  type ArtifactEvidenceRecordV1,
  type ArtifactObservedSourceV1,
  artifactDirectoryResolutionRecordV2,
  artifactEvidenceRecordV1,
  createArtifactEvidenceBundleV1,
  createArtifactEvidenceBundleV2,
} from "./artifact-evidence.js";
import {
  type ArtifactIntake,
  type ArtifactIntakeV1,
  type ArtifactIntakeV2,
  artifactIntakeDirectoryGroupsV2,
  artifactIntakeExactProjectionV1,
  artifactIntakeSourceGroupsV1,
  type EffectiveArtifactIntakeItemV1,
  parseArtifactIntakeText,
  parseArtifactIntakeV1Text,
} from "./artifact-intake.js";
import { resolveInternalScopes, scanTrustDependencyNames } from "./depnames.js";
import {
  runMcpConfigDetectors,
  runTrustDetectors,
  scanNativeMaliciousCode,
  type TrustDetectorName,
  trustRuntimeAdvisory,
} from "./detectors.js";
import {
  DirectoryRegistryResponseV1Schema,
  extractDirectoryClaimV1,
  resolveDirectoryClaimV1,
} from "./directory-resolution.js";
import {
  dispositionForTrustFinding,
  type NormalizedTrustFinding,
  normalizeTrustFindings,
  type RawScannerOccurrence,
  rawNativeOccurrences,
  type TrustPolicyDisposition,
} from "./evidence.js";
import {
  type ArtifactDirectoryTrustSource,
  type ArtifactIntakePackageTrustSource,
  assertTrustTreeSafe,
  cleanupQuarantine,
  type GitHubTrustFetchMetadataValidation,
  type PackageTrustSource,
  readArtifactDirectoryTrustFetch,
  readArtifactIntakePackageTrustFetchMetadata,
  resolveArtifactDirectoryTrustSource,
  resolveArtifactIntakePackageTrustSource,
  resolveGitHubTrustSource,
  resolvePackageTrustSource,
  resolveTrustSource,
  sameGitHubTrustFetchMetadata,
  type TrustFetchMetadata,
  type TrustSource,
  trustDirectoryFetchExec,
  trustFetchExec,
  trustPackageFetchActions,
  validateGitHubTrustFetchMetadata,
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
const TRUST_DETECTOR_NAMES = new Set<TrustDetectorName>([
  "skillspector",
  "cisco",
  "mcp-scanner",
  "semgrep",
  "snyk-agent-scan",
]);

function requiredTrustDetectorFloor(
  requiredDetectors: readonly string[] | undefined,
): readonly TrustDetectorName[] | undefined {
  if (requiredDetectors === undefined) return undefined;
  return requiredDetectors.map((detector) => {
    if (!TRUST_DETECTOR_NAMES.has(detector as TrustDetectorName)) {
      throw new TypeError(`unsupported required trust detector: ${detector}`);
    }
    return detector as TrustDetectorName;
  });
}

export interface ScanTrustTreeOptions {
  env?: NodeJS.ProcessEnv;
  internalScopes?: readonly string[];
  platform?: Platform;
  posture?: Posture;
  mcpPolicy?: OrgPolicy["mcp"];
  requiredDetectors?: readonly TrustDetectorName[];
  detectors?: readonly TrustDetectorName[];
  precomputedDetectorSarif?: Readonly<Partial<Record<TrustDetectorName, string>>>;
  run?: Runner;
  sandboxSmokeShape?: SandboxSmokeShape;
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
  progress?: (message: string) => void;
  inventoryFactory?: (root: string, options?: TrustInventoryBuildOptions) => TrustFileInventory;
}

export interface TrustScanResult {
  checks: Check[];
  analyzersRun: string[];
  /** One row per analyzer emission, before de-duplication or policy. */
  rawOccurrences?: RawScannerOccurrence[];
  /** AIH's contextual, de-duplicated interpretation of the raw rows. */
  normalizedFindings?: NormalizedTrustFinding[];
  /** Policy level for each normalized finding; never an install/profile verdict. */
  policyDispositions?: TrustPolicyDisposition[];
}

interface IncomingMcpServerMap {
  key: "mcpServers" | "servers" | "mcp";
  servers: Record<string, unknown>;
}

type ScannableTrustSource = TrustSource | PackageTrustSource | ArtifactIntakePackageTrustSource;

interface OperationalTrustExecutionPolicyV1 {
  posture: Posture;
  requiredDetectors: readonly TrustDetectorName[];
  internalScopes: readonly string[];
}

interface TrustScanPlanOptions {
  cleanupQuarantine?: boolean;
  sandboxSmokeShape?: (root: string) => SandboxSmokeShape | undefined;
  artifactEvidence?: {
    intake: ArtifactIntakeV1;
    items: readonly EffectiveArtifactIntakeItemV1[];
    records: Map<string, ArtifactEvidenceRecordV1>;
    problems: Record<string, string>;
    scan: ArtifactEvidenceRecordInputV1["scan"];
    treeDigests?: Map<string, string>;
  };
}

interface InternalTrustScanPlanOptions extends TrustScanPlanOptions {
  /** Private operational composition only; public callers cannot pass this through. */
  operationalExecutionPolicy?: OperationalTrustExecutionPolicyV1;
}

// npm accepts several non-registry specs (paths, git URLs) in `npm pack`.
// This command must never reinterpret a policy-pinned tarball scan as one of
// those sources, so accept only ordinary or scoped package names here.
const PACKAGE_TARGET =
  /^((?:@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*))@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)/;

const POLICY_FINDING_FOR_TRUST_CODE = {
  "trust.auto-exec-hook": "auto-executing-hook",
  "trust.hidden-unicode": "hidden-unicode",
  "trust.prompt-injection": "prompt-injection",
  "trust.secrets": "secrets",
} as const;

function packageTrustSourceForTarget(
  ctx: PlanContext,
  target: string,
): PackageTrustSource | undefined {
  const normalizedTarget = target.trim();
  const parsed = PACKAGE_TARGET.exec(normalizedTarget);
  if (parsed === null || parsed[0] !== normalizedTarget) return undefined;
  const packageName = parsed[1];
  const version = parsed[2];
  if (packageName === undefined || version === undefined) return undefined;
  const policy = readOrgPolicy(ctx.root, ctx.env);
  const matches = (policy?.governance?.catalog.custom ?? []).filter(
    (candidate) =>
      candidate.kind === "mcp" &&
      candidate.source.type === "stdio" &&
      candidate.source.package === packageName &&
      candidate.source.version === version,
  );
  if (matches.length !== 1) {
    throw new AihError(
      "npm package scan target must match exactly one pinned custom MCP candidate in aih-org-policy.json",
      "AIH_TRUST",
    );
  }
  const candidate = matches[0];
  if (candidate === undefined || candidate.source.type !== "stdio") {
    throw new AihError("matched custom MCP is not a pinned stdio package", "AIH_TRUST");
  }
  return resolvePackageTrustSource({
    package: candidate.source.package,
    version: candidate.source.version,
    integrity: candidate.source.integrity,
    registry: candidate.source.registry,
    candidate: candidate.id,
    source: candidate.source,
    evidenceRecord: candidate.evidence.record,
  });
}

function evidenceDetectorId(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 64) : "aih-native";
}

function packagePreflightEvidenceRecord(source: PackageTrustSource, scan: TrustScanResult): string {
  const sourceDigest = candidateIdentityDigest({ source: source.candidateSource });
  const findings = [
    ...new Set(
      scan.checks
        .filter((check) => check.verdict === "fail" && typeof check.code === "string")
        .map(
          (check) =>
            POLICY_FINDING_FOR_TRUST_CODE[check.code as keyof typeof POLICY_FINDING_FOR_TRUST_CODE],
        )
        .filter((code) => code !== undefined),
    ),
  ];
  const detectors = [...new Set(scan.analyzersRun.map(evidenceDetectorId))].map((id) => ({
    id,
    required: false,
    status: "pass",
  }));
  const state = scan.checks.some((check) => check.verdict === "fail")
    ? "failed"
    : scan.checks.some((check) => check.verdict === "skip")
      ? "missing"
      : "verified";
  const evidenceDigest =
    "sha256:" +
    createHash("sha256")
      .update(stableJson({ checks: scan.checks, source: source.candidateSource }), "utf8")
      .digest("hex");
  return JSON.stringify(
    {
      id: source.evidenceRecord,
      candidate: source.candidate,
      kind: "mcp",
      source: source.candidateSource,
      sourceDigest,
      evidenceDigest,
      identityDigest: sourceDigest,
      state,
      waivable: false,
      detectors,
      findings,
    },
    null,
    2,
  );
}

function artifactEvidenceState(
  scan: TrustScanResult,
  item: EffectiveArtifactIntakeItemV1,
  treePath: string,
  requiredDetectorFloor?: readonly TrustDetectorName[],
): "verified" | "failed" | "missing" {
  const sourcePath = item.source.path;
  if (sourcePath !== undefined && !existsSync(join(treePath, sourcePath))) return "missing";
  if (scan.checks.some((check) => check.verdict === "fail")) return "failed";
  const skipped = scan.checks.filter((check) => check.verdict === "skip");
  if (requiredDetectorFloor === undefined) {
    // Generic artifact evidence has no code-owned detector profile. Every
    // skipped check therefore leaves its public batch coverage incomplete.
    return skipped.length > 0 ? "missing" : "verified";
  }
  const requiredDetectorSkipped = skipped.some(
    (check) =>
      check.code === "trust.detector-unavailable" &&
      requiredDetectorFloor.includes(
        check.name.replace("trust detector ", "") as TrustDetectorName,
      ),
  );
  const sandboxSkipped = skipped.some((check) => check.code === "trust.sandbox-smoke-unavailable");
  return requiredDetectorSkipped || sandboxSkipped ? "missing" : "verified";
}

function artifactEvidenceFindings(scan: TrustScanResult): string[] {
  return [
    ...new Set(
      scan.checks
        .filter((check) => check.verdict === "fail" && typeof check.code === "string")
        .map(
          (check) =>
            POLICY_FINDING_FOR_TRUST_CODE[check.code as keyof typeof POLICY_FINDING_FOR_TRUST_CODE],
        )
        .filter((code) => code !== undefined),
    ),
  ];
}

function artifactObservedSource(
  source: Exclude<ScannableTrustSource, { kind: "local" | "package" }>,
): ArtifactObservedSourceV1 {
  if (source.kind === "github") {
    const validation = validateGitHubTrustFetchMetadata(source);
    if (validation.state !== "trusted") {
      throw new AihError(
        `artifact intake GitHub fetch metadata is ${validation.state}`,
        "AIH_TRUST",
      );
    }
    return { type: "github", commit: validation.metadata.pinnedSha };
  }
  const metadata = readArtifactIntakePackageTrustFetchMetadata(source);
  return {
    type: "npm",
    tarballSha256: metadata.tarballSha256,
    registryIntegrity: metadata.registryIntegrity,
  };
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
  detectors?: readonly TrustDetectorName[];
  precomputedDetectorSarif?: Readonly<Partial<Record<TrustDetectorName, string>>>;
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
    detectors: options.detectors,
    precomputedDetectorSarif: options.precomputedDetectorSarif,
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

function descriptionChecks(
  rel: string,
  mapKey: string,
  name: string,
  rawServer: unknown,
  posture: Posture,
): Check[] {
  if (!isRecord(rawServer) || typeof rawServer.description !== "string") return [];
  return scanTrustDocument(
    `${rel}#${mapKey}.${safeMcpName(name)}.description`,
    rawServer.description,
  ).map((check) => gradeTrustCheck(check, posture));
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
        checks.push(...descriptionChecks(rel, map.key, name, rawServer, posture));
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

function approvedSourceMatches(
  source: TrustSource,
  approved: ApprovedTrustSource,
  resolvedSha: string | undefined,
): boolean {
  if (source.kind !== "github") return false;
  if (approved.owner.toLowerCase() !== source.owner.toLowerCase()) return false;
  if (approved.repo.toLowerCase() !== source.repo.toLowerCase()) return false;
  if (approved.pinnedSha === undefined) return true;
  return resolvedSha === approved.pinnedSha;
}

function sourceOriginFingerprint(
  code: "trust.untrusted-publisher" | "trust.unsigned-source",
  source: TrustSource,
  policy: NonNullable<OrgPolicy["trust"]>,
  resolvedSha: string | undefined,
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
            resolvedSha,
          }
        : { id: source.id, root: source.root },
    policy: {
      approvedSources: policy.approvedSources,
      requireSignedSource: policy.requireSignedSource,
    },
  }).slice(0, 8);
  return `${code.replace(/\./g, "-")}:${sourceName}:${hash}`;
}

export function githubFetchMetadataCheck(
  source: Extract<TrustSource, { kind: "github" }>,
  validation: GitHubTrustFetchMetadataValidation = validateGitHubTrustFetchMetadata(source),
): Check | undefined {
  if (validation.state === "trusted") return undefined;
  const detail = {
    missing: "fetched GitHub metadata is missing",
    unreadable: "fetched GitHub metadata cannot be read",
    malformed: "fetched GitHub metadata is malformed",
    mismatched: "fetched GitHub metadata does not bind the requested source",
  }[validation.state];
  return {
    name: "trust.fetch-metadata",
    verdict: "fail",
    code: `trust.fetch-metadata-${validation.state}`,
    detail,
  };
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

export function trustSourceOriginChecks(ctx: PlanContext, source: ScannableTrustSource): Check[] {
  if (source.kind !== "github") return [];
  const checks: Check[] = [];
  const fetchedMetadata = ctx.apply ? validateGitHubTrustFetchMetadata(source) : undefined;
  if (fetchedMetadata !== undefined) {
    const metadataCheck = githubFetchMetadataCheck(source, fetchedMetadata);
    if (metadataCheck !== undefined) checks.push(metadataCheck);
  }
  const resolvedSha =
    fetchedMetadata === undefined
      ? source.pin?.toLowerCase()
      : fetchedMetadata.state === "trusted"
        ? fetchedMetadata.metadata.pinnedSha
        : undefined;
  let policy: OrgPolicy["trust"] | undefined;
  try {
    policy = readOrgPolicy(ctx.root, ctx.env)?.trust;
  } catch (error) {
    if (error instanceof OrgPolicyError) return [...checks, orgPolicyDriftCheck(error)];
    throw error;
  }
  if (policy === undefined) return checks;

  const posture = postureFromContext(ctx);
  const sourceName = `${source.owner}/${source.repo}`;
  if (
    policy.approvedSources !== undefined &&
    !policy.approvedSources.some((approved) => approvedSourceMatches(source, approved, resolvedSha))
  ) {
    checks.push(
      sourceOriginCheck(
        "trust.untrusted-publisher",
        `${sourceName} is not listed in org-policy trust.approvedSources`,
        posture,
        sourceOriginFingerprint("trust.untrusted-publisher", source, policy, resolvedSha),
      ),
    );
  }
  if (policy.requireSignedSource && source.pin === undefined) {
    checks.push(
      sourceOriginCheck(
        "trust.unsigned-source",
        `${sourceName}@${source.ref} was acquired without an explicit --pin under trust.requireSignedSource`,
        posture,
        sourceOriginFingerprint("trust.unsigned-source", source, policy, resolvedSha),
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
    detectors,
    precomputedDetectorSarif,
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
        detectors,
        precomputedSarif: precomputedDetectorSarif,
        run,
        skillspectorImageApprovals,
        inventory,
        corroboratedChecks: checks,
        progress,
      })
    : {
        checks: missingDetectorRuntimeChecks(requiredDetectors ?? [], posture),
        analyzersRun: [],
        rawOccurrences: [],
      };
  const mcpDetectorResult =
    mcpConfigFiles.length > 0 && hasDetectorRuntime
      ? await runMcpConfigDetectors(safeRoot, {
          env,
          platform,
          posture,
          requiredDetectors,
          detectors,
          precomputedSarif: precomputedDetectorSarif,
          run,
          skillspectorImageApprovals,
          inventory,
          corroboratedChecks: checks,
          progress,
        })
      : { checks: [], analyzersRun: [], rawOccurrences: [] };
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
  const rawOccurrences = [
    ...rawNativeOccurrences(safeRoot, checks),
    ...detectorResult.rawOccurrences,
    ...mcpDetectorResult.rawOccurrences,
  ];
  const normalizedFindings = normalizeTrustFindings(safeRoot, allChecks, rawOccurrences);
  return {
    analyzersRun: ["aih-native", ...detectorResult.analyzersRun, ...mcpDetectorResult.analyzersRun],
    checks: allChecks,
    rawOccurrences,
    normalizedFindings,
    policyDispositions: normalizedFindings.map(dispositionForTrustFinding),
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
  operationalExecutionPolicy?: OperationalTrustExecutionPolicyV1,
): ScanTrustTreeOptions {
  const policy =
    operationalExecutionPolicy === undefined ? requiredDetectorsFromPolicy(ctx) : undefined;
  return {
    ...base,
    env: ctx.env,
    platform: ctx.host.platform,
    posture: base.posture ?? operationalExecutionPolicy?.posture ?? postureFromContext(ctx),
    mcpPolicy: base.mcpPolicy ?? policy?.mcpPolicy,
    requiredDetectors:
      base.requiredDetectors ??
      operationalExecutionPolicy?.requiredDetectors ??
      policy?.requiredDetectors,
    run: ctx.run,
    progress: ctx.progress,
    skillspectorImageApprovals: [
      ...(policy?.skillspectorImageApprovals ?? []),
      ...(base.skillspectorImageApprovals ?? []),
    ],
  };
}

export async function trustScanProbes(
  source: ScannableTrustSource,
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

/** Public planner: ignores unrecognized runtime properties such as forged operational policy. */
export async function trustScanPlanForSource(
  ctx: PlanContext,
  source: ScannableTrustSource,
  options: TrustScanPlanOptions = {},
): Promise<ReturnType<typeof plan>> {
  const { cleanupQuarantine, sandboxSmokeShape, artifactEvidence } = options;
  return trustScanPlanForSourceInternal(ctx, source, {
    ...(cleanupQuarantine === undefined ? {} : { cleanupQuarantine }),
    ...(sandboxSmokeShape === undefined ? {} : { sandboxSmokeShape }),
    ...(artifactEvidence === undefined ? {} : { artifactEvidence }),
  });
}

async function trustScanPlanForSourceInternal(
  ctx: PlanContext,
  source: ScannableTrustSource,
  options: InternalTrustScanPlanOptions = {},
): Promise<ReturnType<typeof plan>> {
  const actions: Action[] = [];
  const keepQuarantine = ctx.options.keepQuarantine === true;
  const remoteSource = source.kind !== "local";
  if (remoteSource && keepQuarantine) {
    ctx.progress?.(`retained quarantine: ${source.quarantineRoot}`);
  } else if (remoteSource && ctx.deferCleanup !== undefined) {
    ctx.deferCleanup(() => {
      const error = cleanupQuarantine(source);
      if (error !== undefined) throw error;
    });
  }
  const sandboxSmokeShape = options.sandboxSmokeShape ?? sandboxSmokeShapeForTrustScan;
  const operationalExecutionPolicy = options.operationalExecutionPolicy;
  const policy =
    operationalExecutionPolicy === undefined ? requiredDetectorsFromPolicy(ctx) : undefined;
  const scanOptions = {
    internalScopes: operationalExecutionPolicy?.internalScopes ?? resolveInternalScopes(ctx),
    posture: operationalExecutionPolicy?.posture ?? postureFromContext(ctx),
    requiredDetectors:
      requiredTrustDetectorFloor(options.artifactEvidence?.scan.requiredDetectors) ??
      operationalExecutionPolicy?.requiredDetectors ??
      policy?.requiredDetectors,
  } satisfies ScanTrustTreeOptions;
  if (source.kind === "github") actions.push(trustFetchExec(source, ctx));
  if (source.kind === "package" || source.kind === "artifact-intake-package") {
    actions.push(...trustPackageFetchActions(source, ctx));
  }
  actions.push(
    structuredChecksProbe("trust source origin", (probeCtx) =>
      acknowledgeChecks(
        policy === undefined
          ? []
          : policy.checks.length > 0
            ? policy.checks
            : trustSourceOriginChecks(probeCtx, source),
        probeCtx,
      ),
    ),
  );
  if (source.kind === "local") {
    const scan = await scanTrustTreeWithAnalyzers(
      source.root,
      scanOptionsFromContext(
        ctx,
        { ...scanOptions, sandboxSmokeShape: sandboxSmokeShape(source.root) },
        operationalExecutionPolicy,
      ),
    );
    actions.push(
      ...probesForStaticChecks(acknowledgeChecks(scan.checks, ctx)),
      digest("trust runtime advisory", trustRuntimeAdvisory(scan.analyzersRun)),
    );
  } else {
    let remoteScan: Promise<TrustScanResult> | undefined;
    let scannedTreeDigest: string | undefined;
    const scanRemoteSource = (probeCtx: PlanContext): Promise<TrustScanResult> => {
      if (remoteScan !== undefined) return remoteScan;
      let metadataBeforeScan: TrustFetchMetadata | undefined;
      if (source.kind === "github") {
        const validation = validateGitHubTrustFetchMetadata(source);
        if (validation.state !== "trusted") {
          const metadataCheck = githubFetchMetadataCheck(source, validation);
          if (metadataCheck === undefined) throw new Error("expected metadata failure check");
          remoteScan = Promise.resolve({ checks: [metadataCheck], analyzersRun: [] });
          return remoteScan;
        }
        metadataBeforeScan = validation.metadata;
      }
      remoteScan = (async () => {
        const treeBefore = hashSourceTree(source.treePath).treeSha256;
        const scan = await scanTrustTreeWithAnalyzers(
          source.treePath,
          scanOptionsFromContext(
            probeCtx,
            { ...scanOptions, sandboxSmokeShape: sandboxSmokeShape(source.treePath) },
            operationalExecutionPolicy,
          ),
        );
        const treeAfter = hashSourceTree(source.treePath).treeSha256;
        if (treeBefore !== treeAfter) {
          throw new Error(`trust source tree changed during scan: ${source.display}`);
        }
        if (source.kind === "github") {
          const validation = validateGitHubTrustFetchMetadata(source);
          if (
            metadataBeforeScan === undefined ||
            validation.state !== "trusted" ||
            !sameGitHubTrustFetchMetadata(metadataBeforeScan, validation.metadata)
          ) {
            const metadataCheck = githubFetchMetadataCheck(
              source,
              validation.state === "trusted" ? { state: "mismatched" } : validation,
            );
            if (metadataCheck === undefined) throw new Error("expected metadata failure check");
            return { checks: [metadataCheck], analyzersRun: [] };
          }
        }
        scannedTreeDigest = treeAfter;
        return scan;
      })();
      return remoteScan;
    };
    const preflightEvidence =
      source.kind === "package"
        ? dynamicDigest(`preflight evidence record ${source.evidenceRecord}`, async (digestCtx) => {
            if (!digestCtx.apply) {
              return (
                "Preflight evidence record " +
                source.evidenceRecord +
                " is not emitted in dry-run; pass --apply to fetch, hash, and scan the pinned npm tarball."
              );
            }
            const scan = await scanRemoteSource(digestCtx);
            return (
              "Preflight evidence record " +
              source.evidenceRecord +
              " (not authority; obtain independent receipt attestation before activation):\n" +
              JSON.stringify(
                { evidence: [JSON.parse(packagePreflightEvidenceRecord(source, scan))] },
                null,
                2,
              )
            );
          })
        : undefined;
    const artifactEvidence =
      options.artifactEvidence === undefined || source.kind === "package"
        ? undefined
        : dynamicDigest(`artifact evidence for ${source.display}`, async (digestCtx) => {
            if (!digestCtx.apply) {
              return `Artifact evidence for ${source.display} is not emitted in dry-run; pass --apply to fetch, hash, and scan the exact source.`;
            }
            try {
              const scan = await scanRemoteSource(digestCtx);
              const observed = artifactObservedSource(source);
              for (const item of options.artifactEvidence?.items ?? []) {
                const record = artifactEvidenceRecordV1({
                  intake: options.artifactEvidence?.intake as ArtifactIntakeV1,
                  item,
                  state: artifactEvidenceState(
                    scan,
                    item,
                    source.treePath,
                    operationalExecutionPolicy?.requiredDetectors,
                  ),
                  observed,
                  analyzersRun: scan.analyzersRun,
                  checks: scan.checks,
                  findings: artifactEvidenceFindings(scan),
                  scan: options.artifactEvidence?.scan as ArtifactEvidenceRecordInputV1["scan"],
                });
                options.artifactEvidence?.records.set(item.id, record);
                if (scannedTreeDigest === undefined)
                  throw new Error("exact trust tree digest is unavailable after scan");
                options.artifactEvidence?.treeDigests?.set(item.id, scannedTreeDigest);
                delete options.artifactEvidence?.problems[item.id];
              }
              return `Prepared ${String(options.artifactEvidence?.items.length ?? 0)} preflight evidence record(s) for ${source.display}; these records are not authority, approval, installation, or activation.`;
            } catch (error) {
              const problem = (error instanceof Error ? error.message : String(error)).slice(
                0,
                500,
              );
              for (const item of options.artifactEvidence?.items ?? []) {
                if (options.artifactEvidence !== undefined) {
                  options.artifactEvidence.problems[item.id] = problem;
                }
              }
              return `No preflight evidence was prepared for ${source.display}: ${problem}`;
            }
          });
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
        const scan = await scanRemoteSource(probeCtx);
        return acknowledgeChecks(scan.checks, probeCtx);
      }),
      ...(preflightEvidence === undefined ? [] : [preflightEvidence]),
      ...(artifactEvidence === undefined ? [] : [artifactEvidence]),
      dynamicDigest("trust runtime advisory", async (digestCtx) => {
        try {
          if (!digestCtx.apply) return trustRuntimeAdvisory(["aih-native"]);
          const scan = await scanRemoteSource(digestCtx);
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

function artifactIntakeTarget(ctx: PlanContext, target: string): ArtifactIntake | undefined {
  const absolute = isAbsolute(target) ? target : resolve(ctx.root, target);
  if (!existsSync(absolute) || statSync(absolute).isDirectory()) return undefined;
  const opened = readRegularFileWithStats(absolute, { maxBytes: 1024 * 1024 });
  if (opened === undefined || opened.identity.nlink !== 1n) {
    throw new AihError(
      "artifact intake must be a single-link regular JSON file no larger than 1 MiB",
      "AIH_TRUST",
    );
  }
  return parseArtifactIntakeText(opened.contents.toString("utf8"));
}

function artifactEvidenceOutput(ctx: PlanContext): string | undefined {
  const evidenceOut = ctx.options.evidenceOut;
  if (ctx.apply && (typeof evidenceOut !== "string" || evidenceOut.trim().length === 0)) {
    throw new AihError(
      "artifact intake scanning with --apply requires --evidence-out <file>",
      "AIH_TRUST",
    );
  }
  if (ctx.apply) assertArtifactOutputPath(ctx, String(evidenceOut));
  return typeof evidenceOut === "string" ? evidenceOut : undefined;
}

async function appendExactArtifactScanActions(
  ctx: PlanContext,
  intake: ArtifactIntakeV1,
  records: Map<string, ArtifactEvidenceRecordV1>,
  problems: Record<string, string>,
  actions: Action[],
  scan: ArtifactEvidenceRecordInputV1["scan"],
  treeDigests?: Map<string, string>,
  operationalExecutionPolicy?: OperationalTrustExecutionPolicyV1,
): Promise<void> {
  for (const group of artifactIntakeSourceGroupsV1(intake)) {
    const source: Exclude<ScannableTrustSource, { kind: "local" | "package" }> =
      group.source.type === "github"
        ? resolveGitHubTrustSource(group.source.repository, {
            root: ctx.root,
            pin: group.source.commit,
            skipDirs: TRUST_SKIP_DIRS,
          })
        : resolveArtifactIntakePackageTrustSource({
            package: group.source.package,
            version: group.source.version,
            registry: group.source.registry,
            ...(group.source.integrity === undefined
              ? {}
              : { registryIntegrity: group.source.integrity }),
          });
    const sourcePlan = await trustScanPlanForSourceInternal(ctx, source, {
      cleanupQuarantine: true,
      artifactEvidence: { intake, items: group.items, records, problems, scan, treeDigests },
      ...(operationalExecutionPolicy === undefined ? {} : { operationalExecutionPolicy }),
    });
    actions.push(...sourcePlan.actions);
  }
}

function artifactEvidenceScanContext(
  ctx: PlanContext,
  requiredDetectorFloor?: readonly TrustDetectorName[],
  trustedScanPolicy: unknown = readOrgPolicy(ctx.root, ctx.env)?.trust ?? null,
): ArtifactEvidenceRecordInputV1["scan"] {
  const requiredDetectors = [
    ...(requiredDetectorFloor ?? requiredDetectorsFromPolicy(ctx).requiredDetectors),
  ].sort();
  const observedAt = new Date().toISOString();
  const posture = postureFromContext(ctx);
  return {
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + 24 * 60 * 60 * 1000).toISOString(),
    posture,
    scanner: {
      name: "@aihq/core",
      version: VERSION,
      nativeIdentity: nativeAnalyzerIdentity(),
    },
    requiredDetectors,
    policyDigest: `sha256:${canonicalStrictJsonSha256V1({
      domain: "aih-artifact-scan-policy/v1",
      posture,
      requiredDetectors,
      trust: trustedScanPolicy,
    })}`,
  };
}

const operationalExactArtifactScanWitnesses = new WeakMap<
  object,
  Readonly<{
    intakeBytes: string;
    intake: ArtifactIntakeV1;
    records: ReadonlyMap<string, ArtifactEvidenceRecordV1>;
    treeDigests: ReadonlyMap<string, string>;
    problems: Readonly<Record<string, string>>;
  }>
>();

/** Opaque same-process witness minted only by the default-runner operational scan. */
export interface OperationalExactArtifactScanV1 {
  readonly kind: "operational-exact-artifact-scan/v1";
}

/**
 * Runs a fresh exact npm/GitHub artifact scan for Core preparation. It deliberately
 * replaces every caller runner with the process default and accepts no serialized
 * records, precomputed analyzer output, or result factory.
 */
export async function scanExactArtifactIntakeOperationalV1(
  context: Omit<PlanContext, "apply" | "run">,
  intakeBytes: string,
): Promise<OperationalExactArtifactScanV1> {
  if (Buffer.byteLength(intakeBytes, "utf8") > 1_000_000)
    throw new TypeError("fresh artifact intake exceeds 1 MiB");
  const intake = parseArtifactIntakeV1Text(intakeBytes);
  const records = new Map<string, ArtifactEvidenceRecordV1>();
  const treeDigests = new Map<string, string>();
  const problems: Record<string, string> = Object.fromEntries(
    intake.items.map((item) => [item.id, "not scanned"]),
  );
  const actions: Action[] = [];
  const operationalContext: PlanContext = {
    ...context,
    apply: true,
    run: defaultRunner,
    options: { ...context.options, keepQuarantine: false },
  };
  // Rootless policy generation may have no detector requirements. Fresh Core
  // preparation has a code-owned floor and hashes that exact floor into policyDigest.
  // Fresh preparation has an explicit posture and code-owned detector floor.
  // It must never inherit a policy file or environment override from the
  // administrator root being scanned.
  if (operationalContext.posture === undefined) {
    throw new TypeError("fresh artifact scan requires an explicit posture");
  }
  const operationalExecutionPolicy: OperationalTrustExecutionPolicyV1 = {
    posture: operationalContext.posture,
    requiredDetectors: ["semgrep"],
    internalScopes: [],
  };
  const scan = artifactEvidenceScanContext(
    operationalContext,
    operationalExecutionPolicy.requiredDetectors,
    null,
  );
  await appendExactArtifactScanActions(
    operationalContext,
    intake,
    records,
    problems,
    actions,
    scan,
    treeDigests,
    operationalExecutionPolicy,
  );
  await executePlan(plan("fresh organization artifact scan", ...actions), operationalContext);
  const witness: OperationalExactArtifactScanV1 = Object.freeze({
    kind: "operational-exact-artifact-scan/v1",
  });
  operationalExactArtifactScanWitnesses.set(
    witness,
    Object.freeze({
      intakeBytes,
      intake: structuredClone(intake),
      records: new Map([...records].map(([id, record]) => [id, structuredClone(record)])),
      treeDigests: new Map(treeDigests),
      problems: Object.freeze({ ...problems }),
    }),
  );
  return witness;
}

/** Internal Core consumer seam; cloned or serialized witnesses have no payload. */
export function operationalExactArtifactScanPayloadV1(witness: unknown):
  | Readonly<{
      intakeBytes: string;
      intake: ArtifactIntakeV1;
      records: ReadonlyMap<string, ArtifactEvidenceRecordV1>;
      treeDigests: ReadonlyMap<string, string>;
      problems: Readonly<Record<string, string>>;
    }>
  | undefined {
  if (typeof witness !== "object" || witness === null) return undefined;
  const payload = operationalExactArtifactScanWitnesses.get(witness);
  if (payload === undefined) return undefined;
  return {
    intakeBytes: payload.intakeBytes,
    intake: structuredClone(payload.intake),
    records: new Map([...payload.records].map(([id, record]) => [id, structuredClone(record)])),
    treeDigests: new Map(payload.treeDigests),
    problems: { ...payload.problems },
  };
}

async function artifactIntakeScanPlanV1(
  ctx: PlanContext,
  intake: ArtifactIntakeV1,
): Promise<ReturnType<typeof plan>> {
  const evidenceOut = artifactEvidenceOutput(ctx);
  const records = new Map<string, ArtifactEvidenceRecordV1>();
  const problems: Record<string, string> = Object.fromEntries(
    intake.items.map((item) => [item.id, "not scanned"]),
  );
  const actions: Action[] = [];
  await appendExactArtifactScanActions(
    ctx,
    intake,
    records,
    problems,
    actions,
    artifactEvidenceScanContext(ctx),
  );
  actions.push(
    dynamicDigest("artifact evidence bundle", (digestCtx) => {
      if (!digestCtx.apply) {
        return "Artifact intake validated. Pass --apply --evidence-out <file> to acquire each unique exact source once and write one preflight evidence bundle; no package is installed or activated.";
      }
      const bundle = createArtifactEvidenceBundleV1(intake, [...records.values()], problems);
      const output = String(evidenceOut);
      writeArtifact(digestCtx, output, JSON.stringify(bundle, null, 2));
      return {
        text: `Wrote ${String(bundle.evidence.length)} non-authoritative preflight evidence record(s) for ${String(bundle.results.length)} requested artifact(s) to ${output}.`,
        data: bundle,
      };
    }),
  );
  return plan("trust scan", ...actions);
}

function directoryResolutionAction(
  ctx: PlanContext,
  intake: ArtifactIntakeV2,
  source: ArtifactDirectoryTrustSource,
  items: ReturnType<typeof artifactIntakeDirectoryGroupsV2>[number]["items"],
  resolutions: Map<string, ArtifactDirectoryResolutionRecordV2>,
  problems: Record<string, string>,
): Action {
  return dynamicDigest(`resolve ${source.display} claim`, (digestCtx) => {
    if (!digestCtx.apply) {
      return `Directory claim for ${source.display} is not resolved in dry-run; pass --apply to fetch the claim and official MCP Registry metadata into quarantine. No package is installed or activated.`;
    }
    try {
      const fetched = readArtifactDirectoryTrustFetch(source);
      const claim = extractDirectoryClaimV1(
        { provider: source.provider, slug: source.slug, url: source.directoryUrl },
        fetched.directoryHtml,
      );
      const registry = DirectoryRegistryResponseV1Schema.parse(
        parseStrictJsonObjectV1(fetched.registryJson, "official MCP registry response"),
      );
      const resolution = resolveDirectoryClaimV1(claim, registry);
      for (const item of items) {
        const record = artifactDirectoryResolutionRecordV2({ intake, item, resolution });
        resolutions.set(item.id, record);
        delete problems[item.id];
      }
      return `Prepared ${String(items.length)} non-authoritative directory resolution record(s) for ${source.display}; exact source selection and a separate scan are still required.`;
    } catch (error) {
      const problem = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      for (const item of items) problems[item.id] = problem;
      return `No directory resolution was prepared for ${source.display}: ${problem}`;
    } finally {
      if (ctx.deferCleanup === undefined && ctx.options.keepQuarantine !== true) {
        cleanupQuarantine(source);
      }
    }
  });
}

async function artifactIntakeScanPlanV2(
  ctx: PlanContext,
  intake: ArtifactIntakeV2,
): Promise<ReturnType<typeof plan>> {
  const evidenceOut = artifactEvidenceOutput(ctx);
  const records = new Map<string, ArtifactEvidenceRecordV1>();
  const resolutions = new Map<string, ArtifactDirectoryResolutionRecordV2>();
  const problems: Record<string, string> = Object.fromEntries(
    intake.items.map((item) => [item.id, "not scanned"]),
  );
  const actions: Action[] = [];
  const exactIntake = artifactIntakeExactProjectionV1(intake);
  if (exactIntake !== undefined) {
    await appendExactArtifactScanActions(
      ctx,
      exactIntake,
      records,
      problems,
      actions,
      artifactEvidenceScanContext(ctx),
    );
  }
  for (const group of artifactIntakeDirectoryGroupsV2(intake)) {
    const source = resolveArtifactDirectoryTrustSource(group.source);
    actions.push(
      trustDirectoryFetchExec(source, ctx),
      directoryResolutionAction(ctx, intake, source, group.items, resolutions, problems),
    );
  }
  actions.push(
    dynamicDigest("artifact evidence bundle", (digestCtx) => {
      if (!digestCtx.apply) {
        return "Artifact intake validated. Pass --apply --evidence-out <file> to fetch each unique exact or directory source once and write one review bundle; directory resolution is not scan evidence, approval, installation, or activation.";
      }
      const bundle = createArtifactEvidenceBundleV2(
        intake,
        [...records.values()],
        [...resolutions.values()],
        problems,
      );
      const output = String(evidenceOut);
      writeArtifact(digestCtx, output, JSON.stringify(bundle, null, 2));
      return {
        text: `Wrote ${String(bundle.evidence.length)} preflight evidence record(s) and ${String(bundle.resolutions.length)} non-authoritative directory resolution record(s) for ${String(bundle.results.length)} requested artifact(s) to ${output}.`,
        data: bundle,
      };
    }),
  );
  return plan("trust scan", ...actions);
}

async function artifactIntakeScanPlan(
  ctx: PlanContext,
  intake: ArtifactIntake,
): Promise<ReturnType<typeof plan>> {
  return intake.version === 1
    ? artifactIntakeScanPlanV1(ctx, intake)
    : artifactIntakeScanPlanV2(ctx, intake);
}

async function trustScanPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const target = ctx.options.target;
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new AihError(
      "trust scan requires a path, owner/repo, or a policy-pinned package at an exact version",
      "AIH_TRUST",
    );
  }
  const intake = artifactIntakeTarget(ctx, target);
  if (intake !== undefined) return artifactIntakeScanPlan(ctx, intake);
  const packageSource = packageTrustSourceForTarget(ctx, target);
  if (packageSource !== undefined) {
    return trustScanPlanForSource(ctx, packageSource, { cleanupQuarantine: true });
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
  return trustScanPlanForSource(ctx, source, { cleanupQuarantine: source.kind !== "local" });
}

export const trustScanCommand: CommandSpec = {
  name: "scan",
  summary:
    "Scan a local source, GitHub owner/repo, policy-pinned npm package, or artifact intake batch before promotion",
  options: [
    {
      flags: "--pin <sha>",
      description: "fetch exactly this Git commit SHA for owner/repo sources",
    },
    { flags: "--ref <ref>", description: "GitHub ref to resolve before downloading the tarball" },
    {
      flags: "--keep-quarantine",
      description: "retain the owned remote-source quarantine and print its path to stderr",
    },
    {
      flags: "--sarif <file>",
      description: "write verification results as SARIF (or - for stdout)",
    },
    {
      flags: "--evidence-out <file>",
      description: "write one non-authoritative preflight evidence bundle for an artifact intake",
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
