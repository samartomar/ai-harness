import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import { hashComponentTree } from "../baseline-evidence/hash.js";
import type { Posture } from "../config/posture.js";
import { AihError } from "../errors.js";
import type { Runner } from "../internals/proc.js";
import { scanNativeMaliciousCode } from "../trust/detectors.js";
import { isSafeGitRefName } from "../trust/fetch.js";
import {
  buildTrustFileInventory,
  DEFAULT_TRUST_SKIP_DIRS,
  type TrustFileInventory,
} from "../trust/inventory.js";
import {
  isStrictUnicodeSurface,
  scanTrustDocument,
  scanTrustUnicodeDocument,
} from "../trust/lint.js";
import {
  isInstallScriptEvidenceFilePath,
  isMaliciousCodeScanFilePath,
} from "../trust/script-files.js";
import { type BindingDeclaration, BindingNpmSourceSchema } from "./schema.js";

/**
 * Fast-scan gate (D12). No adapter executes upstream code before a policy
 * disposition exists for the EXACT source digest. The pipeline is: resolve exact
 * identity -> compute digests -> fast static inspection -> policy disposition ->
 * (provision). W2 fully implements the git resolver and the disposition gate;
 * the npm resolver produces identity only (tarball acquisition is a typed TODO),
 * and the fast inspection orchestrates existing `src/trust/` seams — deep
 * scanners (SkillSpector/Cisco/…) land in W7 and their dimensions are reported as
 * incomplete coverage here, never as a false green.
 *
 * The {@link ScanDisposition} is brand-protected: it can only be minted inside
 * this module, and `provision` must revalidate it at runtime (brand present,
 * verdict "allow", and its digest equal to the resolved source digest) before it
 * runs any upstream code. A forged or stale token fails closed.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOWER_SHA40 = /^[0-9a-f]{40}$/;

// -- Resolved identity -------------------------------------------------------

export interface ResolvedGitSource {
  kind: "git";
  repository: string;
  commitSha: string;
  treeDigest: string;
  /** Derived, rebuildable checkout path (machine cache); never recorded identity. */
  treePath: string;
}

export interface ResolvedNpmSource {
  kind: "npm";
  package: string;
  exactVersion: string;
  integrity: string;
}

export type ResolvedSource = ResolvedGitSource | ResolvedNpmSource;

/** The exact source digest a disposition is bound to (git tree digest / npm integrity). */
export function resolvedSourceDigest(resolved: ResolvedSource): string {
  return resolved.kind === "git" ? resolved.treeDigest : resolved.integrity;
}

/**
 * The re-provision D7 cross-check: a resolved source must match the committed
 * declaration's exact identity on every field (git: repository/commitSha/
 * treeDigest; npm: package/exactVersion/integrity). A first-bind flow has no
 * declaration yet and simply does not call this; a re-provision that drifts from
 * the committed authority fails closed.
 */
export function assertResolvedMatchesDeclaration(
  declaration: BindingDeclaration,
  resolved: ResolvedSource,
): void {
  const source = declaration.source;
  if (source.kind !== resolved.kind) {
    throw new BindingScanError(
      `resolved source kind "${resolved.kind}" does not match declaration kind "${source.kind}"`,
    );
  }
  const mismatches: string[] = [];
  if (source.kind === "git" && resolved.kind === "git") {
    if (source.repository !== resolved.repository) mismatches.push("repository");
    if (source.commitSha !== resolved.commitSha) mismatches.push("commitSha");
    if (source.treeDigest !== resolved.treeDigest) mismatches.push("treeDigest");
  } else if (source.kind === "npm" && resolved.kind === "npm") {
    if (source.package !== resolved.package) mismatches.push("package");
    if (source.exactVersion !== resolved.exactVersion) mismatches.push("exactVersion");
    if (source.integrity !== resolved.integrity) mismatches.push("integrity");
  }
  if (mismatches.length > 0) {
    throw new BindingScanError(
      `resolved ${resolved.kind} source does not match the committed declaration (${mismatches.join(", ")})`,
    );
  }
}

/** A source made scannable: a content digest plus the on-disk tree to inspect. */
export interface ScannableSource {
  digest: string;
  treePath: string;
}

export function scannableFromGit(resolved: ResolvedGitSource): ScannableSource {
  return { digest: resolved.treeDigest, treePath: resolved.treePath };
}

// -- Errors ------------------------------------------------------------------

/** Fail-closed scan-gate error (resolution, digest mismatch, forged token, …). */
export class BindingScanError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_SCAN");
  }
}

