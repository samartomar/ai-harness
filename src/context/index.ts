import { createHash } from "node:crypto";

export type ContextFileClassification = "hard-exclude" | "soft-exclude" | "conditional-include";

export type ContextInclusionDecision = "include" | "exclude";

export type ContextFileType =
  | "source"
  | "test"
  | "canon"
  | "manifest"
  | "doc"
  | "config"
  | "lockfile"
  | "generated"
  | "secret"
  | "binary"
  | "other";

export type ContextTaskKind =
  | "implementation"
  | "review"
  | "testing"
  | "security"
  | "docs"
  | "release"
  | "closeout";

export interface ContextClassifierOptions {
  contextDir?: string;
}

export interface ContextFileClassificationResult {
  path: string;
  classification: ContextFileClassification;
  type: ContextFileType;
  reasons: string[];
}

export interface ContextFileCandidate {
  path: string;
  bytes?: number;
  relevance?: number;
  type?: ContextFileType;
}

export interface ContextBudgetOptions extends ContextClassifierOptions {
  maxTokens?: number;
  maxFileTokens?: number;
  taskPaths?: readonly string[];
  taskKeywords?: readonly string[];
}

export interface ContextFileScore extends ContextFileClassificationResult {
  decision: ContextInclusionDecision;
  score: number;
  tokenEstimate: number;
}

export interface ContextBudgetTrace extends ContextFileScore {
  reasons: string[];
}

export interface ContextBudgetReport {
  included: ContextBudgetTrace[];
  excluded: ContextBudgetTrace[];
  reasonTrace: ContextBudgetTrace[];
  totalTokenEstimate: number;
  maxTokens: number;
}

export interface LazyCanonOptions extends ContextClassifierOptions {
  taskKind?: ContextTaskKind;
  touchedPaths?: readonly string[];
}

export interface LazyCanonFile extends ContextFileClassificationResult {
  role: "router" | "core" | "contract" | "rule";
}

const DEFAULT_CONTEXT_DIR = "ai-coding";
const DEFAULT_MAX_TOKENS = 24_000;
const DEFAULT_MAX_FILE_TOKENS = 8_000;
const DEFAULT_TOKEN_ESTIMATE = 64;
const MAX_TOKEN_ESTIMATE = 1_000_000;
const MAX_PATH_LABEL_LENGTH = 240;

const HARD_EXCLUDE_TOP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", ".aih"]);
const SOFT_EXCLUDE_TOP_DIRS = new Set([
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "vendor",
  ".serverless",
  "cdk.out",
  ".terraform",
  ".var",
]);
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
]);
const MANIFEST_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "biome.json",
  "biome.jsonc",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "vitest.config.ts",
  "vite.config.ts",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".sh",
  ".ps1",
  ".sql",
  ".css",
  ".scss",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const CONFIG_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tgz",
  ".gz",
  ".7z",
  ".wasm",
  ".exe",
  ".dll",
]);

interface NormalizedPath {
  label: string;
  canonical: string;
  segments: string[];
  hostile: boolean;
  reasons: string[];
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function truncateWithHash(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = `-${shortHash(value)}`;
  let head = Array.from(value)
    .slice(0, Math.max(0, maxLength - suffix.length))
    .join("");
  while (head.length + suffix.length > maxLength) head = head.slice(0, -1);
  return `${head}${suffix}`;
}

function sanitizePathLabel(value: string): string {
  const sanitized = value
    .replace(/\\/g, "/")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: report labels must not carry terminal controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "-")
    .replace(/[^A-Za-z0-9._@+/ -]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return truncateWithHash(sanitized.length > 0 ? sanitized : "path", MAX_PATH_LABEL_LENGTH);
}

function hostilePathLabel(raw: string): string {
  return `hostile-path-${shortHash(raw)}`;
}

function normalizeRepoPath(raw: string): NormalizedPath {
  const slash = raw.replace(/\\/g, "/");
  const reasons: string[] = [];

  if (slash.length === 0) reasons.push("empty path rejected");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: path boundary validation rejects controls
  if (/[\u0000-\u001f\u007f-\u009f]/.test(slash)) reasons.push("control character rejected");
  if (slash.startsWith("/") || slash.startsWith("//") || /^[A-Za-z]:\//.test(slash)) {
    reasons.push("absolute path rejected");
  }
  const segments = slash.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    reasons.push("path traversal rejected");
  }

