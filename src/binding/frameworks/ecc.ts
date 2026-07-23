import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  findAcceptanceDecision,
  readAcceptanceDecisions,
} from "../../baseline-evidence/acceptance.js";
import { baselineCatalogById } from "../../baseline-evidence/catalogs.js";
import type { EccMcpComponentId } from "../../ecc/components.js";
import {
  type EccInstallPreviewArtifact,
  parseEccInstallPreview,
  readEccInstallPreview,
} from "../../ecc/install-preview.js";
import { selectedEccMcpServers } from "../../ecc/mcp.js";
import { AihError } from "../../errors.js";
import { executePlan, type PlanResult } from "../../internals/execute.js";
import { readRegularFileWithStats } from "../../internals/fsxn.js";
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
  type SharedStateEntry,
  type SupportLabel,
  sourceIdentityFromLock,
} from "../card.js";
import { assertKnownFeatureKeys } from "../features.js";
import {
  bindPlugin,
  type ClaudeDriftEntry,
  type ClaudeManagedPlan,
  ClaudeManagedWriteEngine,
  type ClaudeOwnershipIntent,
  claudeHomeDir,
  defaultPluginCacheLocator,
  estimateContextCostFromTree,
  finalizeClaudeOwnership,
  HOME_OWNERSHIP_PREFIX,
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
import {
  CLAUDE_MCP_KEY,
  CLAUDE_MCP_PATH,
  canonicalJson,
  sha256Hex,
} from "../hosts/claude/surfaces.js";
import {
  type BindingLock,
  type BindingOwnershipEntry,
  type BindingWrite,
  planBindingRemoval,
  readBindingLock,
  writeBindingLockAtomic,
} from "../lock.js";
import {
  assertResolvedMatchesDeclaration,
  bindingCacheHome,
  type ResolvedGitSource,
  type ResolvedSource,
  resolveGitSource,
  type ScanDisposition,
} from "../scan-gate.js";
import type { BindingDeclaration, BindingGitSource } from "../schema.js";

/**
 * The ECC **Lean** `FrameworkAdapter` (W4b) — the FIRST D6
 * `adapterType: "upstream-local-installer"`. It is the BINDING orchestration
 * layer around ECC's own selective installer: it does NOT re-implement any ECC
 * install machinery (D9 — the upstream installer is INVOKED, never reimplemented),
 * it drives the installer through an injected seam and records BINDING state in
 * the W2 lock. W4c adds the ECC **Full** variant to THIS file (below the `== ECC
 * Full ==` banners): explicit opt-in (`mode: "full"`), the PROJECT-SCOPE PLUGIN
 * path — Full keeps the file's declared `adapterType` but internally composes the
 * SAME W3 host services `superpowers.ts` uses (`bindPlugin` marketplace/install +
 * D7 subtree identity), adds the two mandatory D18 project-scoped state-root env
 * fields, owns each individually-selected `mcp:<connector>` in `.mcp.json`, and
 * feeds a static state-write inventory into the strict/lax LABEL DECISION. The
 * mode switch on `declaration.framework.mode` ({@link eccMode}) routes lean/full,
 * and {@link assertModeMatchesExistingLock} keeps the two mutually exclusive.
 *
 * D10 (the locked binding ruling this implements EXACTLY):
 * ECC's upstream `minimal` profile is NOT Lean — minimal ships `workflow-quality`
 * (`baseline:workflow`, which bundles `continuous-learning`/`continuous-learning-v2`
 * and `browser-qa`) and all-language stack coverage. ECC Lean (the default mode,
 * `mode: "lean"` or absent) is an EXACT COMPONENT ALLOWLIST executed through ECC's
 * OWN selective installer against the pinned commit:
 *  - ALLOWED: common rules, planning, TDD, debugging, review, security review,
 *    verification ({@link ECC_LEAN_ALLOWLIST}).
 *  - EXPLICITLY EXCLUDED: `hooks-runtime` (`baseline:hooks`), `continuous-learning`
 *    (`skill:continuous-learning`), `continuous-learning-v2` (bundled in
 *    `baseline:workflow`), MCP (`mcp:*`), browser/runtime automation
 *    (`capability:*`, `browser-qa`), auto-update (`baseline:commands`/
 *    `baseline:platform`), and unrelated language/framework skills
 *    ({@link ECC_LEAN_EXCLUDED}).
 *  - `provision` runs the upstream PREVIEW/PLAN from the exact scanned commit (the
 *    pin-bound {@link EccInstallPreviewArtifact}) and DIFFS its output against the
 *    allowlist BEFORE applying; ANY mismatch (an extra runtime surface an
 *    allowlisted component would install, or an allowlisted component the preview
 *    cannot deliver) FAILS THE BIND with {@link EccLeanAllowlistError} — nothing
 *    applied, the installer seam is never called.
 *  - Post-install verification checks the ABSENCE of runtime surfaces: no hooks
 *    entries, no MCP servers, no writes under `~/.claude/skills/learned`.
 *
 * How the existing `src/ecc` seams are composed (READ-only reuse, no duplication):
 *  - the PREVIEW is the shipped, catalog-pin-bound `ecc-install-preview.json`
 *    (`readEccInstallPreview`/`parseEccInstallPreview` from `src/ecc/install-preview.ts`)
 *    — that artifact IS ECC's upstream installer plan output, materialized at
 *    release from the exact pinned commit and asserted bound to the ECC baseline
 *    catalog (`baselineCatalogById("ecc")`), so re-running upstream JS here would
 *    be redundant and would require the checkout's own dependencies;
 *  - the selective INSTALL is driven through the injected {@link EccLeanInstaller}
 *    exec/Runner seam. A real evidence-gated install (ECC's `executeEccEvidencePipeline`
 *    / `verifiedEccInstallPlan`) runs the upstream installer against the pinned
 *    checkout under `npm ci` — a REAL host mutation — and therefore only runs in
 *    the orchestrator-triggered acceptance phase; the default installer here fails
 *    closed with {@link EccLeanInstallerUnavailableError} and unit tests inject a
 *    fixture installer (fakeRunner + mkdtemp home). See the acceptance `it.skip`
 *    in the test file for the manual real-installer procedure.
 *
 * D6 method mapping (mirrors `superpowers.ts`):
 *  - `inspect`: cheap static notes over a checkout tree (no network, no CLI).
 *  - `resolve`: delegates to `resolveGitSource` with the declaration's git source.
 *  - `plan`: PURE preview (D8 + feature-key checks + mode routing, then the
 *    allowlist, the installer's expected writes, and D18 ownership intents — no
 *    disk write).
 *  - `provision`: preview-diff allowlist gate -> selective install -> capture
 *    writes -> allowlisted-only + runtime-surface-absence verification -> atomic
 *    `BindingLock`.
 *  - `verify`: lock present + installed files still match recorded digests + a
 *    runtime-surface absence re-check.
 *  - `remove`: SYNC plan-only (partition home-scoped vs repo-relative ownership;
 *    `planClaudeRemoval` over the repo-relative subset). See {@link EccLeanRemoveResult}.
 *  - `report`: Framework Card input lines (framework, mode, pin, allowlist,
 *    exclusions, runtime-surface absence attestation, labeled context-cost estimate).
 */

/** Adapter-local fail-closed error: wrong framework routed here, or a non-git source/resolution. */
export class EccBindingError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_ECC");
  }
}

/**
 * Fail-closed guard for a mode value outside {@link EccMode} — unreachable through
 * the declaration schema (which restricts `mode` to `lean`/`full`), kept as defense
 * in depth so a widened schema can never silently route an unknown mode. W4b used
 * this to stub Full; W4c implements Full, so the only remaining throw site is the
 * impossible-mode branch in {@link eccMode}.
 */
export class EccModeNotImplementedError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_ECC_MODE");
  }
}

/**
 * D10 point 5 — Lean and Full are MUTUALLY EXCLUSIVE per project. Thrown (typed,
 * fail-closed) when a `plan`/`provision` for one mode meets an existing lock that
 * records the OTHER mode, in BOTH directions (Full over a Lean lock, Lean over a
 * Full lock). Re-binding the SAME mode is allowed. The check lives in the shared
 * mode-routing area ({@link assertModeMatchesExistingLock}) so both directions are
 * covered from one place.
 */
export class EccModeConflictError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_ECC_MODE_CONFLICT");
  }
}

/**
 * The pin-bound preview would NOT install exactly the Lean allowlist — an extra
 * runtime surface an allowlisted component drags in, an allowlisted component the
 * preview cannot deliver, or (post-install) a stray/runtime file. The bind fails
 * closed; nothing is applied.
 */
export class EccLeanAllowlistError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_ECC_ALLOWLIST");
  }
}

/**
 * No {@link EccLeanInstaller} was injected. The default installer refuses to run:
 * a real ECC selective install mutates the machine host (upstream `npm ci` + the
 * pinned installer JS), which only happens in the orchestrator-triggered
 * acceptance phase — the CLI/acceptance layer wires a real installer around ECC's
 * `executeEccEvidencePipeline`; unit tests inject a fixture installer.
 */
export class EccLeanInstallerUnavailableError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_ECC_INSTALLER");
  }
}

/**
 * samartomar/ECC pin — the maintainer-locked commit this binding is pinned to.
 * MIRRORS (deliberately does not import) the "samartomar"/"ECC" entry in
 * `src/internals/baseline-sources.ts` — also the pin of the shipped
 * `src/baseline-evidence/ecc-install-preview.json` and of
 * `baselineCatalogById("ecc").pinnedSha`. Mirrored rather than imported for the
 * same two reasons as `SUPERPOWERS_PIN_COMMIT` in `superpowers.ts`: (1) importing
 * would pull the ECC baseline-evidence catalog module into the binding path just
 * to read one string; (2) the binding pin is a DELIBERATE, independently-reviewed
 * value — if the shared baseline pin moves, this constant must be updated
 * explicitly in the same review, never silently follow. The default preview
 * source cross-checks this constant against the live catalog, so a silent drift
 * fails closed rather than binding the wrong commit.
 */
export const ECC_PIN_COMMIT = "16563d4a30f17d097cc4629f6d97e02adf823016";

/** The pinned git source location (`owner/repo` shape; see `isPlausibleGitRepository`). */
export const ECC_REPOSITORY = "samartomar/ECC";

/** The single ECC install target for the `claude` host (the preview's `target`). */
export const ECC_HOST_TARGET = "claude";