/** A capability deferred to a later work item (e.g. npm tarball acquisition). */
export class BindingNotSupportedError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_UNSUPPORTED");
  }
}

// -- Cache locations (derived, rebuildable) ----------------------------------

/** `<home>/.aih/binding` — repo convention: HOME || USERPROFILE || homedir(). */
export function bindingCacheHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".aih", "binding");
}

function sourceCheckoutDir(cacheHome: string, commitSha: string): string {
  return join(cacheHome, "cache", commitSha);
}

function scanCachePath(cacheHome: string, digest: string): string {
  return join(cacheHome, "scan-cache", `${digest}.json`);
}

// -- Git resolver ------------------------------------------------------------

export interface GitResolveRequest {
  repository: string;
  /** Resolution input only (ref/tag/branch/HEAD) — never stored as identity (D7). */
  ref?: string;
  /** An exact commit SHA input, skipping the ref round-trip. */
  commitSha?: string;
  /** Optional subset of top-level paths to hash; defaults to all but `.git`. */
  declaredPaths?: readonly string[];
}

export interface GitResolveDeps {
  runner: Runner;
  cacheHome: string;
}

function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) return true;
  }
  return false;
}

function firstSha(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0] ?? "";
    if (LOWER_SHA40.test(token)) return token;
  }
  return undefined;
}

async function resolveExactSha(request: GitResolveRequest, runner: Runner): Promise<string> {
  if (request.commitSha !== undefined) {
    if (!LOWER_SHA40.test(request.commitSha)) {
      throw new BindingScanError("commitSha input must be an exact lowercase 40-character SHA");
    }
    return request.commitSha;
  }
  const ref = request.ref ?? "HEAD";
  if (ref !== "HEAD" && !isSafeGitRefName(ref)) {
    throw new BindingScanError(`unsafe git ref for resolution: ${ref}`);
  }
  // `--` ends option parsing so a repository value can never be read as a flag.
  const result = await runner(["git", "ls-remote", "--", request.repository, ref]);
  if (result.spawnError || result.code !== 0) {
    throw new BindingScanError(
      `git ls-remote failed for ${request.repository} (${(result.stderr || "").trim().slice(0, 200)})`,
    );
  }
  const sha = firstSha(result.stdout);
  if (sha === undefined) {
    throw new BindingScanError(
      `could not resolve ${request.repository}@${ref} to an exact commit SHA`,
    );
  }
  return sha;
}

function declaredTopLevelPaths(treePath: string, override?: readonly string[]): string[] {
  if (override !== undefined && override.length > 0) return [...override];
  const entries = readdirSync(treePath).filter((name) => name !== ".git");
  if (entries.length === 0) {
    throw new BindingScanError(`checkout has no scannable content: ${treePath}`);
  }
  return entries.sort((left, right) => left.localeCompare(right));
}

/**
 * Confirm a cached checkout is actually AT `commitSha` and clean. An interrupted
 * prior run (cloned, then the checkout failed) can leave default-HEAD content in
 * `<cache>/<sha>/`; trusting it would hash the WRONG tree into recorded identity.
 */
async function cachedCheckoutIsAtCommit(
  dir: string,
  commitSha: string,
  runner: Runner,
): Promise<boolean> {
  const head = await runner(["git", "-C", dir, "rev-parse", "HEAD"]);
  if (head.spawnError || head.code !== 0 || firstSha(head.stdout) !== commitSha) return false;
  const status = await runner(["git", "-C", dir, "status", "--porcelain"]);
  if (status.spawnError || status.code !== 0) return false;
  return status.stdout.trim().length === 0;
}

async function ensureCheckout(
  request: GitResolveRequest,
  commitSha: string,
  deps: GitResolveDeps,
): Promise<string> {
  const dir = sourceCheckoutDir(deps.cacheHome, commitSha);
  if (
    existsSync(join(dir, ".git")) &&
    (await cachedCheckoutIsAtCommit(dir, commitSha, deps.runner))
  ) {
    return dir;
  }
  // Missing, stale, or dirty: wipe and rebuild the checkout fresh, fail closed.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(deps.cacheHome, "cache"), { recursive: true });
  const clone = await deps.runner([
    "git",
    "clone",
    "--quiet",
    "--no-hardlinks",
    "--",
    request.repository,
    dir,
  ]);
  if (clone.spawnError || clone.code !== 0) {
    throw new BindingScanError(
      `git clone failed for ${request.repository} (${(clone.stderr || "").trim().slice(0, 200)})`,
    );
  }
  const checkout = await deps.runner(["git", "-C", dir, "checkout", "--quiet", commitSha]);
  if (checkout.spawnError || checkout.code !== 0) {
    throw new BindingScanError(
      `git checkout ${commitSha} failed (${(checkout.stderr || "").trim().slice(0, 200)})`,
    );
  }
  return dir;
}

