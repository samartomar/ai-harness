import { createHash } from "node:crypto";
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
import { buildTrustFileInventory, type TrustFileInventory } from "../trust/inventory.js";
import {
  isStrictUnicodeSurface,
  scanTrustDocument,
  scanTrustUnicodeDocument,
} from "../trust/lint.js";
import {
  isInstallScriptEvidenceFilePath,
  isMaliciousCodeScanFilePath,
} from "../trust/script-files.js";
import {
  type ClosureSpec,
  classificationOf,
  classifyClosure,
  type FindingClassification,
  type HostLoadFacts,
  type ProfileClosure,
  type Reachability,
} from "./closure/profile-closure.js";
import scanAcceptanceJson from "./scan-acceptance.json";
import { type BindingDeclaration, BindingNpmSourceSchema, isBareRepositorySlug } from "./schema.js";
import { classifyFileTypography, type TypographyAdvisory } from "./visible-typography.js";

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
 * this module, and `provision` must revalidate it at runtime (brand present, its
 * digest equal to the resolved source digest, and its SELECTED-PROFILE gate
 * authorizing — ALLOW, or ALLOW_WITH_CONDITIONS with its conditions still in
 * force) before it runs any upstream code. A forged, blocked, or stale token
 * fails closed. W5 (a2) adds the closure-aware disposition: the raw source scan
 * and the selected-profile gate are reported separately, and only the executed/
 * loaded closure (plus unresolved reachability) gates — see `closure/`.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOWER_SHA40 = /^[0-9a-f]{40}$/;
// npm SRI sha512: base64 of 64 bytes (86 chars + "=="). Mirrors schema.ts's
// SRI_SHA512 — an npm scannable's digest IS its integrity, so the scan cache
// must recognize this shape alongside a git tree's sha256 hex digest.
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

// -- Resolved identity -------------------------------------------------------

export interface ResolvedGitSource {
  kind: "git";
  repository: string;
  commitSha: string;
  treeDigest: string;
  /** Derived, rebuildable checkout path (machine cache); never recorded identity. */
  treePath: string;
  /**
   * The exact leaf files (source-relative POSIX paths) folded into `treeDigest`.
   * Derived from the digest computation — NOT persisted identity — so the scan can
   * assert it inspected every byte the digest pins (D7 / CM-27 coverage invariant).
   * Optional only so hand-constructed test sources need not restate it;
   * {@link resolveGitSource} — the sole production producer — ALWAYS populates it,
   * so the coverage cross-check is always active on real resolutions.
   */
  files?: readonly string[];
}

export interface ResolvedNpmSource {
  kind: "npm";
  package: string;
  exactVersion: string;
  integrity: string;
  /**
   * Acquisition fields — populated by `acquireNpmTree` (`./npm-source.ts`) once
   * the EXACT tarball has been SRI-verified, contained-unpacked, and digested.
   * Absent on a bare identity resolution ({@link resolveNpmSource}); a hand-built
   * npm source that omits them is not scannable ({@link scannableFromNpm} fails
   * closed). `treeDigest` uses the SAME tree-hash idiom git uses ({@link
   * resolveGitSource} via `hashComponentTree`), so an identical tree digests to an
   * identical value regardless of source kind. `gitHead` is present only when an
   * `expectedGitHead` provenance assertion was made.
   */
  treeDigest?: string;
  /** Derived, rebuildable content-addressed tree path (machine cache); not identity. */
  treePath?: string;
  /** The exact leaf files (source-relative POSIX) folded into `treeDigest`. */
  files?: readonly string[];
  gitHead?: string;
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
  /**
   * The exact files the digest covers. When present, the gate requires the scan
   * inventory to cover every one of them; any identity file the inventory did not
   * see forces coverage INCOMPLETE (fail-closed), so a disposition can never
   * attest bytes no inspector examined.
   */
  identityFiles?: readonly string[];
}

export function scannableFromGit(resolved: ResolvedGitSource): ScannableSource {
  return {
    digest: resolved.treeDigest,
    treePath: resolved.treePath,
    identityFiles: resolved.files,
  };
}

/**
 * Make an acquired npm source scannable — the npm mirror of {@link
 * scannableFromGit}. The scannable digest is the SRI `integrity` (what {@link
 * resolvedSourceDigest} already binds an npm disposition to), NOT the tree digest:
 * an npm tree and a byte-identical git tree share a `treeDigest` but must NEVER
 * share a scan-cache entry, so keying on the npm-namespaced integrity keeps them
 * disjoint by construction. Fails closed if the source was never materialized
 * (identity-only resolution), so a disposition can never attest an absent tree.
 */
export function scannableFromNpm(resolved: ResolvedNpmSource): ScannableSource {
  if (resolved.treePath === undefined) {
    throw new BindingScanError(
      "npm source has no materialized tree; acquire the tarball (acquireNpmTree) before scanning",
    );
  }
  return {
    digest: resolved.integrity,
    treePath: resolved.treePath,
    identityFiles: resolved.files,
  };
}

// -- Errors ------------------------------------------------------------------

/** Fail-closed scan-gate error (resolution, digest mismatch, forged token, …). */
export class BindingScanError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_SCAN");
  }
}

