import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, relative } from "node:path";
import { hashComponentTree } from "../../../baseline-evidence/hash.js";
import { AihError } from "../../../errors.js";

/**
 * D7 plugin-content identity verification for the Claude host, plus the
 * machine-scope ownership + cache-locator conventions the plugin services
 * ({@link ./plugins.ts}) build on.
 *
 * D7 requires that the bytes the host actually LOADS are the bytes AIH scanned.
 * After the host materializes a plugin into its loadable cache, this module
 * re-digests that cache tree with the SAME canonical routine the scan gate uses
 * ({@link hashComponentTree} — the routine `resolveGitSource` folds a checkout
 * with) and compares it to the scanned `treeDigest`. A mismatch fails closed;
 * only an exact match may be recorded in the lock (`scannedDigest` == `loadedDigest`).
 *
 * `scan-gate.ts` is a READ-ONLY module, so its module-private top-level-path
 * selection cannot be imported; {@link loadedTopLevelPaths} mirrors it exactly
 * (every entry except `.git`, sorted) and feeds the SAME `hashComponentTree`, so
 * a loaded tree digests comparably to a scanned one — no second digest algorithm.
 */

// -- Home directory resolution ----------------------------------------------

/**
 * The user's home directory — injected env first (hermetic tests), then the OS.
 * Mirrors `homeDir` in `src/internals/cli-detect.ts` (USERPROFILE || HOME || os).
 */
export function claudeHomeDir(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE || env.HOME || homedir();
}

// -- Machine-scope ("home:") ownership target convention ---------------------

/**
 * Machine-scoped binding effects (marketplace registration, the plugin cache
 * under the user's Claude dir) are recorded as OWNERSHIP entries whose `target`
 * carries a `home:`-prefixed, POSIX, repo-style path. This is schema-legal today:
 * the lock's `ownership[].target` is a free string (only `writes[].path` is
 * `SafeRelPath`-bound). Repo-relative D18 writes keep bare relative targets; a
 * `home:` prefix is the single, documented marker that a target lives under the
 * user's home rather than the project root, so removal can route it to the
 * machine-scope reconciler instead of the repo-relative one.
 */
export const HOME_OWNERSHIP_PREFIX = "home:";

/** `<home>/.claude/plugins` — the Claude plugins state root (repo-style POSIX). */
export const CLAUDE_PLUGINS_DIR_REL = ".claude/plugins";
/** `<home>/.claude/plugins/cache` — where installed plugin trees materialize. */
export const CLAUDE_PLUGINS_CACHE_REL = `${CLAUDE_PLUGINS_DIR_REL}/cache`;
/**
 * `<home>/.claude/settings.json` — where the host records registered
 * marketplaces (empirically verified on 2.1.214). A DIFFERENT file from the
 * repo-relative project `.claude/settings.json` `surfaces.ts` exports as
 * `CLAUDE_SETTINGS_PATH` (same relative shape, different root — home vs.
 * project); named distinctly here so the two are never conflated.
 *
 * `plugins/config.json` — this module's PRE-empirical model — is NOT used by
 * the real host; there is no exported constant for it (dead, deleted, not
 * repointed). The host ALSO derives `plugins/known_marketplaces.json` and
 * `plugins/installed_plugins.json` as its own read caches — AIH never owns or
 * writes either; they exist only as context for a future reader of this file.
 */
export const CLAUDE_HOME_SETTINGS_REL = ".claude/settings.json";
/** Top-level key in the home settings file holding the marketplace map. */
export const CLAUDE_EXTRA_KNOWN_MARKETPLACES_KEY = "extraKnownMarketplaces";

/** Ownership target for a registered marketplace (kind `json-pointer`). */
export function homeMarketplaceTarget(marketplace: string): string {
  return `${HOME_OWNERSHIP_PREFIX}${CLAUDE_HOME_SETTINGS_REL}#/${CLAUDE_EXTRA_KNOWN_MARKETPLACES_KEY}/${marketplace}`;
}

/**
 * Ownership target for a materialized plugin cache tree (kind `file`).
 * Empirically corrected in the W4 live run: the host materializes to
 * `cache/<marketplace>/<plugin>/<version>/` (see
 * {@link defaultPluginCacheLocator}), NOT `cache/<pluginKey>` — ownership
 * roots at the plugin level so every version directory under it is covered by
 * the same recorded surface.
 */
export function homePluginCacheTarget(marketplace: string, plugin: string): string {
  return `${HOME_OWNERSHIP_PREFIX}${CLAUDE_PLUGINS_CACHE_REL}/${marketplace}/${plugin}`;
}

