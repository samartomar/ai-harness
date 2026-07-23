import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AihError } from "../../errors.js";
import { executePlan, type PlanResult } from "../../internals/execute.js";
import { type Action, plan as planActions } from "../../internals/plan.js";
import type { Runner } from "../../internals/proc.js";
import { makeHostAdapter, resolvePlatform } from "../../platform/detect.js";
import {
  assertPlanAllowed,
  assertProvisionAllowed,
  type BindingContext,
  type BindingPlan,
  type BindingReport,
  type FrameworkAdapter,
  type InspectReport,
  type InspectRequest,
  type ProvisionRequest,
  type ProvisionResult,
  type ResolveRequest,
  type VerifyResult,
} from "../adapter.js";
import {
  buildFrameworkCard,
  type ContextCostCard,
  contextCostCard,
  contextCostUnavailable,
  d18SurfaceLabels,
  type FrameworkCardCounts,
  renderFrameworkCard,
  sourceIdentityFromLock,
} from "../card.js";
import { assertKnownFeatureKeys } from "../features.js";
import {
  bindPlugin,
  type ClaudeDriftEntry,
  type ClaudeManagedPlan,
  ClaudeManagedWriteEngine,
  type ClaudeOwnershipIntent,
  carryForwardOwnership,
  claudeHomeDir,
  defaultPluginCacheLocator,
  estimateContextCostFromTree,
  finalizeClaudeOwnership,
  homeMarketplaceTarget,
  homePluginCacheTarget,
  isHomeScopedTarget,
  type PluginCacheLocator,
  type PluginScope,
  planClaudeRemoval,
  pluginEnableKey,
  settingsFileForScope,
  verifyPluginIdentity,
} from "../hosts/claude/index.js";
import { canonicalJson, sha256Hex } from "../hosts/claude/surfaces.js";
import {
  type BindingLock,
  type BindingOwnershipEntry,
  planBindingRemoval,
  readBindingLock,
  writeBindingLockAtomic,
} from "../lock.js";
import {
  bindingCacheHome,
  type ResolvedGitSource,
  type ResolvedSource,
  resolveGitSource,
  type ScanDisposition,
} from "../scan-gate.js";
import type { BindingDeclaration, BindingGitSource } from "../schema.js";

/**
 * The Superpowers `FrameworkAdapter` (W4a) — the FIRST real D6 adapter,
 * `adapterType: "host-plugin"`. It composes the W3 Claude host services
 * (`bindPlugin`/`removePlugin`, the D18 managed-write engine, D7 plugin
 * identity, conservative removal) rather than re-implementing any of them;
 * this module is the ORCHESTRATION layer that decides what gets bound, in
 * what order, and how the extra (non-`bindPlugin`) telemetry field is owned
 * in the same lock.
 *
 * Locked decisions (orchestrator-pinned; do not re-derive or override):
 *  - source: repository {@link SUPERPOWERS_REPOSITORY} at the exact commit
 *    {@link SUPERPOWERS_PIN_COMMIT} (mirrors the maintainer-locked pin in
 *    `src/internals/baseline-sources.ts`'s "obra"/"Superpowers" entry — see
 *    the constant's own doc comment for why it is mirrored, not imported);
 *  - plugin name {@link SUPERPOWERS_PLUGIN_NAME}, marketplace name
 *    {@link SUPERPOWERS_MARKETPLACE_NAME} (AIH registers the scanned
 *    checkout as this marketplace, per the W3b mechanism);
 *  - telemetry disable is MANDATORY at bind time: `env.SUPERPOWERS_DISABLE_TELEMETRY`
 *    is a SECOND D18-owned field in `.claude/settings.json`, applied and
 *    reconciled in the exact same lock as `enabledPlugins` — `bindPlugin`
 *    does not know about it, so this adapter owns it directly through its
 *    own {@link ClaudeManagedWriteEngine} call;
 *  - superpowers declares NO feature flags — `plan` calls
 *    {@link assertKnownFeatureKeys} with an empty known-key list, so any
 *    declared key fails closed.
 *
 * D6 method mapping:
 *  - `inspect`: cheap static notes over a tree path (no network, no CLI).
 *  - `resolve`: delegates to `resolveGitSource` with the declaration's git
 *    source (exact commitSha input, skipping the ref round-trip).
 *  - `plan`: PURE preview (D8 + feature-key checks, then a writes/ownership
 *    preview mirroring what `bindPlugin` + the telemetry field will record —
 *    no write ever lands on disk from `plan`).
 *  - `provision`: `bindPlugin` (marketplace add -> install -> D7 verify ->
 *    `enabledPlugins`) THEN the telemetry field THEN the assembled
 *    `BindingLock` is written atomically. A D7 mismatch inside `bindPlugin`
 *    throws before the telemetry field or the lock are ever touched (no
 *    partial state).
 *  - `verify`: reads the lock; reuses `planClaudeRemoval`'s drift computation
 *    READ-ONLY (its `.actions` are never applied here) for the repo-relative
 *    fields, plus an independent D7 re-check of the loaded plugin cache tree.
 *  - `remove`: STAYS SYNCHRONOUS (the D6 contract) — it only PLANS the
 *    teardown (partition ownership with `isHomeScopedTarget`, `planClaudeRemoval`
 *    over the repo-relative subset). See {@link SuperpowersRemoveResult} for
 *    exactly how a caller applies an "apply"-mode result.
 *  - `report`: Framework Card input lines (framework, pin, D7 identity from
 *    the lock, D18-owned + machine-scope surfaces, a labeled context-cost
 *    estimate over the resolved checkout when its path is still recorded,
 *    and the mandatory telemetry-disabled line).
 */

