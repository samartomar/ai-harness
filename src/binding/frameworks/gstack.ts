import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AihError } from "../../errors.js";
import { executePlan, type PlanResult } from "../../internals/execute.js";
import { readIfExists } from "../../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../../internals/merge.js";
import { type Action, plan as planActions, writeJson, writeText } from "../../internals/plan.js";
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
import { assertKnownFeatureKeys } from "../features.js";
import {
  type ClaudeDriftEntry,
  type ClaudeManagedPlan,
  ClaudeManagedWriteEngine,
  type ClaudeOwnershipIntent,
  claudeHomeDir,
  estimateContextCostFromTree,
  finalizeClaudeOwnership,
  HOME_OWNERSHIP_PREFIX,
  isHomeScopedTarget,
  type PinnedSkillInventory,
  planClaudeRemoval,
  queueSkillDenyList,
  skillDenyListReport,
} from "../hosts/claude/index.js";
import { CLAUDE_SETTINGS_PATH, canonicalJson, sha256Hex } from "../hosts/claude/surfaces.js";
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
 * The gstack `FrameworkAdapter` (W5) — the FIRST D6 `adapterType:
 * "shared-runtime"`. gstack installs its skills at USER scope
 * (`~/.claude/skills/…`), which the Claude host loads into EVERY project; this
 * adapter is the orchestration layer that makes that shared runtime
 * project-selected: a user-scope `skillOverrides` deny of the full pinned skill
 * inventory (born-hidden everywhere), a project-scope re-enable in the bound
 * project only, an unconditional hook strip, and a lockdown config confined to
 * a project GSTACK_HOME. It composes the W3 host services
 * (`queueSkillDenyList`/`skillDenyListReport`, the root-parameterized
 * `ClaudeManagedWriteEngine`, `planClaudeRemoval`, the `home:` ownership
 * convention) and INVOKES the upstream installer through an injectable seam —
 * it reimplements nothing the D11 spike proved (D9: upstream installers
 * invoked, never reimplemented).
 *
 * Grounded in the D11 spike record (gate PASS, 2026-07-22) and the committed
 * W5-ADAPTER-DESIGN. Standing facts this file encodes:
 *  - the deny list MUST live at user scope (`~/.claude/settings.json#/skillOverrides`,
 *    one `"off"` per tree-derived identity) because an unbound repository has no
 *    project settings to hide with; the bound project re-enables via a
 *    project-scope `skillOverrides` (`"on"` per identity);
 *  - reality created 54 identities on the real install, not the modeled 55:
 *    `gstack-connect-chrome` is a CONDITIONAL back-compat alias — reconciliation
 *    tolerates it absent from reality, never absent from the deny;
 *  - the install materializes the FULL post-build checkout (node_modules, build
 *    outputs, `.git`) under `~/.claude/skills/gstack` — excluded from D7
 *    identity, DISCLOSED on the Framework Card, teardown-owned;
 *  - the hook strip matches by install-path/substring across ALL events plus
 *    `_gstack_source` tags, NEVER tag-only (the legacy team SessionStart hook is
 *    untagged and would survive a tag-only strip);
 *  - lockdown config keys are written LITERALLY into the project GSTACK_HOME
 *    (`gstack-config get` falls back to defaults that drift, several wrong);
 *  - office-hours conditions carry a permanent runtime-test obligation:
 *    `codex_reviews: disabled` by default and no codex invocation shape in any
 *    written surface (the spike's live probe is the acceptance-time template).
 */

/** Adapter-local fail-closed error: wrong framework/source routed here, profile
 * mismatch, readiness failure, installer failure, reconciliation failure, or a
 * D7 installed-subset identity mismatch. */
export class GstackBindingError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_GSTACK");
  }
}

// -- Pinned constants ---------------------------------------------------------

/** The pinned git source location (`owner/repo` shape; see `isPlausibleGitRepository`). */
export const GSTACK_REPOSITORY = "garrytan/gstack";

/**
 * garrytan/gstack pin — the maintainer-locked commit this binding is pinned to.
 * MIRRORS (deliberately does not import) the "garrytan"/"gstack" entry in
 * `src/internals/baseline-sources.ts` — the same commit the W5 scan/spike
 * evidence and the shipped scan-acceptance entries bind. Mirrored rather than
 * imported for the same reasons as `SUPERPOWERS_PIN_COMMIT`: the binding pin is
 * a DELIBERATE, independently-reviewed value — if the shared baseline pin ever
 * moves, this constant must be updated explicitly in the same review, never
 * silently follow.
 */
export const GSTACK_PIN_COMMIT = "11de390be1be6849eb9a15f91ff4922dd16c589a";

/**
 * The sha256 tree digest of the pinned checkout (mirrors the W5 scan pin;
 * independently reviewed, never silently follows another module). Feeds
 * {@link GSTACK_PINNED_SKILL_INVENTORY}'s `sourceDigest` so deny-list freshness
 * is tied to the exact scanned tree.
 */
export const GSTACK_PIN_TREE_DIGEST =
  "2794ea4b1e3e01bbbbf8fb4def9d1fe7da1d713f5d2ad12a4b659aff7b40b62e";

/**
 * The RULED selected-profile closure id — the profile string a branded
 * disposition's `closure.profile` must carry for gstack provisioning. This is
 * the closure identity of the setup invocation in
 * {@link GSTACK_SETUP_COMMAND}; `provision` asserts the match BEFORE any side
 * effect (a disposition scanned under a different profile — or a legacy
 * full-tree disposition with no closure — authorizes a DIFFERENT runtime
 * closure and must never drive this install).
 */
export const GSTACK_SELECTED_PROFILE = "claude:prefix:quiet:no-plan-tune-hooks";

/**
 * The exact upstream installer invocation for the selected profile. `--prefix`
 * is REQUIRED (the quiet/non-interactive path otherwise defaults to FLAT skill
 * names like `/qa`); `--quiet --no-plan-tune-hooks` is the ruled zero-hook
 * install. Spawned through bash with `GSTACK_HOME=<project state dir>` in the
 * environment by the default {@link GstackInstaller}.
 */
export const GSTACK_SETUP_COMMAND: readonly string[] = [
  "bash",
  "./setup",
  "--host",
  "claude",
  "--prefix",
  "--quiet",
  "--no-plan-tune-hooks",
];

/** The 53 prefixed wrapper identities of the pinned tree (top-level SKILL.md
 * skill dirs after the `--prefix` name patch), per the W5 harness design 1.5. */
const GSTACK_PREFIXED_IDENTITIES: readonly string[] = [
  "gstack-autoplan",
  "gstack-benchmark",
  "gstack-benchmark-models",
  "gstack-browse",
  "gstack-canary",
  "gstack-careful",
  "gstack-codex",
  "gstack-context-restore",
  "gstack-context-save",
  "gstack-cso",
  "gstack-design-consultation",
  "gstack-design-html",
  "gstack-design-review",
  "gstack-design-shotgun",
  "gstack-devex-review",
  "gstack-diagram",
  "gstack-document-generate",
  "gstack-document-release",
  "gstack-freeze",
  "gstack-guard",
  "gstack-health",
  "gstack-investigate",
  "gstack-ios-clean",
  "gstack-ios-design-review",
  "gstack-ios-fix",
  "gstack-ios-qa",
  "gstack-ios-sync",
  "gstack-land-and-deploy",
  "gstack-landing-report",
  "gstack-learn",
  "gstack-make-pdf",
  "gstack-office-hours",
  "gstack-open-gstack-browser",
  "gstack-pair-agent",
  "gstack-plan-ceo-review",
  "gstack-plan-design-review",
  "gstack-plan-devex-review",
  "gstack-plan-eng-review",
  "gstack-plan-tune",
  "gstack-qa",
  "gstack-qa-only",
  "gstack-retro",
  "gstack-review",
  "gstack-scrape",
  "gstack-setup-browser-cookies",
  "gstack-setup-deploy",
  "gstack-setup-gbrain",
  "gstack-ship",
  "gstack-skillify",
  "gstack-spec",
  "gstack-sync-gbrain",
  "gstack-unfreeze",
  "gstack-upgrade",
];

/**
 * Identities whose CREATION is conditional on the real host (measured, D11 R3):
 * `gstack-connect-chrome` is a back-compat alias created only on legacy
 * migration. Reconciliation tolerates a conditional identity ABSENT FROM
 * REALITY; it is never absent from the deny (the inventory stays the superset —
 * fail-closed).
 */
export const GSTACK_CONDITIONAL_IDENTITIES: ReadonlySet<string> = new Set([
  "gstack-connect-chrome",
]);

/**
 * The pinned 55-identity skill inventory: 53 prefixed wrapper dirs + the
 * `gstack` root alias + the conditional `gstack-connect-chrome`, bound to the
 * pinned tree digest. The deny list is REGENERATED from the freshly resolved
 * tree on every bind ({@link deriveGstackSkillInventory}) because an
 * added/renamed upstream skill defaults to ON and leaks; this constant is the
 * reviewed pinned-tree expectation the derivation is cross-checked against when
 * the resolved digest equals the pin.
 */
