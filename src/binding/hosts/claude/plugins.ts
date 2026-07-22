import { readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { executePlan, type PlanResult } from "../../../internals/execute.js";
import { type Action, plan } from "../../../internals/plan.js";
import type { Runner, RunResult } from "../../../internals/proc.js";
import { makeHostAdapter, resolvePlatform } from "../../../platform/detect.js";
import { execArgv } from "../../../tools/install.js";
import type { BindingLock, BindingOwnershipEntry, BindingWrite } from "../../lock.js";
import {
  assertProvisionAuthorized,
  type ResolvedGitSource,
  type ScanDisposition,
} from "../../scan-gate.js";
import {
  type ClaudeManagedPlan,
  ClaudeManagedWriteEngine,
  carryForwardOwnership,
  finalizeClaudeOwnership,
} from "./managed-writes.js";
import {
  ClaudePluginCacheMissingError,
  ClaudePluginError,
  ClaudePluginIdentityError,
  claudeHomeDir,
  defaultPluginCacheLocator,
  HOME_OWNERSHIP_PREFIX,
  hashLoadedPluginTree,
  homeMarketplaceTarget,
  homePluginCacheTarget,
  installPathFromPluginList,
  marketplaceManifestName,
  type PluginCacheLocator,
  type PluginIdentity,
  pluginSourceSubtreeDigest,
  verifyPluginIdentity,
} from "./plugin-identity.js";
import type { ClaudeDriftEntry } from "./removal.js";
import {
  assertSafeKey,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
  canonicalJson,
  sha256Hex,
} from "./surfaces.js";

/**
 * Claude host plugin-binding SERVICES (W3b) — the bind/verify/remove plugin
 * lifecycle a W4 `host-plugin` FrameworkAdapter calls. This module is NOT a
 * FrameworkAdapter, a CLI command, or a contamination/context-cost surface; it is
 * the host-side machinery under the D6 `provision`/`remove` steps.
 *
 * MECHANISM (orchestrator ruling; pinned on Claude Code 2.1.214). A binding starts
 * from an already-scan-authorized source (W2 produced a brand-protected
 * {@link ScanDisposition} for the exact digest of the resolved checkout). The
 * service ASSERTS that authorization ({@link assertProvisionAuthorized}) — it never
 * re-implements policy — then:
 *   1. registers the SCANNED CHECKOUT ITSELF as the marketplace source
 *      (`claude plugin marketplace add <local-checkout>`), so the bytes the host
 *      installs are the bytes AIH scanned, by construction;
 *   2. materializes the plugin into the loadable cache
 *      (`claude plugin install <plugin>@<marketplace> --scope project|local`);
 *   3. re-digests that cache tree and compares it to the scanned digest (D7). A
 *      mismatch FAILS CLOSED: it disables + uninstalls and throws, writing no lock;
 *   4. on a match, records the D18-owned project enable + the machine-scope
 *      ownership the lock reconciles on removal.
 *
 * PLAN-vs-DIRECT-RUNNER (D14). The repo-relative D18 field write — `enabledPlugins`
 * in `.claude/settings.json` — flows through the canonical W3a plan path
 * ({@link ClaudeManagedWriteEngine} -> `executePlan` -> {@link finalizeClaudeOwnership}),
 * keeping plan/apply separate for the owned project surface. The `claude plugin …`
 * lifecycle is IMPERATIVE through the injected {@link Runner}, because those are
 * machine-scoped side effects — not repo-relative writes `executePlan` contains —
 * and D7 verification is a mid-sequence control-flow gate (install -> digest ->
 * conditionally uninstall + abort) a static action list cannot express. This
 * mirrors `scan-gate.ts`, which drives git through the Runner directly rather than
 * through a plan.
 *
 * enabledPlugins WRITER (design tension; chosen: AIH authors it). `claude plugin
 * install --scope project` itself writes `enabledPlugins` (D4.1). D18 requires the
 * LOCK to own that field. This service AUTHORS the field via {@link ClaudeManagedWriteEngine}
 * (option (b)), because that reuses the fully-tested W3a D18 path with an
 * AIH-authored value: removal is byte-exact (`planClaudeRemoval`: equal -> restore
 * pre-existing / prune, drift -> preserve + report) and re-bind renders identical
 * bytes (`unchanged`, no backup churn). The pre-existing state is captured BEFORE
 * any CLI call (the engine reads at `jsonField` time), so even though the CLI also
 * flips the same bit, the lock records the true pre-AIH state and stays the single
 * D18 owner. The alternative — letting the CLI write it and capturing ownership
 * post-hoc (option (a)) — records a value AIH did not author and leaves the CLI as
 * a co-writer of a field the lock claims to own; it is strictly weaker on the
 * "exact removal + idempotent re-bind" criterion.
 */

/** Plugin scope: `project` -> `.claude/settings.json`; `local` -> `.claude/settings.local.json`. */
export type PluginScope = "project" | "local";

/** Default CLI timeout — a plugin install may clone/copy a tree, so wider than proc's 30s. */
const DEFAULT_PLUGIN_CLI_TIMEOUT_MS = 120_000;

// A plugin / marketplace name is a JSON-pointer segment AND a CLI argument, so it
// must be atomic on both surfaces: no whitespace or control chars (log/pointer),
// no leading `-` (git/CLI option injection), no `/`/`\`/`@`/`..` (path traversal,
// pointer depth, key-composition). This allowlist rejects every hostile shape the
// standing test enumerates; `assertSafeKey` is reused on top for the
// prototype-pollution keys (`constructor`/`prototype`) the charset would admit.
const SAFE_PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a plugin or marketplace name (safe-key rules + CLI/pointer atomicity). */
export function assertSafePluginName(name: string, kind: "plugin" | "marketplace"): void {
  if (typeof name !== "string" || !SAFE_PLUGIN_NAME.test(name)) {
    throw new ClaudePluginError(
      `refusing unsafe ${kind} name ${JSON.stringify(name)} — must match ${String(SAFE_PLUGIN_NAME)}`,
    );
  }
  // Reuse the W3a safe-key guard for the prototype-pollution keys the charset admits.
  assertSafeKey(name);
}

/** The `<plugin>@<marketplace>` key used for install/enable and the `enabledPlugins` map. */
export function pluginEnableKey(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`;
}

/** The `.claude/settings*.json` surface a scope's `enabledPlugins` field lives in. */
export function settingsFileForScope(scope: PluginScope): string {
  return scope === "local" ? CLAUDE_SETTINGS_LOCAL_PATH : CLAUDE_SETTINGS_PATH;
}

// -- Claude CLI wrappers (imperative; through the injected Runner) ------------

export interface PluginCliDeps {
  /** The subprocess seam — a fake in tests; never spawns a real `claude` there. */
  runner: Runner;
  /** Environment for the CLI (home-dir resolution). Defaults to none. */
  env?: NodeJS.ProcessEnv;
  /** Per-call timeout override. */
  timeoutMs?: number;
}

async function runClaude(deps: PluginCliDeps, argv: string[]): Promise<RunResult> {
  // npm ships `claude` as a .cmd shim on Windows, which execFile cannot spawn
  // (ENOENT/EINVAL) — route through the canon cmd /c wrap (injection-asserted
  // per argv element), exactly as the harness already spawns npm/npx.
  return deps.runner(execArgv(resolvePlatform(deps.env), argv), {
    env: deps.env,
    timeoutMs: deps.timeoutMs ?? DEFAULT_PLUGIN_CLI_TIMEOUT_MS,
  });
}

/**
 * Whether `<home>/.claude/settings.json` already registers `marketplace` under
 * `extraKnownMarketplaces` — read BEFORE `marketplace add`, so a failed bind
 * only unwinds a registration it created itself (an unreadable or malformed
 * settings file reads as "not registered").
 */
function marketplaceIsRegistered(home: string, marketplace: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    const known =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { extraKnownMarketplaces?: unknown }).extraKnownMarketplaces
        : undefined;
    return typeof known === "object" && known !== null && Object.hasOwn(known, marketplace);
  } catch {
    return false;
  }
}

/** Fail closed on a spawn failure or non-zero exit where success is required. */
function assertCliOk(result: RunResult, describe: string): void {
  if (result.spawnError || result.code !== 0) {
    const detail = (result.stderr || "").trim().slice(0, 200);
    throw new ClaudePluginError(
      `${describe} failed (exit ${String(result.code)})${detail ? `: ${detail}` : ""}`,
    );
  }
}

/**
 * Register a LOCAL scanned checkout as a marketplace source. The path must be
 * absolute (it is `resolved.treePath`, an AIH-owned cache path) — a relative or
 * `-`-leading value is refused so nothing user-influenced can be read as a CLI flag.
 */
export async function marketplaceAdd(deps: PluginCliDeps, sourcePath: string): Promise<void> {
  if (!isAbsolute(sourcePath)) {
    throw new ClaudePluginError(
      `refusing marketplace source ${JSON.stringify(sourcePath)} — must be an absolute checkout path`,
    );
  }
  assertCliOk(
    await runClaude(deps, ["claude", "plugin", "marketplace", "add", sourcePath]),
    `claude plugin marketplace add ${sourcePath}`,
  );
}

/** Remove a registered marketplace by name. */
export async function marketplaceRemove(deps: PluginCliDeps, marketplace: string): Promise<void> {
  assertSafePluginName(marketplace, "marketplace");
  assertCliOk(
    await runClaude(deps, ["claude", "plugin", "marketplace", "remove", marketplace]),
    `claude plugin marketplace remove ${marketplace}`,
  );
}

/** Install (materialize) a plugin from a marketplace at the given scope. */
export async function installPlugin(
  deps: PluginCliDeps,
  plugin: string,
  marketplace: string,
  scope: PluginScope,
): Promise<void> {
  assertSafePluginName(plugin, "plugin");
  assertSafePluginName(marketplace, "marketplace");
  const key = pluginEnableKey(plugin, marketplace);
  assertCliOk(
    await runClaude(deps, ["claude", "plugin", "install", key, "--scope", scope]),
    `claude plugin install ${key} --scope ${scope}`,
  );
}

/** Enable an installed plugin (lifecycle wrapper). */
export async function enablePlugin(
  deps: PluginCliDeps,
  plugin: string,
  marketplace: string,
): Promise<void> {
  assertSafePluginName(plugin, "plugin");
  assertSafePluginName(marketplace, "marketplace");
  const key = pluginEnableKey(plugin, marketplace);
  assertCliOk(
    await runClaude(deps, ["claude", "plugin", "enable", key]),
    `claude plugin enable ${key}`,
  );
}

/** Disable an installed plugin (lifecycle wrapper). */
export async function disablePlugin(
  deps: PluginCliDeps,
  plugin: string,
  marketplace: string,
): Promise<void> {
  assertSafePluginName(plugin, "plugin");
  assertSafePluginName(marketplace, "marketplace");
  const key = pluginEnableKey(plugin, marketplace);
  assertCliOk(
    await runClaude(deps, ["claude", "plugin", "disable", key]),
    `claude plugin disable ${key}`,
  );
}

/**
 * Uninstall an installed plugin (lifecycle + removal wrapper). The scope is
 * REQUIRED: `claude plugin uninstall` defaults to `--scope user` (2.1.214
 * empirical, W4 live-run correction), so a project/local install must be
 * uninstalled at its own scope or the host refuses with "enabled at project
 * scope".
 */
export async function uninstallPlugin(
  deps: PluginCliDeps,
  plugin: string,
  marketplace: string,
  scope: PluginScope,
): Promise<void> {
  assertSafePluginName(plugin, "plugin");
  assertSafePluginName(marketplace, "marketplace");
  const key = pluginEnableKey(plugin, marketplace);
  assertCliOk(
    await runClaude(deps, ["claude", "plugin", "uninstall", key, "--scope", scope]),
    `claude plugin uninstall ${key} --scope ${scope}`,
  );
}

/** `claude plugin list --json`, parsed. Fails closed on a non-zero exit or unparseable JSON. */
export async function listPlugins(deps: PluginCliDeps): Promise<unknown> {
  const result = await runClaude(deps, ["claude", "plugin", "list", "--json"]);
  assertCliOk(result, "claude plugin list --json");
  return parseCliJson(result.stdout, "claude plugin list");
}

/**
 * `claude plugin details <plugin>@<marketplace>`, raw stdout TEXT.
 *
 * Empirically corrected (2.1.214): this CLI has NO `--json` flag — its
 * output is a human-readable component inventory (Skills/Agents/Hooks/MCP
 * servers/LSP servers with counts and names) plus a host-projected token-cost
 * line (`Always-on:   ~N tok`). Parse it with
 * `contextCostFromPluginDetailsText` in `./context-cost.js`. Fails closed
 * ONLY on a non-zero exit / spawn failure — there is no JSON to fail to parse.
 */
export async function pluginDetails(
  deps: PluginCliDeps,
  plugin: string,
  marketplace: string,
): Promise<string> {
  assertSafePluginName(plugin, "plugin");
  assertSafePluginName(marketplace, "marketplace");
  const key = pluginEnableKey(plugin, marketplace);
  const result = await runClaude(deps, ["claude", "plugin", "details", key]);
  assertCliOk(result, `claude plugin details ${key}`);
  return result.stdout;
}

function parseCliJson(stdout: string, describe: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ClaudePluginError(`${describe} returned unparseable JSON output`);
  }
}

// -- Bind ---------------------------------------------------------------------

export interface BindPluginRequest {
  /** The brand-protected disposition W2 minted for the exact source digest (D12). */
  disposition: ScanDisposition;
  /** The scanned checkout: `treePath` (bytes to register) + `treeDigest` (D7 anchor). */
  resolved: ResolvedGitSource;
  /** The plugin name to install. */
  plugin: string;
  /** The marketplace name to register the scanned checkout under. */
  marketplace: string;
  /** Enable scope; defaults to `project`. */
  scope?: PluginScope;
  /**
   * On a re-bind, the prior lock. When it already owns the `enabledPlugins` field,
   * its ORIGINAL pre-existing value is preserved instead of re-reading disk (which
   * would capture the prior bind's own value), so removal still restores the true
   * pre-AIH state.
   */
  previousLock?: BindingLock;
}

export interface BindPluginDeps {
  /** The project root the D18 `enabledPlugins` field is owned under. */
  root: string;
  /** The subprocess seam for the `claude plugin …` lifecycle. */
  runner: Runner;
  /** Environment (home-dir resolution for machine-scope targets + the cache locator). */
  env?: NodeJS.ProcessEnv;
  /** Injectable cache locator; defaults to {@link defaultPluginCacheLocator}. */
  locateCache?: PluginCacheLocator;
  /** Injectable apply seam for the settings plan; defaults to the real `executePlan`. */
  applyActions?: (root: string, actions: Action[]) => Promise<PlanResult>;
  /** Per-call CLI timeout override. */
  timeoutMs?: number;
}

export interface BindPluginResult {
  plugin: string;
  marketplace: string;
  /** The `<plugin>@<marketplace>` enable/cache key. */
  pluginKey: string;
  scope: PluginScope;
  /** The `.claude/settings*.json` surface the enable was written to. */
  settingsFile: string;
  /** The single D18 `enabledPlugins` write record. */
  writes: BindingWrite[];
  /** Sealed ownership: the `enabledPlugins` field + the two `home:` machine-scope entries. */
  ownership: BindingOwnershipEntry[];
  /** D7 fields for the lock (`match` is always `true` here — a mismatch throws). */
  identity: PluginIdentity;
  /** The scanned checkout registered as the marketplace source. */
  marketplaceSourcePath: string;
  /** The tree that was digested for D7 (the loaded cache). */
  loadedTreePath: string;
}

/**
 * Bind a plugin end to end: assert the scan authorization, register the scanned
 * checkout as the marketplace, install, verify D7 identity, and — only on a match
 * — apply the D18-owned `enabledPlugins` write and seal ownership. A digest
 * mismatch disables + uninstalls and throws {@link ClaudePluginIdentityError} with
 * no lock/ownership produced (fail closed, no partial state).
 */
export async function bindPlugin(
  request: BindPluginRequest,
  deps: BindPluginDeps,
): Promise<BindPluginResult> {
  const scope = request.scope ?? "project";
  const { disposition, resolved, plugin, marketplace } = request;

  // 1. D12: the service ASSERTS the gate authorized THIS exact digest — it never
  //    re-implements the scan policy. A forged, blocked, or stale token fails closed.
  assertProvisionAuthorized(disposition, resolved.treeDigest);

  // 2. Validate names at the boundary (safe-key + CLI/pointer atomicity).
  assertSafePluginName(plugin, "plugin");
  assertSafePluginName(marketplace, "marketplace");
  const pluginKey = pluginEnableKey(plugin, marketplace);
  const settingsFile = settingsFileForScope(scope);
  const home = claudeHomeDir(deps.env ?? {});
  const locate = deps.locateCache ?? defaultPluginCacheLocator;
  const cliDeps: PluginCliDeps = { runner: deps.runner, env: deps.env, timeoutMs: deps.timeoutMs };

  // 3. D7 anchor (empirically corrected): the plugin's own SOURCE SUBTREE, not
  //    the whole scanned checkout — computed BEFORE any CLI call, so a
  //    malformed marketplace.json / missing plugin entry / missing version
  //    fails closed with ZERO host mutation.
  const subtree = pluginSourceSubtreeDigest(resolved.treePath, plugin);

  // 3b. The host registers a marketplace under the MANIFEST's own name, never a
  //     registrar-chosen one (W4 live-run correction) — assert the adapter's
  //     pinned expectation matches before any host mutation.
  const manifestName = marketplaceManifestName(resolved.treePath);
  if (manifestName !== marketplace) {
    throw new ClaudePluginError(
      `refusing to bind ${plugin}: the checkout's marketplace manifest declares name ` +
        `${JSON.stringify(manifestName)} but the adapter expected ${JSON.stringify(marketplace)} — ` +
        `the host registers a marketplace under the manifest's name, so the pinned expectation must match`,
    );
  }

  // 4. Capture the D18 pre-existing `enabledPlugins` state BEFORE any CLI write —
  //    `jsonField` reads disk now — so the lock records the true pre-AIH state even
  //    though the CLI install also flips the same bit. The apply happens in step 8.
  const enablePointer = `/enabledPlugins/${pluginKey}`;
  const settingsPlan: ClaudeManagedPlan = new ClaudeManagedWriteEngine(deps.root)
    .jsonField(settingsFile, enablePointer, true)
    .build();
  carryForwardOwnership(settingsPlan, request.previousLock, `${settingsFile}#${enablePointer}`);

  // 5. Register the scanned checkout itself as the marketplace source (machine
  //    scope). Whether the name was ALREADY registered is captured first: a
  //    failed bind must only unwind a registration it created itself.
  const marketplacePreRegistered = marketplaceIsRegistered(home, marketplace);
  await marketplaceAdd(cliDeps, resolved.treePath);

  let identity: PluginIdentity;
  let loadedTreePath: string;
  try {
    // 6. Materialize the plugin into the host's loadable cache.
    await installPlugin(cliDeps, plugin, marketplace, scope);

    // 7. D7: locate the loaded subtree — PREFER the host's own authoritative
    //    `installPath` (via `claude plugin list --json`, still --json-capable),
    //    falling back to the locator (now version-aware) only on a list
    //    failure or an unparseable/absent entry — then compare to the SUBTREE
    //    digest computed in step 3.
    const locatorFallback = (): string =>
      locate({
        home,
        marketplace,
        plugin,
        pluginKey,
        marketplaceSourcePath: resolved.treePath,
        version: subtree.version,
      });
    try {
      const listPayload = await listPlugins(cliDeps);
      loadedTreePath = installPathFromPluginList(listPayload, pluginKey) ?? locatorFallback();
    } catch {
      loadedTreePath = locatorFallback();
    }
    identity = verifyPluginIdentity(subtree.digest, loadedTreePath);
    if (!identity.match) {
      // FAIL CLOSED: undo the install (best-effort disable + uninstall), write no lock.
      await cleanupFailedInstall(cliDeps, plugin, marketplace, scope);
      throw new ClaudePluginIdentityError(
        `refusing to bind plugin ${pluginKey}: the loaded tree digest ${identity.loadedDigest} does not match the scanned digest ${identity.scannedDigest} (D7 mismatch)`,
        identity,
      );
    }
  } catch (err) {
    // Machine-scope unwind (best-effort): a bind failing after step 5 must not
    // leave its own marketplace registration behind (W4 live-run correction).
    if (!marketplacePreRegistered) {
      try {
        await marketplaceRemove(cliDeps, marketplace);
      } catch {
        // best-effort — the original bind failure below is the error that matters
      }
    }
    throw err;
  }

  // 8. Apply the D18-owned `enabledPlugins` write and seal its post-apply digest.
  const apply = deps.applyActions ?? defaultApplyActions(deps);
  await apply(deps.root, settingsPlan.actions);
  const settingsOwnership = finalizeClaudeOwnership(deps.root, settingsPlan.ownership);

  // 9. Record the machine-scope effects as `home:` ownership the lock reconciles on removal.
  const homeOwnership = sealHomeOwnership({
    marketplace,
    plugin,
    pluginKey,
    marketplaceSourcePath: resolved.treePath,
    loadedDigest: identity.loadedDigest,
  });

  return {
    plugin,
    marketplace,
    pluginKey,
    scope,
    settingsFile,
    writes: settingsPlan.writes,
    ownership: [...settingsOwnership, ...homeOwnership],
    identity,
    marketplaceSourcePath: resolved.treePath,
    loadedTreePath,
  };
}