/**
 * The ECC Lean EXACT COMPONENT ALLOWLIST — the only ECC components a Lean bind
 * installs (D10). Every id resolves to ≥1 clean (non-runtime) operation in the
 * pinned preview for the `claude` target; the provision gate fails closed if any
 * cannot be delivered or if any drags in a runtime surface.
 *
 * Mapping to the D10 ALLOWED prose:
 *  - common rules       → `baseline:rules`
 *  - planning           → `agent:planner`
 *  - TDD                → `skill:tdd-workflow`, `agent:tdd-guide`
 *  - debugging          → `agent:build-error-resolver`
 *  - review             → `agent:code-reviewer`
 *  - security review    → `agent:security-reviewer`, `skill:security-review`
 *  - verification       → `skill:verification-loop`
 */
export const ECC_LEAN_ALLOWLIST: readonly string[] = [
  "baseline:rules",
  "agent:planner",
  "skill:tdd-workflow",
  "agent:tdd-guide",
  "agent:build-error-resolver",
  "agent:code-reviewer",
  "agent:security-reviewer",
  "skill:security-review",
  "skill:verification-loop",
];

/**
 * The explicitly-EXCLUDED ECC surfaces (D10). Human-readable, for the Framework
 * Card `report`; the enforcement is the allowlist gate + the runtime-surface
 * matchers ({@link eccRuntimeSurfaceHit}), not this list.
 */
export const ECC_LEAN_EXCLUDED: readonly string[] = [
  "hooks-runtime (baseline:hooks)",
  "continuous-learning (skill:continuous-learning)",
  "continuous-learning-v2 (bundled in baseline:workflow)",
  "MCP servers (mcp:*)",
  "browser/runtime automation (capability:*, browser-qa)",
  "auto-update (baseline:commands, baseline:platform)",
  "unrelated language/framework skills (non-detected lang:*, framework:*)",
];

// == ECC Full (W4c) — explicit opt-in, project-scope PLUGIN path (D10) =========

/** Route input: absent or `"lean"` -> Lean; `"full"` -> Full. */
export type EccMode = "lean" | "full";

/**
 * The plugin name AIH installs for ECC Full. Full is EXPLICIT OPT-IN
 * (`mode: "full"`) and binds through the SAME W3 host services `superpowers.ts`
 * uses — the scanned checkout is registered as a marketplace and the plugin is
 * installed at PROJECT scope (`bindPlugin`, D7 subtree identity). The file's
 * declared `adapterType` (`upstream-local-installer`) is unchanged; Full internally
 * uses host-plugin mechanics (D10).
 */
export const ECC_FULL_PLUGIN_NAME = "ecc";

/** The marketplace name the PINNED ECC checkout's own manifest declares. The
 * claude host registers a marketplace under the manifest's name — never a
 * registrar-chosen one — so this mirrors the manifest at {@link ECC_PIN_COMMIT};
 * `bindPlugin` asserts the match before any host mutation (W4 live-run
 * correction). */
export const ECC_FULL_MARKETPLACE_NAME = "ecc";

/** ECC Full always binds at project scope (`.claude/settings.json`). */
const ECC_FULL_SCOPE: PluginScope = "project";

/**
 * The MANDATORY project-scoped state-root env fields (D18-owned in
 * `.claude/settings.json`, D10 point 2). Each points at a PROJECT-LOCAL,
 * repo-relative default under `.aih/` — the SAME gitignored territory the binding
 * lock lives in (`.aih/binding/lock.json`), so ECC agent state and the CLv2
 * homunculus never leak into the machine home or the committed tree. Owned in the
 * SAME lock through the one-lock pattern superpowers uses for its telemetry field.
 */
const ENV_AGENT_DATA_POINTER = "/env/ECC_AGENT_DATA_HOME";
const ENV_HOMUNCULUS_POINTER = "/env/CLV2_HOMUNCULUS_DIR";
/** Default project-local path for `ECC_AGENT_DATA_HOME` (repo-relative, gitignored `.aih/`). */
export const ECC_AGENT_DATA_HOME_DEFAULT = ".aih/ecc/agent-data";
/** Default project-local path for `CLV2_HOMUNCULUS_DIR` (repo-relative, gitignored `.aih/`). */
export const ECC_HOMUNCULUS_DIR_DEFAULT = ".aih/ecc/homunculus";

/**
 * The ECC Full MCP CONNECTOR ALLOWLIST — the connector ids a Full bind may select,
 * one per `mcp:<connector>` declaration `features` key (D10 point 3).
 *
 * MIRRORS (deliberately does not import) the resolvable subset of
 * `EXPLICIT_MCP_COMPONENTS` in `src/ecc/components.ts`, as consumed by
 * `selectedEccMcpServers`/`orgAllowedEccMcpComponents` in `src/ecc/mcp.ts` — those
 * resolve each `mcp:<id>` against the validated `mcpServers()` catalog in
 * `src/mcp/servers.ts`. Mirrored rather than imported for the same reasons as the
 * pin constants: (1) the allowlist is a DELIBERATE, independently-reviewed value —
 * if the upstream catalog grows a connector, adding it here is a reviewed change,
 * never a silent follow; (2) it keeps the binding path from depending on the ECC
 * component-selection module just to read a list. `exa` is intentionally OMITTED:
 * `EXPLICIT_MCP_COMPONENTS` lists `mcp:exa`, but `src/mcp/servers.ts` ships no
 * validated `exa` config, so `selectedEccMcpServers(["mcp:exa"])` would throw — a
 * connector with no config can never be a bindable selection. A test asserts every
 * id here resolves through `selectedEccMcpServers`, so a drift fails closed.
 */
export const ECC_FULL_MCP_CONNECTORS: readonly string[] = [
  "code-review-graph",
  "codebase-memory-mcp",
  "sequential-thinking",
  "github",
  "context7",
];

/** The Full known-feature-key list: exactly one `mcp:<connector>` key per allowlisted connector. */
export const ECC_FULL_FEATURE_KEYS: readonly string[] = ECC_FULL_MCP_CONNECTORS.map(
  (id) => `mcp:${id}`,
);

// -- normalized preview operations + allowlist diff (pure) --------------------

/** A preview operation normalized to a scope + a POSIX path relative to that scope. */
export interface NormalizedEccOp {
  componentId: string;
  scope: "home" | "project";
  /** POSIX path relative to `<home>` or `<project>`. */
  rel: string;
  kind: string;
}

/** The allowlist-vs-preview verdict computed BEFORE any install runs. */
export interface EccLeanPreviewDiff {
  ok: boolean;
  /** Allowlisted components with no deliverable operation in the pinned preview. */
  missing: string[];
  /** Allowlisted operations whose destination hits a forbidden runtime surface. */
  runtimeEscapes: string[];
  /** Component ids the preview can deliver for the target. */
  deliverable: string[];
  /** Every operation whose component is in the allowlist. */
  selectedOps: NormalizedEccOp[];
}

