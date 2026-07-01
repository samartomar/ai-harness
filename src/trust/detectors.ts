import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import type { Posture } from "../config/posture.js";
import type { Runner } from "../internals/proc.js";
import type { Check, CheckCode } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";
import { execArgv } from "../tools/install.js";
import { scrubFetchEnv } from "./fetch.js";
import { gradeTrustCheck } from "./grade.js";
import { collectFilesUnder, TRUST_SKIP_DIRS } from "./scan.js";

export type TrustDetectorName = "skillspector" | "cisco" | "semgrep";

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

const SKILLSPECTOR_ANALYZER = "skillspector@docker";
const DETECTOR_UNAVAILABLE = "trust.detector-unavailable";
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
  return line.replace(/\$\{IFS(?:[#%]{1,2}[^}]*)?\}|\$IFS\b/g, " ");
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
      return isScriptLike(rel) && lstatSync(abs).size <= MAX_SCRIPT_SCAN_BYTES;
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
    "-v",
    `${tree}:/scan`,
    "skillspector",
    "scan",
    "/scan",
    "--no-llm",
    "--format",
    "sarif",
  ]);
}

function dockerVersionArgv(platform: Platform): string[] {
  return execArgv(platform, ["docker", "--version"]);
}

function skillspectorImageInspectArgv(platform: Platform): string[] {
  return execArgv(platform, ["docker", "image", "inspect", "skillspector", "--format", "{{.Id}}"]);
}

function unavailableDetail(detector: TrustDetectorName, reason: string): string {
  return `DEGRADED-COVERAGE: deep scan SKIPPED — ${detector} not available (${reason}); coverage is GREEN-tier only. Analyzers run: aih-native`;
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

function unsupportedRequiredDetectorCheck(detector: TrustDetectorName, posture: Posture): Check {
  return unavailableCheck(
    detector,
    "detector integration is not installed in this harness",
    posture,
    true,
  );
}

function ruleCode(result: SarifResult): CheckCode | undefined {
  const raw = typeof result.ruleId === "string" ? result.ruleId : result.rule?.id;
  return typeof raw === "string" ? SKILLSPECTOR_RULE_MAP[raw] : undefined;
}

function resultMessage(result: SarifResult): string {
  return typeof result.message?.text === "string" && result.message.text.length > 0
    ? result.message.text
    : "SkillSpector SARIF finding";
}

function normalizeSarifUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "skillspector.sarif";
  const stripped = toPosix(
    raw
      .replace(/^file:\/\//, "")
      .replace(/^\/scan\/?/, "")
      .replace(/^scan\/?/, ""),
  );
  if (!isSafeRelativeSarifUri(stripped)) return "skillspector.sarif";
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

function sarifLocation(result: SarifResult): NonNullable<Check["location"]> {
  const physical = result.locations?.[0]?.physicalLocation;
  return {
    uri: normalizeSarifUri(physical?.artifactLocation?.uri),
    startLine: sarifStartLine(result),
  };
}

function sarifFingerprint(
  code: CheckCode,
  root: string,
  location: NonNullable<Check["location"]>,
  detail: string,
): string {
  const line = location.startLine ?? 1;
  const sourceLine = fileLine(join(root, location.uri), line) ?? detail;
  return `${code.replace(/\./g, "-")}:skillspector:${location.uri}:${line}:${sha8(sourceLine)}`;
}

function sarifChecks(stdout: string, root: string, posture: Posture): Check[] | undefined {
  let parsed: SarifLog;
  try {
    parsed = JSON.parse(stdout) as SarifLog;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.runs)) return undefined;
  const checks: Check[] = [];
  for (const run of parsed.runs) {
    for (const result of run.results ?? []) {
      const code = ruleCode(result);
      if (code === undefined) continue;
      const location = sarifLocation(result);
      const detail = resultMessage(result);
      checks.push(
        gradeTrustCheck(
          {
            name: code,
            verdict: "fail",
            code,
            detail: `${location.uri}:${location.startLine ?? 1} — SkillSpector: ${detail}`,
            location,
            fingerprint: sarifFingerprint(code, root, location, detail),
          },
          posture,
        ),
      );
    }
  }
  return checks;
}

function analyzerPassCheck(analyzersRun: readonly string[]): Check {
  return {
    name: "trust detector skillspector",
    verdict: "pass",
    detail: `SkillSpector Docker static scan completed with --no-llm. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
  };
}

function isRequired(
  detector: TrustDetectorName,
  requiredDetectors: readonly TrustDetectorName[],
): boolean {
  return requiredDetectors.includes(detector);
}

export async function runTrustDetectors(
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  const required = options.requiredDetectors ?? [];
  const checks: Check[] = [];
  const analyzersRun: string[] = [];

  const version = await options.run(dockerVersionArgv(options.platform), {
    env: scrubFetchEnv(options.env),
    timeoutMs: 30_000,
  });
  if (version.spawnError || version.code === 127 || version.code !== 0) {
    checks.push(
      unavailableCheck(
        "skillspector",
        version.stderr || version.stdout || `docker exit ${version.code ?? "signal"}`,
        options.posture,
        isRequired("skillspector", required),
      ),
    );
  } else {
    const image = await options.run(skillspectorImageInspectArgv(options.platform), {
      env: scrubFetchEnv(options.env),
      timeoutMs: 30_000,
    });
    if (
      image.spawnError ||
      image.code === 127 ||
      image.code !== 0 ||
      image.stdout.trim().length === 0
    ) {
      checks.push(
        unavailableCheck(
          "skillspector",
          image.stderr || image.stdout || "skillspector Docker image not present locally",
          options.posture,
          isRequired("skillspector", required),
        ),
      );
    } else {
      const scan = await options.run(skillspectorDockerRunArgv(options.platform, root), {
        env: scrubFetchEnv(options.env),
        timeoutMs: 120_000,
      });
      if (scan.spawnError || scan.code === 127 || scan.code !== 0) {
        checks.push(
          unavailableCheck(
            "skillspector",
            scan.stderr || scan.stdout || `detector exit ${scan.code ?? "signal"}`,
            options.posture,
            isRequired("skillspector", required),
          ),
        );
      } else {
        const mapped = sarifChecks(scan.stdout, root, options.posture);
        if (mapped === undefined) {
          checks.push(
            unavailableCheck(
              "skillspector",
              "detector did not emit valid SARIF",
              options.posture,
              isRequired("skillspector", required),
            ),
          );
        } else {
          analyzersRun.push(SKILLSPECTOR_ANALYZER);
          const completedAnalyzers = ["aih-native", ...analyzersRun];
          checks.push(analyzerPassCheck(completedAnalyzers), ...mapped);
        }
      }
    }
  }

  for (const detector of required) {
    if (detector === "skillspector") continue;
    checks.push(unsupportedRequiredDetectorCheck(detector, options.posture));
  }

  return { checks, analyzersRun };
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