interface HomeOwnershipInputs {
  marketplace: string;
  plugin: string;
  pluginKey: string;
  marketplaceSourcePath: string;
  loadedDigest: string;
}

/**
 * Seal the two machine-scope ownership entries. Pre-existing is recorded as
 * absent — a fresh marketplace + cache (the user scope stays clean on this
 * VM). The marketplace entry's applied value mirrors the EXACT shape
 * `claude plugin marketplace add <dir>` writes at
 * `~/.claude/settings.json#/extraKnownMarketplaces/<name>` (empirically
 * verified on 2.1.214): `{source: {source: "directory", path: "<abs>"}}` —
 * the outer `source` is the settings field itself; the inner `{source,path}`
 * describes how the host was told to find it. The cache entry's applied
 * value + post-apply digest ARE the loaded (subtree) tree digest, so removal
 * can reconcile the cache conservatively against the very digest D7 matched.
 */
function sealHomeOwnership(inputs: HomeOwnershipInputs): BindingOwnershipEntry[] {
  const marketplaceApplied = {
    source: { source: "directory", path: inputs.marketplaceSourcePath },
  };
  return [
    {
      kind: "json-pointer",
      target: homeMarketplaceTarget(inputs.marketplace),
      preExisting: { absent: true },
      applied: marketplaceApplied,
      postApplyDigest: sha256Hex(canonicalJson(marketplaceApplied)),
    },
    {
      kind: "file",
      target: homePluginCacheTarget(inputs.marketplace, inputs.plugin),
      preExisting: { absent: true },
      applied: inputs.loadedDigest,
      postApplyDigest: inputs.loadedDigest,
    },
  ];
}