  if (reasons.length > 0) {
    return {
      label: hostilePathLabel(raw),
      canonical: slash,
      segments: [],
      hostile: true,
      reasons: ["hostile path rejected", ...reasons],
    };
  }

  return {
    label: sanitizePathLabel(slash),
    canonical: slash,
    segments,
    hostile: false,
    reasons: [],
  };
}

function normalizeContextDir(raw: string | undefined): string {
  const normalized = normalizeRepoPath(raw ?? DEFAULT_CONTEXT_DIR);
  return normalized.hostile ? DEFAULT_CONTEXT_DIR : normalized.canonical;
}

function extensionOf(path: string): string {
  const last = path.split("/").at(-1) ?? path;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot).toLowerCase() : "";
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function isSecretPath(segments: readonly string[]): boolean {
  return (
    segments[0] === "secrets" ||
    segments.some((segment) => segment === ".env" || segment.startsWith(".env."))
  );
}

function isGeneratedPath(path: string, segments: readonly string[]): boolean {
  const first = segments[0];
  const base = basename(path).toLowerCase();
  return (
    (first !== undefined && SOFT_EXCLUDE_TOP_DIRS.has(first)) ||
    base.endsWith(".map") ||
    base.endsWith(".min.js") ||
    base.endsWith(".gen.ts") ||
    base.endsWith(".generated.ts")
  );
}

function isTestPath(path: string, segments: readonly string[]): boolean {
  const base = basename(path).toLowerCase();
  return (
    segments.includes("tests") ||
    segments.includes("__tests__") ||
    base.includes(".test.") ||
    base.includes(".spec.")
  );
}

function isContextPath(path: string, contextDir: string): boolean {
  return path === contextDir || path.startsWith(`${contextDir}/`);
}

function inferContextFileType(
  path: string,
  segments: readonly string[],
  contextDir: string,
): ContextFileType {
  const base = basename(path);
  const lowerBase = base.toLowerCase();
  const ext = extensionOf(path);
  if (isSecretPath(segments)) return "secret";
  if (isContextPath(path, contextDir)) return "canon";
  if (isGeneratedPath(path, segments)) return "generated";
  if (LOCKFILE_NAMES.has(base)) return "lockfile";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  if (isTestPath(path, segments)) return "test";
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  if (MANIFEST_NAMES.has(base) || lowerBase.startsWith(".eslintrc")) return "manifest";
  if (DOC_EXTENSIONS.has(ext) || segments[0] === "docs") return "doc";
  if (CONFIG_EXTENSIONS.has(ext) || base.startsWith(".")) return "config";
  return "other";
}

function classificationFor(
  type: ContextFileType,
  segments: readonly string[],
): ContextFileClassification {
  const first = segments[0];
  if (type === "secret") return "hard-exclude";
  if (first !== undefined && HARD_EXCLUDE_TOP_DIRS.has(first)) return "hard-exclude";
  if (type === "generated" || type === "lockfile" || type === "binary") return "soft-exclude";
  return "conditional-include";
}

function reasonFor(type: ContextFileType, classification: ContextFileClassification): string {
  if (classification === "hard-exclude") {
    if (type === "secret") return "secret path denied";
    return "non-authoritative path denied";
  }
  switch (type) {
    case "generated":
      return "generated artifact";
    case "lockfile":
      return "large lock artifact";
    case "binary":
      return "binary artifact";
    case "canon":
      return "repo canon file";
    case "source":
      return "source file";
    case "test":
      return "test file";
    case "manifest":
      return "manifest file";
    case "doc":
      return "documentation file";
    case "config":
      return "configuration file";
    case "other":
    case "secret":
      return "candidate context file";
  }
}

export function classifyContextFile(
  path: string,
  options: ContextClassifierOptions = {},
): ContextFileClassificationResult {
  const normalized = normalizeRepoPath(path);
  if (normalized.hostile) {
    return {
      path: normalized.label,
      classification: "hard-exclude",
      type: "other",
      reasons: normalized.reasons,
    };
  }

  const contextDir = normalizeContextDir(options.contextDir);
  const type = inferContextFileType(normalized.canonical, normalized.segments, contextDir);
  const classification = classificationFor(type, normalized.segments);
  const reasons = [reasonFor(type, classification)];
  return { path: normalized.label, classification, type, reasons };
}