/** Adapter-local fail-closed error: wrong framework routed here, or a non-git source/resolution. */
export class SuperpowersBindingError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_SUPERPOWERS");
  }
}

/**
 * obra/superpowers pin — the maintainer-locked commit this binding is pinned
 * to. MIRRORS (deliberately does not import) the "obra"/"Superpowers" entry
 * in `src/internals/baseline-sources.ts` — also reachable via
 * `baselineCatalogById("superpowers").pinnedSha` in
 * `src/baseline-evidence/catalogs.ts`, as consumed by `src/superpowers/verified.ts`.
 * Mirrored rather than imported for two reasons: (1) importing would pull the
 * whole ECC/Superpowers baseline-evidence catalog module (JSON component
 * manifests and all) into the binding path just to read one string; (2) the
 * binding pin is a DELIBERATE, independently-reviewed value — if the shared
 * baseline pin ever moves, this constant must be updated explicitly in the
 * same review, never silently follow. Do not set this to a different commit.
 */
export const SUPERPOWERS_PIN_COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";

/**
 * The Superpowers adapter version (W7 §C.2) — bumped when this adapter's
 * provisioning / qualification logic changes. It is one of the fields keyed into the
 * runtime-qualification cache (`scan-cache-tiers.ts` `runtimeQualKey`), so a bump
 * re-keys every prior host qualification (a cache miss / recompute), never a served
 * stale one. Registered alongside the factory in `registry.ts` (`ADAPTER_VERSIONS`).
 */
export const ADAPTER_VERSION = 1 as const;

/** The pinned git source location (`owner/repo` shape; see `isPlausibleGitRepository`). */
export const SUPERPOWERS_REPOSITORY = "obra/superpowers";

/** The plugin name AIH installs. */
export const SUPERPOWERS_PLUGIN_NAME = "superpowers";

/** The marketplace name the PINNED checkout's own manifest declares. The claude
 * host registers a marketplace under the manifest's name — never a
 * registrar-chosen one — so this mirrors the manifest at
 * {@link SUPERPOWERS_PIN_COMMIT}; `bindPlugin` asserts the match before any
 * host mutation (W4 live-run correction). */
export const SUPERPOWERS_MARKETPLACE_NAME = "superpowers-dev";

/** Superpowers carries no scope feature flag — always bound at project scope. */
const SUPERPOWERS_SCOPE: PluginScope = "project";

/** D-locked: telemetry disable is mandatory at bind time (a second D18-owned field). */
const TELEMETRY_ENV_POINTER = "/env/SUPERPOWERS_DISABLE_TELEMETRY";
const TELEMETRY_ENV_VALUE = "1";