/** Best-effort teardown after a failed/mismatched install — never throws (the caller aborts). */
async function cleanupFailedInstall(
  deps: PluginCliDeps,
  plugin: string,
  marketplace: string,
  scope: PluginScope,
): Promise<void> {
  try {
    await disablePlugin(deps, plugin, marketplace);
  } catch {
    // Swallowed: cleanup is best-effort; the identity error is what surfaces.
  }
  try {
    await uninstallPlugin(deps, plugin, marketplace, scope);
  } catch {
    // Swallowed: cleanup is best-effort; the identity error is what surfaces.
  }
}

function defaultApplyActions(
  deps: BindPluginDeps,
): (root: string, actions: Action[]) => Promise<PlanResult> {
  const env = deps.env ?? {};
  const run = deps.runner;
  const host = makeHostAdapter({ platform: resolvePlatform(env), run, env });
  return (root, actions) =>
    executePlan(
      plan("claude-plugin-binding", ...actions),
      {
        root,
        contextDir: "ai-coding",
        apply: true,
        verify: false,
        json: false,
        run,
        host,
        env,
        options: {},
      },
      // A bind runs inside a user project whose worktree is legitimately dirty
      // (their own uncommitted work) — the repo-hygiene gate would make binding
      // unusable there. The write itself stays a targeted single-key merge with
      // pre-existing state captured at plan time.
      { skipWorktreeGate: true },
    );
}

