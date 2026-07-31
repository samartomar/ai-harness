import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashComponentTree } from "../baseline-evidence/hash.js";
import type { Posture } from "../config/posture.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { Runner, RunResult } from "../internals/proc.js";
import type { Check, CheckCode } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";
import { MCP_CONFIG_FILES } from "../secrets/scan.js";
import { execArgv } from "../tools/install.js";
import {
  buildCiscoShardManifest,
  buildCiscoShardResultAsync,
  type CiscoShardManifest,
  type CiscoShardResult,
  type JoinedCiscoShardEvidence,
} from "./cisco-shards.js";
import { dockerBindMountArg } from "./docker.js";
import type { RawScannerOccurrence } from "./evidence.js";
import { scrubDockerClientEnv, scrubFetchEnv } from "./fetch.js";
import { contentFindingFingerprint } from "./fingerprint.js";
import { gradeTrustCheck } from "./grade.js";
import {
  resolveVerifiedSkillspectorImage,
  SKILLSPECTOR_IMAGE,
  type SkillSpectorImageApproval,
} from "./images.js";
import type { TrustFileInventory } from "./inventory.js";
import {
  classifyUnicodeRisk,
  detectorReportedHiddenUnicodeRisk,
  isStrictUnicodeSurface,
  scanTrustDocument,
  type UnicodeRisk,
} from "./lint.js";
import { collectFilesUnder, TRUST_SKIP_DIRS } from "./scan.js";
import { isInstallScriptEvidenceFilePath, isMaliciousCodeScanFilePath } from "./script-files.js";

const INCOMING_MCP_CONFIG_FILES = new Set([...MCP_CONFIG_FILES, "mcp.json"]);

// Detector names land here only when the adapter can at least surface an honest
// availability check. A required-but-unavailable detector fails closed at
// enterprise posture rather than silently passing.
export type TrustDetectorName =
  | "skillspector"
  | "cisco"
  | "mcp-scanner"
  | "semgrep"
  | "snyk-agent-scan";

export interface TrustDetector {
  name: TrustDetectorName;
  analyzerLabel: string;
  checkAvailable: (
    run: Runner,
    platform: Platform,
    env: NodeJS.ProcessEnv,
    runtimeOptions?: TrustDetectorRuntimeOptions,
  ) => Promise<string | undefined>;
  runScan: (
    run: Runner,
    platform: Platform,
    env: NodeJS.ProcessEnv,
    tree: string,
    runtimeOptions?: TrustDetectorRuntimeOptions,
  ) => Promise<string>;
  ruleMap: Record<string, CheckCode>;
}

interface TrustDetectorRuntimeOptions {
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
  inventory?: TrustFileInventory;
}

export interface TrustDetectorOptions {
  env: NodeJS.ProcessEnv;
  platform: Platform;
  posture: Posture;
  requiredDetectors?: readonly TrustDetectorName[];
  run: Runner;
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
  inventory?: TrustFileInventory;
  /** Restrict execution to this detector set. Omitted means the complete set for the scan kind. */
  detectors?: readonly TrustDetectorName[];
  /** Exact, coordinator-validated SARIF that replaces local execution for the named detector. */
  precomputedSarif?: Readonly<Partial<Record<TrustDetectorName, string>>>;
  /** Native AIH findings that can corroborate an elevated third-party rule on the same line. */
  corroboratedChecks?: readonly Check[];
  progress?: (message: string) => void;
}

export interface TrustDetectorResult {
  checks: Check[];
  analyzersRun: string[];
  rawOccurrences: RawScannerOccurrence[];
}

const DETECTOR_UNAVAILABLE = "trust.detector-unavailable";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const trustScannerRootCandidates = [
  resolve(moduleDir, "..", "tools", "trust-scanners"),
  resolve(moduleDir, "..", "..", "tools", "trust-scanners"),
] as const;
const TRUST_SCANNERS_ROOT =
  trustScannerRootCandidates.find((candidate) => existsSync(candidate)) ??
  trustScannerRootCandidates[0];
const ciscoSkillScannerProjectCandidates = [
  resolve(moduleDir, "..", "tools", "cisco-skill-scanner"),
  resolve(moduleDir, "..", "..", "tools", "cisco-skill-scanner"),
] as const;
const UV_SCANNER_PYTHON = "3.12";
const UV_SCANNER_STARTUP_TIMEOUT_MS = 120_000;
export const CISCO_SKILL_SCANNER_PROJECT =
  ciscoSkillScannerProjectCandidates.find((candidate) => existsSync(join(candidate, "uv.lock"))) ??
  ciscoSkillScannerProjectCandidates[0];
export const CISCO_MCP_SCANNER_PROJECT = join(TRUST_SCANNERS_ROOT, "cisco-mcp");
export const SEMGREP_PROJECT = join(TRUST_SCANNERS_ROOT, "semgrep");
export const SNYK_AGENT_SCAN_PROJECT = join(TRUST_SCANNERS_ROOT, "snyk-agent-scan");
// These Semgrep rules are deliberately small harness-owned safety rules, not a
// complete substitute for native trust checks. The regexes are line-oriented,
// including the download-and-execute rule, so a pass is same-line coverage only.
const SEMGREP_RULES_YAML = [
  "rules:",
  "  - id: semgrep.prompt-injection",
  "    languages: [generic]",
  "    message: prompt injection shape in trust content",
  "    severity: WARNING",
  "    pattern-regex: '(?i)(ignore|disregard)\\s+(all\\s+)?previous\\s+instructions'",
  "  - id: semgrep.malicious-code",
  "    languages: [generic]",
  "    message: download-and-execute shell shape in trust content",
  "    severity: WARNING",
  "    pattern-regex: '(?i)(curl|wget|Invoke-WebRequest|iwr).*\\b(sh|bash|iex|Invoke-Expression)\\b'",
  "",
].join("\n");
const MAX_SCRIPT_SCAN_BYTES = 512 * 1024;
const MAX_LEGAL_TEXT_BYTES = 2 * 1024 * 1024;
const LEGAL_TEXT_BASENAME = /^(?:LICENSE|COPYING|NOTICE)(?:$|[._-])/i;
const NON_TEXT_LEGAL_EXTENSIONS = new Set([
  ".bat",
  ".bin",
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".cmd",
  ".com",
  ".conf",
  ".cpp",
  ".cs",
  ".dll",
  ".dylib",
  ".env",
  ".exe",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".ini",
  ".jar",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".php",
  ".pl",
  ".properties",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".so",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
  ".wasm",
  ".xml",
  ".zsh",
]);

const SKILLSPECTOR_RULE_MAP: Record<string, CheckCode> = {
  "auto-exec": "trust.auto-exec-hook",
  "dependency-confusion": "trust.dependency-confusion",
  "hidden-unicode": "trust.hidden-unicode",
  "malicious-code": "trust.malicious-code",
  "prompt-injection": "trust.prompt-injection",
  "skillspector.auto-exec": "trust.auto-exec-hook",
  "skillspector.dependency-confusion": "trust.dependency-confusion",
  "skillspector.hidden-unicode": "trust.hidden-unicode",
  "skillspector.malicious-code": "trust.malicious-code",
  "skillspector.prompt-injection": "trust.prompt-injection",
  "skillspector.typosquat": "trust.typosquat",
  typosquat: "trust.typosquat",
};

export const CISCO_RULE_MAP: Record<string, CheckCode> = {
  PROMPT_INJECTION_IGNORE_INSTRUCTIONS: "trust.prompt-injection",
  YARA_command_injection_generic: "trust.malicious-code",
};

export const MCP_SCANNER_RULE_MAP: Record<string, CheckCode> = {
  "mcp.tool-poisoning": "trust.prompt-injection",
  "mcp.tool_poisoning": "trust.prompt-injection",
  "prompt-injection": "trust.prompt-injection",
  prompt_injection: "trust.prompt-injection",
  "tool-poisoning": "trust.prompt-injection",
  tool_poisoning: "trust.prompt-injection",
  PROMPT_INJECTION_IGNORE_INSTRUCTIONS: "trust.prompt-injection",
};

export const SEMGREP_RULE_MAP: Record<string, CheckCode> = {
  "semgrep.malicious-code": "trust.malicious-code",
  "semgrep.prompt-injection": "trust.prompt-injection",
};

export const SNYK_AGENT_SCAN_RULE_MAP: Record<string, CheckCode> = {
  E001: "trust.prompt-injection",
  E004: "trust.prompt-injection",
  E005: "trust.malicious-code",
  E006: "trust.malicious-code",
  W001: "trust.prompt-injection",
  W021: "trust.hidden-unicode",
};

interface SarifArtifactLocation {
  uri?: unknown;
}

interface SarifRegion {
  startLine?: unknown;
}

interface SarifPhysicalLocation {
  artifactLocation?: SarifArtifactLocation;
  region?: SarifRegion;
}

interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation;
}

interface SarifResult {
  ruleId?: unknown;
  rule?: { id?: unknown };
  level?: unknown;
  message?: { text?: unknown };
  locations?: SarifLocation[];
}

interface SarifRun {
  invocations?: Array<Record<string, unknown>>;
  results?: SarifResult[];
}

interface SarifLog {
  runs?: SarifRun[];
  version?: string;
}

interface SnykAgentFindingLocation {
  file?: unknown;
  line?: unknown;
  path?: unknown;
}

interface SnykAgentFinding {
  code?: unknown;
  description?: unknown;
  file?: unknown;
  id?: unknown;
  issueCode?: unknown;
  line?: unknown;
  location?: SnykAgentFindingLocation;
  message?: unknown;
  path?: unknown;
  reference?: unknown;
  ruleId?: unknown;
  severity?: unknown;
  title?: unknown;
}