export interface SuperpowersAdapterDeps {
  /** Project root the D18 fields (`enabledPlugins`, the telemetry env field) are owned under. */
  root: string;
  /** The subprocess seam for the `claude plugin …` lifecycle — a fake in tests. */
  runner: Runner;
  /** Environment (home-dir resolution for machine-scope targets). Defaults to `{}`. */
  env?: NodeJS.ProcessEnv;
  /** Git checkout cache root for `resolve()`. Defaults to `bindingCacheHome(env)`. */
  cacheHome?: string;
  /** Injectable plugin-cache locator; defaults to {@link defaultPluginCacheLocator}. */
  locateCache?: PluginCacheLocator;
  /** Injectable apply seam for repo-relative writes; defaults to a real `executePlan` wrapper. */
  applyActions?: (root: string, actions: Action[]) => Promise<PlanResult>;
  /** Per-call `claude` CLI timeout override. */
  timeoutMs?: number;
}

/**
 * `remove()` stays SYNCHRONOUS (the D6 `FrameworkAdapter.remove` contract), so
 * it can only PLAN the teardown — actually tearing it down means awaiting
 * `claude plugin …` calls, which a synchronous method cannot do. The caller
 * (a future CLI layer, or a test) applies an "apply"-mode result in EXACTLY
 * this order — REPO-RELATIVE FIRST, then machine-scope:
 *
 *  1. repo-relative restore: `executePlan(plan("...", ...repoRelativeActions), ctx)`
 *     — this is what PRUNES/RESTORES the project's `enabledPlugins` entry, i.e.
 *     disables the plugin at project scope;
 *  2. machine-scope teardown: `removePlugin({ownership: homeOwnership, plugin, marketplace}, deps)`
 *     — this is what runs `claude plugin uninstall`.
 *
 * This order is a HARD HOST CONSTRAINT, not a style preference (empirically
 * verified on 2.1.214): `claude plugin uninstall` REFUSES while the plugin is
 * still enabled at project scope. Reversing the two steps would make removal
 * fail on a real host every time.
 *
 * Then, exactly like the W3 roundtrip precedent (`tests/binding/hosts/claude/roundtrip.test.ts`),
 * the caller deletes the binding lock itself — that is not this plan's or
 * `planClaudeRemoval`'s/`removePlugin`'s job. `"drift-report-only"` mode
 * mirrors {@link BindingRemovalPlan}: nothing to apply; `reason` explains why.
 */
export type SuperpowersRemoveResult =
  | { mode: "drift-report-only"; reason: string }
  | {
      mode: "apply";
      repoRelativeActions: Action[];
      repoRelativeDrift: ClaudeDriftEntry[];
      homeOwnership: BindingOwnershipEntry[];
      plugin: string;
      marketplace: string;
      scope: PluginScope;
    };

function assertSuperpowersDeclaration(declaration: BindingDeclaration): void {
  if (declaration.framework.id !== "superpowers") {
    throw new SuperpowersBindingError(
      `superpowers adapter invoked for framework "${declaration.framework.id}"`,
    );
  }
}

function assertGitSource(source: BindingDeclaration["source"]): BindingGitSource {
  if (source.kind !== "git") {
    throw new SuperpowersBindingError(`superpowers requires a git source; got "${source.kind}"`);
  }
  return source;
}

function assertGitResolved(resolved: ResolvedSource): ResolvedGitSource {
  if (resolved.kind !== "git") {
    throw new SuperpowersBindingError(
      `superpowers requires a resolved git source; got "${resolved.kind}"`,
    );
  }
  return resolved;
}

// -- inspect ------------------------------------------------------------------

function inspectSuperpowersTree(request: InspectRequest): InspectReport {
  const notes: string[] = [];
  const hasManifest = [".claude-plugin", "package.json"].some((rel) =>
    existsSync(join(request.treePath, rel)),
  );
  notes.push(
    hasManifest
      ? "plugin manifest present (.claude-plugin or package.json)"
      : "no plugin manifest found (.claude-plugin or package.json)",
  );

  const skillsDir = join(request.treePath, "skills");
  let skillCount = 0;
  try {
    if (existsSync(skillsDir)) {
      skillCount = readdirSync(skillsDir).filter((name) =>
        existsSync(join(skillsDir, name, "SKILL.md")),
      ).length;
    }
  } catch {
    skillCount = 0;
  }
  notes.push(
    skillCount > 0
      ? `${skillCount} skill(s) found under skills/`
      : "no skills/ directory with SKILL.md files found",
  );

  return { framework: "superpowers", treePath: request.treePath, notes };
}

// -- plan (pure preview) -------------------------------------------------------