function scopeAndRel(destination: string): { scope: "home" | "project"; rel: string } {
  const posix = destination.replace(/\\/g, "/");
  if (posix.startsWith("<home>/")) return { scope: "home", rel: posix.slice("<home>/".length) };
  if (posix.startsWith("<project>/")) {
    return { scope: "project", rel: posix.slice("<project>/".length) };
  }
  // A bare/relative destination is a project write (matches the preview generator).
  return { scope: "project", rel: posix.replace(/^\.\//, "") };
}

/** Normalize every preview operation for a single install target to a scope + relative path. */
export function normalizeEccOperations(
  artifact: EccInstallPreviewArtifact,
  target: string = ECC_HOST_TARGET,
): NormalizedEccOp[] {
  return artifact.operations
    .filter((operation) => operation.target === target)
    .map((operation) => {
      const { scope, rel } = scopeAndRel(operation.destination);
      return { componentId: operation.componentId, scope, rel, kind: operation.kind };
    });
}

/**
 * Runtime-surface matcher (D10 absence rule). Returns a surface label when a
 * scope-relative path lands on hooks-runtime, continuous-learning output, learned
 * skills, an MCP registration, or a Claude SETTINGS file — otherwise `undefined`.
 * Used both as the pre-install "extra surface" gate and the post-install / verify
 * absence check.
 *
 * A `.claude/settings.json` / `.claude/settings.local.json` write is out-of-allowlist
 * for Lean in EITHER scope: those files carry hook ENTRIES, `enabledPlugins`, `env`,
 * and `skillOverrides` — none of which a rules/skills/agents-only Lean bind may touch.
 * The plain path-based hooks/MCP checks miss them (the runtime lives INSIDE the JSON,
 * not in a `hooks/` directory), so they are matched here explicitly.
 */
export function eccRuntimeSurfaceHit(scope: "home" | "project", rel: string): string | undefined {
  const posix = rel.replace(/\\/g, "/");
  const parts = posix.split("/");
  const base = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  if (base === ".mcp.json" || base === "mcp.json") return "MCP servers";
  // Settings files (both scopes): a settings.json / settings.local.json directly
  // inside a `.claude/` directory at any depth.
  if ((base === "settings.json" || base === "settings.local.json") && parent === ".claude") {
    return "settings file (hook entries / enabledPlugins live here)";
  }
  if (scope === "home") {
    if (posix === ".claude/hooks" || posix.startsWith(".claude/hooks/")) return "hooks-runtime";
    if (posix.startsWith(".claude/scripts/hooks/")) return "hooks-runtime";
    if (posix.startsWith(".claude/skills/learned/") || posix === ".claude/skills/learned") {
      return "learned skills";
    }
    if (/\.claude\/skills\/ecc\/continuous-learning(?:-v2)?(?:\/|$)/.test(posix)) {
      return "continuous-learning";
    }
  }
  return undefined;
}

/**
 * Diff the pinned preview against the Lean allowlist. This is the D10 gate output:
 * `missing` (an allowlisted component the preview cannot deliver) and
 * `runtimeEscapes` (an allowlisted component that would install a runtime surface)
 * each make `ok` false. Pure — no I/O, no Runner.
 */
export function computeEccLeanPreviewDiff(
  artifact: EccInstallPreviewArtifact,
  allowlist: readonly string[] = ECC_LEAN_ALLOWLIST,
  target: string = ECC_HOST_TARGET,
): EccLeanPreviewDiff {
  const ops = normalizeEccOperations(artifact, target);
  const deliverable = new Set(ops.map((operation) => operation.componentId));
  const allow = new Set(allowlist);
  const missing = allowlist.filter((id) => !deliverable.has(id));
  const selectedOps = ops.filter((operation) => allow.has(operation.componentId));
  const runtimeEscapes = selectedOps
    .map((operation) => {
      const surface = eccRuntimeSurfaceHit(operation.scope, operation.rel);
      return surface === undefined
        ? undefined
        : `${operation.componentId} -> ${operation.rel} (${surface})`;
    })
    .filter((entry): entry is string => entry !== undefined);
  return {
    ok: missing.length === 0 && runtimeEscapes.length === 0,
    missing,
    runtimeEscapes,
    deliverable: [...deliverable].sort(),
    selectedOps,
  };
}

// -- install manifest (D7 identity for an installer adapter) ------------------

/** One `<scope>:<rel>` install-manifest entry. */
function manifestEntry(scope: "home" | "project", rel: string): string {
  return `${scope}:${rel.replace(/\\/g, "/")}`;
}

export interface EccLeanManifest {
  /** Sorted, deduped `<scope>:<rel>` entries. */
  entries: string[];
  /** The digest text (a source-pin header + the sorted entries). */
  text: string;
  /** sha256 of {@link text}. */
  digest: string;
}

/**
 * The install manifest digest — the D7 identity for an installer adapter. Both
 * `scannedDigest` (from the pinned preview) and `loadedDigest` (from what was
 * actually written) are this digest over their respective file SET, prefixed with
 * the exact scanned source tree digest so the lock is bound to the vetted commit.
 * A faithful Lean bind makes the two SETS identical, so `match` is honestly true;
 * `verify` later recomputes the loaded set from disk and reports per-file drift.
 */
export function eccLeanManifest(
  entries: readonly string[],
  sourceTreeDigest: string,
): EccLeanManifest {
  const sorted = [...new Set(entries)].sort();
  const text = `source:${sourceTreeDigest}\n${sorted.join("\n")}`;
  return { entries: sorted, text, digest: sha256Hex(text) };
}

/** The EXPECTED install manifest (from the vetted preview selection). */
function expectedManifest(diff: EccLeanPreviewDiff, sourceTreeDigest: string): EccLeanManifest {
  return eccLeanManifest(
    diff.selectedOps.map((operation) => manifestEntry(operation.scope, operation.rel)),
    sourceTreeDigest,
  );
}

/**
 * The common install root for a component's files: the single file when there is
 * one, else the longest shared leading directory. Used as the home-scoped
 * ownership target (what removal deletes) — bounded to one entry per component.
 */
export function componentInstallRoot(rels: readonly string[]): string {
  const paths = [...new Set(rels.map((rel) => rel.replace(/\\/g, "/")))].sort();
  if (paths.length === 0) return "";
  if (paths.length === 1) return paths[0] as string;
  const split = paths.map((path) => path.split("/"));
  const first = split[0] as string[];
  let shared = first.length;
  for (const parts of split) {
    let index = 0;
    while (index < shared && index < parts.length && parts[index] === first[index]) index += 1;
    shared = index;
  }
  // A shared prefix that consumes a whole path would name a file as a directory;
  // step back to the containing directory in that case.
  const prefix = first.slice(0, shared);
  if (prefix.length === first.length) prefix.pop();
  return prefix.join("/");
}

// -- installer seam -----------------------------------------------------------

/** A file the selective installer actually wrote, captured for the lock + verification. */
export interface EccLeanInstalledFile {
  scope: "home" | "project";
  /** POSIX path relative to `<home>` (scope "home") or the project root (scope "project"). */
  rel: string;
  /** sha256 hex of the written bytes. */
  contentDigest: string;
  /** The allowlisted component this file belongs to. */
  componentId: string;
}

export interface EccLeanInstallInput {
  resolved: ResolvedGitSource;
  /** The vetted Lean allowlist (component ids) to drive the selective install with. */
  components: readonly string[];
  /** The vetted preview diff (the exact operations the install must produce). */
  diff: EccLeanPreviewDiff;
  /** Project root. */
  root: string;
  /** Machine home (`~`) — a fixture temp dir in tests. */
  home: string;
  /** The subprocess seam for ECC's own installer. */
  runner: Runner;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface EccLeanInstallResult {
  installed: EccLeanInstalledFile[];
}

export type EccLeanInstaller = (input: EccLeanInstallInput) => Promise<EccLeanInstallResult>;

/** The default installer refuses to run — a real ECC install is acceptance-phase only (see class doc). */
const defaultEccLeanInstaller: EccLeanInstaller = async () => {
  throw new EccLeanInstallerUnavailableError(
    "no ECC Lean installer injected; a real evidence-gated ECC selective install mutates the machine host " +
      "and runs only in the orchestrator acceptance phase. Wire an installer around ECC's " +
      "executeEccEvidencePipeline (src/ecc/pipeline.ts) at the CLI/acceptance layer, or inject a fixture installer in tests.",
  );
};

export interface EccLeanAdapterDeps {
  /** Project root the binding lock lives under and repo-relative ownership is resolved against. */
  root: string;
  /** The subprocess seam threaded to the installer. */
  runner: Runner;
  /** Environment (home resolution for machine-scope surfaces). Defaults to `{}`. */
  env?: NodeJS.ProcessEnv;
  /** Git checkout cache root for `resolve()`. Defaults to `bindingCacheHome(env)`. */
  cacheHome?: string;
  /**
   * The upstream preview/plan (pinned to the exact commit). Defaults to the shipped,
   * catalog-bound `ecc-install-preview.json` via {@link readEccInstallPreview}.
   */
  installPreview?: EccInstallPreviewArtifact;
  /** The selective-install exec seam. Defaults to a fail-closed installer (see {@link EccLeanInstallerUnavailableError}). */
  installer?: EccLeanInstaller;
  /** Per-call installer timeout override. */
  timeoutMs?: number;
  // -- ECC Full (W4c) only; ignored by the Lean path --------------------------
  /**
   * Full only: injectable plugin-cache locator threaded to `bindPlugin` (D7) and to
   * `verify`/`remove`. Defaults to {@link defaultPluginCacheLocator}. Tests inject a
   * fixture locator so no real `claude` runs and no real `~/.claude` is touched.
   */
  locateCache?: PluginCacheLocator;
  /**
   * Full only: injectable apply seam for the repo-relative D18 writes (the env-root
   * fields and the `.mcp.json` connectors, plus `bindPlugin`'s `enabledPlugins`).
   * Defaults to a real `executePlan` wrapper (worktree gate skipped).
   */
  applyActions?: (root: string, actions: Action[]) => Promise<PlanResult>;
  /**
   * Full only: state-write surfaces the LABEL DECISION may treat as compliant
   * because they were removed through a SUPPORTED upstream selection mechanism
   * (D10 point 4). The only supported mechanism today is the plugin's own
   * `--config` userConfig options; this list is populated ONLY from such a
   * mechanism — NEVER by editing plugin content. Each string matches a
   * {@link EccStateWriteFinding.surface}.
   */
  excludedSurfaces?: string[];
}

/**
 * `remove()` stays SYNCHRONOUS (the D6 contract) so it can only PLAN the teardown.
 * The caller applies an "apply"-mode result in EXACTLY this order — repo-relative
 * first, then machine-scope:
 *  1. repo-relative restore: `executePlan(plan("...", ...repoRelativeActions), ctx)`
 *     — restores any project-scoped owned surfaces to their pre-bind value;
 *  2. machine-scope teardown: delete each recorded `home:`-scoped install root in
 *     {@link EccLeanRemoveResult.homeOwnership} (ECC's installer has no `uninstall`
 *     command, so removal is conservative deletion of exactly the roots the lock
 *     recorded creating — never un-recorded state).
 * Then the caller drops the binding lock itself (mirrors the W3 roundtrip
 * precedent). `"drift-report-only"` mode mirrors {@link planBindingRemoval}:
 * nothing to apply; `reason` explains why.
 */
export type EccLeanRemoveResult =
  | { mode: "drift-report-only"; reason: string }
  | {
      mode: "apply";
      repoRelativeActions: Action[];
      repoRelativeDrift: ClaudeDriftEntry[];
      /** Home-scoped ECC install roots to delete (conservative, recorded-only). */
      homeOwnership: BindingOwnershipEntry[];
    };

// -- assertions ---------------------------------------------------------------

function assertEccDeclaration(declaration: BindingDeclaration): void {
  if (declaration.framework.id !== "ecc") {
    throw new EccBindingError(`ecc adapter invoked for framework "${declaration.framework.id}"`);
  }
}

/**
 * Route on `declaration.framework.mode`: absent or `"lean"` -> Lean; `"full"` ->
 * Full. The declaration schema restricts `mode` to those values; the final throw
 * is unreachable defense in depth (see {@link EccModeNotImplementedError}).
 */
function eccMode(declaration: BindingDeclaration): EccMode {
  const mode = declaration.framework.mode;
  if (mode === undefined || mode === "lean") return "lean";
  if (mode === "full") return "full";
  throw new EccModeNotImplementedError(`unsupported ECC mode "${String(mode)}"`);
}

/**
 * D10 point 5 — the SHARED mode-routing guard both `plan` and `provision` call, in
 * BOTH modes, so Lean/Full mutual exclusivity is enforced in one place and covers
 * both directions. When a lock already records an ECC binding in the OTHER mode,
 * fail closed with {@link EccModeConflictError}; a matching-mode re-bind is allowed,
 * and a lock for a DIFFERENT framework is a D8 concern handled by the plan/provision
 * guards, not here. Reading the lock performs no write (safe from a pure `plan`).
 */
function assertModeMatchesExistingLock(root: string, requested: EccMode): void {
  const read = readBindingLock(root);
  if (!read.present || read.lock.declaration.framework.id !== "ecc") return;
  const recorded = eccMode(read.lock.declaration);
  if (recorded !== requested) {
    throw new EccModeConflictError(
      `project already has an ECC ${recorded} binding; refusing to ${
        requested === "full" ? "bind Full over a Lean lock" : "re-bind Lean over a Full lock"
      } — ECC Lean and Full are mutually exclusive per project (remove the existing binding first)`,
    );
  }
}

function assertGitSource(source: BindingDeclaration["source"]): BindingGitSource {
  if (source.kind !== "git") {
    throw new EccBindingError(`ecc requires a git source; got "${source.kind}"`);
  }
  return source;
}

function assertGitResolved(resolved: ResolvedSource): ResolvedGitSource {
  if (resolved.kind !== "git") {
    throw new EccBindingError(`ecc requires a resolved git source; got "${resolved.kind}"`);
  }
  return resolved;
}

/**
 * The pinned preview source. Validates structure and asserts it is bound to the
 * ECC baseline catalog pin (== {@link ECC_PIN_COMMIT}); a preview that does not
 * bind the exact commit fails closed rather than diffing the wrong plan.
 */
function loadPreviewArtifact(deps: EccLeanAdapterDeps): EccInstallPreviewArtifact {
  const artifact = parseEccInstallPreview(deps.installPreview ?? readEccInstallPreview());
  const catalog = baselineCatalogById("ecc");
  if (
    artifact.source.owner !== catalog.owner ||
    artifact.source.repo !== catalog.repo ||
    artifact.source.pinnedSha !== catalog.pinnedSha ||
    artifact.source.pinnedSha !== ECC_PIN_COMMIT
  ) {
    throw new EccBindingError(
      `ECC install preview does not bind ${ECC_REPOSITORY}@${ECC_PIN_COMMIT} (got ${artifact.source.owner}/${artifact.source.repo}@${artifact.source.pinnedSha})`,
    );
  }
  return artifact;
}

// -- inspect ------------------------------------------------------------------

function inspectEccTree(request: InspectRequest): InspectReport {
  const notes: string[] = [];
  const hasInstaller = existsSync(join(request.treePath, "scripts", "install-apply.js"));
  notes.push(
    hasInstaller
      ? "ECC selective installer present (scripts/install-apply.js)"
      : "no ECC installer found (scripts/install-apply.js)",
  );
  for (const dir of ["rules", "agents", "skills"]) {
    let count = 0;
    try {
      const full = join(request.treePath, dir);
      if (existsSync(full)) count = readdirSync(full).length;
    } catch {
      count = 0;
    }
    notes.push(count > 0 ? `${count} entr(y/ies) under ${dir}/` : `no ${dir}/ directory found`);
  }
  return { framework: "ecc", treePath: request.treePath, notes };
}

// -- plan (pure preview) -------------------------------------------------------

/** Per-allowlisted-component grouping of the vetted preview operations. */
interface EccLeanComponentPlan {
  componentId: string;
  scope: "home" | "project";
  root: string;
  rels: string[];
}

function groupSelectedByComponent(diff: EccLeanPreviewDiff): EccLeanComponentPlan[] {
  const byComponent = new Map<string, NormalizedEccOp[]>();
  for (const operation of diff.selectedOps) {
    const list = byComponent.get(operation.componentId) ?? [];
    list.push(operation);
    byComponent.set(operation.componentId, list);
  }
  return [...byComponent.entries()]
    .map(([componentId, ops]) => ({
      componentId,
      scope: ops[0]?.scope ?? "home",
      root: componentInstallRoot(ops.map((operation) => operation.rel)),
      rels: [...new Set(ops.map((operation) => operation.rel))].sort(),
    }))
    .sort((left, right) => left.componentId.localeCompare(right.componentId));
}

function ownershipTargetFor(component: EccLeanComponentPlan): string {
  return component.scope === "home" ? `${HOME_OWNERSHIP_PREFIX}${component.root}` : component.root;
}

/** The home container every Lean skill delivery lives under. */
const ECC_SKILLS_CONTAINER_REL = ".claude/skills/ecc";

/**
 * The upstream installer's runtime-state surfaces a Lean install writes
 * BESIDES the vetted content ops (2.1.214 + ECC pin, W4 live-run empirical):
 * a `.claude/.agents/skills/<skill>` cross-CLI mirror per delivered skill and
 * the `.claude/ecc/install-state.json` ledger. Derived from the selected
 * home-scoped skill components so the set tracks the allowlist exactly.
 */
function installerStateSurfaceRels(components: readonly EccLeanComponentPlan[]): string[] {
  const rels = new Set<string>();
  for (const component of components) {
    if (component.scope !== "home") continue;
    // The component root is the DIRECTORY for multi-file skills and the single
    // FILE for one-op skills — capture the skill segment either way.
    const match = /^\.claude\/skills\/ecc\/([^/]+)(?:\/|$)/.exec(component.root);
    if (match !== null) rels.add(`.claude/.agents/skills/${match[1]}`);
  }
  rels.add(".claude/ecc/install-state.json");
  return [...rels].sort();
}

function buildEccLeanPlan(deps: EccLeanAdapterDeps, declaration: BindingDeclaration): BindingPlan {
  const artifact = loadPreviewArtifact(deps);
  const diff = computeEccLeanPreviewDiff(artifact, ECC_LEAN_ALLOWLIST);
  const components = groupSelectedByComponent(diff);
  // ECC Lean writes only to the machine home, so AIH itself performs no
  // repo-relative managed write — `writes` (BindingWrite[], repo-relative) is
  // empty and the installer's home writes are previewed as ownership intents.
  const ownership: BindingOwnershipEntry[] = components.map((component) => {
    const applied = { component: component.componentId, files: component.rels };
    return {
      kind: "file" as const,
      target: ownershipTargetFor(component),
      preExisting: { absent: true as const },
      applied,
      // A PURE preview: content is unknown pre-install, so the intent's digest is
      // over the target IDENTITY (the paths it will own), not file bytes.
      postApplyDigest: sha256Hex(canonicalJson(applied)),
    };
  });
  return { framework: declaration.framework.id, writes: [], ownership };
}

// -- provision ----------------------------------------------------------------

function contentDigestOf(absPath: string): string {
  return sha256Hex(readFileSync(absPath, "utf8"));
}

function homeAbsPath(home: string, scope: "home" | "project", root: string, rel: string): string {
  return scope === "home" ? join(home, rel) : join(root, rel);
}

/** Digest a component's actual installed files (path + content) — the ownership `applied` value. */
function componentSubtreeDigest(files: readonly EccLeanInstalledFile[]): string {
  const manifest = [...files]
    .map((file) => ({ rel: file.rel.replace(/\\/g, "/"), digest: file.contentDigest }))
    .sort((left, right) => left.rel.localeCompare(right.rel));
  return sha256Hex(canonicalJson(manifest));
}

/** The exact acceptance tuple ECC Lean binds decisions against (W4 ruling (e)).
 * The resolve-side binding (repository/commit/treeDigest must match the live
 * resolution) is asserted by the LIVE installer composition — the only place
 * acceptance enters the flow — via `acceptanceResolutionMismatches`; fixture
 * installers never consult acceptance, so a dry-run stays fixture-digested. */
export const ECC_LEAN_ACCEPTANCE_TUPLE = {
  framework: "ecc",
  profile: "ecc-lean-v1",
  host: "claude",
  adapter: "ecc-lean",
} as const;

async function provisionEccLean(
  deps: EccLeanAdapterDeps,
  request: ProvisionRequest,
  disposition: ScanDisposition,
): Promise<ProvisionResult> {
  const declaration = request.context.declaration;
  assertEccDeclaration(declaration);
  // Defense in depth (D8 layer 3 + D12) — the registry dispatch already guards this.
  assertProvisionAllowed(request, disposition);
  const resolved = assertGitResolved(request.resolved);
  assertResolvedMatchesDeclaration(declaration, resolved);
  // D10 point 5: refuse a Lean re-bind over an existing Full lock (before any work).
  assertModeMatchesExistingLock(deps.root, "lean");

  // 1. Run the upstream PREVIEW (pin-bound) and DIFF it against the allowlist
  //    BEFORE any install — a mismatch fails closed with the installer untouched.
  const artifact = loadPreviewArtifact(deps);
  const diff = computeEccLeanPreviewDiff(artifact, ECC_LEAN_ALLOWLIST);
  if (!diff.ok) {
    const detail = [
      diff.missing.length > 0 ? `cannot deliver: ${diff.missing.join(", ")}` : "",
      diff.runtimeEscapes.length > 0 ? `runtime surfaces: ${diff.runtimeEscapes.join("; ")}` : "",
    ]
      .filter((part) => part.length > 0)
      .join(" | ");
    throw new EccLeanAllowlistError(`ECC Lean preview does not match the allowlist (${detail})`);
  }
  const expected = expectedManifest(diff, resolved.treeDigest);

  const env = deps.env ?? {};
  const home = claudeHomeDir(env);
  const components = groupSelectedByComponent(diff);

  // Snapshot pre-existing state of each component root (conservative D18 ownership).
  const preExistingByTarget = new Map<string, BindingOwnershipEntry["preExisting"]>();
  for (const component of components) {
    const abs = homeAbsPath(home, component.scope, deps.root, component.root);
    preExistingByTarget.set(
      ownershipTargetFor(component),
      existsSync(abs) ? { value: `present:${component.root}` } : { absent: true },
    );
  }
  // Installer runtime-state surfaces (W4 live-run correction): the upstream
  // evidence-gated installer ALSO writes a cross-CLI `.agents` skills mirror
  // (generated shims alongside the vetted skill bytes) and its own
  // `ecc/install-state.json` ledger. These are never part of the vetted-content
  // manifest, but they ARE machine writes this bind causes — so they are owned
  // ("own what you created"), removal cleans them, and the acceptance
  // home-delta can expect them. Pre-existing state is captured here, before
  // any install.
  const stateSurfaceRels = installerStateSurfaceRels(components);
  const preExistingByStateSurface = new Map<string, BindingOwnershipEntry["preExisting"]>();
  for (const rel of stateSurfaceRels) {
    preExistingByStateSurface.set(
      rel,
      existsSync(join(home, rel)) ? { value: `present:${rel}` } : { absent: true },
    );
  }
  // The ecc skills NAMESPACE CONTAINER: owned only when THIS bind creates it,
  // so removal prunes the container itself — not just the per-component roots
  // under it — and no empty `.claude/skills/ecc` shell survives to census as
  // a leaked skill surface (W4 live-run phase-6 correction). A pre-existing
  // container is never owned and therefore never deleted.
  const containerPreExisted = existsSync(join(home, ECC_SKILLS_CONTAINER_REL));

  // 2. Drive the selective install (exec/Runner seam) and capture actual writes.
  const installer = deps.installer ?? defaultEccLeanInstaller;
  const { installed } = await installer({
    resolved,
    components: ECC_LEAN_ALLOWLIST,
    diff,
    root: deps.root,
    home,
    runner: deps.runner,
    env,
    timeoutMs: deps.timeoutMs,
  });

  // 3a. Verify allowlisted-only: every written file must be in the vetted set,
  //     and the vetted set must be fully delivered (no stray, no missing).
  const expectedSet = new Set(expected.entries);
  const actualEntries = installed.map((file) => manifestEntry(file.scope, file.rel));
  const stray = actualEntries.filter((entry) => !expectedSet.has(entry));
  if (stray.length > 0) {
    throw new EccLeanAllowlistError(
      `ECC Lean install wrote files outside the vetted allowlist: ${stray.slice(0, 5).join(", ")}`,
    );
  }
  const loaded = eccLeanManifest(actualEntries, resolved.treeDigest);
  if (loaded.digest !== expected.digest) {
    const undelivered = expected.entries.filter((entry) => !new Set(actualEntries).has(entry));
    throw new EccLeanAllowlistError(
      `ECC Lean install did not deliver the full vetted allowlist (missing ${undelivered.slice(0, 5).join(", ")})`,
    );
  }
  // 3b. Verify runtime-surface ABSENCE (defense in depth — the allowlist already
  //     excludes these, but a rogue installer must still fail closed).
  const surfaceHits = installed
    .map((file) => {
      const surface = eccRuntimeSurfaceHit(file.scope, file.rel);
      return surface === undefined ? undefined : `${file.rel} (${surface})`;
    })
    .filter((entry): entry is string => entry !== undefined);
  if (surfaceHits.length > 0) {
    throw new EccLeanAllowlistError(
      `ECC Lean install produced forbidden runtime surfaces: ${surfaceHits.slice(0, 5).join(", ")}`,
    );
  }

  // 4. Assemble ownership (one bounded entry per allowlisted component) + the lock.
  const installedByComponent = new Map<string, EccLeanInstalledFile[]>();
  for (const file of installed) {
    const list = installedByComponent.get(file.componentId) ?? [];
    list.push(file);
    installedByComponent.set(file.componentId, list);
  }
  const ownership: BindingOwnershipEntry[] = components.map((component) => {
    const files = installedByComponent.get(component.componentId) ?? [];
    const digest = componentSubtreeDigest(files);
    return {
      kind: "file",
      target: ownershipTargetFor(component),
      preExisting: preExistingByTarget.get(ownershipTargetFor(component)) ?? { absent: true },
      applied: digest,
      postApplyDigest: digest,
    };
  });
  // Installer runtime-state surfaces actually written by THIS install: digest
  // with the SAME routine verify() re-checks (`currentComponentDigest`), so a
  // later verify is consistent by construction. A surface the installer did
  // not write (e.g. the fixture installer) is simply not owned.
  for (const rel of stateSurfaceRels) {
    const target = `${HOME_OWNERSHIP_PREFIX}${rel}`;
    const digest = currentComponentDigest(home, deps.root, target);
    if (digest === undefined) continue;
    ownership.push({
      kind: "file",
      target,
      preExisting: preExistingByStateSurface.get(rel) ?? { absent: true },
      applied: digest,
      postApplyDigest: digest,
    });
  }
  if (!containerPreExisted) {
    const containerTarget = `${HOME_OWNERSHIP_PREFIX}${ECC_SKILLS_CONTAINER_REL}`;
    const containerDigest = currentComponentDigest(home, deps.root, containerTarget);
    if (containerDigest !== undefined) {
      ownership.push({
        kind: "file",
        target: containerTarget,
        preExisting: { absent: true },
        applied: containerDigest,
        postApplyDigest: containerDigest,
      });
    }
  }

  const lock: BindingLock = {
    schemaVersion: 1,
    declaration,
    // Repo-relative managed writes only; ECC Lean writes solely to the machine home.
    writes: [],
    scannedDigest: expected.digest,
    loadedDigest: loaded.digest,
    match: expected.digest === loaded.digest,
    ownership,
  };
  writeBindingLockAtomic(deps.root, lock);
  return { lock };
}

// -- verify -------------------------------------------------------------------

function currentComponentDigest(home: string, root: string, target: string): string | undefined {
  const scoped = isHomeScopedTarget(target);
  const scope: "home" | "project" = scoped ? "home" : "project";
  const rel = scoped ? target.slice(HOME_OWNERSHIP_PREFIX.length) : target;
  const abs = scoped ? join(home, rel) : join(root, rel);
  if (!existsSync(abs)) return undefined;
  const files: EccLeanInstalledFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const relName = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, relName);
      else {
        files.push({
          scope,
          rel: `${rel}/${relName}`,
          contentDigest: contentDigestOf(full),
          componentId: "",
        });
      }
    }
  };
  if (statSync(abs).isDirectory()) walk(abs, "");
  else files.push({ scope, rel, contentDigest: contentDigestOf(abs), componentId: "" });
  return componentSubtreeDigest(files);
}