interface SnykAgentReport {
  findings?: unknown;
  issues?: unknown;
  results?: unknown;
  vulnerabilities?: unknown;
}

interface SnykAgentScanPathResult {
  issues?: unknown;
  path?: unknown;
  servers?: unknown;
}

interface SnykAgentServerResult {
  config_path?: unknown;
  server?: unknown;
}

interface McpScannerFindingSummary {
  severity?: unknown;
  threat_names?: unknown;
  threat_summary?: unknown;
  total_findings?: unknown;
}

interface McpScannerResult {
  findings?: unknown;
  is_safe?: unknown;
  status?: unknown;
  tool_name?: unknown;
}

interface MaliciousPattern {
  label: string;
  pattern: RegExp;
}

const MALICIOUS_PATTERNS: MaliciousPattern[] = [
  {
    label: "interactive bash reverse shell over /dev/tcp",
    pattern: /\bbash\s+-i\b.*(?:>&|&>)\s*\/dev\/tcp\/[A-Za-z0-9._-]+\/\d+/,
  },
  {
    label: "base64-decoded payload piped to shell",
    pattern: /\bbase64\b[^\n|;&]*(?:-d|--decode)?[^\n|;&]*\|\s*(?:bash|sh)\b/,
  },
  {
    label: "netcat exec shell",
    pattern: /\bnc(?:at)?\b[^\n]*(?:-e|-c)\s*(?:\/bin\/)?(?:bash|sh)\b/,
  },
];

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function normalizeShellWhitespace(line: string): string {
  // Collapse any ${IFS...} parameter-expansion form (plain, #/% removal, :offset
  // substring, //pattern substitution) and bare $IFS to a space, so IFS-obfuscated
  // reverse shells still match the patterns below.
  return line.replace(/\$\{IFS[^}]*\}|\$IFS\b/g, " ");
}

function contentLine(path: string, line: number): string {
  const text = readFileSync(path, "utf8");
  return text.split(/\r?\n/)[line - 1] ?? "";
}

function fileLine(path: string, line: number): string | undefined {
  try {
    return contentLine(path, line);
  } catch {
    return undefined;
  }
}

function maliciousCodeCheck(
  occurrences: Map<string, number>,
  rel: string,
  line: number,
  text: string,
  label: string,
): Check {
  const ruleId = `native:${label}`;
  const content = `${text}\0${label}`;
  const key = JSON.stringify(["trust.malicious-code", rel, ruleId, content]);
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return {
    name: "trust.malicious-code",
    verdict: "fail",
    code: "trust.malicious-code",
    detail: `${rel}:${line} — bundled script matches ${label}; static trust gate rejects raw malicious-code shapes`,
    location: { uri: rel, startLine: line },
    fingerprint: contentFindingFingerprint({
      code: "trust.malicious-code",
      path: rel,
      ruleId,
      content,
      occurrence,
      displayLine: line,
    }),
  };
}

export function scanNativeMaliciousCode(root: string, inventory?: TrustFileInventory): Check[] {
  const files: Iterable<string> = inventory
    ? {
        *[Symbol.iterator]() {
          for (const entry of inventory.matching(
            (candidate) =>
              isMaliciousCodeScanFilePath(candidate.relativePath) &&
              candidate.size <= MAX_SCRIPT_SCAN_BYTES,
          )) {
            yield entry.absolutePath;
          }
        },
      }
    : collectFilesUnder(
        root,
        (abs) => {
          const rel = toPosix(relative(root, abs));
          return isMaliciousCodeScanFilePath(rel) && statSync(abs).size <= MAX_SCRIPT_SCAN_BYTES;
        },
        TRUST_SKIP_DIRS,
      );
  const checks: Check[] = [];
  const occurrences = new Map<string, number>();
  for (const file of files) {
    const rel = toPosix(relative(root, file));
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const normalizedLine = normalizeShellWhitespace(line);
      for (const rule of MALICIOUS_PATTERNS) {
        if (rule.pattern.test(normalizedLine)) {
          checks.push(maliciousCodeCheck(occurrences, rel, index + 1, line, rule.label));
        }
      }
    });
  }
  return checks;
}

export function skillspectorDockerRunArgv(
  platform: Platform,
  tree: string,
  image: string = SKILLSPECTOR_IMAGE,
  containerName = `aih-skillspector-${randomUUID()}`,
): string[] {
  // Native Windows Docker bind mounts can reject drive-letter paths; that fails safe to skip.
  return execArgv(platform, [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "DAC_OVERRIDE",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    dockerBindMountArg(tree, "/scan"),
    image,
    "scan",
    "/scan",
    "--no-llm",
    "--format",
    "sarif",
  ]);
}

function skillspectorDockerCleanupArgv(platform: Platform, containerName: string): string[] {
  return execArgv(platform, ["docker", "rm", "--force", "--volumes", containerName]);
}

function ciscoSkillScannerBaseArgv(): string[] {
  return [
    "uv",
    "run",
    "--project",
    CISCO_SKILL_SCANNER_PROJECT,
    "--locked",
    "--isolated",
    "--python",
    UV_SCANNER_PYTHON,
    "--offline",
    "--no-python-downloads",
    "--no-env-file",
    "skill-scanner",
  ];
}

function mcpScannerBaseArgv(): string[] {
  return [
    "uv",
    "run",
    "--project",
    CISCO_MCP_SCANNER_PROJECT,
    "--locked",
    "--isolated",
    "--python",
    UV_SCANNER_PYTHON,
    "--offline",
    "--no-python-downloads",
    "--no-env-file",
    "mcp-scanner",
  ];
}

function snykAgentScanBaseArgv(): string[] {
  return [
    "uv",
    "run",
    "--project",
    SNYK_AGENT_SCAN_PROJECT,
    "--locked",
    "--isolated",
    "--python",
    UV_SCANNER_PYTHON,
    "--offline",
    "--no-python-downloads",
    "--no-env-file",
    "snyk-agent-scan",
  ];
}

function semgrepBaseArgv(): string[] {
  return [
    "uv",
    "run",
    "--project",
    SEMGREP_PROJECT,
    "--locked",
    "--isolated",
    "--python",
    UV_SCANNER_PYTHON,
    "--offline",
    "--no-python-downloads",
    "--no-env-file",
    "semgrep",
  ];
}

function ciscoSkillScannerVersionArgv(platform: Platform): string[] {
  return execArgv(platform, [...ciscoSkillScannerBaseArgv(), "--version"]);
}

function mcpScannerHelpArgv(platform: Platform): string[] {
  return execArgv(platform, [...mcpScannerBaseArgv(), "--help"]);
}

function semgrepVersionArgv(platform: Platform): string[] {
  return execArgv(platform, [...semgrepBaseArgv(), "--version"]);
}

function snykAgentScanHelpArgv(platform: Platform): string[] {
  return execArgv(platform, [...snykAgentScanBaseArgv(), "help"]);
}

export function ciscoSkillScannerRunArgv(
  platform: Platform,
  tree: string,
  outputSarif: string,
): string[] {
  return execArgv(platform, [
    ...ciscoSkillScannerBaseArgv(),
    "scan",
    tree,
    "--format",
    "sarif",
    "--output-sarif",
    outputSarif,
  ]);
}

export function mcpScannerStaticArgv(platform: Platform, inputJson: string): string[] {
  return execArgv(platform, [
    ...mcpScannerBaseArgv(),
    "--raw",
    "--analyzers",
    "yara,prompt_defense,readiness",
    "static",
    "--tools",
    inputJson,
  ]);
}

export function semgrepScanArgv(platform: Platform, tree: string, config: string): string[] {
  return execArgv(platform, [
    ...semgrepBaseArgv(),
    "scan",
    "--config",
    config,
    "--sarif",
    "--metrics=off",
    "--disable-version-check",
    "--",
    tree,
  ]);
}

export function snykAgentScanArgv(platform: Platform, tree: string): string[] {
  return execArgv(platform, [
    ...snykAgentScanBaseArgv(),
    "scan",
    tree,
    "--json",
    "--no-bootstrap",
    "--suppress-mcpserver-io=true",
  ]);
}

function runFailureReason(result: RunResult, fallback: string): string | undefined {
  if (!result.spawnError && result.code === 0) return undefined;
  return result.stderr || result.stdout || fallback;
}

function snykAgentScanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = scrubFetchEnv(env);
  if (typeof env.SNYK_TOKEN === "string" && env.SNYK_TOKEN.trim().length > 0) {
    out.SNYK_TOKEN = env.SNYK_TOKEN.trim();
  }
  return out;
}

async function checkSkillspectorAvailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  runtimeOptions: TrustDetectorRuntimeOptions = {},
): Promise<string | undefined> {
  const image = await resolveVerifiedSkillspectorImage(
    run,
    platform,
    env,
    30_000,
    runtimeOptions.skillspectorImageApprovals,
  );
  return "reason" in image ? image.reason : undefined;
}