export const GSTACK_PINNED_SKILL_INVENTORY: PinnedSkillInventory = {
  names: [...GSTACK_PREFIXED_IDENTITIES, "gstack", "gstack-connect-chrome"],
  sourceDigest: GSTACK_PIN_TREE_DIGEST,
};

/** The root-alias wrapper directory (frontmatter `name: gstack`, never prefixed). */
export const GSTACK_ROOT_ALIAS_DIR = "_gstack-command";

/** `<home>/.claude/skills` — the user-scope skills root (repo-style POSIX). */
const GSTACK_SKILLS_DIR_REL = ".claude/skills";

/** `<home>/.claude/skills/gstack` — the whole-checkout install root the global
 * branch materializes (incl. node_modules/build outputs/`.git`). */
export const GSTACK_INSTALL_ROOT_REL = `${GSTACK_SKILLS_DIR_REL}/gstack`;

/** Repo-relative project GSTACK_HOME (gitignored `.aih/` territory — the same
 * machine-state root the binding lock lives in), so `~/.gstack`-class state
 * never accumulates in the shared user home. */
export const GSTACK_HOME_REL = ".aih/gstack/home";

/** The literal lockdown config file inside the project GSTACK_HOME. */
export const GSTACK_CONFIG_REL = `${GSTACK_HOME_REL}/config.yaml`;

/** Derived machine record of the D7 installed-subset identity (rebuildable;
 * verify re-checks per-file digests against it). */
export const GSTACK_MANIFEST_REL = ".aih/gstack/installed-manifest.json";

/** Ownership target recording the hook-strip result (a RECORD of removed
 * fragments — removal never restores stripped gstack hooks). */
export const GSTACK_HOOK_STRIP_TARGET = `${HOME_OWNERSHIP_PREFIX}.claude/settings.json#/hooks`;

// -- Feature keys (the three EXPLICIT USER CHOICES) ---------------------------

/** The only feature keys gstack accepts; any other key fails closed at plan time. */
export const GSTACK_FEATURE_KEYS: readonly string[] = [
  "codexReviews",
  "proactive",
  "browserAutomation",
];

export interface GstackChoices {
  /** false (default) => `codex_reviews: disabled`; true => `codex_reviews: enabled`. */
  codexReviews: boolean;
  /** false (default) => `proactive: false`; true => `proactive: true` (R12: upstream default is true). */
  proactive: boolean;
  /** R13: no config key located — false (default) leaves the browse binary
   * unlaunched; the choice is recorded on the Framework Card only. */
  browserAutomation: boolean;
}

function gstackChoices(declaration: BindingDeclaration): GstackChoices {
  const features = declaration.framework.features ?? {};
  return {
    codexReviews: features.codexReviews ?? false,
    proactive: features.proactive ?? false,
    browserAutomation: features.browserAutomation ?? false,
  };
}

/**
 * The literal lockdown config (D11 — written explicitly, never inherited:
 * `gstack-config get` falls back to defaults that drift, and `update_check`,
 * `cross_project_learnings`, `plan_tune_hooks`, and `skill_prefix` default
 * WRONG for this posture). Key order mirrors the spike's P9 evidence exactly.
 */
export const GSTACK_LOCKDOWN_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ["telemetry", "off"],
  ["auto_upgrade", "false"],
  ["update_check", "false"],
  ["cross_project_learnings", "false"],
  ["artifacts_sync_mode", "off"],
  ["plan_tune_hooks", "no"],
  ["checkpoint_mode", "explicit"],
  ["checkpoint_push", "false"],
  ["skill_prefix", "true"],
];

/** Render the literal `config.yaml` content (lockdown keys + the two user
 * choices that HAVE config keys; `browserAutomation` has none — R13). */
export function gstackLockdownConfigYaml(choices: GstackChoices): string {
  const lines = GSTACK_LOCKDOWN_ENTRIES.map(([key, value]) => `${key}: ${value}`);
  lines.push(`codex_reviews: ${choices.codexReviews ? "enabled" : "disabled"}`);
  lines.push(`proactive: ${choices.proactive ? "true" : "false"}`);
  return `${lines.join("\n")}\n`;
}

// -- Name patch + inventory derivation ----------------------------------------

/**
 * The deterministic `--prefix` name patch (mirrors `bin/gstack-patch-names`):
 * rewrite the first frontmatter `name: <cur>` line to `name: gstack-<cur>`,
 * skipping `name: gstack` and already-`gstack-*` names. AIH replicates this
 * one-line rule for D7 expectations; no gstack code runs to compute it.
 */
export function applyGstackNamePatch(content: string): string {
  return content.replace(/^(name:[ \t]*)([^\r\n]+)$/m, (whole, prefix: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed === "gstack" || trimmed.startsWith("gstack-")) return whole;
    return `${prefix}gstack-${trimmed}`;
  });
}

/** Apply the patch rule to a NAME (dir/frontmatter identity), not file content. */
function patchIdentity(name: string): string {
  return name === "gstack" || name.startsWith("gstack-") ? name : `gstack-${name}`;
}