/** The forbidden runtime roots whose ABSENCE a Lean bind attests to (D10). */
function runtimeSurfacePresences(home: string): string[] {
  const claude = join(home, ".claude");
  const present: string[] = [];
  if (existsSync(join(claude, "hooks"))) present.push("hooks");
  if (existsSync(join(claude, "skills", "learned"))) present.push("learned skills");
  for (const cl of ["continuous-learning", "continuous-learning-v2"]) {
    if (existsSync(join(claude, "skills", "ecc", cl))) present.push(cl);
  }
  return present;
}

function verifyEccLean(deps: EccLeanAdapterDeps): VerifyResult {
  const read = readBindingLock(deps.root);
  if (!read.present) return { ok: false, drift: ["no binding lock"] };
  const lock = read.lock;
  const drift: string[] = [];
  const home = claudeHomeDir(deps.env ?? {});

  // Installed files still match recorded per-component digests (drift per component).
  for (const entry of lock.ownership) {
    const current = currentComponentDigest(home, deps.root, entry.target);
    if (current === undefined) {
      drift.push(`${entry.target}: installed surface missing`);
      continue;
    }
    if (typeof entry.applied === "string" && current !== entry.applied) {
      drift.push(`${entry.target}: content drift (loaded ${current} != recorded ${entry.applied})`);
    }
  }

  // Runtime-surface ABSENCE re-check (D10): a runtime surface appearing after a
  // Lean bind is drift.
  for (const surface of runtimeSurfacePresences(home)) {
    drift.push(`runtime surface present after Lean bind: ${surface}`);
  }

  return { ok: drift.length === 0, drift };
}