async function runSkillspectorScan(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  tree: string,
  runtimeOptions: TrustDetectorRuntimeOptions = {},
): Promise<string> {
  const image = await resolveVerifiedSkillspectorImage(
    run,
    platform,
    env,
    30_000,
    runtimeOptions.skillspectorImageApprovals,
  );
  if ("reason" in image) throw new Error(image.reason);
  const containerName = `aih-skillspector-${randomUUID()}`;
  const dockerEnv = scrubDockerClientEnv(env);
  const scan = await run(skillspectorDockerRunArgv(platform, tree, image.image, containerName), {
    env: dockerEnv,
    // Full pinned catalogs are CPU-bound in SkillSpector and exceed the old
    // two-minute budget even on the dedicated 6-vCPU vet hosts. Keep the
    // external process bounded while allowing one exact source-wide run.
    timeoutMs: 900_000,
  });
  const exitLabel = scan.code ?? "signal";
  if (scan.spawnError || scan.truncated) {
    const cleanup = await run(skillspectorDockerCleanupArgv(platform, containerName), {
      env: dockerEnv,
      timeoutMs: 30_000,
    });
    const cleanupDetail =
      cleanup.spawnError || cleanup.code !== 0
        ? `; container cleanup failed: ${
            runFailureReason(cleanup, `docker exit ${cleanup.code ?? "signal"}`) ??
            `docker exit ${cleanup.code ?? "signal"}`
          }`
        : "";
    throw new Error(
      `${
        runFailureReason(scan, `detector exit ${exitLabel}`) ?? `detector exit ${exitLabel}`
      }${cleanupDetail}`,
    );
  }
  if (scan.code !== 0 && scan.code !== 1) {
    const output = (scan.stderr || scan.stdout).trim();
    throw new Error(`detector exit ${exitLabel}${output.length > 0 ? `: ${output}` : ""}`);
  }
  if (scan.stdout.trim().length === 0) {
    throw new Error(scan.stderr.trim() || `detector exit ${exitLabel} emitted no SARIF`);
  }
  return scan.stdout;
}

async function checkCiscoAvailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  runtimeOptionsOrExpectedVersion?: TrustDetectorRuntimeOptions | string,
): Promise<string | undefined> {
  const expectedVersion =
    typeof runtimeOptionsOrExpectedVersion === "string"
      ? runtimeOptionsOrExpectedVersion
      : undefined;
  const version = await run(ciscoSkillScannerVersionArgv(platform), {
    env: scrubFetchEnv(env),
    timeoutMs: UV_SCANNER_STARTUP_TIMEOUT_MS,
  });
  const reason = runFailureReason(version, `uvx exit ${version.code ?? "signal"}`);
  if (reason !== undefined) return reason;
  const output = `${version.stdout}${version.stderr}`.trim();
  if (output.length === 0) {
    return "skill-scanner version check emitted no output";
  }
  const reportedVersions: string[] =
    output.match(/[0-9]+(?:\.[0-9]+)+(?:[-+][0-9A-Za-z.-]+)?/g) ?? [];
  if (expectedVersion !== undefined && !reportedVersions.includes(expectedVersion)) {
    return `skill-scanner version ${JSON.stringify(output)} does not match ${expectedVersion}`;
  }
  return undefined;
}

async function checkMcpScannerAvailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const help = await run(mcpScannerHelpArgv(platform), {
    env: scrubFetchEnv(env),
    timeoutMs: UV_SCANNER_STARTUP_TIMEOUT_MS,
  });
  const reason = runFailureReason(help, `uvx exit ${help.code ?? "signal"}`);
  if (reason !== undefined) return reason;
  if (`${help.stdout}${help.stderr}`.trim().length === 0) {
    return "mcp-scanner help check emitted no output";
  }
  return undefined;
}

async function checkSemgrepAvailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const version = await run(semgrepVersionArgv(platform), {
    env: scrubFetchEnv(env),
    timeoutMs: UV_SCANNER_STARTUP_TIMEOUT_MS,
  });
  const reason = runFailureReason(version, `semgrep exit ${version.code ?? "signal"}`);
  if (reason !== undefined) return reason;
  if (`${version.stdout}${version.stderr}`.trim().length === 0) {
    return "semgrep version check emitted no output";
  }
  return undefined;
}

async function checkSnykAgentScanAvailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (typeof env.SNYK_TOKEN !== "string" || env.SNYK_TOKEN.trim().length === 0) {
    return "SNYK_TOKEN is not set";
  }
  const help = await run(snykAgentScanHelpArgv(platform), {
    env: scrubFetchEnv(env),
    timeoutMs: UV_SCANNER_STARTUP_TIMEOUT_MS,
  });
  const reason = runFailureReason(help, `uvx exit ${help.code ?? "signal"}`);
  if (reason !== undefined) return reason;
  if (`${help.stdout}${help.stderr}`.trim().length === 0) {
    return "snyk-agent-scan help check emitted no output";
  }
  return undefined;
}

function collectCiscoSkillDirs(root: string, inventory?: TrustFileInventory): string[] {
  const dirs = new Set<string>();
  const skillFiles: Iterable<string> = inventory
    ? {
        *[Symbol.iterator]() {
          for (const entry of inventory.matching(
            (candidate) => basename(candidate.absolutePath) === "SKILL.md",
          )) {
            yield entry.absolutePath;
          }
        },
      }
    : collectFilesUnder(root, (abs) => basename(abs) === "SKILL.md", TRUST_SKIP_DIRS);
  for (const file of skillFiles) dirs.add(dirname(file));
  return [...dirs].sort((a, b) =>
    toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))),
  );
}

function prefixSafeCiscoUri(prefix: string, raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  const stripped = toPosix(raw.replace(/^file:\/\//, ""));
  if (!isSafeRelativeSarifUri(stripped)) return raw;
  return prefix.length > 0 ? `${prefix}/${stripped}` : stripped;
}

function prefixCiscoSarifUris(sarifText: string, root: string, skillRoot: string): SarifLog {
  const parsed = parseSarifLog(sarifText);
  if (parsed === undefined) throw new Error("detector did not emit valid SARIF");
  const prefix = toPosix(relative(root, skillRoot));
  return {
    ...parsed,
    runs: parsed.runs?.map((run) => ({
      ...run,
      invocations: run.invocations?.map((invocation) => {
        const {
          startTimeUtc: _startTimeUtc,
          endTimeUtc: _endTimeUtc,
          ...stableInvocation
        } = invocation;
        return stableInvocation;
      }),
      results: run.results?.map((result) => ({
        ...result,
        locations: result.locations?.map((location) => ({
          ...location,
          physicalLocation:
            location.physicalLocation === undefined
              ? undefined
              : {
                  ...location.physicalLocation,
                  artifactLocation: {
                    ...location.physicalLocation.artifactLocation,
                    uri: prefixSafeCiscoUri(
                      prefix,
                      location.physicalLocation.artifactLocation?.uri,
                    ),
                  },
                },
        })),
      })),
    })),
  };
}

const DEFAULT_CISCO_SCAN_CONCURRENCY = 4;
const MAX_CISCO_SCAN_CONCURRENCY = 64;

export function resolveCiscoScanConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.AIH_CISCO_SCAN_CONCURRENCY?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_CISCO_SCAN_CONCURRENCY;
  if (!/^[1-9][0-9]*$/.test(raw)) return DEFAULT_CISCO_SCAN_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= MAX_CISCO_SCAN_CONCURRENCY
    ? parsed
    : DEFAULT_CISCO_SCAN_CONCURRENCY;
}

export interface CiscoSourceShardManifestOptions {
  source: {
    id: string;
    pinnedSha: string;
  };
  analyzer: {
    version: string;
    lockSha256: string;
  };
  policy: {
    version: string;
    profile: string;
  };
  shardCount: number;
  inventory?: TrustFileInventory;
}

export interface CiscoSourceShardRunOptions {
  run: Runner;
  platform: Platform;
  env: NodeJS.ProcessEnv;
  concurrency?: number;
}

export function buildCiscoSourceShardManifest(
  root: string,
  options: CiscoSourceShardManifestOptions,
): CiscoShardManifest {
  const safeRoot = realpathSync(root);
  const paths = collectCiscoSkillDirs(safeRoot, options.inventory).map((skillDir) =>
    toPosix(relative(safeRoot, skillDir)),
  );
  if (paths.length === 0) throw new Error("no SKILL.md directories found for Cisco scan");
  const sourceTree = hashComponentTree(safeRoot, paths);
  return buildCiscoShardManifest({
    source: {
      ...options.source,
      treeSha256: sourceTree.treeSha256,
    },
    analyzer: {
      name: "cisco",
      ...options.analyzer,
    },
    policy: options.policy,
    jobs: paths.map((path) => ({
      path,
      inputSha256: hashComponentTree(safeRoot, [path]).treeSha256,
    })),
    shardCount: options.shardCount,
  });
}

async function scanCiscoSkillDirectory(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  root: string,
  skillDir: string,
): Promise<SarifLog> {
  const tmp = mkdtempSync(join(tmpdir(), "aih-cisco-sarif-"));
  const output = join(tmp, "results.sarif");
  try {
    const scan = await run(ciscoSkillScannerRunArgv(platform, skillDir, output), {
      cwd: skillDir,
      env: scrubFetchEnv(env),
      timeoutMs: 120_000,
    });
    const reason = runFailureReason(scan, `detector exit ${scan.code ?? "signal"}`);
    if (reason !== undefined) throw new Error(reason);
    return prefixCiscoSarifUris(readFileSync(output, "utf8"), root, skillDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function verifyCiscoShardSource(root: string, manifest: CiscoShardManifest): void {
  const paths = manifest.jobs.map((job) => job.path);
  const sourceTree = hashComponentTree(root, paths);
  if (sourceTree.treeSha256 !== manifest.source.treeSha256) {
    throw new Error("Cisco shard source tree does not match the exact manifest identity");
  }
  for (const job of manifest.jobs) {
    if (hashComponentTree(root, [job.path]).treeSha256 !== job.inputSha256) {
      throw new Error(`Cisco shard input identity changed: ${job.path}`);
    }
  }
}

export async function runCiscoSourceShard(
  root: string,
  manifest: CiscoShardManifest,
  shardId: string,
  options: CiscoSourceShardRunOptions,
): Promise<CiscoShardResult> {
  const safeRoot = realpathSync(root);
  verifyCiscoShardSource(safeRoot, manifest);
  const expectedVersion = manifest.analyzer.version.split("+", 1)[0] ?? manifest.analyzer.version;
  const localLockSha256 = createHash("sha256")
    .update(readFileSync(join(CISCO_SKILL_SCANNER_PROJECT, "uv.lock")))
    .digest("hex");
  if (localLockSha256 !== manifest.analyzer.lockSha256) {
    throw new Error(
      `Cisco shard analyzer lock does not match manifest identity: ${localLockSha256}`,
    );
  }
  const unavailable = await checkCiscoAvailable(
    options.run,
    options.platform,
    options.env,
    expectedVersion,
  );
  if (unavailable !== undefined)
    throw new Error(`Cisco shard analyzer unavailable: ${unavailable}`);
  const result = await buildCiscoShardResultAsync(
    manifest,
    shardId,
    async (job) => {
      const skillDir = join(safeRoot, ...job.path.split("/"));
      if (hashComponentTree(safeRoot, [job.path]).treeSha256 !== job.inputSha256) {
        throw new Error(`Cisco shard input identity changed before scan: ${job.path}`);
      }
      const sarif = await scanCiscoSkillDirectory(
        options.run,
        options.platform,
        options.env,
        safeRoot,
        skillDir,
      );
      if (hashComponentTree(safeRoot, [job.path]).treeSha256 !== job.inputSha256) {
        throw new Error(`Cisco shard input identity changed during scan: ${job.path}`);
      }
      return sarif;
    },
    options.concurrency ?? resolveCiscoScanConcurrency(options.env),
  );
  verifyCiscoShardSource(safeRoot, manifest);
  return result;
}

function sourcePathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function joinedCiscoShardSarif(
  joined: JoinedCiscoShardEvidence,
  includedPaths?: readonly string[],
): string {
  const runs: SarifRun[] = [];
  for (const output of joined.outputs) {
    if (
      includedPaths !== undefined &&
      !includedPaths.some((path) => sourcePathsIntersect(output.path, path))
    ) {
      continue;
    }
    const parsed = parseSarifLog(JSON.stringify(output.evidence));
    if (parsed === undefined) {
      throw new Error(`Cisco shard job ${output.path} did not retain valid SARIF evidence`);
    }
    runs.push(...(parsed.runs ?? []));
  }
  return JSON.stringify({ version: "2.1.0", runs });
}

async function mapConcurrentStable<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: Array<{ error: unknown; index: number }> = [];
  let nextIndex = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) throw new Error(`concurrent work item ${index} is missing`);
      try {
        results[index] = await worker(item);
      } catch (error) {
        failures.push({ error, index });
        stopped = true;
      }
    }
  });
  await Promise.all(workers);
  const firstFailure = failures.sort((left, right) => left.index - right.index)[0];
  if (firstFailure !== undefined) throw firstFailure.error;
  return results;
}