/**
 * Resolve a git source to exact identity (D7): an exact 40-char commit SHA (from
 * a ref or a SHA input), a checkout into the derived cache, and a sha256 tree
 * digest via {@link hashComponentTree}. Refs and tags are resolution inputs only
 * and never appear in the returned identity.
 */
export async function resolveGitSource(
  request: GitResolveRequest,
  deps: GitResolveDeps,
): Promise<ResolvedGitSource> {
  if (request.repository.length === 0 || hasControlOrSpace(request.repository)) {
    throw new BindingScanError("git repository must be a non-empty value with no whitespace");
  }
  if (request.repository.startsWith("-")) {
    throw new BindingScanError("git repository must not start with '-' (option-injection guard)");
  }
  const commitSha = await resolveExactSha(request, deps.runner);
  const treePath = await ensureCheckout(request, commitSha, deps);
  const treeDigest = hashComponentTree(
    treePath,
    declaredTopLevelPaths(treePath, request.declaredPaths),
  ).treeSha256;
  return { kind: "git", repository: request.repository, commitSha, treeDigest, treePath };
}

// -- npm resolver (minimal; tarball deferred) --------------------------------

export interface NpmResolveRequest {
  package: string;
  version?: string;
}

export interface NpmRegistryMetadata {
  version: string;
  integrity: string;
}

export type NpmMetadataFetcher = (
  packageName: string,
  version: string | undefined,
) => Promise<NpmRegistryMetadata> | NpmRegistryMetadata;

/**
 * Resolve npm identity from injected registry metadata into an exact version +
 * SRI integrity (D7). The resolved identity is validated against the declaration
 * schema, so a range/dist-tag version or a non-SRI integrity fails closed.
 */
export async function resolveNpmSource(
  request: NpmResolveRequest,
  deps: { fetchMetadata: NpmMetadataFetcher },
): Promise<ResolvedNpmSource> {
  const metadata = await deps.fetchMetadata(request.package, request.version);
  const candidate = {
    kind: "npm" as const,
    package: request.package,
    exactVersion: metadata.version,
    integrity: metadata.integrity,
  };
  const parsed = BindingNpmSourceSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BindingScanError(
      `npm registry metadata did not resolve to exact identity${issue ? `: ${issue.message}` : ""}`,
    );
  }
  return candidate;
}

/** Tarball acquisition is deferred; never fake success (D12). */
export function acquireNpmTree(_resolved: ResolvedNpmSource): never {
  throw new BindingNotSupportedError(
    "npm tarball acquisition and scanning is not yet supported; resolution produces identity only",
  );
}

// -- Fast static inspection (orchestrated trust seams) -----------------------

export type ScanVerdict = "allow" | "block";
export type ScanCoverage = "complete" | "incomplete";
export type ScanSeverity = "info" | "low" | "medium" | "high" | "critical";

const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export interface ScanFinding {
  code: string;
  severity: ScanSeverity;
  detail: string;
  coverage: ScanCoverage;
}

export interface DimensionInspectionContext {
  treePath: string;
  inventory: TrustFileInventory;
}

export interface DimensionReport {
  dimension: string;
  status: "produced" | "missing";
  reason?: string;
  findings: readonly ScanFinding[];
}

export interface DimensionInspector {
  dimension: string;
  run(ctx: DimensionInspectionContext): DimensionReport;
}

// Danger codes always block at every posture (aligns with src/trust/grade.ts's
// danger floor); graded content findings are surfaced but do not, on their own,
// cross the blocking threshold in W2.
const DANGER_SEVERITY: Record<string, ScanSeverity> = {
  "trust.malicious-code": "critical",
  "trust.prompt-injection": "high",
  "trust.hidden-unicode": "high",
};
const GRADED_SEVERITY: Record<string, ScanSeverity> = {
  "trust.visible-unicode": "medium",
};

function findingFromCode(code: string | undefined, detail: string): ScanFinding {
  const resolvedCode = code ?? "trust.finding";
  const severity = DANGER_SEVERITY[resolvedCode] ?? GRADED_SEVERITY[resolvedCode] ?? "medium";
  return { code: resolvedCode, severity, detail, coverage: "complete" };
}

function readTextSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isDocSurface(rel: string): boolean {
  const name = rel.split("/").at(-1) ?? "";
  if (name === "SKILL.md") return true;
  if (!rel.includes("/") && ["AGENTS.md", "CLAUDE.md", "GEMINI.md"].includes(name)) return true;
  return name.toLowerCase().endsWith(".md");
}

function inspectContentRisk(dimension: string, ctx: DimensionInspectionContext): DimensionReport {
  const findings: ScanFinding[] = [];
  for (const entry of ctx.inventory.files) {
    const rel = entry.relativePath;
    const isDoc = isDocSurface(rel);
    const isStrict = isStrictUnicodeSurface(rel) || isMaliciousCodeScanFilePath(rel);
    if (!isDoc && !isStrict) continue;
    const source = readTextSafe(entry.absolutePath);
    if (source === undefined) continue;
    const checks = isDoc ? scanTrustDocument(rel, source) : scanTrustUnicodeDocument(rel, source);
    for (const check of checks) {
      findings.push(findingFromCode(check.code, check.detail ?? `${rel}: content risk`));
    }
  }
  return { dimension, status: "produced", findings };
}

function inspectSuspiciousExecution(
  dimension: string,
  ctx: DimensionInspectionContext,
): DimensionReport {
  const findings = scanNativeMaliciousCode(ctx.treePath, ctx.inventory).map((check) =>
    findingFromCode(check.code ?? "trust.malicious-code", check.detail ?? "malicious-code shape"),
  );
  return { dimension, status: "produced", findings };
}

// -- Real per-dimension inspectors (D12 FAST tier; deep scanners are W7) ------

const MAX_SCAN_BYTES = 512 * 1024;
const STRUCTURE_MAX_FILE_BYTES = 50 * 1024 * 1024;
const STRUCTURE_MAX_FILES = 20_000;
const MAX_FINDINGS_PER_DIMENSION = 50;

const BINARY_EXTENSIONS = new Set([
  ".a",
  ".apk",
  ".bin",
  ".class",
  ".deb",
  ".dll",
  ".dmg",
  ".dylib",
  ".exe",
  ".img",
  ".jar",
  ".lib",
  ".msi",
  ".node",
  ".o",
  ".obj",
  ".pyc",
  ".pyd",
  ".rpm",
  ".so",
  ".wasm",
]);

const HOOK_EVENT_KEYS = new Set([
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "Notification",
  "PreCompact",
]);

const LICENSE_NAME = /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\..+)?$/i;

interface SurfacePattern {
  label: string;
  pattern: RegExp;
}