/** First frontmatter-style `name:` line of a SKILL.md, or undefined. */
function frontmatterName(content: string): string | undefined {
  const match = /^name:[ \t]*([^\r\n]+)$/m.exec(content);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Fail closed on a derived identity unusable as an exact deny-list key (the
 * same shape `assertSafeSkillName` refuses downstream — refused HERE so a
 * hostile tree name aborts derivation before anything is queued). */
function assertDerivedIdentity(name: string): void {
  if (name.length === 0 || name === "__proto__" || name === "prototype" || name === "constructor") {
    throw new GstackBindingError(`refusing unsafe derived skill identity ${JSON.stringify(name)}`);
  }
  if (name.includes("/") || name.includes("~")) {
    throw new GstackBindingError(
      `refusing derived skill identity with a JSON-pointer metacharacter: ${JSON.stringify(name)}`,
    );
  }
  for (const char of name) {
    if (char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) {
      throw new GstackBindingError(
        `refusing control/space character in derived skill identity ${JSON.stringify(name)}`,
      );
    }
  }
}

/**
 * Regenerate the skill inventory from a freshly resolved tree (P5 machinery —
 * bind/update/doctor all re-derive so an added/renamed upstream skill can never
 * default-ON leak past a stale deny list). Identities: one per top-level
 * `<dir>/SKILL.md` keyed by frontmatter `name:` (dir-name fallback) with the
 * deterministic prefix patch applied, plus the `gstack` root alias and the
 * conditional `gstack-connect-chrome`. `sourceDigest` is the resolved tree
 * digest, tying deny-list freshness to the exact scanned bytes.
 */
export function deriveGstackSkillInventory(resolved: ResolvedGitSource): PinnedSkillInventory {
  const prefixed = new Set<string>();
  let dirNames: string[];
  try {
    dirNames = readdirSync(resolved.treePath).sort();
  } catch (err) {
    throw new GstackBindingError(
      `cannot derive gstack skill inventory — resolved tree unreadable: ${(err as Error).message}`,
    );
  }
  for (const dir of dirNames) {
    const full = join(resolved.treePath, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMd = join(full, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const name = frontmatterName(readFileSync(skillMd, "utf8")) ?? dir;
    const identity = patchIdentity(name);
    assertDerivedIdentity(identity);
    prefixed.add(identity);
  }
  const names = [...prefixed].sort();
  if (!prefixed.has("gstack")) names.push("gstack");
  for (const conditional of GSTACK_CONDITIONAL_IDENTITIES) {
    if (!prefixed.has(conditional)) names.push(conditional);
  }
  return { names, sourceDigest: resolved.treeDigest };
}

/** Wrapper directory for an identity: the root alias lives in `_gstack-command`;
 * every prefixed identity's wrapper dir equals the identity. */
function wrapperDirFor(identity: string): string {
  return identity === "gstack" ? GSTACK_ROOT_ALIAS_DIR : identity;
}

// -- D7 installed-subset identity ---------------------------------------------

function sha256HexOfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Committed source files that the pinned upstream build REGENERATES in place
 * (measured against the real setup, W5 adapter-acceptance 2026-07-22): gstack's
 * `./setup` runs `bun run build` (`gen:llms-txt`, `gen:skill-docs --host all`)
 * BEFORE the install copy, rewriting these committed files from the scanned
 * SKILL.md frontmatter. Every one is NON-loaded by Claude — the `llms.txt`
 * index sits inside the R4-skipped `~/.claude/skills/gstack` root; `agents/` are
 * OpenAI-platform manifests; `openclaw/` is OpenClaw-host content;
 * `proactive-suggestions.json` is gstack runtime data — so none reaches the
 * claude skill loader. They are EXCLUDED from D7 byte-identity (their bytes are
 * a deterministic function of the already-identity-verified SKILL.md inputs and
 * the pinned build), PRESENCE-checked (deletion is still a mismatch), and
 * disclosed on the Framework Card. Gitignored build outputs (compiled binaries,
 * per-host doc dirs, vendored xterm) are already outside the scanned inventory.
 */
export function isGstackInstallGenerated(rel: string): boolean {
  const posix = rel.replace(/\\/g, "/");
  return (
    posix === "gstack/llms.txt" ||
    posix === "scripts/proactive-suggestions.json" ||
    posix.startsWith("agents/") ||
    posix.startsWith("openclaw/")
  );
}

/** One per-file record of the installed-subset manifest (actual installed bytes). */
export interface GstackManifestEntry {
  path: string;
  sha256: string;
  /** True for build-regenerated committed files: present-checked, never content-pinned. */
  generated?: boolean;
}

export interface GstackInstalledIdentity {
  /** Equals the resolved tree digest on a faithful install; a distinct subset
   * digest otherwise (so the lock's `match` invariant stays honest). */
  loadedDigest: string;
  /** Per-file deviations (`missing:<rel>` / `content:<rel>`), empty when faithful. */
  mismatches: string[];
  /** Actual installed digests for every inventory file present (verify's baseline). */
  manifest: GstackManifestEntry[];
}

/**
 * The D7 identity for a shared-runtime install: the INSTALLED
 * `~/.claude/skills/gstack` subtree RESTRICTED to the scanned file inventory,
 * compared as EXACT scanned bytes.
 *
 * Measured against the real upstream setup (W5 adapter-acceptance, 2026-07-22):
 * the global-branch install does a verbatim whole-tree `cp -R` of the source
 * into `~/.claude/skills/gstack` BEFORE `gstack-patch-names` runs, and
 * patch-names mutates the SOURCE (then the wrappers are linked from it) — so
 * the install-root copy is UNPATCHED and must equal the scanned bytes exactly,
 * including every top-level `<dir>/SKILL.md`. The `gstack-` name prefix lives
 * only in the SEPARATE wrapper dirs (`~/.claude/skills/gstack-<name>/`), which
 * are NOT in the scanned inventory; the reconciliation step already proves the
 * wrapper SET equals the derived inventory.
 *
 * Two exclusion classes (both disclosed on the card): files the install
 * materializes OUTSIDE the inventory (node_modules, build outputs, `.git`) are
 * never seen here; committed files the pinned build REGENERATES in place
 * ({@link isGstackInstallGenerated} — all non-Claude-loaded) are present-checked
 * but not byte-compared, since their bytes are a deterministic function of the
 * identity-verified SKILL.md inputs.
 *
 * When every inventory file is present and every NON-generated file is
 * byte-equal, the loaded+static subset is content-identical to the scanned tree
 * and `loadedDigest` IS the resolved tree digest (the lock's
 * `match === (scannedDigest === loadedDigest)` invariant holds honestly). Any
 * deviation yields a distinct manifest digest instead, so `match` is false.
 */
export function gstackInstalledSubsetIdentity(
  resolved: ResolvedGitSource,
  installRootAbs: string,
): GstackInstalledIdentity {
  const files = resolved.files;
  if (files === undefined || files.length === 0) {
    throw new GstackBindingError(
      "cannot compute gstack installed-subset identity — resolved source carries no file inventory",
    );
  }
  const mismatches: string[] = [];
  const manifest: GstackManifestEntry[] = [];
  for (const rel of [...files].sort()) {
    const installedPath = join(installRootAbs, rel);
    if (!existsSync(installedPath)) {
      mismatches.push(`missing:${rel}`);
      continue;
    }
    const installed = readFileSync(installedPath);
    const generated = isGstackInstallGenerated(rel);
    manifest.push({
      path: rel,
      sha256: sha256HexOfBytes(installed),
      ...(generated ? { generated: true } : {}),
    });
    if (generated) continue; // build-regenerated committed file: presence proven, content not pinned
    const scanned = readFileSync(join(resolved.treePath, rel));
    if (!installed.equals(scanned)) mismatches.push(`content:${rel}`);
  }
  const loadedDigest =
    mismatches.length === 0
      ? resolved.treeDigest
      : sha256Hex(canonicalJson({ subset: manifest, deviations: mismatches }));
  return { loadedDigest, mismatches, manifest };
}

// -- Hook stripping (path/substring across ALL events + tags, never tag-only) --

/** True when a hook command string is gstack-attributable (install-path
 * substring or the untagged `gstack-session-update` shape). */
function commandMatchesGstack(command: string): boolean {
  const posix = command.replace(/\\/g, "/");
  return posix.includes(".claude/skills/gstack") || posix.includes("gstack-session-update");
}

export interface GstackHookStripResult {
  /** True when at least one fragment was removed (a write-back is required). */
  changed: boolean;
  /** The post-strip `hooks` value, or undefined when the strip emptied it. */
  nextHooks: Record<string, unknown> | undefined;
  /** Every removed fragment, keyed by event (the lock-recorded shapes). */
  fragments: Record<string, unknown[]>;
  removedCount: number;
}

/**
 * Pure strip of every gstack hook shape from a parsed settings object, across
 * ALL events: any group tagged `_gstack_source` (shape B, any tag value), any
 * group whose commands ALL match the install path/`gstack-session-update`
 * substring (shape A — the UNTAGGED legacy team SessionStart), and any
 * matching item inside a mixed group (the group survives with its non-gstack
 * items). Never tag-only: a tag-only strip silently leaves the untagged team
 * hook firing a background `git pull` + `./setup -q` in every project.
 */
export function stripGstackHooks(settings: unknown): GstackHookStripResult {
  const none: GstackHookStripResult = {
    changed: false,
    nextHooks: undefined,
    fragments: {},
    removedCount: 0,
  };
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return none;
  const hooks = settings.hooks;
  const fragments: Record<string, unknown[]> = {};
  const nextHooks: Record<string, unknown> = {};
  let removedCount = 0;
  const fragment = (event: string, shape: unknown): void => {
    const list = fragments[event] ?? [];
    list.push(shape);
    fragments[event] = list;
    removedCount += 1;
  };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isPlainObject(group)) {
        kept.push(group);
        continue;
      }
      if (group._gstack_source !== undefined) {
        fragment(event, group);
        continue;
      }
      const items = group.hooks;
      if (Array.isArray(items) && items.length > 0) {
        const matches = (item: unknown): boolean =>
          isPlainObject(item) &&
          typeof item.command === "string" &&
          commandMatchesGstack(item.command);
        const removed = items.filter(matches);
        if (removed.length === items.length) {
          fragment(event, group);
          continue;
        }
        if (removed.length > 0) {
          fragment(event, { ...group, hooks: removed });
          kept.push({ ...group, hooks: items.filter((item) => !matches(item)) });
          continue;
        }
      }
      kept.push(group);
    }
    // An event array we emptied is dropped entirely; one that was already
    // empty (or untouched) is preserved verbatim.
    if (kept.length > 0 || groups.length === 0) nextHooks[event] = kept;
  }
  if (removedCount === 0) return none;
  return {
    changed: true,
    nextHooks: Object.keys(nextHooks).length > 0 ? nextHooks : undefined,
    fragments,
    removedCount,
  };
}

// -- Installer seam ------------------------------------------------------------