// -- Remove -------------------------------------------------------------------

export interface RemovePluginRequest {
  /** The lock's ownership entries (the `home:` machine-scope ones are reconciled here). */
  ownership: readonly BindingOwnershipEntry[];
  plugin: string;
  marketplace: string;
  /** The scope the plugin was installed at — uninstall must name it (the CLI
   * defaults to user scope; W4 live-run correction). */
  scope: PluginScope;
}

export interface RemovePluginDeps {
  runner: Runner;
  env?: NodeJS.ProcessEnv;
  /** Injectable cache locator; defaults to {@link defaultPluginCacheLocator}. */
  locateCache?: PluginCacheLocator;
  timeoutMs?: number;
}

export interface RemovePluginResult {
  /** Machine-scope targets reconciled clean and torn down via the CLI. */
  removed: string[];
  /** Drifted machine-scope entries: preserved, never torn down, and reported. */
  drift: ClaudeDriftEntry[];
  /** The CLI teardown steps attempted (for the caller's report/telemetry). */
  cli: { describe: string; ok: boolean }[];
}

/**
 * Conservatively reconcile the MACHINE-SCOPE (`home:`) plugin ownership on removal,
 * exactly like the repo-relative reconciler: the loaded cache tree is the one
 * observable, digestible surface, so its current digest is the drift test.
 *  - cache tree absent            -> already gone; idempotent no-op;
 *  - cache digest == the recorded -> clean; tear down (uninstall + marketplace remove);
 *  - cache digest != the recorded -> user-modified; PRESERVE both + report drift.
 *
 * The repo-relative `enabledPlugins` field is reconciled by W3a's `planClaudeRemoval`
 * (a `home:` target reads as absent there, so those entries are inert no-ops); the
 * caller partitions ownership with {@link isHomeScopedTarget}. Machine state is
 * rebuildable, so a torn-down-then-absent surface is never an error.
 */