/** A capability deferred to a later work item (e.g. a deep external scanner dimension). */
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

/**
 * Filesystem-safe scan-cache filename for a scannable digest. A git tree digest is
 * already sha256 hex (safe, used verbatim so existing cache files are unchanged);
 * an npm SRI integrity contains base64 `/`/`+`, so it is hashed into a stable hex
 * token. Distinct digests keep distinct tokens, and {@link readScanCache} still
 * re-checks the stored digest, so a git tree and an npm tree never collide.
 */
function scanCacheFileToken(digest: string): string {
  return SHA256_HEX.test(digest) ? digest : createHash("sha256").update(digest).digest("hex");
}

function scanCachePath(cacheHome: string, digest: string): string {
  return join(cacheHome, "scan-cache", `${scanCacheFileToken(digest)}.json`);
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

/**
 * Transport locator for `request.repository`. The schema admits three identity
 * forms; https and scp-like locators are git-reachable verbatim, but a bare
 * `owner/repo` slug is not (git reads it as a local path), so exactly that
 * shape maps to its canonical GitHub https remote — the same convention as the
 * trust pipeline. Recorded identity (locks, evidence, error text) stays
 * slug-form; only the git argv sees the URL.
 */
function gitRemoteLocator(repository: string): string {
  return isBareRepositorySlug(repository) ? `https://github.com/${repository}.git` : repository;
}

/**
 * Transport timeout for ls-remote/clone/checkout — these move or materialize a
 * whole framework tree (sized by the repo, not by us), so wider than proc's 30s
 * default; same budget as the plugin CLI lane.
 */
const TRANSPORT_TIMEOUT_MS = 120_000;

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
  const result = await runner(
    ["git", "ls-remote", "--", gitRemoteLocator(request.repository), ref],
    { timeoutMs: TRANSPORT_TIMEOUT_MS },
  );
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
  const clone = await deps.runner(
    ["git", "clone", "--quiet", "--no-hardlinks", "--", gitRemoteLocator(request.repository), dir],
    { timeoutMs: TRANSPORT_TIMEOUT_MS },
  );
  if (clone.spawnError || clone.code !== 0) {
    throw new BindingScanError(
      `git clone failed for ${request.repository} (${(clone.stderr || "").trim().slice(0, 200)})`,
    );
  }
  const checkout = await deps.runner(["git", "-C", dir, "checkout", "--quiet", commitSha], {
    timeoutMs: TRANSPORT_TIMEOUT_MS,
  });
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
  const hashed = hashComponentTree(
    treePath,
    declaredTopLevelPaths(treePath, request.declaredPaths),
  );
  return {
    kind: "git",
    repository: request.repository,
    commitSha,
    treeDigest: hashed.treeSha256,
    treePath,
    // Exactly the leaf files the digest covers — the scan must inspect all of them.
    files: hashed.files.map((file) => file.path),
  };
}

// -- npm identity resolver ---------------------------------------------------
// Identity discovery only (package + version -> exact version + SRI integrity).
// EXACT tarball acquisition, SRI verification, contained unpacking, and tree
// digest live in the sibling `./npm-source.ts` as `acquireNpmTree`, which
// consumes a {@link ResolvedNpmSource} and returns it enriched with the
// materialized tree — mirroring how {@link resolveGitSource} materializes a git
// checkout. The result is fed to the gate via {@link scannableFromNpm}.

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

// -- Fast static inspection (orchestrated trust seams) -----------------------

export type ScanVerdict = "allow" | "block";
export type ScanCoverage = "complete" | "incomplete";
export type ScanSeverity = "info" | "low" | "medium" | "high" | "critical";

/**
 * The two independent (a2) outcomes. `rawSourceScan` describes the WHOLE hashed
 * tree (honest: findings present or not); `selectedProfileGate` is the actionable
 * verdict for the selected install/runtime closure — the only one that authorizes
 * provisioning. `ALLOW_WITH_CONDITIONS` means "allowed because the named accepted
 * runtime findings were in force" (see {@link assertProvisionAuthorized}).
 */
export type RawSourceOutcome = "FINDINGS_PRESENT" | "CLEAN";
export type SelectedProfileGate = "ALLOW" | "ALLOW_WITH_CONDITIONS" | "BLOCK";