export interface GstackInstallInput {
  resolved: ResolvedGitSource;
  /** Project root. */
  root: string;
  /** Machine home (`~`) — a fixture temp dir in tests. */
  home: string;
  /** Absolute project-scoped GSTACK_HOME the installer must confine state to. */
  gstackHomeAbs: string;
  /** The subprocess seam. */
  runner: Runner;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface GstackInstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The one seam upstream code is invoked through — a fake in every unit test. */
export type GstackInstaller = (input: GstackInstallInput) => Promise<GstackInstallResult>;

/**
 * The default REAL installer: stages a PRISTINE WORK COPY of the resolved
 * checkout under a scratch dir, then bash-spawns the exact selected profile
 * ({@link GSTACK_SETUP_COMMAND}) from the copy with
 * `GSTACK_HOME=<project state dir>` so global state lands in the project, not
 * `~/.gstack`. The staging is load-bearing (W5 spike lesson): upstream setup
 * runs `bun install` + a build IN ITS CWD, and running it inside the pinned
 * cache checkout would dirty the cache and change the next resolve's digest.
 * The scratch parent's basename is never `skills`, so upstream's global-branch
 * install selection is preserved. The stage is removed afterwards; full
 * stdout/stderr are captured for the provision record. Only the
 * orchestrator-driven acceptance phase runs this against a real host; unit
 * tests always inject a fixture installer. Exported for the focused staging
 * unit test only — production callers go through {@link createGstackAdapter}.
 */
export const defaultGstackInstaller: GstackInstaller = async (input) => {
  const stage = mkdtempSync(join(tmpdir(), "aih-gstack-setup-"));
  // Stage cleanup is BEST-EFFORT with Windows EPERM retry semantics (the
  // copied .git pack files are read-only; node's rm chmod-retries them). A
  // stubborn scratch dir must never fail a successful install — the leftover
  // is annotated on the returned stderr instead of thrown (no silent failure).
  const cleanupStage = (): string | undefined => {
    try {
      rmSync(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return undefined;
    } catch (error) {
      return `[aih] stage cleanup left ${stage}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  try {
    cpSync(input.resolved.treePath, stage, { recursive: true });
    const result = await input.runner([...GSTACK_SETUP_COMMAND], {
      cwd: stage,
      env: { ...input.env, GSTACK_HOME: input.gstackHomeAbs },
      timeoutMs: input.timeoutMs,
    });
    const leftover = cleanupStage();
    return {
      exitCode: result.code ?? 1,
      stdout: result.stdout,
      stderr: leftover === undefined ? result.stderr : `${result.stderr}\n${leftover}`,
    };
  } catch (error) {
    cleanupStage();
    throw error;
  }
};

// -- Deps + remove result ------------------------------------------------------

export interface GstackAdapterDeps {
  /** Project root the repo-relative D18 surfaces are owned under. */
  root: string;
  /** The subprocess seam (readiness probes + the default installer). */
  runner: Runner;
  /** Environment (home-dir resolution for machine-scope surfaces). Defaults to `{}`. */
  env?: NodeJS.ProcessEnv;
  /** Git checkout cache root for `resolve()`. Defaults to `bindingCacheHome(env)`. */
  cacheHome?: string;
  /** The upstream-installer seam. Defaults to the real bash spawn — tests inject fakes. */
  installGstack?: GstackInstaller;
  /** Injectable apply seam for managed writes (root-parameterized: project AND home). */
  applyActions?: (root: string, actions: Action[]) => Promise<PlanResult>;
  /** Per-call timeout override threaded to the installer. */
  timeoutMs?: number;
}

/**
 * `remove()` stays SYNCHRONOUS (the D6 contract) — it PLANS the teardown. The
 * caller applies an "apply"-mode result in EXACTLY this order (the spike's
 * proven teardown order), then deletes the binding lock itself:
 *
 *  1. repo-relative restore: `executePlan(plan("...", ...repoRelativeActions), ctx(root))`
 *     — restores the project re-enables, the CLAUDE.md fence, the lockdown
 *     config, and the manifest record;
 *  2. home restore: `executePlan(plan("...", ...homeActions), ctx(home))` —
 *     conservative deny-key restoration in `~/.claude/settings.json` (byte-exact
 *     pre-existing values; drifted keys preserved + reported in `homeDrift`);
 *  3. home deletions: recursively delete each `homeDeletionsRel` dir (the
 *     install root incl. deps/build/git metadata, every wrapper dir, aliases)
 *     and each `settingsBackupsRel` file (gstack collaterals), then clean
 *     `tempPatterns` (`/tmp/gstack-*`);
 *  4. project state: delete `gstackHomeRel`/`stateDirsRel` dirs (per ownership);
 *  5. drop the binding lock (mirrors the W3 roundtrip precedent).
 *
 * The hook-strip RECORD entry is never restored — removed gstack hooks stay
 * removed. `"drift-report-only"` mirrors `planBindingRemoval`.
 */
export type GstackRemoveResult =
  | { mode: "drift-report-only"; reason: string }
  | {
      mode: "apply";
      repoRelativeActions: Action[];
      repoRelativeDrift: ClaudeDriftEntry[];
      /** Deny-key conservative restoration actions (execute against the HOME root). */
      homeActions: Action[];
      homeDrift: ClaudeDriftEntry[];
      homeOwnership: BindingOwnershipEntry[];
      /** Home-relative dirs to delete recursively (install root, wrappers, aliases). */
      homeDeletionsRel: string[];
      /** Home-relative `settings.json.bak.*` collaterals present at plan time. */
      settingsBackupsRel: string[];
      /** Literal temp path patterns gstack litters (cleaned by the caller). */
      tempPatterns: string[];
      /** Repo-relative GSTACK_HOME dir (per ownership), or undefined when not owned. */
      gstackHomeRel: string | undefined;
      /** Repo-relative state dirs to prune after repo-relative actions, deepest first. */
      stateDirsRel: string[];
    };

// -- Assertions ---------------------------------------------------------------

function assertGstackDeclaration(declaration: BindingDeclaration): void {
  if (declaration.framework.id !== "gstack") {
    throw new GstackBindingError(
      `gstack adapter invoked for framework "${declaration.framework.id}"`,
    );
  }
}

function assertGitSource(source: BindingDeclaration["source"]): BindingGitSource {
  if (source.kind !== "git") {
    throw new GstackBindingError(`gstack requires a git source; got "${source.kind}"`);
  }
  return source;
}

function assertGitResolved(resolved: ResolvedSource): ResolvedGitSource {
  if (resolved.kind !== "git") {
    throw new GstackBindingError(`gstack requires a resolved git source; got "${resolved.kind}"`);
  }
  return resolved;
}

/**
 * The NEW fail-closed provision gate: the branded disposition's selected
 * profile must be EXACTLY the gstack ruled profile. A legacy full-tree
 * disposition (no closure) or a closure computed for any other profile
 * authorizes a different runtime closure and never drives this install.
 * Asserted BEFORE any side effect (no readiness probe, no installer, no write).
 */
function assertSelectedProfileMatch(disposition: ScanDisposition): void {
  const profile = disposition.closure?.profile;
  if (profile !== GSTACK_SELECTED_PROFILE) {
    throw new GstackBindingError(
      `gstack provision requires a disposition for selected profile "${GSTACK_SELECTED_PROFILE}"; ` +
        `got ${profile === undefined ? "a disposition with no closure profile" : `"${profile}"`}`,
    );
  }
}

// -- inspect ------------------------------------------------------------------

function inspectGstackTree(request: InspectRequest): InspectReport {
  const notes: string[] = [];
  let skillCount = 0;
  try {
    for (const dir of readdirSync(request.treePath)) {
      if (existsSync(join(request.treePath, dir, "SKILL.md"))) skillCount += 1;
    }
  } catch {
    skillCount = 0;
  }
  notes.push(
    skillCount > 0
      ? `${skillCount} top-level SKILL.md skill dir(s) found`
      : "no top-level SKILL.md skill dirs found",
  );
  notes.push(
    existsSync(join(request.treePath, "setup")) ? "setup script present" : "no setup script found",
  );
  notes.push(
    existsSync(join(request.treePath, "bin", "gstack-settings-hook"))
      ? "bin/gstack-settings-hook present"
      : "no bin/gstack-settings-hook found",
  );
  notes.push(
    existsSync(join(request.treePath, "browse"))
      ? "browse/ subtree present"
      : "no browse/ subtree found",
  );
  return { framework: "gstack", treePath: request.treePath, notes };
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

/** Re-target a finalized/previewed ownership entry into the `home:` convention. */
function toHomeScoped(entries: readonly BindingOwnershipEntry[]): BindingOwnershipEntry[] {
  return entries.map((entry) => ({
    ...entry,
    target: `${HOME_OWNERSHIP_PREFIX}${entry.target}`,
  }));
}

const GSTACK_CLAUDE_MD_BODY = [
  "This project is bound to the gstack shared-runtime framework via AIH.",
  "",
  "- gstack skills install at user scope and are denied globally by AIH; this",
  "  project re-enables exactly the pinned inventory through",
  "  .claude/settings.json#/skillOverrides.",
  `- gstack state stays in the project GSTACK_HOME (${GSTACK_HOME_REL}); the`,
  "  lockdown config.yaml there is AIH-managed.",
  "- Do not run gstack setup, upgrade, or config commands by hand; use aih to",
  "  manage this binding.",
].join("\n");

/** Queue the project-scope surfaces (re-enables + CLAUDE.md block) on one engine. */
function queueProjectSurfaces(
  engine: ClaudeManagedWriteEngine,
  inventory: PinnedSkillInventory,
): void {
  for (const name of inventory.names) {
    engine.jsonField(CLAUDE_SETTINGS_PATH, `/skillOverrides/${name}`, "on");
  }
  engine.claudeMdBlock(GSTACK_CLAUDE_MD_BODY);
}

function buildGstackPlanPreview(
  deps: GstackAdapterDeps,
  declaration: BindingDeclaration,
): BindingPlan {
  const home = claudeHomeDir(deps.env ?? {});
  const inventory = GSTACK_PINNED_SKILL_INVENTORY;
  const choices = gstackChoices(declaration);

  // User-scope deny preview (read-only engine capture; nothing is applied).
  const denyEngine = new ClaudeManagedWriteEngine(home);
  queueSkillDenyList(denyEngine, inventory);
  const denyPreview = toHomeScoped(previewOwnership(denyEngine.build().ownership));

  // Project-scope re-enables + CLAUDE.md routing block preview.
  const projectEngine = new ClaudeManagedWriteEngine(deps.root);
  queueProjectSurfaces(projectEngine, inventory);
  const projectBuilt = projectEngine.build();

  // GSTACK_HOME lockdown config preview (content is fully known at plan time).
  const configText = gstackLockdownConfigYaml(choices);
  const configDigest = sha256Hex(configText);
  const configPrior = readIfExists(join(deps.root, GSTACK_CONFIG_REL));
  const configWrite: BindingWrite = {
    path: GSTACK_CONFIG_REL,
    mechanism: "file",
    contentDigest: configDigest,
  };
  const configOwnership: BindingOwnershipEntry = {
    kind: "file",
    target: GSTACK_CONFIG_REL,
    preExisting: configPrior === undefined ? { absent: true } : { value: configPrior },
    applied: configDigest,
    postApplyDigest: configDigest,
  };

  // Hook-strip intent (unconditional at provision; previewed as an intent —
  // the real lock records an entry only when fragments were actually removed).
  const stripApplied = { gstackHookStrip: "unconditional (path/substring + tags, all events)" };
  const stripPreview: BindingOwnershipEntry = {
    kind: "json-pointer",
    target: GSTACK_HOOK_STRIP_TARGET,
    preExisting: { absent: true },
    applied: stripApplied,
    postApplyDigest: sha256Hex(canonicalJson(stripApplied)),
  };

  // Install-surface preview: the whole-checkout install root + one wrapper dir
  // per pinned identity (the conditional alias included — the preview is the
  // owned-surface superset, not the reconciled reality).
  const installPreview: BindingOwnershipEntry[] = [
    GSTACK_INSTALL_ROOT_REL,
    ...inventory.names.map((name) => `${GSTACK_SKILLS_DIR_REL}/${wrapperDirFor(name)}`),
  ].map((rel) => {
    const applied = { installedDir: rel };
    return {
      kind: "file" as const,
      target: `${HOME_OWNERSHIP_PREFIX}${rel}`,
      preExisting: { absent: true as const },
      applied,
      postApplyDigest: sha256Hex(canonicalJson(applied)),
    };
  });

  return {
    framework: declaration.framework.id,
    writes: [...projectBuilt.writes, configWrite],
    ownership: [
      ...denyPreview,
      stripPreview,
      ...installPreview,
      ...previewOwnership(projectBuilt.ownership),
      configOwnership,
    ],
  };
}

// -- provision helpers ---------------------------------------------------------

/** Default apply seam: the same recipe as the Superpowers adapter (worktree
 * gate skipped — a bind runs inside a user project legitimately dirty with the
 * user's own work). Root-parameterized so the SAME seam applies project-scope
 * AND home-scope managed writes. */
function defaultApplyActions(
  deps: GstackAdapterDeps,
): (root: string, actions: Action[]) => Promise<PlanResult> {
  const env = deps.env ?? {};
  const run = deps.runner;
  const host = makeHostAdapter({ platform: resolvePlatform(env), run, env });
  return (root, actions) =>
    executePlan(
      planActions("gstack-binding", ...actions),
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
 * Re-provision preservation: replace this build's depth-2 `skillOverrides`
 * leaf intents with ONE parent-container intent when the PREVIOUS gstack lock
 * owns the parent container (the first bind created `skillOverrides`, so its
 * lock owns the container with `preExisting: absent`; a re-bind sees the
 * container as present and would otherwise record leaves whose "pre-existing"
 * is the first bind's own values — a later removal would then restore the
 * binding instead of pruning it). With no prior parent entry, leaf intents
 * carry forward their exact-target prior `preExisting` when one exists.
 */
function normalizeContainerOwnership(
  built: ClaudeManagedPlan,
  previousLock: BindingLock | undefined,
  file: string,
  parentKey: string,
  toLockTarget: (target: string) => string,
): void {
  if (previousLock === undefined) return;
  const parentTarget = `${file}#/${parentKey}`;
  const priorParent = previousLock.ownership.find(
    (entry) => entry.target === toLockTarget(parentTarget),
  );
  if (priorParent === undefined) {
    for (const intent of built.ownership) {
      const prior = previousLock.ownership.find(
        (entry) => entry.target === toLockTarget(intent.target),
      );
      if (prior !== undefined) intent.preExisting = prior.preExisting;
    }
    return;
  }
  const isUnderParent = (intent: ClaudeOwnershipIntent): boolean =>
    intent.file === file && intent.pointer !== undefined && intent.pointer[0] === parentKey;
  const under = built.ownership.filter(isUnderParent);
  if (under.length === 0) return;
  const container: Record<string, unknown> = {};
  for (const intent of under) {
    if (intent.pointer !== undefined && intent.pointer.length === 2) {
      container[intent.pointer[1] ?? ""] = intent.applied;
    } else if (isPlainObject(intent.applied)) {
      Object.assign(container, intent.applied);
    }
  }
  const parentIntent: ClaudeOwnershipIntent = {
    kind: "json-pointer",
    target: parentTarget,
    file,
    pointer: [parentKey],
    preExisting: priorParent.preExisting,
    applied: container,
  };
  built.ownership = [...built.ownership.filter((intent) => !isUnderParent(intent)), parentIntent];
}

/** Snapshot of the gstack-attributable dirs present under `<home>/.claude/skills`. */
function attributableSkillDirs(home: string): Set<string> {
  const skills = join(home, GSTACK_SKILLS_DIR_REL);
  const found = new Set<string>();
  if (!existsSync(skills)) return found;
  for (const dir of readdirSync(skills)) {
    if (dir === "gstack" || dir === GSTACK_ROOT_ALIAS_DIR || dir.startsWith("gstack-")) {
      found.add(dir);
    }
  }
  return found;
}

/**
 * Post-install reconciliation input: every REAL wrapper identity the install
 * created (top-level dir + frontmatter `name:` — both are collected so a
 * dir/frontmatter disagreement surfaces as an extra identity and refuses).
 */
function enumerateRealWrapperIdentities(home: string): Set<string> {
  const skills = join(home, GSTACK_SKILLS_DIR_REL);
  const reality = new Set<string>();
  if (!existsSync(skills)) return reality;
  for (const dir of readdirSync(skills)) {
    const attributable =
      dir === "gstack" || dir === GSTACK_ROOT_ALIAS_DIR || dir.startsWith("gstack-");
    if (!attributable) continue;
    const skillMd = join(skills, dir, "SKILL.md");
    if (!existsSync(skillMd)) continue; // not registrable (e.g. the install root)
    const name = frontmatterName(readFileSync(skillMd, "utf8"));
    if (name !== undefined) reality.add(name);
    reality.add(dir === GSTACK_ROOT_ALIAS_DIR || dir === "gstack" ? "gstack" : dir);
  }
  return reality;
}

/** Delete every attributable skills dir this bind created (never a pre-existing one). */
function removeCreatedSkillDirs(home: string, preExistingDirs: ReadonlySet<string>): void {
  for (const dir of attributableSkillDirs(home)) {
    if (preExistingDirs.has(dir)) continue;
    rmSync(join(home, GSTACK_SKILLS_DIR_REL, dir), { recursive: true, force: true });
  }
}

function pseudoLock(
  declaration: BindingDeclaration,
  resolved: ResolvedGitSource,
  ownership: BindingOwnershipEntry[],
): BindingLock {
  return {
    schemaVersion: 1,
    declaration,
    writes: [],
    scannedDigest: resolved.treeDigest,
    loadedDigest: resolved.treeDigest,
    match: true,
    ownership,
  };
}

/** Strip the `home:` prefix so an entry can drive `planClaudeRemoval` at the home root. */
function toHomeRelative(entries: readonly BindingOwnershipEntry[]): BindingOwnershipEntry[] {
  return entries.map((entry) => ({
    ...entry,
    target: entry.target.slice(HOME_OWNERSHIP_PREFIX.length),
  }));
}

/** Reconstruct the denied identity set from lock ownership (both the collapsed
 * parent-container shape and per-leaf entries). */
function deniedNamesFromLock(lock: BindingLock): string[] {
  const names = new Set<string>();
  const denyPrefix = `${HOME_OWNERSHIP_PREFIX}.claude/settings.json#/skillOverrides`;
  for (const entry of lock.ownership) {
    if (!entry.target.startsWith(denyPrefix)) continue;
    if (entry.target === denyPrefix && isPlainObject(entry.applied)) {
      for (const key of Object.keys(entry.applied)) names.add(key);
    } else if (entry.target.startsWith(`${denyPrefix}/`)) {
      names.add(entry.target.slice(`${denyPrefix}/`.length));
    }
  }
  return [...names].sort();
}

interface GstackManifestFile {
  schemaVersion: 1;
  sourceTreeDigest: string;
  installRootRel: string;
  bunVersion: string;
  nodeVersion: string;
  entries: GstackManifestEntry[];
}

function readGstackManifest(root: string): GstackManifestFile | undefined {
  const raw = readIfExists(join(root, GSTACK_MANIFEST_REL));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as GstackManifestFile;
    return isPlainObject(parsed) && Array.isArray(parsed.entries) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// -- provision ----------------------------------------------------------------

async function provisionGstack(
  deps: GstackAdapterDeps,
  apply: (root: string, actions: Action[]) => Promise<PlanResult>,
  request: ProvisionRequest,
  disposition: ScanDisposition,
): Promise<ProvisionResult> {
  const declaration = request.context.declaration;
  assertGstackDeclaration(declaration);
  // Defense in depth (D8 layer 3 + D12) — the registry dispatch already guards this,
  // but a bare (non-registry) call must still be safe.
  assertProvisionAllowed(request, disposition);
  const resolved = assertGitResolved(request.resolved);
  assertResolvedMatchesDeclaration(declaration, resolved);
  // The NEW fail-closed gate: the disposition's selected profile must be the
  // gstack ruled profile — asserted before ANY side effect.
  assertSelectedProfileMatch(disposition);
  assertKnownFeatureKeys(declaration.framework.features, GSTACK_FEATURE_KEYS, "gstack");
  const choices = gstackChoices(declaration);
  const env = deps.env ?? {};
  const home = claudeHomeDir(env);

  // 1. Readiness: bun on PATH (setup fails hard without it — refuse before the
  //    installer ever runs); node presence recorded (playwright launch path —
  //    informational while browserAutomation stays false).
  const bun = await deps.runner(["bun", "--version"]);
  if (bun.spawnError === true || bun.code !== 0) {
    throw new GstackBindingError(
      "gstack provision readiness failed: bun is not on PATH (upstream setup fails hard without it)",
    );
  }
  const bunVersion = bun.stdout.trim();
  const node = await deps.runner(["node", "--version"]);
  const nodeVersion = node.spawnError === true || node.code !== 0 ? "absent" : node.stdout.trim();

  // Tree-derived inventory (P5: regenerate on every bind). On the exact pinned
  // tree the derivation must reproduce the reviewed 55-name constant.
  const inventory = deriveGstackSkillInventory(resolved);
  if (resolved.treeDigest === GSTACK_PIN_TREE_DIGEST) {
    const derived = new Set(inventory.names);
    const pinned = new Set(GSTACK_PINNED_SKILL_INVENTORY.names);
    const drifted = derived.size !== pinned.size || [...pinned].some((name) => !derived.has(name));
    if (drifted) {
      throw new GstackBindingError(
        "gstack inventory derivation drifted from the reviewed pinned inventory on the pinned tree",
      );
    }
  }

  const priorRead = readBindingLock(deps.root);
  const previousLock =
    priorRead.present && priorRead.lock.declaration.framework.id === "gstack"
      ? priorRead.lock
      : undefined;

  // Pre-install snapshots (own what you created; conservative unwind boundary).
  const preExistingDirs = attributableSkillDirs(home);

  // 2. Invoke the UPSTREAM installer through the injectable seam. A THROWN
  //    seam unwinds exactly like a nonzero exit: the real setup may already
  //    have materialized skills dirs before the failure, and leaving them
  //    undenied would be the leak the reconciliation exists to prevent.
  const installer = deps.installGstack ?? defaultGstackInstaller;
  let install: GstackInstallResult;
  try {
    install = await installer({
      resolved,
      root: deps.root,
      home,
      gstackHomeAbs: join(deps.root, GSTACK_HOME_REL),
      runner: deps.runner,
      env,
      timeoutMs: deps.timeoutMs,
    });
  } catch (error) {
    removeCreatedSkillDirs(home, preExistingDirs);
    throw new GstackBindingError(
      `gstack upstream installer threw: ${error instanceof Error ? error.message : String(error)} — created skills dirs unwound`,
    );
  }
  if (install.exitCode !== 0) {
    removeCreatedSkillDirs(home, preExistingDirs);
    throw new GstackBindingError(
      `gstack upstream installer failed (exit ${install.exitCode}): ${install.stderr
        .trim()
        .slice(0, 400)}`,
    );
  }

  // 3. Post-install reconciliation (fail closed): reality minus inventory must
  //    be EMPTY (an unlisted identity would be undenied => leak); inventory
  //    minus reality must be a subset of the conditional set.
  const reality = enumerateRealWrapperIdentities(home);
  const inventorySet = new Set(inventory.names);
  const unlisted = [...reality].filter((name) => !inventorySet.has(name)).sort();
  if (unlisted.length > 0) {
    removeCreatedSkillDirs(home, preExistingDirs);
    throw new GstackBindingError(
      `gstack post-install reconciliation failed: real identities outside the tree-derived inventory ` +
        `would be undenied and leak: ${unlisted.join(", ")}`,
    );
  }
  const undelivered = [...inventorySet].filter((name) => !reality.has(name)).sort();
  const nonConditional = undelivered.filter((name) => !GSTACK_CONDITIONAL_IDENTITIES.has(name));
  if (nonConditional.length > 0) {
    removeCreatedSkillDirs(home, preExistingDirs);
    throw new GstackBindingError(
      `gstack post-install reconciliation failed: non-conditional inventory identities missing ` +
        `from the real install: ${nonConditional.join(", ")}`,
    );
  }

  // Steps 4–7 run as a SAGA: any failure after the installer unwinds every
  // surface sealed so far (restore project + home JSON from the just-sealed
  // ownership — values still equal applied, so removal restores cleanly — then
  // delete the created install dirs). The hook-strip record is never restored
  // (stripped gstack hooks stay stripped). A machine left with installed but
  // undenied skills would be the exact leak the deny exists to prevent — so a
  // mid-apply failure (e.g. an executor path-containment refusal) must not
  // strand the bind half-applied.
  const sealed: BindingOwnershipEntry[] = [];
  const unwindSealed = async (reason: string): Promise<never> => {
    const repoEntries = sealed.filter((entry) => !isHomeScopedTarget(entry.target));
    const repoRemoval = planClaudeRemoval(
      deps.root,
      pseudoLock(declaration, resolved, repoEntries),
    );
    await apply(deps.root, repoRemoval.actions);
    const homeJsonEntries = toHomeRelative(
      sealed.filter(
        (entry) =>
          isHomeScopedTarget(entry.target) &&
          entry.target !== GSTACK_HOOK_STRIP_TARGET &&
          entry.kind === "json-pointer",
      ),
    );
    const homeRemoval = planClaudeRemoval(home, pseudoLock(declaration, resolved, homeJsonEntries));
    await apply(home, homeRemoval.actions);
    removeCreatedSkillDirs(home, preExistingDirs);
    throw new GstackBindingError(reason);
  };

  let identity: GstackInstalledIdentity;
  let projectWrites: BindingWrite[] = [];
  let sealedConfigText = "";
  let strip: GstackHookStripResult = {
    changed: false,
    nextHooks: undefined,
    fragments: {},
    removedCount: 0,
  };
  try {
    // 4. Deny BEFORE any session can list: user-scope skillOverrides "off" for
    //    the FULL inventory via the root-parameterized engine (the deliberate,
    //    first-class user-scope crossing; D18 ownership with home: targets).
    const denyEngine = new ClaudeManagedWriteEngine(home);
    queueSkillDenyList(denyEngine, inventory);
    const denyPlan = denyEngine.build();
    normalizeContainerOwnership(
      denyPlan,
      previousLock,
      CLAUDE_SETTINGS_PATH,
      "skillOverrides",
      (target) => `${HOME_OWNERSHIP_PREFIX}${target}`,
    );
    await apply(home, denyPlan.actions);
    sealed.push(...toHomeScoped(finalizeClaudeOwnership(home, denyPlan.ownership)));

    // 5. UNCONDITIONAL hook strip (defense against variant drift even though the
    //    ruled profile writes zero hooks): path/substring across ALL events + tags.
    const homeSettingsRaw = readIfExists(join(home, CLAUDE_SETTINGS_PATH));
    if (homeSettingsRaw !== undefined) {
      strip = stripGstackHooks(parseJsoncText(homeSettingsRaw));
      if (strip.changed) {
        const action =
          strip.nextHooks === undefined
            ? writeJson(CLAUDE_SETTINGS_PATH, {}, "Strip gstack hooks (emptied)", {
                merge: true,
                removeJsonTopLevelKeys: ["hooks"],
              })
            : writeJson(CLAUDE_SETTINGS_PATH, { hooks: strip.nextHooks }, "Strip gstack hooks", {
                merge: true,
                replaceJsonKeys: ["hooks"],
              });
        await apply(home, [action]);
        const applied = { strippedGstackHooks: strip.fragments };
        sealed.push({
          kind: "json-pointer",
          target: GSTACK_HOOK_STRIP_TARGET,
          preExisting: { value: strip.fragments },
          applied,
          postApplyDigest: sha256Hex(canonicalJson(applied)),
        });
      }
    }

    // 6. Project surfaces: skillOverrides re-enables ("on" x inventory), the
    //    CLAUDE.md routing block, and the GSTACK_HOME literal lockdown config.
    const projectEngine = new ClaudeManagedWriteEngine(deps.root);
    queueProjectSurfaces(projectEngine, inventory);
    const projectPlan = projectEngine.build();
    normalizeContainerOwnership(
      projectPlan,
      previousLock,
      CLAUDE_SETTINGS_PATH,
      "skillOverrides",
      (target) => target,
    );
    await apply(deps.root, projectPlan.actions);
    sealed.push(...finalizeClaudeOwnership(deps.root, projectPlan.ownership));
    projectWrites = projectPlan.writes;

    const configText = gstackLockdownConfigYaml(choices);
    sealedConfigText = configText;
    const configPrior = readIfExists(join(deps.root, GSTACK_CONFIG_REL));
    await apply(deps.root, [
      writeText(GSTACK_CONFIG_REL, configText, "Write gstack lockdown config.yaml"),
    ]);
    const configDigest = sha256Hex(readIfExists(join(deps.root, GSTACK_CONFIG_REL)) ?? "");
    sealed.push({
      kind: "file",
      target: GSTACK_CONFIG_REL,
      preExisting: configPrior === undefined ? { absent: true } : { value: configPrior },
      applied: sha256Hex(configText),
      postApplyDigest: configDigest,
    });

    // Install-surface ownership: the whole-checkout install root + every wrapper
    // dir reality created (own what you created; the conditional alias is owned
    // only when it actually exists).
    const createdDirs = [...attributableSkillDirs(home)].sort();
    sealed.push(
      ...createdDirs.map((dir): BindingOwnershipEntry => {
        const rel = `${GSTACK_SKILLS_DIR_REL}/${dir}`;
        const applied = { installedDir: rel };
        return {
          kind: "file",
          target: `${HOME_OWNERSHIP_PREFIX}${rel}`,
          preExisting: preExistingDirs.has(dir) ? { value: `present:${rel}` } : { absent: true },
          applied,
          postApplyDigest: sha256Hex(canonicalJson(applied)),
        };
      }),
    );

    // 7. D7 identity: scannedDigest = resolved tree digest; loadedDigest = the
    //    installed subtree RESTRICTED to the scanned inventory with the
    //    deterministic name patch applied to expectations.
    identity = gstackInstalledSubsetIdentity(resolved, join(home, GSTACK_INSTALL_ROOT_REL));
    if (identity.mismatches.length > 0) {
      await unwindSealed(
        `gstack D7 installed-subset identity mismatch (${identity.mismatches
          .slice(0, 5)
          .join(", ")}) — bind unwound`,
      );
    }
  } catch (error) {
    if (error instanceof GstackBindingError) throw error;
    // unwindSealed returns Promise<never> — it always throws.
    return unwindSealed(
      `gstack provision failed mid-apply: ${
        error instanceof Error ? error.message : String(error)
      } — sealed surfaces unwound`,
    );
  }
  const assembledOwnership: BindingOwnershipEntry[] = sealed;

  // Persist the installed-subset manifest (verify's per-file re-check baseline).
  const manifestFile: GstackManifestFile = {
    schemaVersion: 1,
    sourceTreeDigest: resolved.treeDigest,
    installRootRel: GSTACK_INSTALL_ROOT_REL,
    bunVersion,
    nodeVersion,
    entries: identity.manifest,
  };
  const manifestText = `${JSON.stringify(manifestFile, null, 2)}\n`;
  const manifestPrior = readIfExists(join(deps.root, GSTACK_MANIFEST_REL));
  await apply(deps.root, [
    writeText(GSTACK_MANIFEST_REL, manifestText, "Record gstack installed-subset manifest"),
  ]);
  const manifestDigest = sha256Hex(manifestText);
  const manifestOwnership: BindingOwnershipEntry = {
    kind: "file",
    target: GSTACK_MANIFEST_REL,
    preExisting: manifestPrior === undefined ? { absent: true } : { value: manifestPrior },
    applied: manifestDigest,
    postApplyDigest: manifestDigest,
  };

  // 8. Lock assembly (repo-relative writes + repo-relative and home: ownership),
  //    written atomically. Re-provision carries prior preExisting by exact target.
  const ownership: BindingOwnershipEntry[] = [...assembledOwnership, manifestOwnership];
  if (previousLock !== undefined) {
    for (const entry of ownership) {
      if (entry.target === GSTACK_HOOK_STRIP_TARGET) continue;
      const prior = previousLock.ownership.find((p) => p.target === entry.target);
      if (prior !== undefined) entry.preExisting = prior.preExisting;
    }
  }
  const writes: BindingWrite[] = [
    ...projectWrites,
    { path: GSTACK_CONFIG_REL, mechanism: "file", contentDigest: sha256Hex(sealedConfigText) },
    { path: GSTACK_MANIFEST_REL, mechanism: "file", contentDigest: manifestDigest },
  ];
  const lock: BindingLock = {
    schemaVersion: 1,
    declaration,
    writes,
    scannedDigest: resolved.treeDigest,
    loadedDigest: identity.loadedDigest,
    match: resolved.treeDigest === identity.loadedDigest,
    ownership,
  };
  writeBindingLockAtomic(deps.root, lock);
  return { lock };
}

// -- verify -------------------------------------------------------------------

function verifyGstack(deps: GstackAdapterDeps): VerifyResult {
  const read = readBindingLock(deps.root);
  if (!read.present) return { ok: false, drift: ["no binding lock"] };
  const lock = read.lock;
  const drift: string[] = [];
  const home = claudeHomeDir(deps.env ?? {});

  // Deny-list re-verification against the lock-recorded inventory: every denied
  // name must still be "off" at user scope. `extra` off-entries are user-authored
  // (or the conditional-alias superset) — reported by `report`, never drift and
  // never auto-deleted.
  try {
    const inventory: PinnedSkillInventory = {
      names: deniedNamesFromLock(lock),
      sourceDigest: lock.scannedDigest,
    };
    const denyReport = skillDenyListReport(home, inventory, {
      lockedSourceDigest: lock.scannedDigest,
    });
    for (const name of denyReport.missing) {
      drift.push(`home skillOverrides deny missing for ${name} (no longer "off")`);
    }
  } catch (err) {
    drift.push(
      `home deny-list re-check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Hook-absence re-check: any gstack shape back in the home settings is drift.
  try {
    const raw = readIfExists(join(home, CLAUDE_SETTINGS_PATH));
    if (raw !== undefined && stripGstackHooks(parseJsoncText(raw)).removedCount > 0) {
      drift.push("gstack hook shape present in home settings (strip re-check failed)");
    }
  } catch (err) {
    drift.push(`home hook re-check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // D7 subset identity re-check against the recorded installed manifest.
  const manifest = readGstackManifest(deps.root);
  if (manifest === undefined) {
    drift.push(`installed-subset manifest missing or unreadable (${GSTACK_MANIFEST_REL})`);
  } else {
    if (manifest.sourceTreeDigest !== lock.scannedDigest) {
      drift.push("installed-subset manifest is bound to a different source tree digest");
    }
    for (const entry of manifest.entries) {
      const abs = join(home, manifest.installRootRel, entry.path);
      if (!existsSync(abs)) {
        drift.push(`installed file missing: ${entry.path}`);
        continue;
      }
      if (sha256HexOfBytes(readFileSync(abs)) !== entry.sha256) {
        drift.push(`installed file content drift: ${entry.path}`);
      }
    }
  }

  // Project re-enable / CLAUDE.md / GSTACK_HOME drift via planClaudeRemoval,
  // READ-ONLY (its actions are never applied here).
  const repoOwnership = lock.ownership.filter((entry) => !isHomeScopedTarget(entry.target));
  const removal = planClaudeRemoval(deps.root, { ...lock, ownership: repoOwnership });
  for (const entry of removal.drift) drift.push(`${entry.target}: ${entry.reason}`);

  return { ok: drift.length === 0, drift };
}

// -- remove -------------------------------------------------------------------

function removeGstack(deps: GstackAdapterDeps): GstackRemoveResult {
  const removalPlan = planBindingRemoval(deps.root);
  if (removalPlan.mode === "drift-report-only") {
    return { mode: "drift-report-only", reason: removalPlan.reason };
  }
  const lock = removalPlan.lock;
  const home = claudeHomeDir(deps.env ?? {});
  const homeOwnership = lock.ownership.filter((entry) => isHomeScopedTarget(entry.target));
  const repoRelativeOwnership = lock.ownership.filter((entry) => !isHomeScopedTarget(entry.target));
  const repoRelative = planClaudeRemoval(deps.root, { ...lock, ownership: repoRelativeOwnership });

  // Deny-key conservative restoration (byte-exact preExisting), computed against
  // the HOME root. The hook-strip RECORD is excluded — stripped gstack hooks are
  // never restored.
  const homeJsonEntries = toHomeRelative(
    homeOwnership.filter(
      (entry) => entry.kind === "json-pointer" && entry.target !== GSTACK_HOOK_STRIP_TARGET,
    ),
  );
  const homeRemoval = planClaudeRemoval(home, {
    ...lock,
    ownership: homeJsonEntries,
  });

  // Install-surface deletions: every owned dir under `.claude/skills/` this bind
  // created (preExisting absent). A pre-existing dir is preserved (conservative).
  const homeDeletionsRel = homeOwnership
    .filter(
      (entry) =>
        entry.kind === "file" &&
        entry.target.startsWith(`${HOME_OWNERSHIP_PREFIX}${GSTACK_SKILLS_DIR_REL}/`) &&
        "absent" in entry.preExisting,
    )
    .map((entry) => entry.target.slice(HOME_OWNERSHIP_PREFIX.length))
    .sort();

  // Settings backups gstack's settings-hook litters (collaterals — teardown deletes).
  const settingsBackupsRel: string[] = [];
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    for (const name of readdirSync(claudeDir)) {
      if (name.startsWith("settings.json.bak")) settingsBackupsRel.push(`.claude/${name}`);
    }
  }

  const ownsConfig = repoRelativeOwnership.some((entry) => entry.target === GSTACK_CONFIG_REL);
  const stateDirsRel = ownsConfig ? [GSTACK_HOME_REL, ".aih/gstack"] : [".aih/gstack"];

  return {
    mode: "apply",
    repoRelativeActions: repoRelative.actions,
    repoRelativeDrift: repoRelative.drift,
    homeActions: homeRemoval.actions,
    homeDrift: homeRemoval.drift,
    homeOwnership,
    homeDeletionsRel,
    settingsBackupsRel: settingsBackupsRel.sort(),
    tempPatterns: ["/tmp/gstack-*"],
    gstackHomeRel: ownsConfig ? GSTACK_HOME_REL : undefined,
    stateDirsRel,
  };
}

// -- report -------------------------------------------------------------------

/** The standing residual risks the Framework Card reports verbatim on every render. */
export const GSTACK_RESIDUAL_RISKS: readonly string[] = [
  "R5: slash-menu hiding is verified by proxy only (no non-interactive slash-menu surface on the probed host)",
  "conditional alias: gstack-connect-chrome creation is conditional (legacy migration); the deny inventory stays the superset",
  "office-hours: codex_reviews acceptance is conditional on cross-model runtime conditions; PERMANENT runtime-test obligation — every bind re-asserts codex_reviews: disabled and zero codex invocation shapes in written surfaces",
];

function reportGstack(deps: GstackAdapterDeps, context: BindingContext): BindingReport {
  const lines: string[] = [];
  const source = context.declaration.source;
  const pin =
    source.kind === "git"
      ? `${source.repository}@${source.commitSha}`
      : `${source.package}@${source.exactVersion}`;
  const choices = gstackChoices(context.declaration);
  lines.push("framework: gstack");
  lines.push("adapter-type: shared-runtime");
  lines.push(`pin: ${pin}`);
  lines.push(`selected profile: ${GSTACK_SELECTED_PROFILE}`);

  const home = claudeHomeDir(deps.env ?? {});
  const read = readBindingLock(deps.root);

  const pushSharedAndPolicy = (): void => {
    lines.push(
      `shared surface: install root ${HOME_OWNERSHIP_PREFIX}${GSTACK_INSTALL_ROOT_REL} materializes the ` +
        "FULL post-build checkout including node_modules, build outputs, and .git " +
        "(excluded from D7 identity, disclosed here; denied, non-registering, teardown-owned)",
    );
    lines.push(
      "install-generated (D7-excluded, present-checked, non-Claude-loaded; bytes derived from the " +
        "identity-verified SKILL.md inputs by the pinned build): gstack/llms.txt, agents/**, " +
        "openclaw/**, scripts/proactive-suggestions.json",
    );
    lines.push(
      `shared surface: gstack global state is confined to the project GSTACK_HOME at ${GSTACK_HOME_REL} ` +
        "(no shared ~/.gstack writes)",
    );
    lines.push(
      "shared surface: ~/.claude/settings.json.bak.* backups are gstack collaterals; teardown deletes them",
    );
    for (const [key, value] of GSTACK_LOCKDOWN_ENTRIES) lines.push(`lockdown ${key}: ${value}`);
    lines.push(`user choice codex_reviews: ${choices.codexReviews ? "enabled" : "disabled"}`);
    lines.push(`user choice proactive: ${choices.proactive ? "true" : "false"}`);
    lines.push(
      `user choice browser automation: ${
        choices.browserAutomation ? "on-demand" : "off"
      } (no config key located (R13); browse binary left unlaunched when off)`,
    );
    for (const risk of GSTACK_RESIDUAL_RISKS) lines.push(`residual risk: ${risk}`);
  };

  if (!read.present) {
    lines.push("binding lock: absent (not yet provisioned)");
    pushSharedAndPolicy();
    return { framework: "gstack", lines };
  }

  const lock = read.lock;
  lines.push(`scannedDigest: ${lock.scannedDigest}`);
  lines.push(`loadedDigest: ${lock.loadedDigest}`);
  lines.push(`match: ${String(lock.match)}`);

  const repoRelative = lock.ownership
    .filter((entry) => !isHomeScopedTarget(entry.target))
    .map((entry) => entry.target);
  const homeScope = lock.ownership
    .filter((entry) => isHomeScopedTarget(entry.target))
    .map((entry) => entry.target);
  lines.push(`D18-owned surfaces: ${repoRelative.length > 0 ? repoRelative.join(", ") : "(none)"}`);
  lines.push(`machine-scope surfaces: ${homeScope.length > 0 ? homeScope.join(", ") : "(none)"}`);

  const denied = deniedNamesFromLock(lock);
  lines.push(`deny count (user scope): ${denied.length}`);
  lines.push(`re-enable count (project scope): ${denied.length}`);
  try {
    const denyReport = skillDenyListReport(
      home,
      { names: denied, sourceDigest: lock.scannedDigest },
      { lockedSourceDigest: lock.scannedDigest },
    );
    lines.push(
      `deny re-verification: missing ${denyReport.missing.length}, ` +
        `extra ${denyReport.extra.length} (extras are user-authored or the conditional alias; ` +
        "reported, never auto-deleted)",
    );
  } catch {
    lines.push("deny re-verification: unavailable (home settings unreadable)");
  }

  const manifest = readGstackManifest(deps.root);
  if (manifest !== undefined) {
    lines.push(`bun: ${manifest.bunVersion}`);
    lines.push(`node: ${manifest.nodeVersion}`);
    lines.push(`installed-subset manifest: ${manifest.entries.length} file(s) under identity`);
  }

  const installRootAbs = join(home, GSTACK_INSTALL_ROOT_REL);
  if (existsSync(installRootAbs)) {
    try {
      const cost = estimateContextCostFromTree(installRootAbs);
      lines.push(
        `context-cost estimate (${cost.evidence}, labeled estimate): ~${cost.projectedTokens} tokens ` +
          `(skills ${cost.counts.skills}, agents ${cost.counts.agents}, commands ${cost.counts.commands}, ` +
          `hooks ${cost.counts.hooks}, mcpServers ${cost.counts.mcpServers})`,
      );
    } catch (err) {
      lines.push(
        `context-cost estimate: unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  } else {
    lines.push("context-cost estimate: unavailable (install root not present)");
  }

  pushSharedAndPolicy();
  return { framework: "gstack", lines };
}

// -- factory --------------------------------------------------------------------

export function createGstackAdapter(deps: GstackAdapterDeps): FrameworkAdapter {
  const apply = deps.applyActions ?? defaultApplyActions(deps);

  return {
    framework: "gstack",
    adapterType: "shared-runtime",

    inspect(request: InspectRequest): InspectReport {
      return inspectGstackTree(request);
    },

    async resolve(request: ResolveRequest): Promise<ResolvedSource> {
      assertGstackDeclaration(request.declaration);
      const source = assertGitSource(request.declaration.source);
      // Exact pin resolution; the 120 s transport budget lives in scan-gate. The
      // expected installed-subset digest needs no separate computation: by the
      // patch-normalizing construction in `gstackInstalledSubsetIdentity`, a
      // faithful install's loadedDigest IS the resolved treeDigest.
      return resolveGitSource(
        { repository: source.repository, commitSha: source.commitSha },
        { runner: deps.runner, cacheHome: deps.cacheHome ?? bindingCacheHome(deps.env ?? {}) },
      );
    },

    plan(context: BindingContext): BindingPlan {
      assertGstackDeclaration(context.declaration);
      assertPlanAllowed(context);
      assertKnownFeatureKeys(context.declaration.framework.features, GSTACK_FEATURE_KEYS, "gstack");
      assertGitSource(context.declaration.source);
      return buildGstackPlanPreview(deps, context.declaration);
    },

    async provision(
      request: ProvisionRequest,
      disposition: ScanDisposition,
    ): Promise<ProvisionResult> {
      return provisionGstack(deps, apply, request, disposition);
    },

    verify(_context: BindingContext): VerifyResult {
      return verifyGstack(deps);
    },

    remove(_context: BindingContext) {
      return removeGstack(deps);
    },

    report(context: BindingContext): BindingReport {
      return reportGstack(deps, context);
    },
  };
}