function normalizeRelevance(value: number | undefined): number {
  if (value === undefined) return 0.5;
  if (!Number.isFinite(value)) return 0;
  if (value > 1 && value <= 100) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function estimateTokens(bytes: number | undefined, type: ContextFileType): number {
  if (bytes === undefined) return type === "canon" ? 96 : DEFAULT_TOKEN_ESTIMATE;
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_TOKEN_ESTIMATE;
  return Math.max(1, Math.min(MAX_TOKEN_ESTIMATE, Math.ceil(bytes / 4)));
}

function typeWeight(type: ContextFileType): number {
  switch (type) {
    case "source":
      return 30;
    case "test":
      return 28;
    case "canon":
      return 26;
    case "manifest":
      return 24;
    case "config":
      return 20;
    case "doc":
      return 16;
    case "other":
      return 8;
    case "lockfile":
      return -20;
    case "generated":
      return -25;
    case "binary":
      return -35;
    case "secret":
      return -100;
  }
}

function classificationBase(classification: ContextFileClassification): number {
  switch (classification) {
    case "conditional-include":
      return 35;
    case "soft-exclude":
      return 10;
    case "hard-exclude":
      return 0;
  }
}

function normalizedTaskPaths(taskPaths: readonly string[] | undefined): string[] {
  return (taskPaths ?? [])
    .map((path) => normalizeRepoPath(path))
    .filter((path) => !path.hostile)
    .map((path) => path.canonical);
}

function taskPathBonus(path: string, taskPaths: readonly string[] | undefined): number {
  const normalized = normalizedTaskPaths(taskPaths);
  if (normalized.includes(path)) return 50;
  if (
    normalized.some(
      (taskPath) => path.startsWith(`${taskPath}/`) || taskPath.startsWith(`${path}/`),
    )
  ) {
    return 20;
  }
  return 0;
}

function keywordBonus(path: string, taskKeywords: readonly string[] | undefined): number {
  const lowerPath = path.toLowerCase();
  let score = 0;
  for (const keyword of taskKeywords ?? []) {
    const normalized = keyword.toLowerCase().trim();
    if (normalized.length > 1 && lowerPath.includes(normalized)) score += 6;
  }
  return Math.min(score, 18);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function boundedMaxFileTokens(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FILE_TOKENS;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_TOKEN_ESTIMATE, Math.floor(value));
}

export function scoreContextFile(
  candidate: ContextFileCandidate,
  options: ContextBudgetOptions = {},
): ContextFileScore {
  const classified = classifyContextFile(candidate.path, options);
  const normalized = normalizeRepoPath(candidate.path);
  const canonicalPath = normalized.hostile ? classified.path : normalized.canonical;
  const type = candidate.type ?? classified.type;
  const relevance = normalizeRelevance(candidate.relevance);
  const tokenEstimate = estimateTokens(candidate.bytes, type);
  const score = clampScore(
    classificationBase(classified.classification) +
      typeWeight(type) +
      relevance * 40 +
      taskPathBonus(canonicalPath, options.taskPaths) +
      keywordBonus(canonicalPath, options.taskKeywords),
  );
  const maxFileTokens = boundedMaxFileTokens(options.maxFileTokens);
  const reasons = [
    ...classified.reasons,
    `relevance ${relevance.toFixed(2)}`,
    `${tokenEstimate} token estimate`,
  ];
  if (tokenEstimate > maxFileTokens) reasons.push("file token estimate exceeds per-file budget");

  let decision: ContextInclusionDecision = "include";
  if (classified.classification === "hard-exclude") decision = "exclude";
  else if (tokenEstimate > maxFileTokens) decision = "exclude";
  else if (classified.classification === "soft-exclude" && score < 75) decision = "exclude";
  else if (classified.classification === "conditional-include" && score < 35) decision = "exclude";
  if (decision === "exclude" && classified.classification === "soft-exclude") {
    reasons.push("soft-excluded unless explicitly relevant");
  }

  return {
    ...classified,
    type,
    decision,
    score,
    tokenEstimate,
    reasons,
  };
}

function boundedMaxTokens(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_TOKENS;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_TOKEN_ESTIMATE, Math.floor(value));
}

function byScoreThenPath(
  a: { file: ContextFileScore; index: number },
  b: { file: ContextFileScore; index: number },
): number {
  return b.file.score - a.file.score || a.file.path.localeCompare(b.file.path) || a.index - b.index;
}