// -- remove -------------------------------------------------------------------

function removeEccLean(deps: EccLeanAdapterDeps): EccLeanRemoveResult {
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
  };
}

// -- report -------------------------------------------------------------------

function reportEccLean(deps: EccLeanAdapterDeps, context: BindingContext): BindingReport {
  const source = context.declaration.source;

  // Selection + acceptance disclosure (W4 ruling (e)): the allowlist, the
  // explicit exclusions, and the raw vet outcome vs the signed acceptance are
  // carried as card disclosures — an admitted component is never described as
  // "vet passed" and findings are never described as absent.
  const disclosures: string[] = [
    `allowlist: ${ECC_LEAN_ALLOWLIST.join(", ")}`,
    `excluded: ${ECC_LEAN_EXCLUDED.join(", ")}`,
  ];
  const decision = findAcceptanceDecision(readAcceptanceDecisions(), ECC_LEAN_ACCEPTANCE_TUPLE);
  if (decision === undefined) {
    disclosures.push("vet acceptance: none shipped — blocked evidence components stay held");
  } else {
    const codes = [
      ...new Set(decision.components.flatMap((component) => component.acceptedFindingCodes)),
    ].sort();
    disclosures.push(
      `raw vet outcome: ${decision.components.length} allowlist evidence component(s) BLOCKED by ` +
        `signed findings (verdicts preserved in vendor-lock.json; not reclassified)`,
    );
    disclosures.push(
      `policy decision: accepted-with-conditions — ${decision.decisionId} ` +
        `(owner ${decision.owner}, record ${decision.recordSha256.slice(0, 12)}…, policy v${String(decision.policyVersion)})`,
    );
    disclosures.push(`accepted finding codes: ${codes.join(", ")}`);
    disclosures.push(`residual risk: ${decision.residualRisk}`);
    disclosures.push(
      `effective install decision: allowed for ${decision.profile} on ` +
        `${decision.repository}@${decision.commitSha.slice(0, 12)} (exact tuple only)`,
    );
  }

  const home = claudeHomeDir(deps.env ?? {});
  const read = readBindingLock(deps.root);
  const installMechanism = "upstream-local-installer (selective install)";

  if (!read.present) {
    const card = buildFrameworkCard({
      framework: "ecc",
      mode: "lean",
      scope: "project",
      targetLabel: "DEFERRED",
      source,
      installMechanism,
      residualRisks: disclosures,
      enterpriseDisposition: "runtime-surface absence: not applicable (not yet provisioned)",
    });
    return { framework: "ecc", card, lines: renderFrameworkCard(card) };
  }

  const lock = read.lock;
  const { identity } = sourceIdentityFromLock(lock);
  const { repoRelative, homeScope } = d18SurfaceLabels(lock);

  // D10 runtime-surface absence attestation — the state-containment axis that
  // makes Lean strict-CAPABLE (the doctor still gates STRICT via DoctorCardInput).
  const present = runtimeSurfacePresences(home);
  const runtimeSurface =
    present.length === 0
      ? "runtime-surface absence: attested (no hooks, no MCP servers, no learned skills)"
      : `runtime-surface absence: VIOLATED — present: ${present.join(", ")}`;

  let contextCost: ContextCostCard;
  let counts: FrameworkCardCounts | undefined;
  try {
    const fragment = contextCostCard(estimateContextCostFromTree(join(home, ".claude")));
    contextCost = fragment.contextCost;
    counts = fragment.counts;
  } catch {
    contextCost = contextCostUnavailable("claude tree not estimable");
  }

  const card = buildFrameworkCard({
    framework: "ecc",
    mode: "lean",
    scope: "project",
    targetLabel:
      present.length === 0 ? "STRICT_PROJECT_BINDING_VERIFIED" : "PROJECT_BINDING_CONFLICTED",
    source,
    identity,
    installMechanism,
    scriptsBinariesDeps: [...repoRelative, ...homeScope],
    contextCost,
    counts,
    residualRisks: disclosures,
    enterpriseDisposition: runtimeSurface,
  });
  return { framework: "ecc", card, lines: renderFrameworkCard(card) };
}