/** Predict the post-apply digest a real write would seal, without applying anything. */
function previewOwnership(intents: readonly ClaudeOwnershipIntent[]): BindingOwnershipEntry[] {
  return intents.map((intent) => ({
    kind: intent.kind,
    target: intent.target,
    preExisting: intent.preExisting,
    applied: intent.applied,
    postApplyDigest: sha256Hex(canonicalJson(intent.applied)),
  }));
}

/**
 * Preview the two machine-scope (`home:`) entries `bindPlugin` will record.
 * The exact local checkout path isn't knowable without I/O (a git resolve),
 * so the marketplace preview stands in the declared repository (nested under
 * the empirically-verified `{source: {source: "directory", path}}` shape
 * `claude plugin marketplace add` actually writes — see
 * `hosts/claude/plugins.ts`'s `sealHomeOwnership`); the cache preview uses
 * the declared `treeDigest` directly — the exact value a successful bind
 * MUST produce there (D7 requires the match).
 */
function previewHomeOwnership(source: BindingGitSource): BindingOwnershipEntry[] {
  const marketplaceApplied = { source: { source: "directory", path: source.repository } };
  return [
    {
      kind: "json-pointer",
      target: homeMarketplaceTarget(SUPERPOWERS_MARKETPLACE_NAME),
      preExisting: { absent: true },
      applied: marketplaceApplied,
      postApplyDigest: sha256Hex(canonicalJson(marketplaceApplied)),
    },
    {
      kind: "file",
      target: homePluginCacheTarget(SUPERPOWERS_MARKETPLACE_NAME, SUPERPOWERS_PLUGIN_NAME),
      preExisting: { absent: true },
      applied: source.treeDigest,
      postApplyDigest: source.treeDigest,
    },
  ];
}

function buildSuperpowersPlanPreview(root: string, source: BindingGitSource): BindingPlan {
  const settingsFile = settingsFileForScope(SUPERPOWERS_SCOPE);
  const pluginKey = pluginEnableKey(SUPERPOWERS_PLUGIN_NAME, SUPERPOWERS_MARKETPLACE_NAME);
  const built = new ClaudeManagedWriteEngine(root)
    .jsonField(settingsFile, `/enabledPlugins/${pluginKey}`, true)
    .jsonField(settingsFile, TELEMETRY_ENV_POINTER, TELEMETRY_ENV_VALUE)
    .build();
  return {
    framework: "superpowers",
    writes: built.writes,
    ownership: [...previewOwnership(built.ownership), ...previewHomeOwnership(source)],
  };
}

// -- provision helpers ----------------------------------------------------------

/**
 * Read the checkout path back out of a sealed marketplace ownership entry's
 * `applied` value — empirically corrected nested shape:
 * `{source: {source: "directory", path: "<abs>"}}` (mirrors
 * `hosts/claude/plugins.ts`'s `sealHomeOwnership`/`readMarketplaceSource`).
 */
