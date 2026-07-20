import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { baselineCatalogById } from "../../baseline-evidence/catalogs.js";
import {
  type EccInstallPreviewArtifact,
  parseEccInstallPreview,
  readEccInstallPreview,
} from "../../ecc/install-preview.js";
import { AihError } from "../../errors.js";
import type { Action } from "../../internals/plan.js";
import type { Runner } from "../../internals/proc.js";
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
import { assertKnownFeatureKeys } from "../features.js";
import {
  type ClaudeDriftEntry,
  claudeHomeDir,
  estimateContextCostFromTree,
  HOME_OWNERSHIP_PREFIX,
  isHomeScopedTarget,
  planClaudeRemoval,
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
 * the W2 lock. W4c adds the Full variant to THIS file — the mode switch on
 * `declaration.framework.mode` already routes lean/full; full currently throws a
 * typed not-implemented error.
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

/** The requested ECC mode is recognized but not yet implemented in this file (Full is W4c). */
export class EccModeNotImplementedError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_ECC_MODE");
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

/** Route on `declaration.framework.mode`: absent or "lean" -> lean; "full" -> typed not-implemented. */
function assertLeanMode(declaration: BindingDeclaration): void {
  const mode = declaration.framework.mode;
  if (mode === undefined || mode === "lean") return;
  if (mode === "full") {
    throw new EccModeNotImplementedError(
      'ECC Full mode is not implemented yet (W4c); only Lean (mode: "lean" or absent) is supported',
    );
  }
  // Any other value is already rejected by the declaration schema; fail closed regardless.
  throw new EccModeNotImplementedError(`unsupported ECC mode "${mode}"`);
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

async function provisionEccLean(
  deps: EccLeanAdapterDeps,
  request: ProvisionRequest,
  disposition: ScanDisposition,
): Promise<ProvisionResult> {
  const declaration = request.context.declaration;
  assertEccDeclaration(declaration);
  assertLeanMode(declaration);
  // Defense in depth (D8 layer 3 + D12) — the registry dispatch already guards this.
  assertProvisionAllowed(request, disposition);
  const resolved = assertGitResolved(request.resolved);
  assertResolvedMatchesDeclaration(declaration, resolved);

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
  const lines: string[] = [];
  const source = context.declaration.source;
  const pin =
    source.kind === "git"
      ? `${source.repository}@${source.commitSha}`
      : `${source.package}@${source.exactVersion}`;
  lines.push("framework: ecc");
  lines.push("mode: lean");
  lines.push(`pin: ${pin}`);
  lines.push(`allowlist: ${ECC_LEAN_ALLOWLIST.join(", ")}`);
  lines.push(`excluded: ${ECC_LEAN_EXCLUDED.join(", ")}`);

  const home = claudeHomeDir(deps.env ?? {});
  const read = readBindingLock(deps.root);
  if (!read.present) {
    lines.push("binding lock: absent (not yet provisioned)");
    lines.push("runtime-surface absence: not applicable (not yet provisioned)");
    return { framework: "ecc", lines };
  }

  const lock = read.lock;
  lines.push(`scannedDigest: ${lock.scannedDigest}`);
  lines.push(`loadedDigest: ${lock.loadedDigest}`);
  lines.push(`match: ${String(lock.match)}`);
  const installedComponents = lock.ownership
    .map((entry) =>
      isHomeScopedTarget(entry.target)
        ? entry.target.slice(HOME_OWNERSHIP_PREFIX.length)
        : entry.target,
    )
    .sort();
  lines.push(
    `installed surfaces: ${installedComponents.length > 0 ? installedComponents.join(", ") : "(none)"}`,
  );

  const present = runtimeSurfacePresences(home);
  lines.push(
    present.length === 0
      ? "runtime-surface absence: attested (no hooks, no MCP servers, no learned skills)"
      : `runtime-surface absence: VIOLATED — present: ${present.join(", ")}`,
  );

  const claudeTree = join(home, ".claude");
  try {
    const cost = estimateContextCostFromTree(claudeTree);
    lines.push(
      `context-cost estimate (${cost.evidence}, labeled estimate): ~${cost.projectedTokens} tokens ` +
        `(skills ${cost.counts.skills}, agents ${cost.counts.agents}, commands ${cost.counts.commands}, ` +
        `rules ${cost.counts.rules}, hooks ${cost.counts.hooks}, mcpServers ${cost.counts.mcpServers})`,
    );
  } catch (err) {
    lines.push(
      `context-cost estimate: unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  return { framework: "ecc", lines };
}

// -- factory ------------------------------------------------------------------

/**
 * Widening note for `frameworks/registry.ts`: `BindingRegistryDeps` widens to also
 * carry ECC's construction deps ({@link EccLeanAdapterDeps}'s ECC-only optionals —
 * `installer`, `installPreview`). `root`/`runner`/`env`/`cacheHome`/`timeoutMs` are
 * shared with `SuperpowersAdapterDeps`.
 */
export function createEccAdapter(deps: EccLeanAdapterDeps): FrameworkAdapter {
  return {
    framework: "ecc",
    adapterType: "upstream-local-installer",

    inspect(request: InspectRequest): InspectReport {
      return inspectEccTree(request);
    },

    async resolve(request: ResolveRequest): Promise<ResolvedSource> {
      assertEccDeclaration(request.declaration);
      assertLeanMode(request.declaration);
      const source = assertGitSource(request.declaration.source);
      return resolveGitSource(
        { repository: source.repository, commitSha: source.commitSha },
        { runner: deps.runner, cacheHome: deps.cacheHome ?? bindingCacheHome(deps.env ?? {}) },
      );
    },

    plan(context: BindingContext): BindingPlan {
      assertEccDeclaration(context.declaration);
      assertPlanAllowed(context);
      assertKnownFeatureKeys(context.declaration.framework.features, [], "ecc");
      assertLeanMode(context.declaration);
      return buildEccLeanPlan(deps, context.declaration);
    },

    async provision(
      request: ProvisionRequest,
      disposition: ScanDisposition,
    ): Promise<ProvisionResult> {
      return provisionEccLean(deps, request, disposition);
    },

    verify(_context: BindingContext): VerifyResult {
      return verifyEccLean(deps);
    },

    remove(_context: BindingContext) {
      return removeEccLean(deps);
    },

    report(context: BindingContext): BindingReport {
      return reportEccLean(deps, context);
    },
  };
}
