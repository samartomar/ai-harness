import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { Posture } from "../config/posture.js";
import type { Runner, RunResult } from "../internals/proc.js";
import type { Check, CheckCode } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";
import { MCP_CONFIG_FILES } from "../secrets/scan.js";
import { execArgv } from "../tools/install.js";
import { scrubFetchEnv } from "./fetch.js";
import { gradeTrustCheck } from "./grade.js";
import { collectFilesUnder, TRUST_SKIP_DIRS } from "./scan.js";

// Detector names land here only when the adapter can at least surface an honest
// availability check. A required-but-unavailable detector fails closed at
// enterprise posture rather than silently passing.
export type TrustDetectorName = "skillspector" | "cisco" | "mcp-scanner" | "semgrep";

export interface TrustDetector {
  name: TrustDetectorName;
  analyzerLabel: string;
  checkAvailable: (
    run: Runner,
    platform: Platform,
    env: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  runScan: (
    run: Runner,
    platform: Platform,
    env: NodeJS.ProcessEnv,
    tree: string,
  ) => Promise<string>;
  ruleMap: Record<string, CheckCode>;
}

export interface TrustDetectorOptions {
  env: NodeJS.ProcessEnv;
  platform: Platform;
  posture: Posture;
  requiredDetectors?: readonly TrustDetectorName[];
  run: Runner;
}

export interface TrustDetectorResult {
  checks: Check[];
  analyzersRun: string[];
}

const DETECTOR_UNAVAILABLE = "trust.detector-unavailable";
const CISCO_SKILL_SCANNER_PACKAGE = "cisco-ai-skill-scanner";
const CISCO_MCP_SCANNER_PACKAGE = "cisco-ai-mcp-scanner";
const SKILLSPECTOR_IMAGE = "skillspector:aih-326a2b489411";
// These Semgrep rules are deliberately small harness-owned safety rules, not a
// complete substitute for native trust checks. The regexes are line-oriented.
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
const SCRIPT_EXTENSIONS = new Set([
  "",
  ".bash",
  ".bat",
  ".cjs",
  ".cmd",
  ".js",
  ".mjs",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".ts",
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
  message?: { text?: unknown };
  locations?: SarifLocation[];
}

interface SarifRun {
  results?: SarifResult[];
}

interface SarifLog {
  runs?: SarifRun[];
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

function sha8(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

function normalizeShellWhitespace(line: string): string {
  // Collapse any ${IFS...} parameter-expansion form (plain, #/% removal, :offset
  // substring, //pattern substitution) and bare $IFS to a space, so IFS-obfuscated
  // reverse shells still match the patterns below.
  return line.replace(/\$\{IFS[^}]*\}|\$IFS\b/g, " ");
}

// Extensions that are never a shell/interpreter script — used to exclude
// install/script-NAMED media/archive assets (e.g. `install-notes.png`) from the
// text scan while still covering extensionless installers (`install`, `setup`).
const NON_SCRIPT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
]);

// Filenames that are conventionally executable setup scripts even without a
// script extension (a reverse shell in a bundled `install`/`setup` is the exact
// risk this layer exists to catch).
const SCRIPT_LIKE_SUBSTRINGS = [
  "install",
  "setup",
  "configure",
  "bootstrap",
  "entrypoint",
  "postinstall",
  "preinstall",
  "build",
  "script",
];

function isScriptLike(rel: string): boolean {
  const name = basename(rel).toLowerCase();
  if (name === "package.json" || name === "package-lock.json") return false;
  const ext = extname(name);
  if (SCRIPT_EXTENSIONS.has(ext)) return true;
  // A media/archive asset that merely happens to be install-named is not a script.
  if (NON_SCRIPT_EXTENSIONS.has(ext)) return false;
  // Otherwise, scan setup-script-named files (incl. extensionless `install`/`setup`)
  // so a reverse shell in a conventionally-named installer is not silently skipped.
  return SCRIPT_LIKE_SUBSTRINGS.some((needle) => name.includes(needle));
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

function maliciousCodeCheck(rel: string, line: number, text: string, label: string): Check {
  return {
    name: "trust.malicious-code",
    verdict: "fail",
    code: "trust.malicious-code",
    detail: `${rel}:${line} — bundled script matches ${label}; static trust gate rejects raw malicious-code shapes`,
    location: { uri: rel, startLine: line },
    fingerprint: `trust-malicious-code:${rel}:${line}:${sha8(text)}`,
  };
}

export function scanNativeMaliciousCode(root: string): Check[] {
  const files = collectFilesUnder(
    root,
    (abs) => {
      const rel = toPosix(relative(root, abs));
      return isScriptLike(rel) && statSync(abs).size <= MAX_SCRIPT_SCAN_BYTES;
    },
    TRUST_SKIP_DIRS,
  );
  const checks: Check[] = [];
  for (const file of files) {
    const rel = toPosix(relative(root, file));
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const normalizedLine = normalizeShellWhitespace(line);
      for (const rule of MALICIOUS_PATTERNS) {
        if (rule.pattern.test(normalizedLine)) {
          checks.push(maliciousCodeCheck(rel, index + 1, line, rule.label));
        }
      }
    });
  }
  return checks;
}