function marketplaceSourceFrom(entry: BindingOwnershipEntry | undefined): string {
  const applied = entry?.applied;
  if (typeof applied !== "object" || applied === null) return "";
  const source = (applied as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return "";
  const path = (source as { path?: unknown }).path;
  return typeof path === "string" ? path : "";
}

/**
 * Default repo-relative apply seam: the same recipe as `hosts/claude/plugins.ts`'s
 * private `defaultApplyActions` (worktree gate skipped — a bind runs inside a
 * user project whose tree is legitimately dirty with the user's own work).
 */
function defaultApplyActions(
  deps: SuperpowersAdapterDeps,
): (root: string, actions: Action[]) => Promise<PlanResult> {
  const env = deps.env ?? {};
  const run = deps.runner;
  const host = makeHostAdapter({ platform: resolvePlatform(env), run, env });
  return (root, actions) =>
    executePlan(
      planActions("superpowers-binding", ...actions),
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
      { skipWorktreeGate: true },
    );
}

// -- verify ---------------------------------------------------------------------

function verifySuperpowers(deps: SuperpowersAdapterDeps): VerifyResult {
  const read = readBindingLock(deps.root);
  if (!read.present) return { ok: false, drift: ["no binding lock"] };
  const lock = read.lock;
  const drift: string[] = [];

  // Repo-relative fields (enabledPlugins + the telemetry env field): reuse
  // planClaudeRemoval's drift computation READ-ONLY — its `.actions` are
  // never applied here, only `.drift` is read.
  const removal = planClaudeRemoval(deps.root, lock);
  for (const entry of removal.drift) drift.push(`${entry.target}: ${entry.reason}`);

  // Machine-scope: an independent D7 re-check of the loaded plugin cache tree.
  let identityOk = true;
  try {
    const pluginKey = pluginEnableKey(SUPERPOWERS_PLUGIN_NAME, SUPERPOWERS_MARKETPLACE_NAME);
    const marketplaceEntry = lock.ownership.find(
      (entry) => entry.target === homeMarketplaceTarget(SUPERPOWERS_MARKETPLACE_NAME),
    );
    const locate = deps.locateCache ?? defaultPluginCacheLocator;
    const loadedTreePath = locate({
      home: claudeHomeDir(deps.env ?? {}),
      marketplace: SUPERPOWERS_MARKETPLACE_NAME,
      plugin: SUPERPOWERS_PLUGIN_NAME,
      pluginKey,
      marketplaceSourcePath: marketplaceSourceFrom(marketplaceEntry),
    });
    const identity = verifyPluginIdentity(lock.scannedDigest, loadedTreePath);
    identityOk = identity.match;
    if (!identity.match) {
      drift.push(
        `plugin cache identity mismatch: loaded ${identity.loadedDigest} != scanned ${lock.scannedDigest}`,
      );
    }
  } catch (err) {
    identityOk = false;
    drift.push(
      `plugin cache identity re-check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { ok: drift.length === 0 && identityOk, drift };
}

// -- remove -----------------------------------------------------------------

function removeSuperpowers(deps: SuperpowersAdapterDeps): SuperpowersRemoveResult {
  const removalPlan = planBindingRemoval(deps.root);
  if (removalPlan.mode === "drift-report-only") {
    return { mode: "drift-report-only", reason: removalPlan.reason };
  }
  const lock = removalPlan.lock;
  const homeOwnership = lock.ownership.filter((entry) => isHomeScopedTarget(entry.target));
  const repoRelativeOwnership = lock.ownership.filter((entry) => !isHomeScopedTarget(entry.target));
  const repoRelative = planClaudeRemoval(deps.root, { ...lock, ownership: repoRelativeOwnership });
  return {
    mode: "apply",
    repoRelativeActions: repoRelative.actions,
    repoRelativeDrift: repoRelative.drift,
    homeOwnership,
    plugin: SUPERPOWERS_PLUGIN_NAME,
    marketplace: SUPERPOWERS_MARKETPLACE_NAME,
    scope: SUPERPOWERS_SCOPE,
  };
}

// -- report -------------------------------------------------------------------

function reportSuperpowers(deps: SuperpowersAdapterDeps, context: BindingContext): BindingReport {
  const source = context.declaration.source;
  const read = readBindingLock(deps.root);

  if (!read.present) {
    const card = buildFrameworkCard({
      framework: "superpowers",
      scope: "project",
      targetLabel: "DEFERRED",
      source,
      installMechanism: "host-plugin (project-scope Claude plugin)",
      telemetry: "disabled",
      enterpriseDisposition: "not yet provisioned",
    });
    return { framework: "superpowers", card, lines: renderFrameworkCard(card) };
  }

  const lock = read.lock;
  const { identity } = sourceIdentityFromLock(lock);
  const { repoRelative, homeScope } = d18SurfaceLabels(lock);

  // context-cost: estimated from the materialized marketplace source subtree. A
  // missing/unestimable tree reports unavailable with a PATH-FREE reason (the raw
  // estimator error may embed an absolute path, which the committed card forbids).
  const marketplaceEntry = lock.ownership.find(
    (entry) => entry.target === homeMarketplaceTarget(SUPERPOWERS_MARKETPLACE_NAME),
  );
  const treePath = marketplaceSourceFrom(marketplaceEntry);
  let contextCost: ContextCostCard;
  let counts: FrameworkCardCounts | undefined;
  if (treePath.length > 0) {
    try {
      const fragment = contextCostCard(estimateContextCostFromTree(treePath));
      contextCost = fragment.contextCost;
      counts = fragment.counts;
    } catch {
      contextCost = contextCostUnavailable("resolved checkout tree not estimable");
    }
  } else {
    contextCost = contextCostUnavailable("resolved checkout path not recorded");
  }

  const card = buildFrameworkCard({
    framework: "superpowers",
    scope: "project",
    targetLabel: "STRICT_PROJECT_BINDING_VERIFIED",
    source,
    identity,
    installMechanism: "host-plugin (project-scope Claude plugin)",
    telemetry: "disabled",
    scriptsBinariesDeps: [...repoRelative, ...homeScope],
    contextCost,
    counts,
    enterpriseDisposition: "project-scope host-plugin; telemetry disabled",
  });
  return { framework: "superpowers", card, lines: renderFrameworkCard(card) };
}

// -- factory --------------------------------------------------------------------

export function createSuperpowersAdapter(deps: SuperpowersAdapterDeps): FrameworkAdapter {
  const apply = deps.applyActions ?? defaultApplyActions(deps);

  return {
    framework: "superpowers",
    adapterType: "host-plugin",

    inspect(request: InspectRequest): InspectReport {
      return inspectSuperpowersTree(request);
    },

    async resolve(request: ResolveRequest): Promise<ResolvedSource> {
      assertSuperpowersDeclaration(request.declaration);
      const source = assertGitSource(request.declaration.source);
      return resolveGitSource(
        { repository: source.repository, commitSha: source.commitSha },
        { runner: deps.runner, cacheHome: deps.cacheHome ?? bindingCacheHome(deps.env ?? {}) },
      );
    },

    plan(context: BindingContext): BindingPlan {
      assertSuperpowersDeclaration(context.declaration);
      assertPlanAllowed(context);
      assertKnownFeatureKeys(context.declaration.framework.features, [], "superpowers");
      const source = assertGitSource(context.declaration.source);
      return buildSuperpowersPlanPreview(deps.root, source);
    },

    async provision(
      request: ProvisionRequest,
      disposition: ScanDisposition,
    ): Promise<ProvisionResult> {
      assertSuperpowersDeclaration(request.context.declaration);
      // Defense in depth (D8 layer 3 + D12) — the registry dispatch already
      // guards this, but a bare (non-registry) call must still be safe.
      assertProvisionAllowed(request, disposition);
      const resolved = assertGitResolved(request.resolved);

      const priorRead = readBindingLock(deps.root);
      const previousLock = priorRead.present ? priorRead.lock : undefined;

      const bound = await bindPlugin(
        {
          disposition,
          resolved,
          plugin: SUPERPOWERS_PLUGIN_NAME,
          marketplace: SUPERPOWERS_MARKETPLACE_NAME,
          scope: SUPERPOWERS_SCOPE,
          previousLock,
        },
        {
          root: deps.root,
          runner: deps.runner,
          env: deps.env,
          locateCache: deps.locateCache,
          applyActions: apply,
          timeoutMs: deps.timeoutMs,
        },
      );

      // The telemetry field is NOT part of bindPlugin — own it directly here,
      // as one more D18 field in the SAME lock (D-locked: mandatory at bind time).
      const telemetryTarget = `${bound.settingsFile}#${TELEMETRY_ENV_POINTER}`;
      const telemetryPlan: ClaudeManagedPlan = new ClaudeManagedWriteEngine(deps.root)
        .jsonField(bound.settingsFile, TELEMETRY_ENV_POINTER, TELEMETRY_ENV_VALUE)
        .build();
      carryForwardOwnership(telemetryPlan, previousLock, telemetryTarget);
      await apply(deps.root, telemetryPlan.actions);
      const telemetryOwnership = finalizeClaudeOwnership(deps.root, telemetryPlan.ownership);

      const lock: BindingLock = {
        schemaVersion: 1,
        declaration: request.context.declaration,
        writes: [...bound.writes, ...telemetryPlan.writes],
        scannedDigest: bound.identity.scannedDigest,
        loadedDigest: bound.identity.loadedDigest,
        match: bound.identity.match,
        ownership: [...bound.ownership, ...telemetryOwnership],
      };
      writeBindingLockAtomic(deps.root, lock);
      return { lock };
    },

    verify(_context: BindingContext): VerifyResult {
      return verifySuperpowers(deps);
    },

    remove(_context: BindingContext) {
      return removeSuperpowers(deps);
    },

    report(context: BindingContext): BindingReport {
      return reportSuperpowers(deps, context);
    },
  };
}