async function runCiscoSkillScan(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  tree: string,
  runtimeOptions: TrustDetectorRuntimeOptions = {},
): Promise<string> {
  const skillDirs = collectCiscoSkillDirs(tree, runtimeOptions.inventory);
  if (skillDirs.length === 0) throw new Error("no SKILL.md directories found for Cisco scan");
  const runsBySkill = await mapConcurrentStable(
    skillDirs,
    resolveCiscoScanConcurrency(env),
    async (skillDir): Promise<SarifRun[]> =>
      (await scanCiscoSkillDirectory(run, platform, env, tree, skillDir)).runs ?? [],
  );
  return JSON.stringify({ version: "2.1.0", runs: runsBySkill.flat() });
}

function mcpConfigRoots(root: string, inventory?: TrustFileInventory): string[] {
  const skillDirs = new Set<string>();
  const skillFiles = inventory
    ? inventory.matching((entry) => basename(entry.absolutePath) === "SKILL.md")
    : collectFilesUnder(root, (abs) => basename(abs) === "SKILL.md", TRUST_SKIP_DIRS).map(
        (absolutePath) => ({ absolutePath }),
      );
  for (const entry of skillFiles) skillDirs.add(dirname(entry.absolutePath));
  return [root, ...skillDirs];
}

function mcpConfigFiles(root: string, inventory?: TrustFileInventory): string[] {
  return [
    ...new Set(
      mcpConfigRoots(root, inventory).flatMap((dir) =>
        [...INCOMING_MCP_CONFIG_FILES]
          .filter((name) => existsSync(join(dir, name)))
          .map((name) => join(dir, name)),
      ),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snykIssueReference(issue: SnykAgentFinding): number | undefined {
  const reference = issue.reference;
  if (!Array.isArray(reference)) return undefined;
  const serverIndex = reference[0];
  return typeof serverIndex === "number" && Number.isInteger(serverIndex) && serverIndex >= 0
    ? serverIndex
    : undefined;
}

function snykServerUri(server: SnykAgentServerResult): string | undefined {
  const configPath = firstString(server, ["config_path", "configPath", "path"]);
  if (configPath !== undefined) return configPath;
  if (isRecord(server.server)) {
    return firstString(server.server, ["path", "config_path", "configPath"]);
  }
  return undefined;
}

function snykScanPathIssueUri(
  scanPath: string,
  pathResult: SnykAgentScanPathResult,
  issue: SnykAgentFinding,
): string {
  const direct = firstString(issue, ["file", "path"]);
  if (direct !== undefined) return direct;
  const reference = snykIssueReference(issue);
  if (reference !== undefined && Array.isArray(pathResult.servers)) {
    const server = pathResult.servers[reference];
    if (isRecord(server)) {
      const serverUri = snykServerUri(server);
      if (serverUri !== undefined) return serverUri;
    }
  }
  return firstString(pathResult, ["path"]) ?? scanPath;
}

function snykFindingArray(report: unknown): SnykAgentFinding[] | undefined {
  if (Array.isArray(report)) return report.filter(isRecord) as SnykAgentFinding[];
  if (!isRecord(report)) return undefined;
  const typedReport = report as SnykAgentReport;
  for (const key of ["findings", "issues", "results", "vulnerabilities"] as const) {
    const value = typedReport[key];
    if (Array.isArray(value)) return value.filter(isRecord) as SnykAgentFinding[];
  }
  const pathFindings: SnykAgentFinding[] = [];
  let sawScanPathResult = false;
  for (const [scanPath, rawPathResult] of Object.entries(typedReport)) {
    if (!isRecord(rawPathResult)) continue;
    const pathResult = rawPathResult as SnykAgentScanPathResult;
    if (!Array.isArray(pathResult.issues)) continue;
    sawScanPathResult = true;
    for (const rawIssue of pathResult.issues) {
      if (!isRecord(rawIssue)) continue;
      const issue = rawIssue as SnykAgentFinding;
      pathFindings.push({
        ...issue,
        path: snykScanPathIssueUri(scanPath, pathResult, issue),
      });
    }
  }
  if (sawScanPathResult || Object.keys(typedReport).length === 0) return pathFindings;
  return undefined;
}

function firstString(record: object, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function snykFindingRuleId(finding: SnykAgentFinding): string {
  return firstString(finding, ["id", "code", "issueCode", "ruleId"]) ?? "snyk-agent-scan.finding";
}

function snykFindingMessage(finding: SnykAgentFinding): string {
  const title = firstString(finding, ["title", "message", "description"]);
  const description = firstString(finding, ["description", "message"]);
  if (title !== undefined && description !== undefined && title !== description) {
    return `${title}: ${description}`;
  }
  return title ?? description ?? "Snyk Agent Scan finding";
}

function snykSafeSarifUri(raw: string, tree: string): string {
  const stripped = raw.replace(/^file:\/\//, "");
  const posix = toPosix(stripped);
  if (isAbsolute(stripped) || isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) {
    const relativeUri = toPosix(relative(realpathIfExists(tree), realpathIfExists(stripped)));
    if (relativeUri.length === 0) return ".";
    return isSafeRelativeSarifUri(relativeUri) ? relativeUri : ".";
  }
  return isSafeRelativeSarifUri(posix) ? posix : ".";
}

function snykFindingUri(finding: SnykAgentFinding, tree: string): string {
  let raw: string | undefined;
  if (isRecord(finding.location)) {
    const locationFile = firstString(finding.location, ["file", "path"]);
    if (locationFile !== undefined) raw = locationFile;
  }
  raw ??= firstString(finding, ["file", "path"]);
  return raw === undefined ? "." : snykSafeSarifUri(raw, tree);
}

function snykFindingLine(finding: SnykAgentFinding): number {
  const raw = isRecord(finding.location) ? (finding.location.line ?? finding.line) : finding.line;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function snykAgentScanSarif(raw: string, tree: string): SarifLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("snyk-agent-scan did not emit parseable JSON");
  }
  const findings = snykFindingArray(parsed);
  if (findings === undefined) {
    throw new Error("snyk-agent-scan JSON did not include a findings array");
  }
  const results = findings.filter(isRecord).map((finding): SarifResult => {
    const typed = finding as SnykAgentFinding;
    return {
      ruleId: snykFindingRuleId(typed),
      message: { text: snykFindingMessage(typed) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: snykFindingUri(typed, tree) },
            region: { startLine: snykFindingLine(typed) },
          },
        },
      ],
    };
  });
  return { version: "2.1.0", runs: [{ results }] };
}

function mcpScannerRuleId(analyzer: string, threat: string): string {
  const normalized = threat
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : analyzer;
}

function mcpScannerToolUri(raw: unknown): string {
  if (typeof raw !== "string") return "mcp-scanner.json";
  const separator = raw.lastIndexOf(":");
  const candidate = separator > 0 ? raw.slice(0, separator) : raw;
  return isSafeRelativeSarifUri(candidate) ? candidate : "mcp-scanner.json";
}

function mcpScannerSarif(raw: string): SarifLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("mcp-scanner did not emit parseable JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("mcp-scanner JSON did not include a result array");
  }

  const results: SarifResult[] = [];
  for (const rawResult of parsed) {
    if (!isRecord(rawResult)) {
      throw new Error("mcp-scanner JSON included a malformed result");
    }
    const result = rawResult as McpScannerResult;
    if (result.status !== "completed" || typeof result.is_safe !== "boolean") {
      throw new Error("mcp-scanner JSON included an incomplete result");
    }
    if (!isRecord(result.findings)) {
      throw new Error("mcp-scanner JSON result omitted analyzer findings");
    }

    let emitted = 0;
    for (const [analyzer, rawSummary] of Object.entries(result.findings)) {
      if (!isRecord(rawSummary)) {
        throw new Error("mcp-scanner JSON included a malformed analyzer finding");
      }
      const summary = rawSummary as McpScannerFindingSummary;
      const total =
        typeof summary.total_findings === "number" &&
        Number.isInteger(summary.total_findings) &&
        summary.total_findings >= 0
          ? summary.total_findings
          : undefined;
      if (total === undefined) {
        throw new Error("mcp-scanner JSON analyzer finding omitted a valid total");
      }
      if (total === 0) continue;

      const threats = Array.isArray(summary.threat_names)
        ? summary.threat_names.filter((threat): threat is string => typeof threat === "string")
        : [];
      const findingNames = threats.length > 0 ? threats : [analyzer];
      const detail =
        typeof summary.threat_summary === "string" && summary.threat_summary.length > 0
          ? summary.threat_summary
          : `${total} finding(s) from ${analyzer}`;
      const severity = typeof summary.severity === "string" ? `; severity ${summary.severity}` : "";
      for (const threat of findingNames) {
        results.push({
          ruleId: mcpScannerRuleId(analyzer, threat),
          message: { text: `${detail}${severity}; analyzer ${analyzer}; count ${total}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: mcpScannerToolUri(result.tool_name) },
                region: { startLine: 1 },
              },
            },
          ],
        });
        emitted += 1;
      }
    }
    if (result.is_safe === false && emitted === 0) {
      throw new Error("mcp-scanner marked a result unsafe without reporting a finding");
    }
  }

  return { version: "2.1.0", runs: [{ results }] };
}

function safeToolName(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9._:-]/g, "_").replace(/^_+|_+$/g, "");
  return safe.length > 0 ? safe.slice(0, 120) : "mcp-server";
}

function mcpStaticToolsFromConfig(rel: string, parsed: unknown): Array<Record<string, unknown>> {
  if (!isRecord(parsed)) return [];
  const maps: Array<Record<string, unknown>> = [];
  for (const key of ["mcpServers", "servers", "mcp"]) {
    const value = parsed[key];
    if (isRecord(value)) maps.push(value);
  }
  return maps.flatMap((servers) =>
    Object.entries(servers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rawServer]) => {
        const description =
          isRecord(rawServer) && typeof rawServer.description === "string"
            ? rawServer.description.slice(0, 400)
            : `MCP server declared in ${rel}`;
        return {
          name: safeToolName(`${rel}:${name}`),
          description,
          inputSchema: { type: "object", properties: {} },
        };
      }),
  );
}

function mcpStaticTools(
  root: string,
  inventory?: TrustFileInventory,
): Array<Record<string, unknown>> {
  return mcpConfigFiles(root, inventory).flatMap((abs) => {
    const rel = toPosix(relative(root, abs));
    try {
      return mcpStaticToolsFromConfig(rel, JSON.parse(readFileSync(abs, "utf8")) as unknown);
    } catch {
      return [
        {
          name: safeToolName(`${rel}:malformed`),
          description: `Malformed MCP config declared in ${rel}`,
          inputSchema: { type: "object", properties: {} },
        },
      ];
    }
  });
}

async function runMcpScannerScan(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  tree: string,
  runtimeOptions: TrustDetectorRuntimeOptions = {},
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "aih-mcp-scanner-"));
  const input = join(tmp, "tools.json");
  try {
    writeFileSync(
      input,
      `${JSON.stringify({ tools: mcpStaticTools(tree, runtimeOptions.inventory) }, null, 2)}\n`,
      "utf8",
    );
    const scan = await run(mcpScannerStaticArgv(platform, input), {
      env: scrubFetchEnv(env),
      timeoutMs: 120_000,
    });
    const reason = runFailureReason(scan, `detector exit ${scan.code ?? "signal"}`);
    if (reason !== undefined) throw new Error(reason);
    if (scan.stdout.trim().length === 0) throw new Error("mcp-scanner emitted no JSON");
    return JSON.stringify(mcpScannerSarif(scan.stdout));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runSemgrepScan(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  tree: string,
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "aih-semgrep-rules-"));
  const config = join(tmp, "rules.yml");
  try {
    writeFileSync(config, SEMGREP_RULES_YAML, "utf8");
    const scan = await run(semgrepScanArgv(platform, tree, config), {
      env: scrubFetchEnv(env),
      timeoutMs: 120_000,
    });
    if (scan.spawnError || (scan.code !== 0 && scan.code !== 1)) {
      throw new Error(scan.stderr || scan.stdout || `detector exit ${scan.code ?? "signal"}`);
    }
    if (scan.stdout.trim().length === 0) throw new Error("semgrep scan emitted no SARIF");
    const parsed = parseSarifLog(scan.stdout);
    const detail = scan.stderr.trim().length > 0 ? `: ${scan.stderr.trim().slice(0, 200)}` : "";
    if (parsed === undefined) throw new Error(`semgrep scan emitted no parseable SARIF${detail}`);
    if (parsed.version !== "2.1.0") {
      const version = typeof parsed.version === "string" ? parsed.version : "missing";
      throw new Error(`semgrep returned SARIF version ${version}, expected 2.1.0${detail}`);
    }
    return scan.stdout;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runSnykAgentScan(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  tree: string,
): Promise<string> {
  const scan = await run(snykAgentScanArgv(platform, tree), {
    env: snykAgentScanEnv(env),
    timeoutMs: 120_000,
  });
  if (scan.spawnError) {
    throw new Error(scan.stderr || scan.stdout || `detector exit ${scan.code ?? "signal"}`);
  }
  if (scan.stdout.trim().length === 0) {
    throw new Error(scan.stderr || "snyk-agent-scan emitted no JSON on stdout");
  }
  // Snyk Agent Scan documents --ci as the mode that exits non-zero for findings,
  // but we avoid --ci because it requires --dangerously-run-mcp-servers. Accept
  // exit 1 only when the JSON payload contains findings.
  if (scan.code !== 0 && scan.code !== 1) {
    throw new Error(scan.stderr || scan.stdout || `detector exit ${scan.code ?? "signal"}`);
  }
  const sarif = snykAgentScanSarif(scan.stdout, tree);
  if (scan.code === 1 && !sarif.runs?.some((sarifRun) => (sarifRun.results ?? []).length > 0)) {
    throw new Error(scan.stderr || "snyk-agent-scan exited 1 without findings");
  }
  return JSON.stringify(sarif);
}

function unavailableDetail(detector: TrustDetectorName, reason: string): string {
  const runbook =
    detector === "skillspector"
      ? " See docs/security/skillspector.md to build the pinned image."
      : "";
  return `DEGRADED-COVERAGE: deep scan SKIPPED — ${detector} not available (${reason}); coverage is GREEN-tier only. Analyzers run: aih-native.${runbook}`;
}

function unavailableCheck(
  detector: TrustDetectorName,
  reason: string,
  posture: Posture,
  required: boolean,
): Check {
  const base: Check = {
    name: `trust detector ${detector}`,
    verdict: "skip",
    code: DETECTOR_UNAVAILABLE,
    detail: unavailableDetail(detector, reason),
  };
  if (!required || posture !== "enterprise") return base;
  return {
    ...base,
    verdict: "fail",
    detail: `required detector ${detector} is unavailable at enterprise posture. ${base.detail}`,
  };
}

function parseSarifLog(raw: string): (SarifLog & { runs: SarifRun[] }) | undefined {
  try {
    const parsed = JSON.parse(raw) as SarifLog;
    return Array.isArray(parsed.runs) ? { ...parsed, runs: parsed.runs } : undefined;
  } catch {
    return undefined;
  }
}

function resultRuleId(result: SarifResult): string | undefined {
  const raw = typeof result.ruleId === "string" ? result.ruleId : result.rule?.id;
  return typeof raw === "string" ? raw : undefined;
}

function sourceTextForLocation(
  root: string,
  location: NonNullable<Check["location"]>,
): string | undefined {
  try {
    return readFileSync(join(root, location.uri), "utf8");
  } catch {
    return undefined;
  }
}

function reviewableLegalTextContent(
  root: string,
  location: NonNullable<Check["location"]>,
): Buffer | undefined {
  if (!LEGAL_TEXT_BASENAME.test(basename(location.uri))) return undefined;
  if (isStrictUnicodeSurface(location.uri)) return undefined;
  if (isInstallScriptEvidenceFilePath(location.uri)) return undefined;
  if (NON_TEXT_LEGAL_EXTENSIONS.has(extname(location.uri).toLowerCase())) return undefined;
  try {
    const path = join(root, location.uri);
    const rootReal = realpathSync(root);
    const pathReal = realpathSync(path);
    const fromRoot = relative(rootReal, pathReal);
    if (!isSafeRelativeSarifUri(toPosix(fromRoot))) return undefined;
    const opened = readRegularFileWithStats(pathReal, { maxBytes: MAX_LEGAL_TEXT_BYTES });
    if (opened === undefined || (opened.stats.mode & 0o111) !== 0) return undefined;
    if (opened.contents.includes(0)) return undefined;
    return opened.contents.subarray(0, 256).toString("utf8").startsWith("#!")
      ? undefined
      : opened.contents;
  } catch {
    return undefined;
  }
}

function unicodeRiskForLocation(
  root: string,
  location: NonNullable<Check["location"]>,
): UnicodeRisk | undefined {
  const source = sourceTextForLocation(root, location);
  return source === undefined
    ? detectorReportedHiddenUnicodeRisk()
    : classifyUnicodeRisk(location.uri, source);
}

function isReviewableVisibleUnicodeDetectorResult(
  result: SarifResult,
  detector: TrustDetector,
): boolean {
  if (detector.name !== "skillspector") return false;
  const message = resultMessage(result, detector).toLowerCase();
  return (
    /\bvisible\b.*\bunicode\b/.test(message) ||
    /\bunicode\b.*\bvisible\b/.test(message) ||
    /\bnon-ascii\b/.test(message) ||
    /\bunicode\b.*\bcount\b/.test(message)
  );
}

function hiddenUnicodeRiskForDetectorResult(
  result: SarifResult,
  detector: TrustDetector,
  root: string,
  location: NonNullable<Check["location"]>,
): UnicodeRisk | undefined {
  if (!isReviewableVisibleUnicodeDetectorResult(result, detector)) {
    return detectorReportedHiddenUnicodeRisk();
  }
  return unicodeRiskForLocation(root, location);
}

type DetectorRuleClassification =
  | { code: CheckCode; advisory?: never }
  | { advisory: string; code?: never };

const SKILLSPECTOR_SC4_OFFLINE_FALLBACK =
  /^🟡 SC4: OSV\.dev unreachable, using static fallback \([1-9][0-9]* packages\)\. Results may be incomplete\. Set SKILLSPECTOR_OSV_TIMEOUT to increase timeout or check network connectivity to api\.osv\.dev\.$/;
const SKILLSPECTOR_YR4_METADATA_MESSAGE =
  "YARA rule 'agent_skill_mcp_tool_poisoning_metadata': MCP/tool metadata poisoning indicators in tool schemas or skill manifests [agent_skills]";
const COREPACK_PACKAGE_MANAGER_INTEGRITY = /^[A-Za-z0-9._-]+@[^+\s"]+\+sha512\.[a-f0-9]{128}$/i;
// The Cisco skill-scanner's metadata-hygiene "missing license field" finding.
// Its rule id (MANIFEST_MISSING_LICENSE, emitted by cisco-ai-skill-scanner
// ==2.0.12) is not in CISCO_RULE_MAP, so it otherwise falls through to the
// block-at-every-posture trust.cisco-finding bucket. It is an evidence/metadata
// gap (mirrors the native trust.license-missing UNKNOWN posture), not poisoning,
// so it is reclassified to a graded, acknowledgeable trust-origin finding. The
// reclass is gated on that SPECIFIC benign rule id (never a danger-mapped one),
// the skill-scanner, the manifest surface (SKILL.md), and the specific wording
// pinned to that scanner version; re-verify the rule id and wording on a scanner
// pin bump. Scope is deliberately narrow: only this metadata-hygiene finding
// reclassifies — every other Cisco finding stays as mapped or cisco-finding.
const CISCO_MISSING_LICENSE_RULE_ID = "MANIFEST_MISSING_LICENSE";
const CISCO_MISSING_LICENSE_MESSAGE =
  /\bskill manifest does not include a ['"‘’]?license['"‘’]?\s+field\b/i;
const REPOSITORY_LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"] as const;
// SkillSpector YR4 (`agent_skill_mcp_tool_poisoning_metadata`) fires when
// `any of ($schema_*)` (ubiquitous manifest keys like `"description":`) is
// present AND at least one Gate-B poisoning co-signal matches. The carve-out
// below only downgrades the finding to advisory when the SOLE surviving Gate-B
// signal is the pinned Corepack `packageManager` integrity blob (which trips the
// rule's `$long_base64`). To stay fail-closed, `hasSkillspectorYr4PoisoningSignal`
// MUST over-approximate every Gate-B string in the pinned rule: each constant
// below mirrors exactly one rule string (five are byte-for-byte identical). The
// full class-by-class equivalence table and the re-verify-on-pin-bump obligation
// live in docs/security/skillspector.md \u2014 re-check it whenever
// SKILLSPECTOR_SOURCE_REVISION changes.
const SKILLSPECTOR_YR4_HIDDEN_HTML =
  /<!--[^>]{0,240}(?:SYSTEM|IGNORE|OVERRIDE|DEVELOPER|ASSISTANT)[^>]{0,240}-->/i;
const SKILLSPECTOR_YR4_HIDDEN_MARKDOWN =
  /\[\/\/\]:\s*#\s*\([^)]{0,240}(?:SYSTEM|IGNORE|OVERRIDE|DEVELOPER|ASSISTANT)[^)]{0,240}\)/i;
const SKILLSPECTOR_YR4_DATA_URI = /data:text\/[a-zA-Z0-9.+-]+;base64,/i;
const SKILLSPECTOR_YR4_LONG_OPAQUE = /[A-Za-z0-9+/]{120,}={0,2}/;
// `[\s\S]{0,160}` (not `.{0,160}`) mirrors YARA's newline-permissive `.`, which
// matches CR / U+2028 / U+2029 that JavaScript's `.` skips. Without this, a
// poisoning payload separated from its `(parameter|argument|description)` anchor
// by a lone CR (legal JSON whitespace) matched the pinned rule but slipped past
// this co-signal, wrongly earning the advisory carve-out.
const SKILLSPECTOR_YR4_PARAMETER_INJECTION =
  /(?:parameter|argument|description)[\s\S]{0,160}(?:ignore previous|override safety|send to|transmit|exfiltrate|SYSTEM:)/i;
const SKILLSPECTOR_YR4_DIRECTIONAL_CONTROL = /[\u200b-\u200d\u202d\u202e]/;

function hasSkillspectorYr4PoisoningSignal(source: string): boolean {
  return (
    SKILLSPECTOR_YR4_HIDDEN_HTML.test(source) ||
    SKILLSPECTOR_YR4_HIDDEN_MARKDOWN.test(source) ||
    SKILLSPECTOR_YR4_DATA_URI.test(source) ||
    SKILLSPECTOR_YR4_LONG_OPAQUE.test(source) ||
    SKILLSPECTOR_YR4_PARAMETER_INJECTION.test(source) ||
    SKILLSPECTOR_YR4_DIRECTIONAL_CONTROL.test(source)
  );
}

function skillspectorAdvisory(
  result: SarifResult,
  detector: TrustDetector,
  root: string,
  location: NonNullable<Check["location"]>,
): string | undefined {
  if (detector.name !== "skillspector") return undefined;
  const ruleId = resultRuleId(result);
  const message = resultMessage(result, detector);
  if (
    ruleId === "SC4" &&
    result.level === "note" &&
    SKILLSPECTOR_SC4_OFFLINE_FALLBACK.test(message)
  ) {
    return `${message} This is the expected dependency-coverage mode for the locked no-egress baseline scan; static fallback coverage remains incomplete.`;
  }
  if (
    ruleId !== "YR4" ||
    message !== SKILLSPECTOR_YR4_METADATA_MESSAGE ||
    basename(location.uri) !== "package.json"
  ) {
    return undefined;
  }
  const source = sourceTextForLocation(root, location);
  if (source === undefined) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return undefined;
  }
  const packageManager = (manifest as Record<string, unknown>).packageManager;
  if (
    typeof packageManager !== "string" ||
    !COREPACK_PACKAGE_MANAGER_INTEGRITY.test(packageManager)
  ) {
    return undefined;
  }
  const encodedIntegrity = JSON.stringify(packageManager);
  if (!source.includes(encodedIntegrity)) return undefined;
  const withoutCorepackIntegrity = source.replace(encodedIntegrity, '""');
  if (hasSkillspectorYr4PoisoningSignal(withoutCorepackIntegrity)) return undefined;
  return `${message}; reviewed false positive: the only poisoning co-signal is the top-level Corepack packageManager integrity suffix, which remains pinned.`;
}

// The Cisco skill-scanner's "missing license field" metadata-hygiene finding is
// reclassified out of the generic cisco-finding block into an acknowledgeable
// trust-origin finding. It is gated on the SPECIFIC benign SARIF rule id the
// scanner emits for it (MANIFEST_MISSING_LICENSE) and NEVER reclassifies a rule
// id that maps to a danger code — so a danger finding whose echoed message text
// merely quotes the license phrase can never be relabelled. Only the Cisco
// skill-scanner, only that rule id, only the manifest surface (SKILL.md), only
// that exact wording — never the mcp-scanner or any other Cisco finding.
function repositoryLicensePath(root: string): string | undefined {
  for (const name of REPOSITORY_LICENSE_FILES) {
    const candidate = join(root, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return name;
    } catch {
      // An unreadable or unstable path is not accepted as license evidence.
    }
  }
  return undefined;
}

function ciscoMetadataLicenseClassification(
  result: SarifResult,
  detector: TrustDetector,
  root: string,
  location: NonNullable<Check["location"]>,
): DetectorRuleClassification | undefined {
  if (detector.name !== "cisco") return undefined;
  const ruleId = resultRuleId(result);
  if (ruleId !== CISCO_MISSING_LICENSE_RULE_ID) return undefined;
  // A danger-mapped rule id is never eligible for the benign reclass, even if it
  // somehow shared the benign rule id string.
  if (detector.ruleMap[ruleId] !== undefined) return undefined;
  if (basename(location.uri) !== "SKILL.md") return undefined;
  if (!CISCO_MISSING_LICENSE_MESSAGE.test(resultMessage(result, detector))) return undefined;
  const inherited = repositoryLicensePath(root);
  return inherited === undefined
    ? { code: "trust.skill-metadata-license" }
    : {
        advisory: `${resultMessage(result, detector)}; repository-level license inheritance resolved by ${inherited}`,
      };
}

function ruleCode(
  result: SarifResult,
  detector: TrustDetector,
  root: string,
  location: NonNullable<Check["location"]>,
  corroboratedDangerLocations: ReadonlySet<string>,
): DetectorRuleClassification | undefined {
  const raw = resultRuleId(result);
  if (raw === undefined) return undefined;
  const advisory = skillspectorAdvisory(result, detector, root, location);
  if (advisory !== undefined) return { advisory };
  // A rule id mapped by the detector always wins over any message-text
  // reclassification below: a danger-mapped finding (e.g.
  // PROMPT_INJECTION_IGNORE_INSTRUCTIONS -> trust.prompt-injection,
  // YARA_command_injection_generic -> trust.malicious-code) must never be
  // relabelled to an acknowledgeable trust-origin code by a substring match on
  // echoed message content.
  const mapped = detector.ruleMap[raw];
  if (mapped !== undefined) {
    if (mapped === "trust.hidden-unicode") {
      const risk = hiddenUnicodeRiskForDetectorResult(result, detector, root, location);
      return risk === undefined ? undefined : { code: risk.code };
    }
    if (mapped === "trust.prompt-injection") {
      const source = sourceTextForLocation(root, location);
      if (source === undefined) return { code: "trust.detector-finding" };
      const native = scanTrustDocument(location.uri, source).filter(
        (check) => check.location?.startLine === location.startLine,
      );
      if (native.some((check) => check.code === "trust.prompt-injection")) {
        return { code: "trust.prompt-injection" };
      }
      if (native.some((check) => check.code === "trust.external-egress")) {
        return { code: "trust.external-egress" };
      }
      return { code: "trust.detector-finding" };
    }
    if (
      mapped === "trust.malicious-code" &&
      !corroboratedDangerLocations.has(
        `trust.malicious-code:${location.uri}:${String(location.startLine ?? 1)}`,
      )
    ) {
      return { code: "trust.detector-finding" };
    }
    if (
      mapped === "trust.auto-exec-hook" &&
      !corroboratedDangerLocations.has(
        `trust.auto-exec-hook:${location.uri}:${String(location.startLine ?? 1)}`,
      )
    ) {
      return { code: "trust.detector-finding" };
    }
    return {
      code: mapped,
    };
  }
  // Only an UNMAPPED Cisco rule id reaches the benign missing-license reclass.
  const metadataLicense = ciscoMetadataLicenseClassification(result, detector, root, location);
  if (metadataLicense !== undefined) return metadataLicense;
  const legalText = reviewableLegalTextContent(root, location);
  if (
    detector.name === "skillspector" ||
    detector.name === "semgrep" ||
    detector.name === "snyk-agent-scan"
  ) {
    if (
      detector.name === "skillspector" &&
      /\bExternal Transmission\b/i.test(resultMessage(result, detector))
    ) {
      return { code: "trust.external-egress" };
    }
    return legalText === undefined
      ? { code: "trust.detector-finding" }
      : { code: "trust.legal-text-detector-finding" };
  }
  if (detector.name === "cisco" || detector.name === "mcp-scanner") {
    return legalText === undefined
      ? { code: "trust.cisco-finding" }
      : { code: "trust.legal-text-detector-finding" };
  }
  return undefined;
}

function detectorFindingLabel(detector: TrustDetector): string {
  if (detector.name === "skillspector") return "SkillSpector";
  if (detector.name === "mcp-scanner") return "Cisco AI Defense mcp-scanner";
  if (detector.name === "semgrep") return "Semgrep";
  if (detector.name === "snyk-agent-scan") return "Snyk Agent Scan";
  return "Cisco AI Defense skill-scanner";
}

function resultMessage(result: SarifResult, detector: TrustDetector): string {
  return typeof result.message?.text === "string" && result.message.text.length > 0
    ? result.message.text
    : `${detectorFindingLabel(detector)} SARIF finding`;
}

const ROLE_ASSIGNMENT =
  /\b(?:act|behave|serve|work)\s+as\b|\byou\s+are\s+(?:an?|the)\b|\brole\s+(?:assignment|definition)\b/i;
const DANGEROUS_ROLE_CONTEXT =
  /\b(?:ignore|disregard|override|jailbreak|previous|prior|system\s+prompt|developer\s+instruction|api[_ -]?key|credential|password|secret|token|upload|send|post|leak|steal|exfiltrat\w*)\b|https?:\/\//i;

function isNarrowReviewableRoleDefinition(
  result: SarifResult,
  detector: TrustDetector,
  root: string,
  location: NonNullable<Check["location"]>,
): boolean {
  if (isStrictUnicodeSurface(location.uri)) return false;
  const line = fileLine(join(root, location.uri), location.startLine ?? 1) ?? "";
  const evidence = [resultRuleId(result) ?? "", resultMessage(result, detector), line].join("\n");
  return ROLE_ASSIGNMENT.test(evidence) && !DANGEROUS_ROLE_CONTEXT.test(evidence);
}

function unicodeResultMessage(message: string, risk: UnicodeRisk | undefined): string {
  if (risk === undefined) return message;
  return `${message}; character category: ${risk.category}; reason: ${risk.reason}`;
}

function legalTextResultMessage(message: string, code: CheckCode): string {
  if (code !== "trust.legal-text-detector-finding") return message;
  return `${message}; file class: non-executable legal text; severity: reviewable trust-origin because generic detector heuristics on LICENSE/COPYING/NOTICE require human review`;
}

function normalizeSarifUri(raw: unknown, detector: TrustDetector): string {
  const fallback = `${detector.name}.sarif`;
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const stripped = toPosix(
    raw
      .replace(/^file:\/\//, "")
      .replace(/^\/scan\/?/, "")
      .replace(/^scan\/?/, ""),
  );
  if (!isSafeRelativeSarifUri(stripped)) return fallback;
  return stripped;
}

function isSafeRelativeSarifUri(uri: string): boolean {
  if (uri.length === 0 || isAbsolute(uri) || /^[A-Za-z]:/.test(uri)) return false;
  return !uri.split("/").some((part) => part === "..");
}

function sarifStartLine(result: SarifResult): number {
  const raw = result.locations?.[0]?.physicalLocation?.region?.startLine;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function sarifLocation(
  result: SarifResult,
  detector: TrustDetector,
): NonNullable<Check["location"]> {
  const physical = result.locations?.[0]?.physicalLocation;
  return {
    uri: normalizeSarifUri(physical?.artifactLocation?.uri, detector),
    startLine: sarifStartLine(result),
  };
}

function sarifFingerprint(
  occurrences: Map<string, number>,
  code: CheckCode,
  root: string,
  location: NonNullable<Check["location"]>,
  ruleId: string,
  detail: string,
  detector: TrustDetector,
): string {
  const line = location.startLine ?? 1;
  const findingRule = `${detector.name}:${ruleId}`;
  const lineContent = fileLine(join(root, location.uri), line) ?? detail;
  const content = `${lineContent}\0${detail}`;
  const key = JSON.stringify([code, location.uri, findingRule, content]);
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return contentFindingFingerprint({
    code,
    path: location.uri,
    ruleId: findingRule,
    content,
    occurrence,
    displayLine: line,
  });
}

function sarifChecks(
  stdout: string,
  root: string,
  posture: Posture,
  detector: TrustDetector,
  corroboratedDangerLocations: ReadonlySet<string>,
): { checks: Check[]; rawOccurrences: RawScannerOccurrence[] } | undefined {
  const parsed = parseSarifLog(stdout);
  if (parsed === undefined) return undefined;
  const checks: Check[] = [];
  const rawOccurrences: RawScannerOccurrence[] = [];
  const occurrences = new Map<string, number>();
  const rawOccurrenceCounts = new Map<string, number>();
  const seen = new Set<string>();
  for (const run of parsed.runs) {
    for (const result of run.results ?? []) {
      const location = sarifLocation(result, detector);
      const rawRuleId = resultRuleId(result) ?? "unknown-rule";
      const rawMessage = resultMessage(result, detector);
      const rawKey = JSON.stringify([
        detector.name,
        rawRuleId,
        location.uri,
        location.startLine ?? 1,
        rawMessage,
      ]);
      const rawOccurrence = rawOccurrenceCounts.get(rawKey) ?? 0;
      rawOccurrenceCounts.set(rawKey, rawOccurrence + 1);
      const sourceValue = fileLine(join(root, location.uri), location.startLine ?? 1);
      rawOccurrences.push({
        fingerprint: `trust-raw:${createHash("sha256")
          .update(JSON.stringify([rawKey, rawOccurrence]), "utf8")
          .digest("hex")}`,
        analyzer: detector.analyzerLabel,
        ruleId: rawRuleId,
        message: rawMessage,
        ...(typeof result.level === "string" ? { level: result.level } : {}),
        location,
        ...(sourceValue === undefined ? {} : { sourceValue }),
      });
      const duplicateKey = JSON.stringify([
        detector.name,
        rawRuleId,
        location.uri,
        location.startLine ?? 1,
      ]);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const classification = ruleCode(
        result,
        detector,
        root,
        location,
        corroboratedDangerLocations,
      );
      if (classification === undefined) continue;
      if (classification.advisory !== undefined) {
        checks.push({
          name: `trust detector ${detector.name} advisory`,
          verdict: "pass",
          detail: `${location.uri}:${location.startLine ?? 1} — ${detectorFindingLabel(detector)}: ${classification.advisory}`,
          location,
        });
        continue;
      }
      const { code } = classification;
      if (
        code === "trust.prompt-injection" &&
        isNarrowReviewableRoleDefinition(result, detector, root, location)
      ) {
        continue;
      }
      const risk =
        code === "trust.hidden-unicode" || code === "trust.visible-unicode"
          ? hiddenUnicodeRiskForDetectorResult(result, detector, root, location)
          : undefined;
      const detail = legalTextResultMessage(
        unicodeResultMessage(resultMessage(result, detector), risk),
        code,
      );
      checks.push(
        gradeTrustCheck(
          {
            name: code,
            verdict: "fail",
            code,
            detail: `${location.uri}:${location.startLine ?? 1} — ${detectorFindingLabel(detector)}: ${detail}`,
            location,
            fingerprint: sarifFingerprint(
              occurrences,
              code,
              root,
              location,
              resultRuleId(result) ?? "unknown-rule",
              detail,
              detector,
            ),
          },
          posture,
        ),
      );
    }
  }
  return { checks, rawOccurrences };
}

function analyzerPassCheck(detector: TrustDetector, analyzersRun: readonly string[]): Check {
  if (detector.name === "skillspector") {
    return {
      name: "trust detector skillspector",
      verdict: "pass",
      detail: `SkillSpector Docker static scan completed with --no-llm. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
    };
  }
  if (detector.name === "mcp-scanner") {
    return {
      name: "trust detector mcp-scanner",
      verdict: "pass",
      detail: `Cisco AI Defense mcp-scanner static scan completed through the committed uv lock with offline local analyzers. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
    };
  }
  if (detector.name === "semgrep") {
    return {
      name: "trust detector semgrep",
      verdict: "pass",
      detail: `Semgrep static scan completed with harness rules, SARIF output, --metrics=off, and --disable-version-check. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
    };
  }
  if (detector.name === "snyk-agent-scan") {
    return {
      name: "trust detector snyk-agent-scan",
      verdict: "pass",
      detail: `Snyk Agent Scan completed with JSON output, --no-bootstrap, and no MCP auto-exec bypass. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
    };
  }
  return {
    name: "trust detector cisco",
    verdict: "pass",
    detail: `Cisco AI Defense skill-scanner static scan completed through the committed uv lock with offline defaults-only. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
  };
}

function isRequired(
  detector: TrustDetectorName,
  requiredDetectors: readonly TrustDetectorName[],
): boolean {
  return requiredDetectors.includes(detector);
}

const SKILL_TRUST_DETECTORS: TrustDetector[] = [
  {
    name: "skillspector",
    analyzerLabel: "skillspector@docker",
    checkAvailable: checkSkillspectorAvailable,
    runScan: runSkillspectorScan,
    ruleMap: SKILLSPECTOR_RULE_MAP,
  },
  {
    name: "cisco",
    analyzerLabel: "cisco@uvx",
    checkAvailable: checkCiscoAvailable,
    runScan: runCiscoSkillScan,
    ruleMap: CISCO_RULE_MAP,
  },
  {
    name: "semgrep",
    analyzerLabel: "semgrep@uv:1.172.0",
    checkAvailable: checkSemgrepAvailable,
    runScan: runSemgrepScan,
    ruleMap: SEMGREP_RULE_MAP,
  },
  {
    name: "snyk-agent-scan",
    analyzerLabel: "snyk-agent-scan@uv:0.5.15",
    checkAvailable: checkSnykAgentScanAvailable,
    runScan: runSnykAgentScan,
    ruleMap: SNYK_AGENT_SCAN_RULE_MAP,
  },
];

const MCP_CONFIG_DETECTORS: TrustDetector[] = [
  // Semgrep stays in SKILL_TRUST_DETECTORS: it scans the full trust tree,
  // including MCP config files. This list is for MCP-specific detector tools.
  {
    name: "mcp-scanner",
    analyzerLabel: "mcp-scanner@uv:4.8.1",
    checkAvailable: checkMcpScannerAvailable,
    runScan: runMcpScannerScan,
    ruleMap: MCP_SCANNER_RULE_MAP,
  },
];

const ALL_TRUST_DETECTORS: readonly TrustDetector[] = [
  ...SKILL_TRUST_DETECTORS,
  ...MCP_CONFIG_DETECTORS,
];

/** One requested detector that is NOT runnable, with the underlying reason. */
export interface DetectorAvailabilityProbe {
  name: TrustDetectorName;
  analyzerLabel: string;
  reason: string;
}

export interface DetectorAvailabilityOptions {
  run: Runner;
  platform: Platform;
  env: NodeJS.ProcessEnv;
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
}

/**
 * Probe availability of specific detectors WITHOUT scanning. Returns one entry
 * per requested detector that is not runnable, carrying the underlying reason
 * (e.g. an offline uv cache miss). An empty array means every requested detector
 * is ready. Used by the baseline preflight to fail fast with an actionable
 * provisioning message instead of aborting mid-vet with an opaque
 * missing-analyzer error. It never runs a scan, fabricates a receipt, or relaxes
 * the required-detector floor.
 */
export async function checkDetectorsAvailable(
  names: readonly TrustDetectorName[],
  options: DetectorAvailabilityOptions,
): Promise<DetectorAvailabilityProbe[]> {
  const runtimeOptions: TrustDetectorRuntimeOptions = {
    skillspectorImageApprovals: options.skillspectorImageApprovals ?? [],
  };
  const unavailable: DetectorAvailabilityProbe[] = [];
  for (const name of names) {
    const detector = ALL_TRUST_DETECTORS.find((candidate) => candidate.name === name);
    if (detector === undefined) throw new Error(`unknown trust detector: ${name}`);
    const reason = await detector.checkAvailable(
      options.run,
      options.platform,
      options.env,
      runtimeOptions,
    );
    if (reason !== undefined) {
      unavailable.push({ name, analyzerLabel: detector.analyzerLabel, reason });
    }
  }
  return unavailable;
}

async function runDetectorList(
  detectors: readonly TrustDetector[],
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  const required = options.requiredDetectors ?? [];
  const checks: Check[] = [];
  const analyzersRun: string[] = [];
  const rawOccurrences: RawScannerOccurrence[] = [];
  const runtimeOptions: TrustDetectorRuntimeOptions = {
    skillspectorImageApprovals: options.skillspectorImageApprovals ?? [],
    inventory: options.inventory,
  };
  const fallbackMalicious =
    options.corroboratedChecks === undefined
      ? scanNativeMaliciousCode(root, options.inventory)
      : [];
  const corroboratedDangerLocations = new Set(
    [...(options.corroboratedChecks ?? []), ...fallbackMalicious]
      .filter(
        (check) =>
          check.location !== undefined &&
          (check.code === "trust.malicious-code" || check.code === "trust.auto-exec-hook"),
      )
      .map(
        (check) =>
          `${check.code ?? ""}:${check.location?.uri ?? ""}:${String(check.location?.startLine ?? 1)}`,
      ),
  );

  for (const detector of detectors) {
    options.progress?.(`trust scan: detector ${detector.name} started`);
    let sarifText = options.precomputedSarif?.[detector.name];
    if (sarifText === undefined) {
      const unavailable = await detector.checkAvailable(
        options.run,
        options.platform,
        options.env,
        runtimeOptions,
      );
      if (unavailable !== undefined) {
        checks.push(
          unavailableCheck(
            detector.name,
            unavailable,
            options.posture,
            isRequired(detector.name, required),
          ),
        );
        continue;
      }

      try {
        sarifText = await detector.runScan(
          options.run,
          options.platform,
          options.env,
          root,
          runtimeOptions,
        );
      } catch (error) {
        checks.push(
          unavailableCheck(
            detector.name,
            (error as Error).message,
            options.posture,
            isRequired(detector.name, required),
          ),
        );
        continue;
      }
    }

    const mapped = sarifChecks(
      sarifText,
      root,
      options.posture,
      detector,
      corroboratedDangerLocations,
    );
    if (mapped === undefined) {
      checks.push(
        unavailableCheck(
          detector.name,
          "detector did not emit valid SARIF",
          options.posture,
          isRequired(detector.name, required),
        ),
      );
      continue;
    }

    analyzersRun.push(detector.analyzerLabel);
    rawOccurrences.push(...mapped.rawOccurrences);
    const completedAnalyzers = ["aih-native", ...analyzersRun];
    checks.push(analyzerPassCheck(detector, completedAnalyzers), ...mapped.checks);
    options.progress?.(`trust scan: detector ${detector.name} complete`);
  }

  return { checks, analyzersRun, rawOccurrences };
}

export async function runTrustDetectors(
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  const selected =
    options.detectors === undefined
      ? SKILL_TRUST_DETECTORS
      : SKILL_TRUST_DETECTORS.filter((detector) => options.detectors?.includes(detector.name));
  return runDetectorList(selected, root, options);
}

export async function runMcpConfigDetectors(
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  const selected =
    options.detectors === undefined
      ? MCP_CONFIG_DETECTORS
      : MCP_CONFIG_DETECTORS.filter((detector) => options.detectors?.includes(detector.name));
  return runDetectorList(selected, root, options);
}

export function trustRuntimeAdvisory(analyzersRun: readonly string[]): string {
  return [
    `No findings != safe. Static analyzers actually run: ${analyzersRun.join(", ")}.`,
    "What this gate does not cover, and the manual runtime mitigations to consider:",
    "- Transitive or pinned-dependency malice: run a sandboxed `npm install --ignore-scripts` and `npm audit` before trusting dependency behavior.",
    "- Hosted-MCP rug-pull after approval: run a runtime MCP-scan with tool-pinning before first use.",
    "- Bundled installer scripts may fetch-pipes remote code to a shell (`curl|wget ... | sh`); review setup scripts before running them.",
    '- Residual auto-exec risk: set `permissions.deny: ["Bash(*)"]` in the consuming CLI policy.',
    "These are advisory commands/settings for a human to review; the trust gate never auto-runs them.",
  ].join("\n");
}