export async function removePlugin(
  request: RemovePluginRequest,
  deps: RemovePluginDeps,
): Promise<RemovePluginResult> {
  assertSafePluginName(request.plugin, "plugin");
  assertSafePluginName(request.marketplace, "marketplace");
  const pluginKey = pluginEnableKey(request.plugin, request.marketplace);
  const home = claudeHomeDir(deps.env ?? {});
  const locate = deps.locateCache ?? defaultPluginCacheLocator;
  const cliDeps: PluginCliDeps = { runner: deps.runner, env: deps.env, timeoutMs: deps.timeoutMs };

  const cacheEntry = request.ownership.find(
    (entry) => entry.target === homePluginCacheTarget(request.marketplace, request.plugin),
  );
  const marketplaceEntry = request.ownership.find(
    (entry) => entry.target === homeMarketplaceTarget(request.marketplace),
  );

  const removed: string[] = [];
  const drift: ClaudeDriftEntry[] = [];
  const cli: RemovePluginResult["cli"] = [];

  if (cacheEntry === undefined) {
    // Nothing machine-scope recorded — nothing to reconcile.
    return { removed, drift, cli };
  }

  const loadedTreePath = locate({
    home,
    marketplace: request.marketplace,
    plugin: request.plugin,
    pluginKey,
    marketplaceSourcePath: readMarketplaceSource(marketplaceEntry),
  });
  const state = cacheDriftState(loadedTreePath, cacheEntry.postApplyDigest);

  if (state.kind === "absent") {
    // Idempotent: the host already removed the cache — nothing to tear down.
    return { removed, drift, cli };
  }
  if (state.kind === "drifted" || state.kind === "unreadable") {
    // Preserve BOTH entries + report drift. A tree we cannot prove is gone
    // (drifted) or cannot read (unreadable) is NEVER torn down — that is the
    // conservative-removal invariant (fail closed, never fail open on error).
    const cacheReason =
      state.kind === "unreadable"
        ? `plugin cache unreadable — preserved: ${state.detail}`
        : "materialized plugin cache modified since bind";
    const marketplaceReason =
      state.kind === "unreadable"
        ? "preserved: its plugin cache is unreadable"
        : "preserved: its plugin cache drifted since bind";
    drift.push({ kind: cacheEntry.kind, target: cacheEntry.target, reason: cacheReason });
    if (marketplaceEntry !== undefined) {
      drift.push({
        kind: marketplaceEntry.kind,
        target: marketplaceEntry.target,
        reason: marketplaceReason,
      });
    }
    return { removed, drift, cli };
  }

  // Clean: tear the plugin and its marketplace down (best-effort, idempotent).
  cli.push(
    await bestEffortCli(
      () => uninstallPlugin(cliDeps, request.plugin, request.marketplace, request.scope),
      `claude plugin uninstall ${pluginKey} --scope ${request.scope}`,
    ),
  );
  // 2.1.214 empirical (W4 live rehearsal): a project-scope uninstall
  // deregisters the plugin but leaves the materialized cache bytes on disk.
  // The digest check above proved this tree is EXACTLY the recorded surface,
  // so deleting the owned cache root directly is the same recorded-surface
  // teardown the Lean installer path performs — this line is never reached on
  // drift or unreadable state.
  rmSync(join(home, ...cacheEntry.target.slice(HOME_OWNERSHIP_PREFIX.length).split("/")), {
    recursive: true,
    force: true,
  });
  removed.push(cacheEntry.target);
  if (marketplaceEntry !== undefined) {
    cli.push(
      await bestEffortCli(
        () => marketplaceRemove(cliDeps, request.marketplace),
        `claude plugin marketplace remove ${request.marketplace}`,
      ),
    );
    removed.push(marketplaceEntry.target);
  }
  return { removed, drift, cli };
}