// == ECC Full (W4c) — state-write inventory (label-decision input, D10 point 4) =

/** One state-writing surface the Full inventory found in the scanned checkout. */
export interface EccStateWriteFinding {
  /** Which detector produced this finding. */
  kind:
    | "continuous-learning-skill"
    | "learned-skills-write"
    | "hook-definition"
    | "outside-root-write";
  /**
   * A STABLE surface id — enumerated in {@link EccFullLabelInput.sharedWrites} and
   * matched against an {@link EccLeanAdapterDeps.excludedSurfaces} entry. Shaped
   * `<kind>:<location>` so it is both human-readable and deterministic across runs.
   */
  surface: string;
  /** Human-readable detail for the Framework Card / report lines. */
  detail: string;
}

/** The Full LABEL DECISION input recorded in `report()` and returned from `provision`. */
export interface EccFullLabelInput {
  /**
   * `true` only when the inventory found ZERO noncompliant surfaces, OR every one
   * was excluded through a supported selection mechanism (D10 point 4). Otherwise
   * `false` with {@link sharedWrites} enumerating the surfaces that keep it lax.
   */
  strict: boolean;
  /** The noncompliant shared-write surfaces NOT excluded (sorted, deduped). */
  sharedWrites: string[];
}

/** Text extensions the content scanners read (shell / js / ts / py / json). */
const INVENTORY_TEXT_EXTS: ReadonlySet<string> = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".py",
  ".json",
]);
/** Skip absurdly large files; the scanners are grep-style, not parsers. */
const INVENTORY_MAX_FILE_BYTES = 512 * 1024;
/** Directories never worth walking for state-write surfaces. */
const INVENTORY_SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Writes to the shared learned-skills dir (the known legacy case). */
const LEARNED_WRITE_RE = /(?:\$HOME|\$\{HOME\}|~)\/\.claude\/skills\/learned/;
/**
 * Heuristic net for OTHER writes outside the project-scoped state roots: a write
 * verb (redirection / mkdir / cp / mv / touch / node fs write) targeting a home or
 * absolute system path. Best-effort textual detection — documented as a heuristic
 * (see {@link eccFullStateWriteInventory}); it neither parses shell nor resolves
 * variables, so it can miss obfuscated writes and (rarely) over-report.
 */
const OUTSIDE_WRITE_RE =
  /(?:>>?\s*|\btee\s+|\bmkdir\s+(?:-p\s+)?|\bcp\s+|\bmv\s+|\btouch\s+|\b(?:writeFileSync|appendFileSync|mkdirSync|createWriteStream)\s*\(\s*)["'`]?(?:\$HOME|\$\{HOME\}|~\/|\/(?:etc|usr|var|opt|root)\/)/;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect relative POSIX dir + file paths under `root` (skipping vcs / vendor dirs). */
function walkInventoryTree(root: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const childAbs = join(abs, name);
      const childRel = rel.length > 0 ? `${rel}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = statSync(childAbs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (INVENTORY_SKIP_DIRS.has(name)) continue;
        dirs.push(childRel);
        walk(childAbs, childRel);
      } else {
        files.push(childRel);
      }
    }
  };
  walk(root, "");
  return { dirs, files };
}

function readTextCapped(abs: string): string | undefined {
  // fd-based read: the size cap is enforced on the opened handle's own fstat and
  // symlinks are refused at open, so there is no check-to-read window on a path
  // discovered by the inventory walk (js/file-system-race).
  const read = readRegularFileWithStats(abs, { maxBytes: INVENTORY_MAX_FILE_BYTES });
  return read?.contents.toString("utf8");
}

/** (b) Hook definitions carried by the plugin manifest (`.claude-plugin/plugin.json`). */
function hookManifestFindings(treePath: string): EccStateWriteFinding[] {
  const manifestPath = join(treePath, ".claude-plugin", "plugin.json");
  const raw = existsSync(manifestPath) ? readTextCapped(manifestPath) : undefined;
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecordValue(parsed)) return [];
  const hooks = parsed.hooks;
  const findings: EccStateWriteFinding[] = [];
  if (Array.isArray(hooks)) {
    for (let index = 0; index < hooks.length; index += 1) {
      findings.push({
        kind: "hook-definition",
        surface: `hook-definition:plugin.json#${index}`,
        detail: `plugin manifest declares a hook (entry ${index})`,
      });
    }
  } else if (isRecordValue(hooks)) {
    for (const key of Object.keys(hooks).sort()) {
      findings.push({
        kind: "hook-definition",
        surface: `hook-definition:plugin.json#${key}`,
        detail: `plugin manifest declares a "${key}" hook`,
      });
    }
  } else if (typeof hooks === "string" && hooks.length > 0) {
    findings.push({
      kind: "hook-definition",
      surface: "hook-definition:plugin.json",
      detail: `plugin manifest references a hooks file (${hooks})`,
    });
  }
  return findings;
}

/** A script referencing either project env root is treated as compliant by detector (c). */
function mentionsEnvRoots(content: string): boolean {
  return content.includes("ECC_AGENT_DATA_HOME") || content.includes("CLV2_HOMUNCULUS_DIR");
}

function dedupeFindings(findings: readonly EccStateWriteFinding[]): EccStateWriteFinding[] {
  const seen = new Set<string>();
  const out: EccStateWriteFinding[] = [];
  for (const finding of findings) {
    if (seen.has(finding.surface)) continue;
    seen.add(finding.surface);
    out.push(finding);
  }
  return out.sort((left, right) => left.surface.localeCompare(right.surface));
}

/**
 * STATIC state-write surface inventory over the SCANNED checkout — the LABEL
 * DECISION input (D10 point 4). Three detectors:
 *  (a) the known legacy case — any `skills/continuous-learning` directory (matched
 *      by prefix), and any shell / js / ts / py file whose CONTENT writes to the
 *      shared learned-skills dir (`$HOME`/`${HOME}`/`~` + `/.claude/skills/learned`);
 *  (b) any hook definitions the plugin manifest carries ({@link hookManifestFindings});
 *  (c) a best-effort HEURISTIC net for anything ELSE writing outside the
 *      project-scoped env roots — a write verb targeting a home/absolute path
 *      ({@link OUTSIDE_WRITE_RE}), excluding scripts that reference the project env
 *      roots. Being textual, (c) does not parse shell or resolve variables, so it
 *      can miss obfuscated writes and occasionally over-report; it is intentionally
 *      conservative (one finding per file) to keep the surface set deterministic.
 * Read-only: no network, no CLI, no host mutation.
 */
export function eccFullStateWriteInventory(scannedTreePath: string): EccStateWriteFinding[] {
  if (!existsSync(scannedTreePath)) return [];
  const { dirs, files } = walkInventoryTree(scannedTreePath);
  const findings: EccStateWriteFinding[] = [];

  // (a) continuous-learning skill directories (any `skills/continuous-learning*/`).
  for (const dir of dirs) {
    if (/(?:^|\/)skills\/continuous-learning[^/]*$/.test(dir)) {
      findings.push({
        kind: "continuous-learning-skill",
        surface: `continuous-learning-skill:${dir}`,
        detail: `legacy continuous-learning skill directory present at ${dir}`,
      });
    }
  }

  // (b) hooks the plugin manifest carries.
  findings.push(...hookManifestFindings(scannedTreePath));

  // (a2) + (c) content scans over text files.
  for (const rel of files) {
    if (!INVENTORY_TEXT_EXTS.has(extname(rel).toLowerCase())) continue;
    const content = readTextCapped(join(scannedTreePath, ...rel.split("/")));
    if (content === undefined) continue;
    if (LEARNED_WRITE_RE.test(content)) {
      findings.push({
        kind: "learned-skills-write",
        surface: `learned-skills-write:${rel}`,
        detail: `writes to the shared learned-skills dir ($HOME/.claude/skills/learned) in ${rel}`,
      });
      continue; // the specific legacy case; do not double-count as a generic outside-root write
    }
    if (OUTSIDE_WRITE_RE.test(content) && !mentionsEnvRoots(content)) {
      findings.push({
        kind: "outside-root-write",
        surface: `outside-root-write:${rel}`,
        detail: `heuristic: a write targets a home/absolute path outside the project-scoped state roots in ${rel}`,
      });
    }
  }

  return dedupeFindings(findings);
}

/**
 * Compute the Full LABEL DECISION from the inventory (D10 point 4). `strict` is
 * `true` iff every found surface is excluded through a supported selection mechanism
 * ({@link EccLeanAdapterDeps.excludedSurfaces}); the remaining surfaces are
 * enumerated (sorted, deduped) as {@link EccFullLabelInput.sharedWrites}.
 */
export function computeEccFullLabel(
  findings: readonly EccStateWriteFinding[],
  excludedSurfaces: readonly string[] = [],
): EccFullLabelInput {
  const excluded = new Set(excludedSurfaces);
  const sharedWrites = [
    ...new Set(
      findings.map((finding) => finding.surface).filter((surface) => !excluded.has(surface)),
    ),
  ].sort();
  return { strict: sharedWrites.length === 0, sharedWrites };
}

// == ECC Full — connector selection + plan preview =============================

/** The connector ids a Full declaration turns ON via `mcp:<connector>: true` feature keys. */
function selectedFullConnectors(declaration: BindingDeclaration): string[] {
  const features = declaration.framework.features ?? {};
  return ECC_FULL_MCP_CONNECTORS.filter((id) => features[`mcp:${id}`] === true);
}

/** Resolve the selected connectors' validated configs from the ECC MCP catalog (D10 point 3). */
function selectedEccFullServers(declaration: BindingDeclaration): Record<string, unknown> {
  const ids = selectedFullConnectors(declaration).map((id) => `mcp:${id}` as EccMcpComponentId);
  return ids.length === 0 ? {} : selectedEccMcpServers(ids);
}

/** Predict the post-apply digest a real write would seal, without applying anything. */
function previewEccOwnership(intents: readonly ClaudeOwnershipIntent[]): BindingOwnershipEntry[] {
  return intents.map((intent) => ({
    kind: intent.kind,
    target: intent.target,
    preExisting: intent.preExisting,
    applied: intent.applied,
    postApplyDigest: sha256Hex(canonicalJson(intent.applied)),
  }));
}