/** True for a machine-scope ownership target (the `home:`-prefixed convention). */
export function isHomeScopedTarget(target: string): boolean {
  return target.startsWith(HOME_OWNERSHIP_PREFIX);
}

// -- Plugin cache locator (modeled default; injectable) ----------------------

export interface PluginCacheLocatorParams {
  /** Resolved user home dir (see {@link claudeHomeDir}). */
  home: string;
  /** The marketplace name the plugin was installed from. */
  marketplace: string;
  /** The plugin name. */
  plugin: string;
  /** The `<plugin>@<marketplace>` enable/cache key. */
  pluginKey: string;
  /** The scanned checkout registered as the marketplace source (`resolved.treePath`). */
  marketplaceSourcePath: string;
  /**
   * The plugin's version (from its own `.claude-plugin/plugin.json`, e.g. via
   * {@link pluginSourceSubtreeDigest}), when known. Refines the cache-path
   * guess to the exact versioned directory; callers should prefer
   * {@link installPathFromPluginList}'s authoritative path over this locator
   * whenever the host's own report is available.
   */
  version?: string;
}

/** Resolve the on-disk tree the host will LOAD for an installed plugin (D7 subject). */
export type PluginCacheLocator = (params: PluginCacheLocatorParams) => string;

/**
 * The DEFAULT cache layout — empirically verified on 2.1.214 (2026-07):
 * `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, containing
 * the plugin SOURCE SUBTREE only (not the whole marketplace checkout).
 *
 * When `version` is unknown, this falls back to the `<marketplace>/<plugin>`
 * PARENT directory — a documented, less-precise guess (it may contain more
 * than one version subdirectory, or none yet). Callers should prefer
 * {@link installPathFromPluginList}'s authoritative, host-reported path
 * whenever available and treat this default as the last-resort guess it is.
 */
export const defaultPluginCacheLocator: PluginCacheLocator = ({
  home,
  marketplace,
  plugin,
  version,
}) =>
  version !== undefined
    ? join(home, ".claude", "plugins", "cache", marketplace, plugin, version)
    : join(home, ".claude", "plugins", "cache", marketplace, plugin);

/**
 * Extract the authoritative `installPath` for `pluginKey` from a parsed
 * `claude plugin list --json` payload — shape (2.1.214, empirical):
 * `{version: 2, plugins: {"<plugin>@<marketplace>": [{scope, installPath, version,
 * installedAt, lastUpdated, projectPath}]}}`. When more than one scope entry
 * exists for the key, the first is used (the payload carries no scope filter
 * here; a caller needing a specific scope should inspect the raw payload
 * itself). The host may report a long-form path, so the result is normalized.
 *
 * Callers PREFER this over {@link defaultPluginCacheLocator}'s layout guess —
 * it is the host's own report of where it materialized the plugin, not a
 * guess. NEVER throws: any absent key, wrong shape, or missing field yields
 * `undefined` so the caller can fall back to the locator instead of failing
 * the whole bind over an inventory-parsing hiccup.
 */
export function installPathFromPluginList(
  listPayload: unknown,
  pluginKey: string,
): string | undefined {
  if (typeof listPayload !== "object" || listPayload === null) return undefined;
  const plugins = (listPayload as { plugins?: unknown }).plugins;
  if (typeof plugins !== "object" || plugins === null) return undefined;
  const entries = (plugins as Record<string, unknown>)[pluginKey];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const first = entries[0];
  if (typeof first !== "object" || first === null) return undefined;
  const installPath = (first as { installPath?: unknown }).installPath;
  return typeof installPath === "string" && installPath.length > 0
    ? normalize(installPath)
    : undefined;
}

// -- Errors ------------------------------------------------------------------

/** Fail-closed plugin-service error (CLI failure, unparseable output, bad name, empty/unreadable cache). */
export class ClaudePluginError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_CLAUDE_PLUGIN");
  }
}

/**
 * The materialized cache tree the locator points at does not EXIST — the one
 * case conservative removal may treat as an idempotent "already gone". It is a
 * DISTINCT subclass so the reconciler can discriminate a genuinely missing tree
 * from a present-but-unreadable one (an unreadable/empty tree stays a plain
 * {@link ClaudePluginError} and is preserved + reported, never dropped).
 */
export class ClaudePluginCacheMissingError extends ClaudePluginError {}

/** D7 identity fields recorded in the lock (`match` is `scannedDigest === loadedDigest`). */
export interface PluginIdentity {
  scannedDigest: string;
  loadedDigest: string;
  match: boolean;
}

/**
 * A D7 fail-closed: the tree the host would load does not hash to the scanned
 * digest. Carries the {@link PluginIdentity} so the caller can surface both
 * digests; the binding must NOT write a lock when this is thrown.
 */