/**
 * Read the checkout path back out of a sealed marketplace ownership entry's
 * `applied` value — empirically corrected shape:
 * `{source: {source: "directory", path: "<abs>"}}` (see {@link sealHomeOwnership}).
 */
function readMarketplaceSource(entry: BindingOwnershipEntry | undefined): string {
  const applied = entry?.applied;
  if (typeof applied !== "object" || applied === null) return "";
  const source = (applied as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return "";
  const path = (source as { path?: unknown }).path;
  return typeof path === "string" ? path : "";
}

type CacheReconcileState =
  | { kind: "absent" }
  | { kind: "clean" }
  | { kind: "drifted" }
  | { kind: "unreadable"; detail: string };

/**
 * Classify the recorded cache tree for removal. ONLY a genuinely missing tree
 * ({@link ClaudePluginCacheMissingError}) is the idempotent "already gone" case;
 * every other failure — empty, unreadable, digest error — is fail-closed
 * `unreadable`: the tree may still exist and still be loadable, so removal
 * PRESERVES it and reports drift rather than silently dropping the lock entry.
 */
function cacheDriftState(loadedTreePath: string, recordedDigest: string): CacheReconcileState {
  let loadedDigest: string;
  try {
    // Digest the loaded tree with the SAME routine bind matched against.
    loadedDigest = hashLoadedPluginTree(loadedTreePath);
  } catch (err) {
    if (err instanceof ClaudePluginCacheMissingError) {
      return { kind: "absent" };
    }
    return { kind: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  return loadedDigest === recordedDigest ? { kind: "clean" } : { kind: "drifted" };
}

async function bestEffortCli(
  action: () => Promise<void>,
  describe: string,
): Promise<{ describe: string; ok: boolean }> {
  try {
    await action();
    return { describe, ok: true };
  } catch {
    return { describe, ok: false };
  }
}