/**
 * Preview the two machine-scope (`home:`) entries `bindPlugin` will record. The
 * exact local checkout path isn't knowable without I/O, so the marketplace preview
 * stands in the declared repository; the cache preview uses the declared
 * `treeDigest` — the value a successful bind MUST produce (D7). Mirrors the private
 * `previewHomeOwnership` in `superpowers.ts`.
 */
function previewEccHomeOwnership(source: BindingGitSource): BindingOwnershipEntry[] {
  const marketplaceApplied = { source: { source: "directory", path: source.repository } };
  return [
    {
      kind: "json-pointer",
      target: homeMarketplaceTarget(ECC_FULL_MARKETPLACE_NAME),
      preExisting: { absent: true },
      applied: marketplaceApplied,
      postApplyDigest: sha256Hex(canonicalJson(marketplaceApplied)),
    },
    {
      kind: "file",
      target: homePluginCacheTarget(ECC_FULL_MARKETPLACE_NAME, ECC_FULL_PLUGIN_NAME),
      preExisting: { absent: true },
      applied: source.treeDigest,
      postApplyDigest: source.treeDigest,
    },
  ];
}

/**
 * PURE Full plan preview (no disk write). Mirrors `bindPlugin`'s `enabledPlugins`
 * write, the two mandatory D18 env-root fields (D10 point 2), one owned MCP entry
 * per individually-selected connector (D10 point 3), and the two `home:` machine
 * entries. D10 point 6: the connector count + env-root fields are visible in the
 * preview so the CLI can render cost/consent before confirm.
 */
function buildEccFullPlanPreview(
  root: string,
  source: BindingGitSource,
  declaration: BindingDeclaration,
): BindingPlan {
  const settingsFile = settingsFileForScope(ECC_FULL_SCOPE);
  const pluginKey = pluginEnableKey(ECC_FULL_PLUGIN_NAME, ECC_FULL_MARKETPLACE_NAME);
  const engine = new ClaudeManagedWriteEngine(root)
    .jsonField(settingsFile, `/enabledPlugins/${pluginKey}`, true)
    .jsonField(settingsFile, ENV_AGENT_DATA_POINTER, ECC_AGENT_DATA_HOME_DEFAULT)
    .jsonField(settingsFile, ENV_HOMUNCULUS_POINTER, ECC_HOMUNCULUS_DIR_DEFAULT);
  for (const [id, config] of Object.entries(selectedEccFullServers(declaration))) {
    engine.mcpServer(id, config);
  }
  const built = engine.build();
  return {
    framework: declaration.framework.id,
    writes: built.writes,
    ownership: [...previewEccOwnership(built.ownership), ...previewEccHomeOwnership(source)],
  };
}

// == ECC Full — provision (host-plugin bind + D18 env roots + MCP connectors) ==

/**
 * The Full `provision` result — the standard `{ lock }` PLUS the LABEL DECISION
 * input (D10 point 4). Extending the result WITHOUT touching the W2 `ProvisionResult`
 * / lock schema: the adapter's `provision` still satisfies the `ProvisionResult`
 * contract, and this widened shape rides through it (a caller casts, exactly as the
 * Lean/Full remove results do). `report()` recomputes the same label by re-running
 * the inventory over the marketplace source path recorded in the lock.
 */
export interface EccFullProvisionResult extends ProvisionResult {
  labelInput: EccFullLabelInput;
}

/**
 * Default repo-relative apply seam for the Full path (env-root fields + `.mcp.json`
 * connectors + `bindPlugin`'s `enabledPlugins`). Same recipe as the private
 * `defaultApplyActions` in `superpowers.ts` (worktree gate skipped — a bind runs
 * inside a user project legitimately dirty with their own work).
 */