export class ClaudePluginIdentityError extends ClaudePluginError {
  readonly identity: PluginIdentity;
  constructor(message: string, identity: PluginIdentity) {
    super(message);
    this.identity = identity;
  }
}

// -- Plugin source subtree digest (D7 anchor: empirically corrected) ---------

/** {@link pluginSourceSubtreeDigest}'s result. */
export interface PluginSourceSubtree {
  /** The resolved on-disk path of the plugin's own source subtree. */
  subtreePath: string;
  /** The sha256 tree digest of `subtreePath` (the D7 anchor — see the module doc). */
  digest: string;
  /** The plugin's own version, from its `.claude-plugin/plugin.json`. */
  version: string;
}

function readJsonFileOrThrow(path: string, describe: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ClaudePluginError(
      `${describe} not found or unreadable at ${path}: ${(err as Error).message}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ClaudePluginError(
      `${describe} is not valid JSON at ${path}: ${(err as Error).message}`,
    );
  }
}

/**
 * Validate + normalize a `marketplace.json` `plugins[].source` value to a
 * POSIX-relative path (or the sentinel `"."` for the whole-checkout
 * degenerate case: `"./"`/`"."`/empty). Fails closed on any absolute path, a
 * drive letter, a home-dir (`~`) reference, or a normalized result that
 * escapes the checkout via `..` — a plugin source string never earns more
 * trust than any other checkout content the scan gate already covered.
 */
function normalizePluginSourcePath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ClaudePluginError(`plugin source must be a string; got ${JSON.stringify(raw)}`);
  }
  const posixLike = raw.trim().replace(/\\/g, "/");
  if (posixLike.length === 0 || posixLike === "." || posixLike === "./") {
    return ".";
  }
  if (isAbsolute(posixLike) || /^[A-Za-z]:/.test(posixLike) || posixLike.startsWith("~")) {
    throw new ClaudePluginError(
      `plugin source must be relative to the checkout, not absolute: ${JSON.stringify(raw)}`,
    );
  }
  const normalized = posix.normalize(posixLike).replace(/\/$/, "");
  if (normalized === "." || normalized === "") return ".";
  if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw new ClaudePluginError(`plugin source escapes the checkout: ${JSON.stringify(raw)}`);
  }
  return normalized;
}

/** Defense in depth: confirm `candidate` did not resolve outside `checkoutPath`. */
function assertWithinCheckout(checkoutPath: string, candidate: string): void {
  if (candidate === checkoutPath) return;
  const rel = relative(checkoutPath, candidate).replace(/\\/g, "/");
  if (rel.length === 0 || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new ClaudePluginError(`plugin source escapes the checkout: ${candidate}`);
  }
}

/** Look up `plugins[].source` for `plugin` in the checkout's `.claude-plugin/marketplace.json`. */
function findMarketplacePluginSource(checkoutPath: string, plugin: string): unknown {
  const manifestPath = join(checkoutPath, ".claude-plugin", "marketplace.json");
  const parsed = readJsonFileOrThrow(
    manifestPath,
    "marketplace manifest (.claude-plugin/marketplace.json)",
  );
  const plugins =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { plugins?: unknown }).plugins
      : undefined;
  if (!Array.isArray(plugins)) {
    throw new ClaudePluginError(`marketplace manifest at ${manifestPath} has no "plugins" array`);
  }
  const entry = plugins.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { name?: unknown }).name === plugin,
  );
  if (entry === undefined) {
    throw new ClaudePluginError(
      `marketplace manifest at ${manifestPath} has no plugin named ${JSON.stringify(plugin)}`,
    );
  }
  return (entry as { source?: unknown }).source;
}

/**
 * The marketplace name the checkout's own manifest declares. The claude host
 * registers a marketplace under THIS name — `claude plugin marketplace add`
 * takes no name argument, so the registrar never chooses it (W4 live-run
 * correction). `bindPlugin` asserts the adapter's pinned expectation matches
 * this value before any host mutation; a missing or malformed name fails
 * closed the same way.
 */
export function marketplaceManifestName(checkoutPath: string): string {
  const manifestPath = join(checkoutPath, ".claude-plugin", "marketplace.json");
  const parsed = readJsonFileOrThrow(
    manifestPath,
    "marketplace manifest (.claude-plugin/marketplace.json)",
  );
  const name =
    typeof parsed === "object" && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
  if (typeof name !== "string" || name.length === 0) {
    throw new ClaudePluginError(
      `marketplace manifest at ${manifestPath} declares no "name" — the host registers a marketplace under the manifest's own name, so it must be present`,
    );
  }
  return name;
}