export function skillspectorDockerRunArgv(platform: Platform, tree: string): string[] {
  // Native Windows Docker bind mounts can reject drive-letter paths; that fails safe to skip.
  return execArgv(platform, [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,source=${tree},target=/scan,readonly`,
    SKILLSPECTOR_IMAGE,
    "scan",
    "/scan",
    "--no-llm",
    "--format",
    "sarif",
  ]);
}

function ciscoSkillScannerBaseArgv(): string[] {
  return [
    "uvx",
    "--offline",
    "--no-python-downloads",
    "--no-env-file",
    "--from",
    CISCO_SKILL_SCANNER_PACKAGE,
    "skill-scanner",
  ];
}

function mcpScannerBaseArgv(): string[] {
  return [
    "uvx",
    "--offline",
    "--no-python-downloads",
    "--no-env-file",
    "--from",
    CISCO_MCP_SCANNER_PACKAGE,
    "mcp-scanner",
  ];
}

function ciscoSkillScannerVersionArgv(platform: Platform): string[] {
  return execArgv(platform, [...ciscoSkillScannerBaseArgv(), "--version"]);
}

function mcpScannerHelpArgv(platform: Platform): string[] {
  return execArgv(platform, [...mcpScannerBaseArgv(), "--help"]);
}

function semgrepVersionArgv(platform: Platform): string[] {
  return execArgv(platform, ["semgrep", "--version"]);
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

export function mcpScannerStaticArgv(
  platform: Platform,
  inputJson: string,
  outputSarif: string,
): string[] {
  return execArgv(platform, [
    ...mcpScannerBaseArgv(),
    "--storage",
    "memory",
    "static",
    "--tools",
    inputJson,
    "--format",
    "sarif",
    "--output",
    outputSarif,
    "--analyzers",
    "yara,prompt-injection,tool-poisoning,secrets",
  ]);
}

export function semgrepScanArgv(platform: Platform, tree: string, config: string): string[] {
  return execArgv(platform, [
    "semgrep",
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

function dockerVersionArgv(platform: Platform): string[] {
  return execArgv(platform, ["docker", "--version"]);
}

function skillspectorImageInspectArgv(platform: Platform): string[] {
  return execArgv(platform, [
    "docker",
    "image",
    "inspect",
    SKILLSPECTOR_IMAGE,
    "--format",
    "{{.Id}}",
  ]);
}

function runFailureReason(result: RunResult, fallback: string): string | undefined {
  if (!result.spawnError && result.code === 0) return undefined;
  return result.stderr || result.stdout || fallback;
}

async function checkSkillspectorAvailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const version = await run(dockerVersionArgv(platform), {
    env: scrubFetchEnv(env),
    timeoutMs: 30_000,
  });
  const versionReason = runFailureReason(version, `docker exit ${version.code ?? "signal"}`);
  if (versionReason !== undefined) return versionReason;

  const image = await run(skillspectorImageInspectArgv(platform), {
    env: scrubFetchEnv(env),
    timeoutMs: 30_000,
  });
  const imageReason = runFailureReason(image, "skillspector Docker image not present locally");
  if (imageReason !== undefined) return imageReason;
  if (image.stdout.trim().length === 0) return "skillspector Docker image not present locally";
  return undefined;
}

async function runSkillspectorScan(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  tree: string,
): Promise<string> {
  const scan = await run(skillspectorDockerRunArgv(platform, tree), {
    env: scrubFetchEnv(env),
    timeoutMs: 120_000,
  });
  const reason = runFailureReason(scan, `detector exit ${scan.code ?? "signal"}`);
  if (reason !== undefined) throw new Error(reason);
  return scan.stdout;
}

async function checkCiscoAvailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const version = await run(ciscoSkillScannerVersionArgv(platform), {
    env: scrubFetchEnv(env),
    timeoutMs: 30_000,
  });
  const reason = runFailureReason(version, `uvx exit ${version.code ?? "signal"}`);
  if (reason !== undefined) return reason;
  if (`${version.stdout}${version.stderr}`.trim().length === 0) {
    return "skill-scanner version check emitted no output";
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
    timeoutMs: 30_000,
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
    timeoutMs: 30_000,
  });
  const reason = runFailureReason(version, `semgrep exit ${version.code ?? "signal"}`);
  if (reason !== undefined) return reason;
  if (`${version.stdout}${version.stderr}`.trim().length === 0) {
    return "semgrep version check emitted no output";
  }
  return undefined;
}

function collectCiscoSkillDirs(root: string): string[] {
  const skillFiles = collectFilesUnder(
    root,
    (abs) => basename(abs) === "SKILL.md",
    TRUST_SKIP_DIRS,
  );
  return [...new Set(skillFiles.map((file) => dirname(file)))].sort((a, b) =>
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

async function runCiscoSkillScan(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  tree: string,
): Promise<string> {
  const skillDirs = collectCiscoSkillDirs(tree);
  if (skillDirs.length === 0) throw new Error("no SKILL.md directories found for Cisco scan");
  const runs: SarifRun[] = [];
  for (const skillDir of skillDirs) {
    const tmp = mkdtempSync(join(tmpdir(), "aih-cisco-sarif-"));
    const output = join(tmp, "results.sarif");
    try {
      const scan = await run(ciscoSkillScannerRunArgv(platform, skillDir, output), {
        env: scrubFetchEnv(env),
        timeoutMs: 120_000,
      });
      const reason = runFailureReason(scan, `detector exit ${scan.code ?? "signal"}`);
      if (reason !== undefined) throw new Error(reason);
      const prefixed = prefixCiscoSarifUris(readFileSync(output, "utf8"), tree, skillDir);
      runs.push(...(prefixed.runs ?? []));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return JSON.stringify({ version: "2.1.0", runs });
}

function mcpConfigFiles(root: string): string[] {
  const known = new Set(MCP_CONFIG_FILES);
  return collectFilesUnder(root, (abs) => known.has(toPosix(relative(root, abs))), TRUST_SKIP_DIRS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function mcpStaticTools(root: string): Array<Record<string, unknown>> {
  return mcpConfigFiles(root).flatMap((abs) => {
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
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "aih-mcp-scanner-"));
  const input = join(tmp, "tools.json");
  const output = join(tmp, "results.sarif");
  try {
    writeFileSync(input, `${JSON.stringify({ tools: mcpStaticTools(tree) }, null, 2)}\n`, "utf8");
    const scan = await run(mcpScannerStaticArgv(platform, input, output), {
      env: scrubFetchEnv(env),
      timeoutMs: 120_000,
    });
    const reason = runFailureReason(scan, `detector exit ${scan.code ?? "signal"}`);
    if (reason !== undefined) throw new Error(reason);
    return readFileSync(output, "utf8");
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
    if (parseSarifLog(scan.stdout) === undefined) {
      const detail = scan.stderr.trim().length > 0 ? `: ${scan.stderr.trim()}` : "";
      throw new Error(`semgrep scan did not emit valid SARIF${detail}`);
    }
    return scan.stdout;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

function ruleCode(result: SarifResult, detector: TrustDetector): CheckCode | undefined {
  const raw = resultRuleId(result);
  if (raw === undefined) return undefined;
  const hasGenericExternalFallback = detector.name === "cisco" || detector.name === "mcp-scanner";
  return (
    detector.ruleMap[raw] ??
    (detector.name === "semgrep"
      ? "trust.detector-finding"
      : hasGenericExternalFallback
        ? "trust.cisco-finding"
        : undefined)
  );
}

function detectorFindingLabel(detector: TrustDetector): string {
  if (detector.name === "skillspector") return "SkillSpector";
  if (detector.name === "mcp-scanner") return "Cisco AI Defense mcp-scanner";
  if (detector.name === "semgrep") return "Semgrep";
  return "Cisco AI Defense skill-scanner";
}

function resultMessage(result: SarifResult, detector: TrustDetector): string {
  return typeof result.message?.text === "string" && result.message.text.length > 0
    ? result.message.text
    : `${detectorFindingLabel(detector)} SARIF finding`;
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
  code: CheckCode,
  root: string,
  location: NonNullable<Check["location"]>,
  detail: string,
  detector: TrustDetector,
): string {
  const line = location.startLine ?? 1;
  const sourceLine = fileLine(join(root, location.uri), line) ?? detail;
  return `${code.replace(/\./g, "-")}:${detector.name}:${location.uri}:${line}:${sha8(sourceLine)}`;
}

function sarifChecks(
  stdout: string,
  root: string,
  posture: Posture,
  detector: TrustDetector,
): Check[] | undefined {
  const parsed = parseSarifLog(stdout);
  if (parsed === undefined) return undefined;
  const checks: Check[] = [];
  for (const run of parsed.runs) {
    for (const result of run.results ?? []) {
      const code = ruleCode(result, detector);
      if (code === undefined) continue;
      const location = sarifLocation(result, detector);
      const detail = resultMessage(result, detector);
      checks.push(
        gradeTrustCheck(
          {
            name: code,
            verdict: "fail",
            code,
            detail: `${location.uri}:${location.startLine ?? 1} — ${detectorFindingLabel(detector)}: ${detail}`,
            location,
            fingerprint: sarifFingerprint(code, root, location, detail, detector),
          },
          posture,
        ),
      );
    }
  }
  return checks;
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
      detail: `Cisco AI Defense mcp-scanner static scan completed through uvx --offline defaults-only. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
    };
  }
  if (detector.name === "semgrep") {
    return {
      name: "trust detector semgrep",
      verdict: "pass",
      detail: `Semgrep static scan completed with harness rules, SARIF output, --metrics=off, and --disable-version-check. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
    };
  }
  return {
    name: "trust detector cisco",
    verdict: "pass",
    detail: `Cisco AI Defense skill-scanner static scan completed through uvx --offline defaults-only. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
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
    analyzerLabel: "semgrep@local",
    checkAvailable: checkSemgrepAvailable,
    runScan: runSemgrepScan,
    ruleMap: SEMGREP_RULE_MAP,
  },
];

const MCP_CONFIG_DETECTORS: TrustDetector[] = [
  // Semgrep stays in SKILL_TRUST_DETECTORS: it scans the full trust tree,
  // including MCP config files. This list is for MCP-specific detector tools.
  {
    name: "mcp-scanner",
    analyzerLabel: "mcp-scanner@uvx",
    checkAvailable: checkMcpScannerAvailable,
    runScan: runMcpScannerScan,
    ruleMap: MCP_SCANNER_RULE_MAP,
  },
];

async function runDetectorList(
  detectors: readonly TrustDetector[],
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  const required = options.requiredDetectors ?? [];
  const checks: Check[] = [];
  const analyzersRun: string[] = [];

  for (const detector of detectors) {
    const unavailable = await detector.checkAvailable(options.run, options.platform, options.env);
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

    let sarifText: string;
    try {
      sarifText = await detector.runScan(options.run, options.platform, options.env, root);
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

    const mapped = sarifChecks(sarifText, root, options.posture, detector);
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
    const completedAnalyzers = ["aih-native", ...analyzersRun];
    checks.push(analyzerPassCheck(detector, completedAnalyzers), ...mapped);
  }

  return { checks, analyzersRun };
}

export async function runTrustDetectors(
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  return runDetectorList(SKILL_TRUST_DETECTORS, root, options);
}

export async function runMcpConfigDetectors(
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  return runDetectorList(MCP_CONFIG_DETECTORS, root, options);
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