function defaultEccApplyActions(
  deps: EccLeanAdapterDeps,
): (root: string, actions: Action[]) => Promise<PlanResult> {
  const env = deps.env ?? {};
  const run = deps.runner;
  const host = makeHostAdapter({ platform: resolvePlatform(env), run, env });
  return (root, actions) =>
    executePlan(
      planActions("ecc-full-binding", ...actions),
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

/**
 * Re-bind carry-forward for a parent CONTAINER AIH created (`.claude/settings.json`
 * `/env`, `.mcp.json` `/mcpServers`). On first bind the container is absent, so
 * `build()` collapses its leaves into ONE parent-container ownership entry (D18
 * "own what you created"). On a re-bind the container is present, so `build()` would
 * instead record per-leaf ownership whose "pre-existing" is the FIRST bind's own
 * value — a later removal would then restore the binding rather than prune the
 * container AIH added. When the prior lock owned the container, this re-collapses
 * the fresh leaves back into that single parent-container entry, preserving the
 * original pre-existing state. A no-op without a prior lock or prior container entry
 * (the fresh-bind path). Extends `carryForwardOwnership`'s intent to the multi-field
 * container case.
 */
function recollapseOwnedContainer(
  managedPlan: ClaudeManagedPlan,
  previousLock: BindingLock | undefined,
  file: string,
  parent: string,
): void {
  if (previousLock === undefined) return;
  const parentTarget = `${file}#/${parent}`;
  const prior = previousLock.ownership.find((entry) => entry.target === parentTarget);
  if (prior === undefined) return;
  const container: Record<string, unknown> = {};
  const kept: ClaudeOwnershipIntent[] = [];
  for (const intent of managedPlan.ownership) {
    if (intent.file === file && intent.pointer !== undefined && intent.pointer[0] === parent) {
      if (intent.pointer.length === 2) {
        container[intent.pointer[1] as string] = intent.applied;
        continue;
      }
      if (intent.pointer.length === 1 && isRecordValue(intent.applied)) {
        Object.assign(container, intent.applied);
        continue;
      }
    }
    kept.push(intent);
  }
  kept.unshift({
    kind: "json-pointer",
    target: parentTarget,
    file,
    pointer: [parent],
    preExisting: prior.preExisting,
    applied: container,
  });
  managedPlan.ownership = kept;
}

/** Build the two mandatory project-scoped state-root env fields as a single D18 plan. */
function buildEccFullEnvPlan(
  root: string,
  settingsFile: string,
  previousLock: BindingLock | undefined,
): ClaudeManagedPlan {
  const built = new ClaudeManagedWriteEngine(root)
    .jsonField(settingsFile, ENV_AGENT_DATA_POINTER, ECC_AGENT_DATA_HOME_DEFAULT)
    .jsonField(settingsFile, ENV_HOMUNCULUS_POINTER, ECC_HOMUNCULUS_DIR_DEFAULT)
    .build();
  recollapseOwnedContainer(built, previousLock, settingsFile, "env");
  return built;
}

/**
 * Own each individually-selected MCP connector as a D18 `.mcp.json` entry (D10
 * point 3). No connectors selected => NO `.mcp.json` write at all. Configs come
 * straight from the ECC MCP catalog ({@link selectedEccMcpServers}), so the on-disk
 * shape is exactly what ECC's own selective installer would write.
 */
async function applyEccFullMcpConnectors(
  deps: EccLeanAdapterDeps,
  apply: (root: string, actions: Action[]) => Promise<PlanResult>,
  declaration: BindingDeclaration,
  previousLock: BindingLock | undefined,
): Promise<{ writes: BindingWrite[]; ownership: BindingOwnershipEntry[] }> {
  const servers = selectedEccFullServers(declaration);
  if (Object.keys(servers).length === 0) return { writes: [], ownership: [] };
  const engine = new ClaudeManagedWriteEngine(deps.root);
  for (const [id, config] of Object.entries(servers)) engine.mcpServer(id, config);
  const built = engine.build();
  recollapseOwnedContainer(built, previousLock, CLAUDE_MCP_PATH, CLAUDE_MCP_KEY);
  await apply(deps.root, built.actions);
  return { writes: built.writes, ownership: finalizeClaudeOwnership(deps.root, built.ownership) };
}

async function provisionEccFull(
  deps: EccLeanAdapterDeps,
  apply: (root: string, actions: Action[]) => Promise<PlanResult>,
  request: ProvisionRequest,
  disposition: ScanDisposition,
): Promise<EccFullProvisionResult> {
  const declaration = request.context.declaration;
  assertEccDeclaration(declaration);
  // Defense in depth (D8 layer 3 + D12) — the registry dispatch already guards this.
  assertProvisionAllowed(request, disposition);
  const resolved = assertGitResolved(request.resolved);
  assertResolvedMatchesDeclaration(declaration, resolved);
  // D10 point 5: refuse Full over an existing Lean lock (before any host mutation).
  assertModeMatchesExistingLock(deps.root, "full");

  const priorRead = readBindingLock(deps.root);
  const previousLock = priorRead.present ? priorRead.lock : undefined;

  // 1. Bind the ECC plugin through the W3 host services (marketplace add -> install
  //    -> D7 subtree identity -> enabledPlugins). A D7 mismatch throws before any
  //    env / mcp field or lock is touched (fail closed, no partial state).
  const bound = await bindPlugin(
    {
      disposition,
      resolved,
      plugin: ECC_FULL_PLUGIN_NAME,
      marketplace: ECC_FULL_MARKETPLACE_NAME,
      scope: ECC_FULL_SCOPE,
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

  // 2. Own the MANDATORY project-scoped state-root env fields (D18) in the SAME lock.
  const envPlan = buildEccFullEnvPlan(deps.root, bound.settingsFile, previousLock);
  await apply(deps.root, envPlan.actions);
  const envOwnership = finalizeClaudeOwnership(deps.root, envPlan.ownership);

  // 3. Own each individually-selected MCP connector in `.mcp.json` (none -> no write).
  const mcp = await applyEccFullMcpConnectors(deps, apply, declaration, previousLock);

  // 4. Assemble the lock (D7 identity from bindPlugin; the extra D18 fields ride along).
  const lock: BindingLock = {
    schemaVersion: 1,
    declaration,
    writes: [...bound.writes, ...envPlan.writes, ...mcp.writes],
    scannedDigest: bound.identity.scannedDigest,
    loadedDigest: bound.identity.loadedDigest,
    match: bound.identity.match,
    ownership: [...bound.ownership, ...envOwnership, ...mcp.ownership],
  };
  writeBindingLockAtomic(deps.root, lock);

  // 5. LABEL DECISION from the static state-write inventory over the scanned checkout.
  const labelInput = computeEccFullLabel(
    eccFullStateWriteInventory(resolved.treePath),
    deps.excludedSurfaces,
  );
  return { lock, labelInput };
}

// == ECC Full — verify / remove / report ======================================

/** Read the checkout path back out of a sealed marketplace ownership entry (see `sealHomeOwnership`). */
function marketplaceSourceFrom(entry: BindingOwnershipEntry | undefined): string {
  const applied = entry?.applied;
  if (!isRecordValue(applied)) return "";
  const source = applied.source;
  if (!isRecordValue(source)) return "";
  return typeof source.path === "string" ? source.path : "";
}

/**
 * Full `verify` — parity with the Lean path but plugin-shaped (mirrors
 * `verifySuperpowers`): reuse `planClaudeRemoval`'s drift computation READ-ONLY for
 * the repo-relative D18 fields (enabledPlugins, the two env roots, the `.mcp.json`
 * connectors), plus an independent D7 re-check of the loaded plugin cache tree.
 */
function verifyEccFull(deps: EccLeanAdapterDeps, lock: BindingLock): VerifyResult {
  const drift: string[] = [];

  const removal = planClaudeRemoval(deps.root, lock);
  for (const entry of removal.drift) drift.push(`${entry.target}: ${entry.reason}`);

  let identityOk = true;
  try {
    const pluginKey = pluginEnableKey(ECC_FULL_PLUGIN_NAME, ECC_FULL_MARKETPLACE_NAME);
    const marketplaceEntry = lock.ownership.find(
      (entry) => entry.target === homeMarketplaceTarget(ECC_FULL_MARKETPLACE_NAME),
    );
    const locate = deps.locateCache ?? defaultPluginCacheLocator;
    const loadedTreePath = locate({
      home: claudeHomeDir(deps.env ?? {}),
      marketplace: ECC_FULL_MARKETPLACE_NAME,
      plugin: ECC_FULL_PLUGIN_NAME,
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

/**
 * The Full teardown plan — mirrors `SuperpowersRemoveResult` (the host-plugin path
 * needs `plugin`/`marketplace` for `claude plugin uninstall`, unlike Lean's
 * installer teardown). The caller applies repo-relative restore FIRST, then the
 * machine-scope `removePlugin` teardown (the hard host-ordering constraint).
 */
export type EccFullRemoveResult =
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

function removeEccFull(deps: EccLeanAdapterDeps): EccFullRemoveResult {
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
    plugin: ECC_FULL_PLUGIN_NAME,
    marketplace: ECC_FULL_MARKETPLACE_NAME,
    scope: ECC_FULL_SCOPE,
  };
}

function reportEccFull(deps: EccLeanAdapterDeps, context: BindingContext): BindingReport {
  const source = context.declaration.source;
  // Selected connectors + env-root fields (D10 point 6 — CLI-render inputs),
  // available regardless of lock presence.
  const connectors = selectedFullConnectors(context.declaration);
  const sharedState: SharedStateEntry[] = [
    { label: "ECC_AGENT_DATA_HOME", kind: "state-dir", note: ECC_AGENT_DATA_HOME_DEFAULT },
    { label: "CLV2_HOMUNCULUS_DIR", kind: "state-dir", note: ECC_HOMUNCULUS_DIR_DEFAULT },
  ];
  const installMechanism = `host-plugin (project-scope plugin ${ECC_FULL_PLUGIN_NAME}@${ECC_FULL_MARKETPLACE_NAME})`;

  const read = readBindingLock(deps.root);
  if (!read.present) {
    const card = buildFrameworkCard({
      framework: "ecc",
      mode: "full",
      scope: "project",
      targetLabel: "DEFERRED",
      source,
      installMechanism,
      mcpServers: connectors,
      sharedState,
      enterpriseDisposition: "label decision: not applicable (not yet provisioned)",
    });
    return { framework: "ecc", card, lines: renderFrameworkCard(card) };
  }

  const lock = read.lock;
  const { identity } = sourceIdentityFromLock(lock);
  const { repoRelative, homeScope } = d18SurfaceLabels(lock);

  // Re-run the LABEL DECISION over the recorded marketplace source path — the
  // plumbing that carries the label input beyond provision (D10 point 4). The
  // strict/lax result is the state-containment axis (`targetLabel`); the doctor
  // still gates STRICT via DoctorCardInput.
  const marketplaceEntry = lock.ownership.find(
    (entry) => entry.target === homeMarketplaceTarget(ECC_FULL_MARKETPLACE_NAME),
  );
  const treePath = marketplaceSourceFrom(marketplaceEntry);
  let targetLabel: SupportLabel;
  let disposition: string;
  const residualRisks: string[] = [];
  let contextCost: ContextCostCard;
  let counts: FrameworkCardCounts | undefined;
  if (treePath.length > 0) {
    const label = computeEccFullLabel(eccFullStateWriteInventory(treePath), deps.excludedSurfaces);
    targetLabel = label.strict
      ? "STRICT_PROJECT_BINDING_VERIFIED"
      : "PROJECT_SELECTED_SHARED_RUNTIME";
    disposition = `label decision: ${label.strict ? "strict" : "lax"}`;
    residualRisks.push(
      `shared writes: ${label.sharedWrites.length > 0 ? label.sharedWrites.join(", ") : "(none)"}`,
    );
    try {
      const fragment = contextCostCard(estimateContextCostFromTree(treePath));
      contextCost = fragment.contextCost;
      counts = fragment.counts;
    } catch {
      contextCost = contextCostUnavailable("resolved checkout tree not estimable");
    }
  } else {
    targetLabel = "PROJECT_SELECTED_SHARED_RUNTIME";
    disposition = "label decision: unavailable (resolved checkout path not recorded)";
    contextCost = contextCostUnavailable("resolved checkout path not recorded");
  }

  const card = buildFrameworkCard({
    framework: "ecc",
    mode: "full",
    scope: "project",
    targetLabel,
    source,
    identity,
    installMechanism,
    mcpServers: connectors,
    scriptsBinariesDeps: [...repoRelative, ...homeScope],
    sharedState,
    contextCost,
    counts,
    residualRisks,
    enterpriseDisposition: disposition,
  });
  return { framework: "ecc", card, lines: renderFrameworkCard(card) };
}

// -- factory ------------------------------------------------------------------

/**
 * Widening note for `frameworks/registry.ts`: `BindingRegistryDeps` widens to also
 * carry ECC's construction deps ({@link EccLeanAdapterDeps}'s ECC-only optionals —
 * `installer`, `installPreview`, and the Full-only `excludedSurfaces`;
 * `locateCache`/`applyActions` are already shared with `SuperpowersAdapterDeps`).
 * `root`/`runner`/`env`/`cacheHome`/`timeoutMs` are shared with `SuperpowersAdapterDeps`.
 *
 * Mode routing (D10): `plan`/`provision` route on the declaration's mode
 * ({@link eccMode} — absent/`"lean"` -> Lean, `"full"` -> Full); `verify`/`remove`/
 * `report` route on the LOCK's recorded mode (the applied-state authority), falling
 * back to the declaration when no lock is present. Lean and Full share one file and
 * one `adapterType`; only the provisioning mechanics differ (D6 installer vs the
 * project-scope host-plugin path).
 */
export function createEccAdapter(deps: EccLeanAdapterDeps): FrameworkAdapter {
  const apply = deps.applyActions ?? defaultEccApplyActions(deps);

  return {
    framework: "ecc",
    adapterType: "upstream-local-installer",

    inspect(request: InspectRequest): InspectReport {
      return inspectEccTree(request);
    },

    async resolve(request: ResolveRequest): Promise<ResolvedSource> {
      // Resolution is mode-agnostic (source identity only); Full is no longer rejected.
      assertEccDeclaration(request.declaration);
      const source = assertGitSource(request.declaration.source);
      return resolveGitSource(
        { repository: source.repository, commitSha: source.commitSha },
        { runner: deps.runner, cacheHome: deps.cacheHome ?? bindingCacheHome(deps.env ?? {}) },
      );
    },

    plan(context: BindingContext): BindingPlan {
      const declaration = context.declaration;
      assertEccDeclaration(declaration);
      assertPlanAllowed(context);
      if (eccMode(declaration) === "full") {
        // Full accepts one `mcp:<connector>` key per allowlisted connector (D10 point 3).
        assertKnownFeatureKeys(declaration.framework.features, ECC_FULL_FEATURE_KEYS, "ecc");
        assertModeMatchesExistingLock(deps.root, "full");
        return buildEccFullPlanPreview(deps.root, assertGitSource(declaration.source), declaration);
      }
      // Lean accepts NO feature keys.
      assertKnownFeatureKeys(declaration.framework.features, [], "ecc");
      assertModeMatchesExistingLock(deps.root, "lean");
      return buildEccLeanPlan(deps, declaration);
    },

    async provision(
      request: ProvisionRequest,
      disposition: ScanDisposition,
    ): Promise<ProvisionResult> {
      return eccMode(request.context.declaration) === "full"
        ? provisionEccFull(deps, apply, request, disposition)
        : provisionEccLean(deps, request, disposition);
    },

    verify(context: BindingContext): VerifyResult {
      const read = readBindingLock(deps.root);
      if (
        read.present &&
        read.lock.declaration.framework.id === "ecc" &&
        eccMode(read.lock.declaration) === "full"
      ) {
        return verifyEccFull(deps, read.lock);
      }
      // Lean path also handles the no-lock case (parity: `{ ok: false, drift: ["no binding lock"] }`).
      void context;
      return verifyEccLean(deps);
    },

    remove(context: BindingContext) {
      const read = readBindingLock(deps.root);
      void context;
      if (
        read.present &&
        read.lock.declaration.framework.id === "ecc" &&
        eccMode(read.lock.declaration) === "full"
      ) {
        return removeEccFull(deps);
      }
      // Lean path also handles the no-lock case (parity: drift-report-only).
      return removeEccLean(deps);
    },

    report(context: BindingContext): BindingReport {
      const read = readBindingLock(deps.root);
      const mode =
        read.present && read.lock.declaration.framework.id === "ecc"
          ? eccMode(read.lock.declaration)
          : eccMode(context.declaration);
      return mode === "full" ? reportEccFull(deps, context) : reportEccLean(deps, context);
    },
  };
}