/**
 * The D7 anchor (empirically corrected): digest the plugin's own SOURCE
 * SUBTREE — the exact bytes `claude plugin install` materializes — not the
 * whole scanned checkout. Reads `.claude-plugin/marketplace.json` from
 * `checkoutPath` to find `plugin`'s `source` entry, resolves it INSIDE the
 * checkout (fail closed on an absolute or traversing source), then digests
 * that subtree with the SAME `hashComponentTree` non-`.git` routine
 * `resolveGitSource`/{@link hashLoadedPluginTree} use. A degenerate `"./"` (or
 * `"."`, or empty) source — the common single-plugin-at-root marketplace
 * shape (e.g. obra/superpowers) — resolves to the checkout root itself, so
 * its digest EQUALS the checkout's own whole-tree digest.
 *
 * The whole-checkout identity (repository/commitSha/treeDigest) remains the
 * D7 upstream authority enforced by the scan disposition + declaration
 * (`assertResolvedMatchesDeclaration`); THIS digest is what the lock's
 * `scannedDigest` means from here on — the scanned bytes the host actually
 * loads, which for a multi-plugin marketplace is a strict subset of the
 * checkout.
 */
export function pluginSourceSubtreeDigest(
  checkoutPath: string,
  plugin: string,
): PluginSourceSubtree {
  const rawSource = findMarketplacePluginSource(checkoutPath, plugin);
  const normalizedSource = normalizePluginSourcePath(rawSource);
  const subtreePath =
    normalizedSource === "." ? checkoutPath : join(checkoutPath, ...normalizedSource.split("/"));
  assertWithinCheckout(checkoutPath, subtreePath);

  const pluginJsonPath = join(subtreePath, ".claude-plugin", "plugin.json");
  const pluginManifest = readJsonFileOrThrow(
    pluginJsonPath,
    "plugin manifest (.claude-plugin/plugin.json)",
  );
  const version =
    typeof pluginManifest === "object" && pluginManifest !== null
      ? (pluginManifest as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new ClaudePluginError(`plugin manifest at ${pluginJsonPath} has no string "version"`);
  }

  let topLevel: string[];
  try {
    topLevel = readdirSync(subtreePath)
      .filter((name) => name !== ".git")
      .sort((left, right) => left.localeCompare(right));
  } catch (err) {
    throw new ClaudePluginError(
      `plugin source subtree is unreadable: ${subtreePath} (${(err as Error).message})`,
    );
  }
  if (topLevel.length === 0) {
    throw new ClaudePluginError(`plugin source subtree has no content: ${subtreePath}`);
  }
  const hashed = hashComponentTree(subtreePath, topLevel);
  return { subtreePath, digest: hashed.treeSha256, version };
}

// -- Loaded-tree digest (reuse the canonical scan-gate routine) --------------

/**
 * The top-level roots fed to {@link hashComponentTree}, mirroring `scan-gate.ts`'s
 * module-private `declaredTopLevelPaths` (every entry except `.git`, sorted). An
 * empty tree fails closed — a host that materialized nothing must never digest to
 * a "match".
 */
function loadedTopLevelPaths(treePath: string): string[] {
  const entries = readdirSync(treePath).filter((name) => name !== ".git");
  if (entries.length === 0) {
    throw new ClaudePluginError(`materialized plugin tree has no loadable content: ${treePath}`);
  }
  return entries.sort((left, right) => left.localeCompare(right));
}

/**
 * Digest a materialized plugin cache tree the SAME way the scan gate digests a
 * checkout: {@link hashComponentTree} over the non-`.git` top-level roots. Fails
 * closed when the tree is missing (the host did not materialize the cache the
 * locator points at).
 */
export function hashLoadedPluginTree(treePath: string): string {
  if (!existsSync(treePath)) {
    // Missing-only: a distinct subclass so removal can treat this — and ONLY this
    // — as the idempotent already-gone case (an empty/unreadable tree below does not).
    throw new ClaudePluginCacheMissingError(`plugin cache tree not found at ${treePath}`);
  }
  return hashComponentTree(treePath, loadedTopLevelPaths(treePath)).treeSha256;
}

/**
 * D7 verification: digest the loaded tree and compare it to the scanned digest,
 * returning the exact `{scannedDigest, loadedDigest, match}` the lock records.
 * This function only COMPUTES the verdict (and fails closed when the tree cannot
 * be read); the caller enforces the fail-closed cleanup on a `match: false`.
 */
export function verifyPluginIdentity(
  scannedDigest: string,
  loadedTreePath: string,
): PluginIdentity {
  const loadedDigest = hashLoadedPluginTree(loadedTreePath);
  return { scannedDigest, loadedDigest, match: scannedDigest === loadedDigest };
}
