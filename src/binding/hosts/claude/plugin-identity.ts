import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
/** `<home>/.claude/plugins/config.json` — the registered-marketplaces config. */
export const CLAUDE_PLUGINS_CONFIG_REL = `${CLAUDE_PLUGINS_DIR_REL}/config.json`;
/** Top-level key in `config.json` holding the marketplace map. */
export const CLAUDE_PLUGINS_MARKETPLACES_KEY = "marketplaces";
/** `<home>/.claude/plugins/cache` — where installed plugin trees materialize. */
export const CLAUDE_PLUGINS_CACHE_REL = `${CLAUDE_PLUGINS_DIR_REL}/cache`;

/** Ownership target for a registered marketplace (kind `json-pointer`). */
export function homeMarketplaceTarget(marketplace: string): string {
  return `${HOME_OWNERSHIP_PREFIX}${CLAUDE_PLUGINS_CONFIG_REL}#/${CLAUDE_PLUGINS_MARKETPLACES_KEY}/${marketplace}`;
}

/** Ownership target for a materialized plugin cache tree (kind `file`). */
export function homePluginCacheTarget(pluginKey: string): string {
  return `${HOME_OWNERSHIP_PREFIX}${CLAUDE_PLUGINS_CACHE_REL}/${pluginKey}`;
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
}

/** Resolve the on-disk tree the host will LOAD for an installed plugin (D7 subject). */
export type PluginCacheLocator = (params: PluginCacheLocatorParams) => string;

/**
 * The documented DEFAULT cache layout — MODELED on this VM (the user scope must
 * stay clean, so it is never populated for real here) and correctable by W4's
 * real-VM acceptance run WITHOUT code archaeology, precisely because it is behind
 * this one injectable seam.
 *
 * Default: `<home>/.claude/plugins/marketplaces/<marketplace>` — the materialized
 * marketplace tree, which for a single-plugin-at-root source (AIH registers the
 * scanned checkout itself as the marketplace) IS the loadable plugin tree. A
 * multi-plugin marketplace would append the plugin's subpath; W4 encodes that in
 * the injected locator once the real layout is confirmed.
 */
export const defaultPluginCacheLocator: PluginCacheLocator = ({ home, marketplace }) =>
  join(home, ".claude", "plugins", "marketplaces", marketplace);

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