const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export interface ScanFinding {
  code: string;
  severity: ScanSeverity;
  detail: string;
  coverage: ScanCoverage;
  /** Source-relative POSIX path of the scanned file. Present only on
   * content-risk findings, where it lets an accepted-baseline entry pin the
   * finding; inspectors whose findings must never be acceptable (e.g.
   * malicious-code) deliberately do not set it. */
  path?: string;
  /** sha256 of the scanned file's UTF-8 text, CRLF-normalized to LF — the
   * acceptance content pin. Normalized so a checkout's platform line-ending
   * drift (core.autocrlf) cannot void or forge-break an acceptance while any
   * substantive edit still does. */
  contentSha256?: string;
  /** Set by the policy decision when a maintainer-accepted baseline entry
   * matched this finding exactly (code + path + content hash). */
  accepted?: boolean;
  /** Closure classification of this finding's file — present ONLY when a closure
   * spec was applied. Absent ⇒ legacy full-tree behavior (every finding blocks). */
  classification?: FindingClassification;
  /** Precise reachability under {@link classification} (audit granularity;
   * `unknown` rolls up INTO `closure` for the gate but is disclosed distinctly). */
  closureReachability?: Reachability | "non-materialized";
  /** Gate-layer visible-typography demotion overlay (W5 rule-8): present ONLY on a
   * `trust.hidden-unicode` finding whose file is ALL advisory typography under a
   * seeded closure. The raw `severity` stays "high" (raw counts unaffected); a
   * finding carrying this is treated as NON-gating by {@link decide}. */
  advisory?: TypographyAdvisory;
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

function findingFromCode(
  code: string | undefined,
  detail: string,
  pin?: { path: string; contentSha256: string },
): ScanFinding {
  const resolvedCode = code ?? "trust.finding";
  const severity = DANGER_SEVERITY[resolvedCode] ?? GRADED_SEVERITY[resolvedCode] ?? "medium";
  const finding: ScanFinding = { code: resolvedCode, severity, detail, coverage: "complete" };
  if (pin !== undefined) {
    finding.path = pin.path;
    finding.contentSha256 = pin.contentSha256;
  }
  return finding;
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
    const pin = {
      path: toComparablePath(rel),
      contentSha256: createHash("sha256")
        .update(source.replace(/\r\n/g, "\n"), "utf8")
        .digest("hex"),
    };
    const checks = isDoc ? scanTrustDocument(rel, source) : scanTrustUnicodeDocument(rel, source);
    for (const check of checks) {
      findings.push(findingFromCode(check.code, check.detail ?? `${rel}: content risk`, pin));
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

// The binding scan skips ONLY ".git", matching the digest's fileset
// (declaredTopLevelPaths excludes ".git" and hashComponentTree then recurses with
// no skipping). It must NOT reuse DEFAULT_TRUST_SKIP_DIRS, which skips
// dist/vendor/node_modules/coverage — those bytes ARE in treeDigest, so an
// inventory that skipped them would leave identity bytes uninspected (CM-27/D7).
const BINDING_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([".git"]);

function defaultInventory(root: string): TrustFileInventory {
  return buildTrustFileInventory(root, { skipDirs: BINDING_SCAN_SKIP_DIRS });
}

function runInspectors(
  treePath: string,
  inventory: TrustFileInventory,
  inspectors: readonly DimensionInspector[],
): DimensionReport[] {
  return inspectors.map((inspector) => inspector.run({ treePath, inventory }));
}

/**
 * Run the fast inspection over an on-disk tree, returning one report per D12
 * dimension. Split out from {@link runFastScanGate} so the inspection is
 * independently testable and reusable; the gate applies policy on top.
 */
export function inspectTree(treePath: string, deps: InspectTreeDeps = {}): DimensionReport[] {
  const inventory = (deps.inventoryFactory ?? defaultInventory)(treePath);
  return runInspectors(treePath, inventory, deps.inspectors ?? W2_DEFAULT_INSPECTORS);
}

function toComparablePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Structural D7/CM-27 guarantee: assert the scan inventory covered every leaf file
 * the digest folded in. Any identity file the inventory did not see — and an
 * ABSENT identity list entirely — becomes a MISSING dimension, which {@link decide}
 * routes through the same fail-closed incomplete-coverage path, so the disposition
 * can never plainly allow an identity whose coverage it cannot prove. A source with
 * no identity list cannot certify coverage and must fail closed, never pass by
 * default (production always supplies it via {@link scannableFromGit}; this guards
 * any future hand-built source).
 */
function identityCoverageReport(
  identityFiles: readonly string[] | undefined,
  inventory: TrustFileInventory,
): DimensionReport | undefined {
  if (identityFiles === undefined) {
    return {
      dimension: "identity-coverage",
      status: "missing",
      reason:
        "no identity file list accompanied the source, so the scan cannot certify it covered the pinned digest",
      findings: [],
    };
  }
  const inventoryPaths = new Set(
    inventory.files.map((entry) => toComparablePath(entry.relativePath)),
  );
  const missing = identityFiles.map(toComparablePath).filter((path) => !inventoryPaths.has(path));
  if (missing.length === 0) return undefined;
  return {
    dimension: "identity-coverage",
    status: "missing",
    reason: `${missing.length} identity file(s) folded into the digest were not inspected (e.g. ${missing.slice(0, 3).join(", ")})`,
    findings: [],
  };
}

// -- Disposition (brand-protected) -------------------------------------------

declare const scanDispositionBrand: unique symbol;

/**
 * The rule-9 five-way disclosure: raw findings, closure findings, inert findings,
 * accepted runtime findings, and residual risk — each counted separately so a
 * Framework Card can show them without conflation. Computed on every decision;
 * for a legacy (no-closure) disposition, `closureFindings` is the whole set and
 * `inertFindings` is empty.
 */
export interface FrameworkCardDisclosure {
  rawFindings: { total: number; high: number; bySeverity: Record<ScanSeverity, number> };
  closureFindings: { total: number; high: number; unknownReachability: number };
  inertFindings: { total: number; high: number };
  acceptedRuntimeFindings: { total: number };
  /** Rule-8 visible-typography demotions: high `trust.hidden-unicode` findings whose
   * file is all advisory typography, reported (non-blocking) rather than accepted. */
  visibleTypographyAdvisories: { total: number; files: number };
  residualRisk: { blockingUnaccepted: number; unknownReachability: number; inertReported: number };
}

export interface ScanDisposition {
  readonly [scanDispositionBrand]: "ScanDisposition";
  readonly digest: string;
  /** Legacy verdict, always derived: `selectedProfileGate === "BLOCK" ? "block" : "allow"`. */
  readonly verdict: ScanVerdict;
  readonly findings: readonly ScanFinding[];
  readonly posture: Posture;
  readonly producedAt: string;
  /** Whole-tree outcome (descriptive; never authorizes on its own). */
  readonly rawSourceScan: RawSourceOutcome;
  /** The actionable gate for the selected profile — what `assertProvisionAuthorized` reads. */
  readonly selectedProfileGate: SelectedProfileGate;
  /** Closure identity + conditions; absent for a legacy full-tree disposition. */
  readonly closure?: {
    profile: string;
    classifierVersion: number;
    closureDigest: string;
    hostFactsDigest: string;
    /** Acceptance keys that neutralized a blocking ≥high finding — the conditions
     * `ALLOW_WITH_CONDITIONS` requires still be in force at provision time. */
    requiredAcceptanceKeys?: readonly string[];
  };
  readonly disclosure: FrameworkCardDisclosure;
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

// -- Maintainer-accepted content findings (scan-acceptance baseline) ---------

/**
 * One maintainer-accepted content finding, pinned to the exact file content:
 * `fileSha256` is the sha256 of the file's UTF-8 text, so ANY edit to the file
 * voids the acceptance and the finding blocks again until re-reviewed.
 * `repository` is audit metadata only — the match key is (code, path,
 * fileSha256), which is already content-exact without it.
 *
 * `profile` scopes the entry to ONE selected-profile closure (a2): a scoped entry
 * only applies under that profile and never neutralizes a finding in a file
 * outside its blocking closure. ABSENT ⇒ the entry applies under any closure (the
 * W4 full-tree default, so pre-a2 entries need no `profile`). Because an inert
 * finding never gates, an acceptance whose file is out-of-closure is structurally
 * incapable of widening the gate — enforced by construction, not by a check.
 */
export interface AcceptedContentFinding {
  repository: string;
  code: string;
  path: string;
  fileSha256: string;
  profile?: string;
  /** Audit metadata (rule-8): the human-reviewed class this acceptance falls under
   * (e.g. EXPECTED_SKILL_WORKFLOW_CONTROL). Does NOT affect the match key. */
  acceptanceClass?: string;
  /** Audit metadata (rule-8): the runtime conditions the acceptance is contingent on. */
  conditions?: readonly string[];
}

const AcceptedContentFindingSchema = z
  .object({
    repository: z.string().min(1),
    code: z.string().min(1),
    path: z.string().min(1),
    fileSha256: z.string().regex(SHA256_HEX),
    profile: z.string().min(1).optional(),
    acceptanceClass: z.string().min(1).optional(),
    conditions: z.array(z.string().min(1)).optional(),
  })
  .strict();

const ScanAcceptanceArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    reason: z.string().min(1),
    accepted: z.array(AcceptedContentFindingSchema),
  })
  .strict();

export type ScanAcceptanceArtifact = z.infer<typeof ScanAcceptanceArtifactSchema>;

/**
 * Parse the shipped scan-acceptance artifact. Fail-closed: a malformed
 * artifact yields ZERO acceptances (the gate stays at full strictness), never
 * a widened gate — and the artifact's own unit test fails loudly on shape
 * drift so a malformed ship cannot go unnoticed.
 */
export function readScanAcceptanceArtifact(): ScanAcceptanceArtifact {
  const parsed = ScanAcceptanceArtifactSchema.safeParse(scanAcceptanceJson);
  if (!parsed.success) {
    return { schemaVersion: 2, reason: "malformed artifact — zero acceptances", accepted: [] };
  }
  return parsed.data;
}

let shippedAcceptance: ScanAcceptanceArtifact | undefined;
function shippedAcceptedFindings(): readonly AcceptedContentFinding[] {
  shippedAcceptance ??= readScanAcceptanceArtifact();
  return shippedAcceptance.accepted;
}

/** Unambiguous match key regardless of path/code characters. */
function acceptanceKey(code: string, path: string, fileSha256: string): string {
  return JSON.stringify([code, path, fileSha256]);
}

/** Read-only hygiene report of an acceptance set against a computed closure. */
export interface ScanAcceptanceReport {
  /** Entries (matching the closure's profile, or unscoped) whose file IS in the blocking closure. */
  applicable: readonly AcceptedContentFinding[];
  /** Scoped/unscoped entries whose file is absent or inert for this closure — reported, never
   * auto-deleted, and already harmless (an out-of-closure acceptance cannot widen the gate). */
  staleOutOfClosure: readonly AcceptedContentFinding[];
}

/**
 * Compare an acceptance set against a profile closure (pure — never writes).
 * Entries scoped to a DIFFERENT profile are skipped entirely; the remainder split
 * into `applicable` (file present AND in the blocking closure) and
 * `staleOutOfClosure` (file removed, or materialized-inert). Mirrors the
 * `skillDenyListReport` missing/extra hygiene model: staleness is a note, not a
 * gate change — the gate already fails toward "the entry does nothing."
 */
export function scanAcceptanceReport(
  closure: ProfileClosure,
  accepted: readonly AcceptedContentFinding[] = shippedAcceptedFindings(),
): ScanAcceptanceReport {
  const applicable: AcceptedContentFinding[] = [];
  const staleOutOfClosure: AcceptedContentFinding[] = [];
  for (const entry of accepted) {
    if (entry.profile !== undefined && entry.profile !== closure.spec.profile) continue;
    const present = closure.nodes.has(entry.path);
    const inClosure = present && classificationOf(closure, entry.path).classification === "closure";
    if (inClosure) applicable.push(entry);
    else staleOutOfClosure.push(entry);
  }
  return { applicable, staleOutOfClosure };
}

export interface FastScanPolicy {
  posture: Posture;
  /** Only meaningful at vibe: permit provisioning despite incomplete coverage. */
  allowIncompleteAtVibe?: boolean;
  /**
   * Maintainer-accepted content findings; when absent, the shipped
   * scan-acceptance artifact applies. Acceptance can only match a finding
   * that carries a content pin (path + contentSha256 — content-risk findings
   * only) and never reaches critical severity.
   */
  acceptedFindings?: readonly AcceptedContentFinding[];
  /**
   * The selected-profile closure spec (a2). ABSENT ⇒ legacy full-tree behavior:
   * every finding blocks exactly as before. PRESENT ⇒ closure-aware disposition:
   * findings are classified and only closure (+ unknown-reachability) findings gate.
   */
  closureSpec?: ClosureSpec;
  /** Injected host-load facts for the closure's model-load axis. Absent ⇒ fail closed. */
  hostFacts?: HostLoadFacts;
  /**
   * Phase-2 (W7 §C) deep-scanner dimensions, PRE-COMPUTED by the caller. The deep
   * scanners are ASYNC (they spawn uvx/docker through a runner) and cannot run inside
   * this synchronous gate, so the provision/doctor flow runs them via
   * `scan-cache-tiers.ts` (`runDeepScanTier` — which consults and writes the deep-scan
   * cache) and passes the produced/missing dimensions here. They are folded through the
   * SAME {@link decide} / coverage path as the fast dimensions: a `missing` deep
   * dimension yields an incomplete-coverage finding exactly like a missing fast
   * dimension. ABSENT ⇒ byte-identical to the pre-Phase-2 gate — the exact same report
   * array is decided, so every existing caller is unaffected. Deep tiers are opt-in;
   * NOTHING scans at session start.
   */
  deepDimensionReports?: readonly DimensionReport[];
}

function coverageFinding(report: DimensionReport): ScanFinding {
  return {
    code: `coverage.${report.dimension}-unavailable`,
    severity: "info",
    detail: report.reason ?? `${report.dimension} inspection unavailable`,
    coverage: "incomplete",
  };
}

interface DecisionResult {
  verdict: ScanVerdict;
  gate: SelectedProfileGate;
  rawSourceScan: RawSourceOutcome;
  findings: ScanFinding[];
  disclosure: FrameworkCardDisclosure;
  requiredAcceptanceKeys: string[];
}

function rankOf(severity: ScanSeverity): number {
  return SEVERITIES.indexOf(severity);
}

/** Whether a finding gates. Legacy (no closure) ⇒ every finding blocks; closure-aware
 * ⇒ only `classification === "closure"` blocks, and a visible-typography `advisory`
 * demotion is non-gating even though its file is in the closure. */
function isBlockingFinding(finding: ScanFinding, closureApplied: boolean): boolean {
  if (!closureApplied) return true;
  return finding.classification === "closure" && finding.advisory === undefined;
}

function buildDisclosure(
  findings: readonly ScanFinding[],
  blocking: readonly ScanFinding[],
  inert: readonly ScanFinding[],
  advisories: readonly ScanFinding[],
): FrameworkCardDisclosure {
  const high = (finding: ScanFinding): boolean => rankOf(finding.severity) >= rankOf("high");
  const bySeverity: Record<ScanSeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  const blockingHigh = blocking.filter(high);
  const unknownReachability = blockingHigh.filter(
    (finding) => finding.closureReachability === "unknown",
  ).length;
  const advisoryFiles = new Set(
    advisories.map((finding) => finding.path).filter((path): path is string => path !== undefined),
  );
  return {
    rawFindings: { total: findings.length, high: findings.filter(high).length, bySeverity },
    closureFindings: { total: blocking.length, high: blockingHigh.length, unknownReachability },
    inertFindings: { total: inert.length, high: inert.filter(high).length },
    acceptedRuntimeFindings: { total: blocking.filter((f) => f.accepted === true).length },
    visibleTypographyAdvisories: { total: advisories.length, files: advisoryFiles.size },
    residualRisk: {
      blockingUnaccepted: blockingHigh.filter((f) => f.accepted !== true).length,
      unknownReachability,
      inertReported: inert.filter(high).length,
    },
  };
}

/**
 * Compute the visible-typography advisory overlay for a seeded closure (rule-8).
 * Reads each `trust.hidden-unicode` finding's file ONCE (per-file roll-up) and,
 * when every non-ASCII occurrence is advisory-eligible, records a demotion keyed
 * by path. ACTIVE ONLY for a seeded closure with a reader — legacy and W4
 * full-tree paths never reclassify (byte-identical). Fail-closed: an unreadable
 * or non-demotable file yields no advisory, so its finding stays high/blocking.
 */
function computeTypographyAdvisories(
  findings: readonly ScanFinding[],
  closure: ProfileClosure | undefined,
  reader: ((rel: string) => string | undefined) | undefined,
): Map<string, TypographyAdvisory> {
  const advisories = new Map<string, TypographyAdvisory>();
  if (closure === undefined || closure.spec.mode !== "seeded" || reader === undefined) {
    return advisories;
  }
  const paths = new Set<string>();
  for (const finding of findings) {
    if (finding.code === "trust.hidden-unicode" && finding.path !== undefined) {
      paths.add(finding.path);
    }
  }
  for (const path of paths) {
    const text = reader(path);
    if (text === undefined) continue;
    const verdict = classifyFileTypography(path, text);
    if (verdict.demote) {
      advisories.set(path, {
        reclassifiedFrom: "high",
        contextClass: verdict.contextClass ?? "visible-typography",
      });
    }
  }
  return advisories;
}

/**
 * The (a2) decision. Collects findings (+ coverage findings for missing
 * dimensions), applies profile-scoped acceptance, classifies each finding against
 * the closure (when one is supplied), then decides the tri-state selected-profile
 * gate. When no closure is supplied the classification step is skipped and every
 * finding blocks — byte-identical to the pre-a2 gate (the W4 safety property).
 */
function decide(
  reports: readonly DimensionReport[],
  policy: FastScanPolicy,
  closure?: ProfileClosure,
  typographyReader?: (rel: string) => string | undefined,
): DecisionResult {
  const collected: ScanFinding[] = [];
  for (const report of reports) {
    collected.push(...report.findings);
    if (report.status === "missing") collected.push(coverageFinding(report));
  }
  const closureApplied = closure !== undefined;
  const advisoryByPath = computeTypographyAdvisories(collected, closure, typographyReader);

  // Acceptance marking: a maintainer-accepted (code, path, fileSha256) triple
  // neutralizes exactly that content-pinned finding. Critical findings are
  // never acceptable, and a finding without a pin can never match. An entry
  // scoped to a `profile` only applies under that profile's closure (an
  // out-of-closure acceptance is additionally inert because inert findings do
  // not gate — see the closure-membership property).
  const activeProfile = closure?.spec.profile;
  const acceptedKeys = new Set(
    (policy.acceptedFindings ?? shippedAcceptedFindings())
      .filter((entry) => entry.profile === undefined || entry.profile === activeProfile)
      .map((entry) => acceptanceKey(entry.code, entry.path, entry.fileSha256)),
  );

  const findings = collected.map((finding) => {
    let marked = finding;
    let blockingHere = true;
    if (closure !== undefined) {
      // A pathless finding (e.g. malicious-code) can never be proven inert — it
      // has no file to classify — so it fails closed to blocking `closure`.
      const classified =
        finding.path !== undefined
          ? classificationOf(closure, finding.path)
          : { classification: "closure" as const, reachability: "unknown" as const };
      // Rule 5/6: a critical (danger) finding is NEVER inert, even in a file the
      // closure classifies materialized — a proof of inertness cannot cover a
      // danger finding. Its file's reachability is still recorded for audit.
      const classification: FindingClassification =
        rankOf(finding.severity) >= rankOf("critical") ? "closure" : classified.classification;
      marked = {
        ...marked,
        classification,
        closureReachability: classified.reachability,
      };
      // Rule-8 visible-typography demotion: a hidden-unicode finding whose file is
      // all advisory typography is reported but does NOT gate (raw severity stays).
      const advisory =
        finding.code === "trust.hidden-unicode" && finding.path !== undefined
          ? advisoryByPath.get(finding.path)
          : undefined;
      if (advisory !== undefined) marked = { ...marked, advisory };
      blockingHere = classification === "closure" && advisory === undefined;
    }
    // Acceptance only marks a BLOCKING finding — accepting an inert finding is a
    // structural no-op (it never gated), so the mark is withheld to keep the
    // evidence honest. In legacy mode every finding blocks, so this is unchanged.
    if (
      blockingHere &&
      finding.path !== undefined &&
      finding.contentSha256 !== undefined &&
      rankOf(finding.severity) < rankOf("critical") &&
      acceptedKeys.has(acceptanceKey(finding.code, finding.path, finding.contentSha256))
    ) {
      marked = { ...marked, accepted: true };
    }
    return marked;
  });

  const blocking = findings.filter((finding) => isBlockingFinding(finding, closureApplied));
  const inert = closureApplied
    ? findings.filter((finding) => finding.classification === "materialized-inert")
    : [];
  const advisories = findings.filter((finding) => finding.advisory !== undefined);

  const blockingUnacceptedHigh = blocking.some(
    (finding) => rankOf(finding.severity) >= rankOf("high") && finding.accepted !== true,
  );
  const acceptedBlockingHigh = blocking.filter(
    (finding) => rankOf(finding.severity) >= rankOf("high") && finding.accepted === true,
  );
  const complete = reports.every((report) => report.status === "produced");
  // ALLOW_WITH_CONDITIONS only exists when a closure scopes the conditions; a
  // legacy disposition with accepted highs is a plain ALLOW (verdict-identical to
  // the pre-a2 gate, so W4 provisioning is unchanged).
  const conditionsGate: SelectedProfileGate =
    closureApplied && acceptedBlockingHigh.length > 0 ? "ALLOW_WITH_CONDITIONS" : "ALLOW";

  let gate: SelectedProfileGate;
  if (blockingUnacceptedHigh) {
    gate = "BLOCK";
  } else if (!complete) {
    gate =
      policy.posture === "vibe" && policy.allowIncompleteAtVibe === true ? conditionsGate : "BLOCK";
  } else {
    gate = conditionsGate;
  }
  const verdict: ScanVerdict = gate === "BLOCK" ? "block" : "allow";
  const rawSourceScan: RawSourceOutcome = findings.some(
    (finding) => rankOf(finding.severity) >= rankOf("high"),
  )
    ? "FINDINGS_PRESENT"
    : "CLEAN";
  const requiredAcceptanceKeys = closureApplied
    ? acceptedBlockingHigh
        .filter((finding) => finding.path !== undefined && finding.contentSha256 !== undefined)
        .map((finding) =>
          acceptanceKey(finding.code, finding.path as string, finding.contentSha256 as string),
        )
    : [];
  return {
    verdict,
    gate,
    rawSourceScan,
    findings,
    disclosure: buildDisclosure(findings, blocking, inert, advisories),
    requiredAcceptanceKeys,
  };
}

function produceDisposition(
  digest: string,
  policy: FastScanPolicy,
  reports: readonly DimensionReport[],
  producedAt: string,
  closure?: ProfileClosure,
  typographyReader?: (rel: string) => string | undefined,
): ScanDisposition {
  const decision = decide(reports, policy, closure, typographyReader);
  const closureBlock =
    closure === undefined
      ? undefined
      : {
          profile: closure.spec.profile,
          classifierVersion: closure.spec.classifierVersion,
          closureDigest: closure.closureDigest,
          hostFactsDigest: closure.hostFactsDigest,
          requiredAcceptanceKeys:
            decision.requiredAcceptanceKeys.length > 0
              ? decision.requiredAcceptanceKeys
              : undefined,
        };
  return mintDisposition({
    digest,
    verdict: decision.verdict,
    findings: decision.findings,
    posture: policy.posture,
    producedAt,
    rawSourceScan: decision.rawSourceScan,
    selectedProfileGate: decision.gate,
    closure: closureBlock,
    disclosure: decision.disclosure,
  });
}

// -- Scan cache (derived; corrupt == miss, never fail-closed) ----------------

// Cached findings are PRE-decision: they may carry the acceptance content pin
// (path/contentSha256) but never an `accepted` mark — acceptance is decided
// fresh on every gate call so baseline changes are always honored. A record
// carrying unknown fields fails the strict parse and is treated as a miss.
const ScanFindingSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(SEVERITIES),
    detail: z.string(),
    coverage: z.enum(["complete", "incomplete"]),
    path: z.string().min(1).optional(),
    contentSha256: z.string().regex(SHA256_HEX).optional(),
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

// schemaVersion 3: the cache stores PRE-decision reports (closure classification
// and acceptance are always recomputed fresh), so a stale record can never carry
// a wrong verdict — but the a2 change reshapes the disposition, and the v1→v2
// precedent's conservatism is retained: bumping the literal turns every older
// record into a cache miss (a recompute), never a served pre-a2 artifact.
const ScanCacheRecordSchema = z
  .object({
    schemaVersion: z.literal(3),
    // A git tree digest (sha256 hex) OR an npm scannable digest (SRI sha512
    // integrity): npm and git dispositions bind to different digest namespaces,
    // so the derived cache must recognize both. A record whose digest matches
    // neither shape is a miss (recompute), never a fail-closed block.
    digest: z.string().refine((value) => SHA256_HEX.test(value) || SRI_SHA512.test(value)),
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
  // The closure is a policy-cheap classification recomputed every call (like
  // acceptance), so it rides both the warm-cache and the fresh path. Absent a
  // closure spec, it is undefined and the gate stays byte-identical to pre-a2.
  const closure =
    policy.closureSpec === undefined
      ? undefined
      : computeClosureForSource(source, policy.closureSpec, policy.hostFacts, deps);
  // The visible-typography reclassifier re-reads flagged files from the derived
  // checkout; supplied only when a closure is active (it is otherwise inert).
  const typographyReader =
    closure === undefined
      ? undefined
      : (rel: string): string | undefined => readTextSafe(join(source.treePath, rel));
  // Phase-2 (§C.4) deep-dimension fold — THE one integration seam. Pre-computed deep
  // dimensions (from `scan-cache-tiers.ts`) are appended to the fast dimensions so the
  // SAME `decide()`/coverage path handles both. Absent ⇒ the SAME array reference is
  // decided (identity-preserving), so the disposition is byte-identical to the
  // pre-Phase-2 gate and every existing caller/test is unaffected.
  const deepDimensionReports = policy.deepDimensionReports ?? [];
  const withDeep = (reports: readonly DimensionReport[]): readonly DimensionReport[] =>
    deepDimensionReports.length === 0 ? reports : [...reports, ...deepDimensionReports];
  // A source with no identity list can never certify coverage, so it must not ride
  // a warm cache to an allow: skip the cache read entirely and fall through to the
  // fail-closed recompute below.
  const cached =
    source.identityFiles === undefined ? undefined : readScanCache(deps.cacheHome, source.digest);
  if (cached !== undefined) {
    return produceDisposition(
      source.digest,
      policy,
      withDeep(cached.reports),
      cached.scannedAt,
      closure,
      typographyReader,
    );
  }
  // One inventory serves BOTH the inspectors and the identity-coverage check, so
  // the digest and the scanned fileset can never silently diverge.
  const inventory = (deps.inventoryFactory ?? defaultInventory)(source.treePath);
  const reports = runInspectors(
    source.treePath,
    inventory,
    deps.inspectors ?? W2_DEFAULT_INSPECTORS,
  );
  const identityReport = identityCoverageReport(source.identityFiles, inventory);
  const allReports = identityReport === undefined ? reports : [...reports, identityReport];
  const scannedAt = new Date().toISOString();
  // Persist the cache only for a source whose identity list is present. An
  // absent-identity run is a fail-closed error path; caching its report set would
  // spuriously block a later, correctly-constructed source for the same digest.
  if (source.identityFiles !== undefined) {
    writeScanCache(deps.cacheHome, {
      schemaVersion: 3,
      digest: source.digest,
      scannedAt,
      reports: allReports.map((report) => ({ ...report, findings: [...report.findings] })),
    });
  }
  return produceDisposition(
    source.digest,
    policy,
    withDeep(allReports),
    scannedAt,
    closure,
    typographyReader,
  );
}

/**
 * Classify the selected-profile closure for a scannable source. The file universe
 * is the exact identity fileset the digest pins (so the closure and the digest can
 * never silently diverge); a hand-built source without one falls back to an
 * inventory walk. Blocking files are read from the derived checkout on demand.
 */
function computeClosureForSource(
  source: ScannableSource,
  spec: ClosureSpec,
  hostFacts: HostLoadFacts | undefined,
  deps: FastScanDeps,
): ProfileClosure {
  const files =
    source.identityFiles !== undefined
      ? source.identityFiles.map(toComparablePath)
      : (deps.inventoryFactory ?? defaultInventory)(source.treePath).files.map((entry) =>
          toComparablePath(entry.relativePath),
        );
  const readText = (rel: string): string | undefined => readTextSafe(join(source.treePath, rel));
  return classifyClosure({ files, readText }, spec, hostFacts);
}

// -- Provision authorization guard (D12 code-path invariant) -----------------

/**
 * The gate every adapter's `provision` MUST pass before running any upstream
 * code: the disposition must be genuine (branded by this module), its digest must
 * equal the EXACT resolved source digest being provisioned, and its
 * SELECTED-PROFILE gate must authorize. `BLOCK` fails closed; `ALLOW` passes;
 * `ALLOW_WITH_CONDITIONS` passes only when every condition it named is still in
 * force — i.e. each `requiredAcceptanceKeys` entry corresponds to a finding the
 * disposition actually carries as accepted (a tamper/integrity check). A legacy
 * disposition with no `selectedProfileGate` falls back to its `verdict`.
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
  if (disposition.digest !== expectedDigest) {
    throw new BindingScanError(
      `refusing to provision: scan disposition digest ${disposition.digest} does not match the resolved source digest ${expectedDigest}`,
    );
  }
  const gate: SelectedProfileGate =
    disposition.selectedProfileGate ?? (disposition.verdict === "allow" ? "ALLOW" : "BLOCK");
  if (gate === "BLOCK") {
    throw new BindingScanError(
      `refusing to provision: selected-profile gate is "BLOCK" (verdict "${disposition.verdict}")`,
    );
  }
  if (gate === "ALLOW_WITH_CONDITIONS") {
    const required = disposition.closure?.requiredAcceptanceKeys ?? [];
    if (required.length === 0) {
      throw new BindingScanError(
        "refusing to provision: ALLOW_WITH_CONDITIONS disposition names no acceptance conditions",
      );
    }
    const acceptedKeys = new Set(
      disposition.findings
        .filter(
          (finding) =>
            finding.accepted === true &&
            finding.path !== undefined &&
            finding.contentSha256 !== undefined,
        )
        .map((finding) =>
          acceptanceKey(finding.code, finding.path as string, finding.contentSha256 as string),
        ),
    );
    const unmet = required.filter((key) => !acceptedKeys.has(key));
    if (unmet.length > 0) {
      throw new BindingScanError(
        `refusing to provision: ${unmet.length} ALLOW_WITH_CONDITIONS acceptance condition(s) are no longer in force`,
      );
    }
  }
}