// FAST-tier static heuristics over text surfaces (bounded by MAX_SCAN_BYTES, like
// the native malicious-code scanner). These are line/substring shape checks — the
// deep behavioral scanners W7 adds are separate dimensions, not a replacement.
const NETWORK_PATTERNS: readonly SurfacePattern[] = [
  { label: "outbound HTTP(S) URL", pattern: /https?:\/\/[^\s"'`)]+/i },
  {
    label: "curl/wget/Invoke-WebRequest download",
    pattern: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i,
  },
  {
    label: "network client call",
    pattern:
      /\b(?:fetch|axios|got|node-fetch|urllib|requests\.(?:get|post|put))\b|https?\.request\b/i,
  },
  {
    label: "npm registry version check",
    pattern: /registry\.npmjs\.org|\bnpm\s+(?:view|outdated|dist-tag)\b/i,
  },
  {
    label: "auto-update marker",
    pattern: /\b(?:auto[-_]?update|self[-_]?update|check[-_ ]for[-_ ]updates?)\b/i,
  },
];
const TELEMETRY_PATTERNS: readonly SurfacePattern[] = [
  {
    label: "telemetry/analytics vendor",
    pattern:
      /\b(?:telemetry|analytics|posthog|segment(?:\.io)?|sentry|mixpanel|amplitude|datadog|google-analytics|gtag)\b/i,
  },
  {
    label: "telemetry env toggle",
    pattern: /\b[A-Z0-9_]*(?:TELEMETRY|ANALYTICS)[A-Z0-9_]*\b|\bDO_NOT_TRACK\b/,
  },
];
const WRITE_DEST_PATTERNS: readonly SurfacePattern[] = [
  {
    label: "redirect to HOME/absolute path",
    pattern: /(?:>>?|\btee\b)\s*["']?(?:~\/|\/[A-Za-z]|\$HOME|\$\{HOME\}|%USERPROFILE%)/,
  },
  {
    label: "write to HOME/absolute path",
    pattern:
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(\s*["'`](?:~\/|\/|\$\{?HOME)/,
  },
  {
    label: "HOME/homedir reference",
    pattern: /\$HOME\b|\$\{HOME\}|%USERPROFILE%|os\.homedir\(\)|\bhomedir\(\)/,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isExecutableSurface(rel: string): boolean {
  return isMaliciousCodeScanFilePath(rel) || isInstallScriptEvidenceFilePath(rel);
}

function isScannableTextSurface(rel: string): boolean {
  return isExecutableSurface(rel) || isStrictUnicodeSurface(rel) || isDocSurface(rel);
}

function containsNullByte(path: string): boolean {
  try {
    return readFileSync(path).includes(0);
  } catch {
    return false;
  }
}

function scanForPatterns(
  dimension: string,
  ctx: DimensionInspectionContext,
  patterns: readonly SurfacePattern[],
  severityFor: (executable: boolean) => ScanSeverity,
  onlyExecutable = false,
): DimensionReport {
  const findings: ScanFinding[] = [];
  for (const entry of ctx.inventory.files) {
    if (findings.length >= MAX_FINDINGS_PER_DIMENSION) break;
    const rel = entry.relativePath;
    const executable = isExecutableSurface(rel);
    if (onlyExecutable ? !executable : !isScannableTextSurface(rel)) continue;
    if (entry.size > MAX_SCAN_BYTES) continue;
    const text = readTextSafe(entry.absolutePath);
    if (text === undefined) continue;
    for (const { label, pattern } of patterns) {
      if (findings.length >= MAX_FINDINGS_PER_DIMENSION) break;
      if (pattern.test(text)) {
        findings.push({
          code: `binding.${dimension}`,
          severity: severityFor(executable),
          detail: `${rel}: ${label}`,
          coverage: "complete",
        });
      }
    }
  }
  return { dimension, status: "produced", findings };
}

function inspectStructure(ctx: DimensionInspectionContext): DimensionReport {
  const findings: ScanFinding[] = [];
  if (ctx.inventory.files.length > STRUCTURE_MAX_FILES) {
    findings.push({
      code: "binding.structure.file-count",
      severity: "info",
      detail: `tree contains ${ctx.inventory.files.length} files (over ${STRUCTURE_MAX_FILES})`,
      coverage: "complete",
    });
  }
  for (const entry of ctx.inventory.files) {
    if (findings.length >= MAX_FINDINGS_PER_DIMENSION) break;
    if (entry.size > STRUCTURE_MAX_FILE_BYTES) {
      findings.push({
        code: "binding.structure.large-file",
        severity: "low",
        detail: `${entry.relativePath}: unusually large file (${entry.size} bytes)`,
        coverage: "complete",
      });
    }
  }
  return { dimension: "structure", status: "produced", findings };
}

function inspectScripts(ctx: DimensionInspectionContext): DimensionReport {
  const scripts: string[] = [];
  const installScripts: string[] = [];
  for (const entry of ctx.inventory.files) {
    const rel = entry.relativePath;
    if (isMaliciousCodeScanFilePath(rel)) scripts.push(rel);
    if (isInstallScriptEvidenceFilePath(rel)) installScripts.push(rel);
  }
  const findings: ScanFinding[] = installScripts
    .slice(0, MAX_FINDINGS_PER_DIMENSION)
    .map((rel) => ({
      code: "binding.scripts.install-script",
      severity: "medium",
      detail: `${rel}: install/setup script (executes on install)`,
      coverage: "complete",
    }));
  if (scripts.length > 0) {
    const shown = scripts.slice(0, 5).join(", ");
    findings.push({
      code: "binding.scripts.present",
      severity: "info",
      detail: `${scripts.length} script file(s): ${shown}${scripts.length > 5 ? ", …" : ""}`,
      coverage: "complete",
    });
  }
  return { dimension: "scripts", status: "produced", findings };
}

function inspectBinaries(ctx: DimensionInspectionContext): DimensionReport {
  const findings: ScanFinding[] = [];
  for (const entry of ctx.inventory.files) {
    if (findings.length >= MAX_FINDINGS_PER_DIMENSION) break;
    const rel = entry.relativePath;
    const ext = extname(rel).toLowerCase();
    let binary = BINARY_EXTENSIONS.has(ext);
    if (!binary && ext === "" && entry.size > 0 && entry.size <= MAX_SCAN_BYTES) {
      binary = containsNullByte(entry.absolutePath);
    }
    if (binary) {
      findings.push({
        code: "binding.binaries.blob",
        severity: "medium",
        detail: `${rel}: binary/executable blob`,
        coverage: "complete",
      });
    }
  }
  return { dimension: "binaries", status: "produced", findings };
}

function hookEventsIn(text: string): string[] {
  const parsed = parseJsonRecord(text);
  if (parsed === undefined) return [];
  if (isRecord(parsed.hooks)) return Object.keys(parsed.hooks);
  return Object.keys(parsed).filter((key) => HOOK_EVENT_KEYS.has(key));
}

function inspectHooks(ctx: DimensionInspectionContext): DimensionReport {
  const findings: ScanFinding[] = [];
  for (const entry of ctx.inventory.files) {
    if (findings.length >= MAX_FINDINGS_PER_DIMENSION) break;
    const rel = entry.relativePath;
    const parts = rel.split("/");
    const name = parts.at(-1) ?? "";
    if (parts.slice(0, -1).includes("hooks")) {
      findings.push({
        code: "binding.hooks.dir",
        severity: "medium",
        detail: `${rel}: file under a hooks/ surface`,
        coverage: "complete",
      });
      continue;
    }
    if (!/^settings.*\.json$/.test(name) && name !== ".claude.json") continue;
    if (entry.size > MAX_SCAN_BYTES) continue;
    const text = readTextSafe(entry.absolutePath);
    if (text === undefined) continue;
    const events = hookEventsIn(text);
    if (events.length > 0) {
      findings.push({
        code: "binding.hooks.settings",
        severity: "medium",
        detail: `${rel}: hook events ${events.join(", ")}`,
        coverage: "complete",
      });
    }
  }
  return { dimension: "hooks", status: "produced", findings };
}

function mcpServersIn(text: string): string[] {
  const parsed = parseJsonRecord(text);
  if (parsed === undefined) return [];
  const out: string[] = [];
  for (const key of ["mcpServers", "servers", "mcp"]) {
    const value = parsed[key];
    if (isRecord(value)) out.push(...Object.keys(value));
  }
  return out;
}

function inspectMcp(ctx: DimensionInspectionContext): DimensionReport {
  const findings: ScanFinding[] = [];
  for (const entry of ctx.inventory.files) {
    if (findings.length >= MAX_FINDINGS_PER_DIMENSION) break;
    const rel = entry.relativePath;
    const name = rel.split("/").at(-1) ?? "";
    const isMcpFile = name === ".mcp.json" || name === "mcp.json";
    const isSettings = /^settings.*\.json$/.test(name) || name === ".claude.json";
    if (!isMcpFile && !isSettings) continue;
    if (entry.size > MAX_SCAN_BYTES) continue;
    const text = readTextSafe(entry.absolutePath);
    if (text === undefined) continue;
    const servers = mcpServersIn(text);
    if (servers.length > 0) {
      findings.push({
        code: "binding.mcp.declaration",
        severity: "medium",
        detail: `${rel}: MCP servers ${servers.slice(0, 5).join(", ")}`,
        coverage: "complete",
      });
    } else if (isMcpFile) {
      findings.push({
        code: "binding.mcp.declaration",
        severity: "medium",
        detail: `${rel}: MCP config present`,
        coverage: "complete",
      });
    }
  }
  return { dimension: "mcp", status: "produced", findings };
}

function inspectLicenses(ctx: DimensionInspectionContext): DimensionReport {
  let hasLicenseFile = false;
  let hasLicenseField = false;
  for (const entry of ctx.inventory.files) {
    const name = entry.relativePath.split("/").at(-1) ?? "";
    if (LICENSE_NAME.test(name)) hasLicenseFile = true;
    if (name === "package.json" && entry.size <= MAX_SCAN_BYTES) {
      const license = parseJsonRecord(readTextSafe(entry.absolutePath) ?? "")?.license;
      if (typeof license === "string" && license.trim().length > 0) hasLicenseField = true;
    }
  }
  const findings: ScanFinding[] =
    hasLicenseFile || hasLicenseField
      ? []
      : [
          {
            code: "binding.licenses.missing",
            severity: "info",
            detail: "no LICENSE file or package.json license field found",
            coverage: "complete",
          },
        ];
  return { dimension: "licenses", status: "produced", findings };
}

/**
 * The W2 fast-inspection registry. Every one of the eleven D12 FAST-tier
 * dimensions is genuinely inspected here (native `src/trust/` seams for content
 * and execution; inventory-driven checks for structure/scripts/binaries/hooks/
 * MCP/licenses; bounded static pattern scans for network/telemetry/write
 * destinations). Deep external scanners (W7) add SEPARATE dimensions later; the
 * incomplete-coverage machinery in {@link runFastScanGate} exists for those.
 */
export const W2_DEFAULT_INSPECTORS: readonly DimensionInspector[] = [
  { dimension: "structure", run: inspectStructure },
  { dimension: "scripts", run: inspectScripts },
  { dimension: "binaries", run: inspectBinaries },
  { dimension: "hooks", run: inspectHooks },
  { dimension: "mcp", run: inspectMcp },
  { dimension: "licenses", run: inspectLicenses },
  { dimension: "hidden-unicode", run: (ctx) => inspectContentRisk("hidden-unicode", ctx) },
  {
    dimension: "suspicious-execution",
    run: (ctx) => inspectSuspiciousExecution("suspicious-execution", ctx),
  },
  {
    dimension: "network-update",
    run: (ctx) =>
      scanForPatterns("network-update", ctx, NETWORK_PATTERNS, (exec) => (exec ? "medium" : "low")),
  },
  {
    dimension: "telemetry",
    run: (ctx) =>
      scanForPatterns("telemetry", ctx, TELEMETRY_PATTERNS, (exec) => (exec ? "medium" : "low")),
  },
  {
    dimension: "write-destinations",
    run: (ctx) =>
      scanForPatterns("write-destinations", ctx, WRITE_DEST_PATTERNS, () => "medium", true),
  },
];

export interface InspectTreeDeps {
  inspectors?: readonly DimensionInspector[];
  inventoryFactory?: (root: string) => TrustFileInventory;
}

function defaultInventory(root: string): TrustFileInventory {
  return buildTrustFileInventory(root, { skipDirs: DEFAULT_TRUST_SKIP_DIRS });
}

/**
 * Run the fast inspection over an on-disk tree, returning one report per D12
 * dimension. Split out from {@link runFastScanGate} so the inspection is
 * independently testable and reusable; the gate applies policy on top.
 */
export function inspectTree(treePath: string, deps: InspectTreeDeps = {}): DimensionReport[] {
  const inventory = (deps.inventoryFactory ?? defaultInventory)(treePath);
  const inspectors = deps.inspectors ?? W2_DEFAULT_INSPECTORS;
  return inspectors.map((inspector) => inspector.run({ treePath, inventory }));
}

// -- Disposition (brand-protected) -------------------------------------------

declare const scanDispositionBrand: unique symbol;

export interface ScanDisposition {
  readonly [scanDispositionBrand]: "ScanDisposition";
  readonly digest: string;
  readonly verdict: ScanVerdict;
  readonly findings: readonly ScanFinding[];
  readonly posture: Posture;
  readonly producedAt: string;
}

// Runtime brand: identity-based, module-private, and unforgeable even with symbol
// reflection — a structurally identical object cast in from outside is not in the
// set and is rejected by the provision guard.
const brandedDispositions = new WeakSet<object>();

function mintDisposition(
  fields: Omit<ScanDisposition, typeof scanDispositionBrand>,
): ScanDisposition {
  const disposition = { ...fields } as ScanDisposition;
  brandedDispositions.add(disposition);
  return disposition;
}

export interface FastScanPolicy {
  posture: Posture;
  /** Only meaningful at vibe: permit provisioning despite incomplete coverage. */
  allowIncompleteAtVibe?: boolean;
}

function coverageFinding(report: DimensionReport): ScanFinding {
  return {
    code: `coverage.${report.dimension}-unavailable`,
    severity: "info",
    detail: report.reason ?? `${report.dimension} inspection unavailable`,
    coverage: "incomplete",
  };
}

function decide(
  reports: readonly DimensionReport[],
  policy: FastScanPolicy,
): { verdict: ScanVerdict; findings: ScanFinding[] } {
  const findings: ScanFinding[] = [];
  for (const report of reports) {
    findings.push(...report.findings);
    if (report.status === "missing") findings.push(coverageFinding(report));
  }
  const rank = (severity: ScanSeverity): number => SEVERITIES.indexOf(severity);
  const hasBlockingFinding = findings.some((finding) => rank(finding.severity) >= rank("high"));
  const complete = reports.every((report) => report.status === "produced");
  let verdict: ScanVerdict;
  if (hasBlockingFinding) {
    verdict = "block";
  } else if (!complete) {
    verdict =
      policy.posture === "vibe" && policy.allowIncompleteAtVibe === true ? "allow" : "block";
  } else {
    verdict = "allow";
  }
  return { verdict, findings };
}

function produceDisposition(
  digest: string,
  policy: FastScanPolicy,
  reports: readonly DimensionReport[],
  producedAt: string,
): ScanDisposition {
  const { verdict, findings } = decide(reports, policy);
  return mintDisposition({ digest, verdict, findings, posture: policy.posture, producedAt });
}

// -- Scan cache (derived; corrupt == miss, never fail-closed) ----------------

const ScanFindingSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(SEVERITIES),
    detail: z.string(),
    coverage: z.enum(["complete", "incomplete"]),
  })
  .strict();

const DimensionReportSchema = z
  .object({
    dimension: z.string().min(1),
    status: z.enum(["produced", "missing"]),
    reason: z.string().optional(),
    findings: z.array(ScanFindingSchema),
  })
  .strict();

const ScanCacheRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    digest: z.string().regex(SHA256_HEX),
    scannedAt: z.string().min(1),
    reports: z.array(DimensionReportSchema),
  })
  .strict();

type ScanCacheRecord = z.infer<typeof ScanCacheRecordSchema>;

function readScanCache(cacheHome: string, digest: string): ScanCacheRecord | undefined {
  const raw = (() => {
    try {
      return readFileSync(scanCachePath(cacheHome, digest), "utf8");
    } catch {
      return undefined;
    }
  })();
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = ScanCacheRecordSchema.safeParse(parsed);
  if (!result.success || result.data.digest !== digest) return undefined;
  return result.data;
}

function writeScanCache(cacheHome: string, record: ScanCacheRecord): void {
  const dir = join(cacheHome, "scan-cache");
  mkdirSync(dir, { recursive: true });
  const path = scanCachePath(cacheHome, record.digest);
  try {
    // Derived cache: best-effort. A write failure must never change validation
    // outcomes — the next run simply recomputes.
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    // ignore — the cache is rebuildable
  }
}

export interface FastScanDeps {
  cacheHome: string;
  inspectors?: readonly DimensionInspector[];
  inventoryFactory?: (root: string) => TrustFileInventory;
}

/**
 * Run the fast scan for a scannable source and produce a brand-protected
 * disposition. The inspection reports (the expensive part) are cached per exact
 * digest under the derived scan cache; the cheap policy decision re-runs each
 * call so posture changes are honored. Deleting the cache only forces a
 * recompute — it never changes the validation outcome.
 */
export function runFastScanGate(
  source: ScannableSource,
  policy: FastScanPolicy,
  deps: FastScanDeps,
): ScanDisposition {
  const cached = readScanCache(deps.cacheHome, source.digest);
  if (cached !== undefined) {
    return produceDisposition(source.digest, policy, cached.reports, cached.scannedAt);
  }
  const reports = inspectTree(source.treePath, {
    inspectors: deps.inspectors,
    inventoryFactory: deps.inventoryFactory,
  });
  const scannedAt = new Date().toISOString();
  writeScanCache(deps.cacheHome, {
    schemaVersion: 1,
    digest: source.digest,
    scannedAt,
    reports: reports.map((report) => ({ ...report, findings: [...report.findings] })),
  });
  return produceDisposition(source.digest, policy, reports, scannedAt);
}

// -- Provision authorization guard (D12 code-path invariant) -----------------

/**
 * The gate every adapter's `provision` MUST pass before running any upstream
 * code: the disposition must be genuine (branded by this module), its verdict
 * must be "allow", and its digest must equal the EXACT resolved source digest
 * being provisioned. A forged, blocked, or stale token fails closed.
 */
export function assertProvisionAuthorized(
  disposition: ScanDisposition,
  expectedDigest: string,
): void {
  if (!brandedDispositions.has(disposition)) {
    throw new BindingScanError(
      "refusing to provision: scan disposition is forged or was not produced by the scan gate",
    );
  }
  if (disposition.verdict !== "allow") {
    throw new BindingScanError(
      `refusing to provision: scan disposition verdict is "${disposition.verdict}"`,
    );
  }
  if (disposition.digest !== expectedDigest) {
    throw new BindingScanError(
      `refusing to provision: scan disposition digest ${disposition.digest} does not match the resolved source digest ${expectedDigest}`,
    );
  }
}
