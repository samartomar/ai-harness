import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Posture } from "../config/posture.js";
import type { Runner } from "../internals/proc.js";
import type { Check, CheckCode } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";
import { execArgv } from "../tools/install.js";
import { scrubFetchEnv } from "./fetch.js";
import { gradeTrustCheck } from "./grade.js";

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
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aih",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
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
    label: "curl piped to shell",
    pattern: /\bcurl\b[^\n|;&]*\|\s*(?:bash|sh)\b/,
  },
  {
    label: "wget piped to shell",
    pattern: /\bwget\b[^\n|;&]*\|\s*(?:bash|sh)\b/,
  },
  {
    label: "base64-decoded payload piped to shell",
    pattern: /\bbase64\b[^\n|;&]*(?:-d|--decode)?[^\n|;&]*\|\s*(?:bash|sh)\b/,
  },
  {
    label: "netcat exec shell",
    pattern: /\bnc\b[^\n]*(?:-e|-c)\s*(?:\/bin\/)?(?:bash|sh)\b/,
  },
];

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function sha8(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

function collectFiles(root: string, accept: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      if (abs !== root && SKIP_DIRS.has(basename(abs))) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (!st.isFile()) return;
    const rel = toPosix(relative(root, abs));
    if (accept(rel)) out.push(abs);
  };
  visit(root);
  return out.sort((a, b) => toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))));
}

function isScriptLike(rel: string): boolean {
  const name = basename(rel).toLowerCase();
  if (name === "package.json" || name === "package-lock.json") return false;
  if (name.includes("script") || name.includes("install")) return true;
  return SCRIPT_EXTENSIONS.has(extname(name));
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
  const files = collectFiles(root, isScriptLike);
  const checks: Check[] = [];
  for (const file of files) {
    const rel = toPosix(relative(root, file));
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of MALICIOUS_PATTERNS) {
        if (rule.pattern.test(line)) {
          checks.push(maliciousCodeCheck(rel, index + 1, line, rule.label));
        }
      }
    });
  }
  return checks;
}

export function skillspectorDockerRunArgv(platform: Platform, tree: string): string[] {
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

function normalizeSarifUri(root: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "skillspector.sarif";
  const stripped = raw
    .replace(/^file:\/\//, "")
    .replace(/^\/scan\/?/, "")
    .replace(/^scan\/?/, "");
  return toPosix(stripped) || toPosix(relative(root, root));
}

function sarifStartLine(result: SarifResult): number {
  const raw = result.locations?.[0]?.physicalLocation?.region?.startLine;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function sarifLocation(result: SarifResult, root: string): NonNullable<Check["location"]> {
  const physical = result.locations?.[0]?.physicalLocation;
  return {
    uri: normalizeSarifUri(root, physical?.artifactLocation?.uri),
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
      const location = sarifLocation(result, root);
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
    '- Residual auto-exec risk: set `permissions.deny: ["Bash(*)"]` in the consuming CLI policy.',
    "These are advisory commands/settings for a human to review; the trust gate never auto-runs them.",
  ].join("\n");
}