export function buildContextBudgetReport(
  candidates: readonly ContextFileCandidate[],
  options: ContextBudgetOptions = {},
): ContextBudgetReport {
  const maxTokens = boundedMaxTokens(options.maxTokens);
  const ranked = candidates
    .map((candidate, index) => ({ file: scoreContextFile(candidate, options), index }))
    .sort(byScoreThenPath);
  const included: ContextBudgetTrace[] = [];
  const excluded: ContextBudgetTrace[] = [];
  const reasonTrace: ContextBudgetTrace[] = [];
  let totalTokenEstimate = 0;

  for (const { file } of ranked) {
    let next: ContextBudgetTrace = { ...file, reasons: [...file.reasons] };
    if (next.decision === "include" && totalTokenEstimate + next.tokenEstimate > maxTokens) {
      next = {
        ...next,
        decision: "exclude",
        reasons: [...next.reasons, "context token budget exceeded"],
      };
    }
    if (next.decision === "include") {
      totalTokenEstimate += next.tokenEstimate;
      included.push(next);
    } else {
      excluded.push(next);
    }
    reasonTrace.push(next);
  }

  return { included, excluded, reasonTrace, totalTokenEstimate, maxTokens };
}

function pushUnique(paths: string[], path: string): void {
  if (!paths.includes(path)) paths.push(path);
}

function shouldLoadEnvironmentRule(paths: readonly string[]): boolean {
  return paths.some(
    (path) =>
      path.startsWith("src/internals/fs") ||
      path.startsWith("src/internals/proc") ||
      path.startsWith("src/platform/") ||
      path.startsWith("src/tools/") ||
      path.startsWith("src/sandbox/") ||
      path.startsWith("src/workspace/") ||
      path.includes("shell") ||
      path.includes("spawn") ||
      path.includes("path"),
  );
}

function shouldLoadProductRule(paths: readonly string[]): boolean {
  return paths.some((path) => path.startsWith("src/report/") || path.startsWith("docs/specs/"));
}

function shouldLoadDocsRule(
  taskKind: ContextTaskKind | undefined,
  paths: readonly string[],
): boolean {
  return (
    taskKind === "docs" ||
    paths.some((path) => path.startsWith("docs/") || DOC_EXTENSIONS.has(extensionOf(path)))
  );
}

function shouldLoadGitRule(
  taskKind: ContextTaskKind | undefined,
  paths: readonly string[],
): boolean {
  return (
    taskKind === "release" ||
    taskKind === "closeout" ||
    paths.some((path) => path.startsWith(".github/") || path === "package.json")
  );
}

function roleForCanonPath(path: string): LazyCanonFile["role"] {
  if (path.endsWith("/RULE_ROUTER.md")) return "router";
  if (path.endsWith("/rules/agent-behavior-core.md")) return "core";
  if (path.endsWith("/project.md")) return "contract";
  return "rule";
}

export function selectLazyCanonFiles(options: LazyCanonOptions = {}): LazyCanonFile[] {
  const contextDir = normalizeContextDir(options.contextDir);
  const touchedPaths = normalizedTaskPaths(options.touchedPaths);
  const paths: string[] = [];
  const rule = (name: string) => `${contextDir}/rules/${name}`;

  pushUnique(paths, `${contextDir}/RULE_ROUTER.md`);
  pushUnique(paths, rule("agent-behavior-core.md"));
  pushUnique(paths, `${contextDir}/project.md`);

  if (
    options.taskKind === "implementation" ||
    options.taskKind === "security" ||
    touchedPaths.some((path) => path.startsWith("src/"))
  ) {
    pushUnique(paths, rule("engine-invariants.md"));
  }
  if (shouldLoadEnvironmentRule(touchedPaths)) pushUnique(paths, rule("environment.md"));
  if (options.taskKind === "review") pushUnique(paths, rule("review-protocol.md"));
  if (shouldLoadProductRule(touchedPaths)) pushUnique(paths, rule("product-principles.md"));
  if (shouldLoadDocsRule(options.taskKind, touchedPaths)) {
    pushUnique(paths, rule("doc-and-truth-homes.md"));
  }
  if (shouldLoadGitRule(options.taskKind, touchedPaths))
    pushUnique(paths, rule("git-ci-discipline.md"));
  if (options.taskKind === "closeout") pushUnique(paths, rule("tracking-and-done.md"));

  return paths.map((path) => ({
    ...classifyContextFile(path, { contextDir }),
    role: roleForCanonPath(path),
  }));
}
