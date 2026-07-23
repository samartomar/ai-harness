import { existsSync } from "node:fs";
import { join } from "node:path";
import { postureFromContext } from "../../config/posture.js";
import { readIfExists } from "../../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../../internals/merge.js";
import type { PlanContext } from "../../internals/plan.js";
import type { Check } from "../../internals/verify.js";
import type { DoctorCardInput } from "../card.js";
import {
  classifyTuple,
  type HostTuple,
  measureHostTuple,
  SUPPORTED_HOST_TUPLE,
} from "../host-tuple.js";
import {
  CLAUDE_MCP_PATH,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
  type ContextCostReport,
  claudeContaminationReport,
  claudeHomeDir,
  collectHookChain,
  estimateContextCostFromTree,
  type FrameworkAttribution,
  isHomeScopedTarget,
  readClaudeSettingsDrift,
  type SkillDenyListReport,
  skillDenyListReport,
} from "../hosts/claude/index.js";
import { type BindingLockRead, readBindingLock } from "../lock.js";
import { type BindingSource, type FrameworkId, readBindingDeclaration } from "../schema.js";
import { GSTACK_PINNED_SKILL_INVENTORY } from "./gstack.js";

/**
 * The binding doctor — READ-ONLY diagnostics wired into `aih doctor`
 * (`src/doctor.ts`). It carries the two W4d ECC checks
 * ({@link eccDoubleInstallCheck}, {@link eccModeExclusivityCheck}) PLUS the eight
 * W7 §B probes B1–B8 that wire the binding primitives (contamination, host tuple,
 * framework attribution, deny-list, hook chain, settings drift, MCP inventory) into
 * the health report:
 *
 *  - B1 {@link bindingContaminationCheck} — D13 user-scope leakage (posture-graded).
 *  - B2 {@link bindingContextCostCheck} — informational context-cost projection.
 *  - B3 {@link bindingHostTupleCheck} — D16 host tuple vs the pinned qualified tuple.
 *  - B4 {@link bindingFrameworkDriftCheck} — D8 one-framework drift + no-adapter.
 *  - B5 {@link bindingDenyListFreshnessCheck} — D11 gstack deny-list freshness.
 *  - B6 {@link bindingHookChainChecks} — per-event hook chain inventory.
 *  - B7 {@link bindingSettingsDriftCheck} — D18 owned-settings drift.
 *  - B8 {@link bindingMcpInventoryCheck} — MCP server inventory.
 *
 * EVERY probe is DETERMINISTIC — no timestamp, no absolute path, no machine-varying
 * raw value enters any `Check.detail`; every list is sorted before formatting — so
 * two consecutive runs against the same state produce byte-identical output (the
 * doctor stability rule). Every probe SELF-SKIPS when no binding lock/declaration is
 * present, reads tolerantly, and NEVER throws (a corrupt lock is a finding, not a
 * crash) — doctor is read-only diagnostics.
 */

const ECC_PLUGIN_ENABLE_PATTERN = /^ecc@/;

/** `enabledPlugins` keys from `<root>/.claude/settings.json`, read tolerantly (absent/malformed -> []). */
function projectEnabledPluginKeys(root: string): string[] {
  const raw = readIfExists(join(root, ".claude", "settings.json"));
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = parseJsoncText(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.enabledPlugins)) return [];
  return Object.keys(parsed.enabledPlugins);
}

/** The subset of `keys` that are an ECC plugin enable (`ecc@<marketplace>`). */
function eccPluginKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => ECC_PLUGIN_ENABLE_PATTERN.test(key));
}

/** `.claude/rules/ecc/` locations that count as a manual ECC copy (project and/or home scope). */
function manualEccCopyLocations(root: string, home: string): string[] {
  const found: string[] = [];
  if (existsSync(join(root, ".claude", "rules", "ecc"))) found.push("project:.claude/rules/ecc");
  if (existsSync(join(home, ".claude", "rules", "ecc"))) found.push("home:.claude/rules/ecc");
  return found;
}

/**
 * FAIL when an `ecc@`-prefixed plugin enable AND a manual ECC rules copy are
 * BOTH present at once — upstream warns that stacking the two produces
 * duplicates. PASS otherwise, naming whichever of the two (if either) was
 * found.
 */
export function eccDoubleInstallCheck(ctx: PlanContext): Check {
  const name = "ecc-double-install";
  const pluginKeys = eccPluginKeys(projectEnabledPluginKeys(ctx.root));
  const manualLocations = manualEccCopyLocations(ctx.root, claudeHomeDir(ctx.env));

  if (pluginKeys.length > 0 && manualLocations.length > 0) {
    return {
      name,
      verdict: "fail",
      detail:
        `ECC plugin enabled (${pluginKeys.join(", ")}) AND a manual ECC rules copy present ` +
        `(${manualLocations.join(", ")}) — installing both stacks duplicates per upstream guidance; remove one`,
    };
  }
  if (pluginKeys.length > 0) {
    return {
      name,
      verdict: "pass",
      detail: `ECC plugin enabled (${pluginKeys.join(", ")}); no manual ECC rules copy found`,
    };
  }
  if (manualLocations.length > 0) {
    return {
      name,
      verdict: "pass",
      detail: `manual ECC rules copy present (${manualLocations.join(", ")}); no ECC plugin enabled`,
    };
  }
  return {
    name,
    verdict: "pass",
    detail: "no ECC plugin enable and no manual ECC rules copy found",
  };
}

/**
 * FAIL when the binding lock's declared ECC mode disagrees with what is
 * actually installed:
 *  - `mode: "lean"` but an `ecc@`-prefixed plugin is enabled (a plugin
 *    installed on top of a Lean bind);
 *  - `mode: "full"` but no `ecc@` plugin is enabled while home-scoped Lean
 *    component ownership (a `home:`-prefixed ownership target) is still
 *    recorded in the lock.
 * PASS when the lock is absent, the bound framework is not `ecc`, or the mode
 * and installed state agree — nothing to enforce either way.
 */
export function eccModeExclusivityCheck(ctx: PlanContext): Check {
  const name = "ecc-mode-exclusivity";
  let read: BindingLockRead;
  try {
    read = readBindingLock(ctx.root);
  } catch (err) {
    return { name, verdict: "fail", detail: (err as Error).message };
  }
  if (!read.present) {
    return { name, verdict: "pass", detail: "no binding lock present — nothing to enforce" };
  }

  const { declaration, ownership } = read.lock;
  if (declaration.framework.id !== "ecc") {
    return {
      name,
      verdict: "pass",
      detail: `bound framework is "${declaration.framework.id}", not ecc — nothing to enforce`,
    };
  }

  const mode = declaration.framework.mode ?? "lean";
  const pluginKeys = eccPluginKeys(projectEnabledPluginKeys(ctx.root));
  const homeOwnershipTargets = ownership
    .map((entry) => entry.target)
    .filter((target) => isHomeScopedTarget(target));

  if (mode === "lean" && pluginKeys.length > 0) {
    return {
      name,
      verdict: "fail",
      detail:
        `lean mode lock but an ecc@ plugin entry (${pluginKeys.join(", ")}) is enabled — ` +
        `mode/state mismatch (a plugin stacked on a Lean bind produces duplicates)`,
    };
  }
  if (mode === "full" && pluginKeys.length === 0 && homeOwnershipTargets.length > 0) {
    return {
      name,
      verdict: "fail",
      detail:
        `full mode lock but no ecc@ plugin entry is enabled while home-scoped Lean component ` +
        `ownership exists (${homeOwnershipTargets.join(", ")}) — mode/state mismatch`,
    };
  }
  if (mode === "lean") {
    return {
      name,
      verdict: "pass",
      detail: "lean mode lock with no ecc@ plugin entry — consistent",
    };
  }
  return pluginKeys.length > 0
    ? {
        name,
        verdict: "pass",
        detail: `full mode lock with an ecc@ plugin entry (${pluginKeys.join(", ")}) — consistent`,
      }
    : {
        name,
        verdict: "pass",
        detail:
          "full mode lock with no ecc@ plugin entry and no lean home-scoped ownership — consistent",
      };
}

// ===========================================================================
// W7 §B — the eight binding doctor probes (B1–B8). All read-only, deterministic,
// self-skipping when no binding is present, never throwing.
// ===========================================================================

/** A non-failing skip Check (used for self-skips and non-routable advisories). */
function skip(name: string, detail: string): Check {
  return { name, verdict: "skip", detail };
}

/**
 * The framework/source this project is bound to, and whether ANY binding is
 * present (either the applied lock or the committed declaration). Tolerant: a
 * corrupt lock or invalid declaration still counts as `present` (a binding exists;
 * the corruption is surfaced by other checks) but yields no framework/source, so a
 * probe that needs those self-skips rather than throwing.
 */
function bindingInfo(ctx: PlanContext): {
  framework?: FrameworkId;
  source?: BindingSource;
  present: boolean;
} {
  let present = false;
  try {
    const read = readBindingLock(ctx.root);
    if (read.present) {
      return {
        framework: read.lock.declaration.framework.id,
        source: read.lock.declaration.source,
        present: true,
      };
    }
  } catch {
    present = true; // a corrupt lock IS a binding — never silently treated as unbound
  }
  try {
    const declaration = readBindingDeclaration(ctx.root);
    if (declaration !== undefined) {
      return { framework: declaration.framework.id, source: declaration.source, present: true };
    }
  } catch {
    present = true; // an invalid declaration IS a binding
  }
  return { present };
}

/**
 * Map a declared {@link FrameworkId} to its contamination
 * {@link FrameworkAttribution} vocabulary. Identity today — every v1 framework
 * id doubles as its attribution ("gsd" remains attribution-only detection
 * vocabulary with no framework id since PR #491 removed gsd-core). The seam
 * stays so a future id that diverges from the attribution vocabulary maps here.
 */
function attributionOf(framework: FrameworkId): FrameworkAttribution {
  return framework;
}

// -- B1: contamination + countable leakage (posture-graded, O4) --------------

/**
 * B1 — user-scope contamination. Clean ⇒ pass. Leakage ⇒ posture-graded (O4): a
 * failing check at enterprise, an advisory skip (label downgrade to
 * PROJECT_BINDING_CONFLICTED) at vibe/team. Detail is the countable leakage
 * summary (`N skills, N agents, …`) — counts only, no surface paths, deterministic.
 */
export function bindingContaminationCheck(ctx: PlanContext): Check {
  const name = "binding contamination";
  if (!bindingInfo(ctx).present) {
    return skip(name, "no binding declared — user-scope contamination not evaluated");
  }
  const report = claudeContaminationReport({ home: claudeHomeDir(ctx.env), projectRoot: ctx.root });
  if (report.clean)
    return { name, verdict: "pass", detail: "no user-scope framework contamination" };
  const l = report.leakage;
  const summary = `${l.skills} skills, ${l.agents} agents, ${l.hooks} hooks, ${l.rules} rules, ${l.plugins} plugins, ${l.mcpServers} mcpServers`;
  if (postureFromContext(ctx) === "enterprise") {
    return { name, verdict: "fail", code: "binding.contaminated", detail: summary };
  }
  return {
    name,
    verdict: "skip",
    code: "binding.contaminated",
    detail: `${summary} (advisory; support label downgrades to PROJECT_BINDING_CONFLICTED)`,
  };
}

// -- B2: context cost + evidence source (informational) ----------------------

/**
 * B2 — informational context-cost projection over the project's `.claude` surface
 * tree (AIH static estimate). Pass with the evidence-source label + counts; skip
 * (no code) when there is no tree to project from. No token number is fabricated.
 */
export function bindingContextCostCheck(ctx: PlanContext): Check {
  const name = "binding context cost";
  if (!bindingInfo(ctx).present) {
    return skip(name, "no binding declared — context cost not projected");
  }
  let report: ContextCostReport;
  try {
    report = estimateContextCostFromTree(join(ctx.root, ".claude"));
  } catch {
    return skip(name, "no project .claude surface tree to project context cost from");
  }
  const c = report.counts;
  const tokens =
    report.projectedTokens !== undefined ? `~${report.projectedTokens} tokens` : "unknown tokens";
  return {
    name,
    verdict: "pass",
    detail:
      `evidence source ${report.source} (${report.evidence}${report.estimate ? ", labeled estimate" : ""}): ${tokens} — ` +
      `skills ${c.skills}, agents ${c.agents}, commands ${c.commands}, rules ${c.rules}, hooks ${c.hooks}, mcpServers ${c.mcpServers}`,
  };
}

// -- B3: D16 host-tuple check (O5) -------------------------------------------

/** The Node MAJOR component — the tested-major-range granularity (O5). */
function nodeMajor(version: string): string {
  return version.split(".")[0] ?? "";
}

/** Sorted NAMES of the hard facts that differ between measured and pinned (no raw values). */
function hardFactMismatches(measured: HostTuple, pinned: HostTuple): string[] {
  const out: string[] = [];
  if (measured.arch !== pinned.arch) out.push("arch");
  if (measured.windowsBuild !== pinned.windowsBuild) out.push("windowsBuild");
  if (measured.bun !== pinned.bun) out.push("bun");
  if (nodeMajor(measured.node) !== nodeMajor(pinned.node)) out.push("node-major");
  if (measured.ramClassGb !== pinned.ramClassGb) out.push("ram-class");
  if (measured.vcpuClass !== pinned.vcpuClass) out.push("vcpu-class");
  return out.sort();
}

/**
 * B3 — the D16 host tuple. `in-tuple` ⇒ pass; `version-drift` (hard facts held, only
 * the Claude Code version advanced) ⇒ advisory skip (`binding.host-version-drift`);
 * `off-tuple` ⇒ posture-graded like O4 (`binding.host-off-tuple`): a failing check at
 * enterprise, an advisory skip (support downgrades to HOST_BINDING_UNVALIDATED) at
 * vibe/team. Detail names the pinned facts / mismatched field NAMES only — never a
 * raw machine value — so it is portable and deterministic. `measured` is injectable
 * for deterministic tests; production measures the live host.
 */
export async function bindingHostTupleCheck(
  ctx: PlanContext,
  measured?: HostTuple,
): Promise<Check> {
  const name = "binding host tuple";
  if (!bindingInfo(ctx).present) {
    return skip(name, "no binding declared — host tuple not evaluated");
  }
  const tuple = measured ?? (await measureHostTuple(ctx));
  const verdict = classifyTuple(tuple, SUPPORTED_HOST_TUPLE);
  if (verdict === "in-tuple") {
    return {
      name,
      verdict: "pass",
      detail: `host in-tuple — all hard facts match the pinned D16 tuple (Claude Code ${SUPPORTED_HOST_TUPLE.claudeCode.measuredOn} provenance)`,
    };
  }
  if (verdict === "version-drift") {
    return {
      name,
      verdict: "skip",
      code: "binding.host-version-drift",
      detail: `Claude Code version advanced from the pinned ${SUPPORTED_HOST_TUPLE.claudeCode.measuredOn}; the hard host facts were re-measured and held — advisory`,
    };
  }
  const detail = `host off-tuple — hard facts differ: ${hardFactMismatches(tuple, SUPPORTED_HOST_TUPLE).join(", ")}`;
  if (postureFromContext(ctx) === "enterprise") {
    return { name, verdict: "fail", code: "binding.host-off-tuple", detail };
  }
  return {
    name,
    verdict: "skip",
    code: "binding.host-off-tuple",
    detail: `${detail} (advisory; support label downgrades to HOST_BINDING_UNVALIDATED)`,
  };
}

// -- B4: D8 one-framework drift + no-adapter ---------------------------------

/**
 * The frameworks this aih build registers an adapter for (mirrors
 * `createBindingAdapterRegistry`, `frameworks/registry.ts`). A declared framework
 * NOT in this set is diagnosable-no-adapter, never a crash. Kept as a local set so a
 * read-only probe need not construct a live registry; robust to `gsd-core` leaving
 * `FRAMEWORK_IDS` (PR #491) because it is simply absent here.
 */
const ADAPTER_BACKED_FRAMEWORKS: ReadonlySet<FrameworkId> = new Set<FrameworkId>([
  "superpowers",
  "ecc",
  "gstack",
]);

/**
 * B4 — D8 post-bind one-framework drift. A declared framework with no registered
 * adapter ⇒ diagnosable advisory skip (`binding.no-adapter`), never a throw. More
 * than one methodology framework with a LIVE surface (the declared one plus any
 * competing framework attributed in the user-scope contamination scan) ⇒ fail
 * (`binding.framework-drift`). Exactly one ⇒ pass. `adapterFrameworks` is injectable
 * so a test can supply a registry built WITHOUT a given adapter.
 */
export function bindingFrameworkDriftCheck(
  ctx: PlanContext,
  opts: { adapterFrameworks?: Iterable<FrameworkId> } = {},
): Check {
  const name = "binding framework drift";
  const info = bindingInfo(ctx);
  if (info.framework === undefined) {
    return skip(name, "no readable binding framework — framework drift not evaluated");
  }
  const declared = info.framework;
  const adapterSet = new Set(opts.adapterFrameworks ?? ADAPTER_BACKED_FRAMEWORKS);
  if (!adapterSet.has(declared)) {
    return {
      name,
      verdict: "skip",
      code: "binding.no-adapter",
      detail: `declared framework "${declared}" has no registered adapter in this build — cannot fully verify (diagnosable)`,
    };
  }
  const report = claudeContaminationReport({ home: claudeHomeDir(ctx.env), projectRoot: ctx.root });
  const live = new Set<FrameworkAttribution>([attributionOf(declared)]);
  for (const entry of report.entries) {
    if (entry.attribution !== "unknown") live.add(entry.attribution);
  }
  if (live.size > 1) {
    return {
      name,
      verdict: "fail",
      code: "binding.framework-drift",
      detail: `more than one methodology framework has a live surface: ${[...live].sort().join(", ")} (D8 allows exactly one per project)`,
    };
  }
  return {
    name,
    verdict: "pass",
    detail: `exactly one methodology framework live: ${attributionOf(declared)}`,
  };
}

// -- B5: D11 gstack deny-list freshness (self-skips off-gstack) ---------------

/**
 * B5 — D11 gstack deny-list freshness. Self-skips cleanly when the bound framework
 * is not gstack (the 2026-07-23 scope reduction: gstack is EVALUATED_DEFERRED, but
 * B5 still ships). For a gstack binding it compares the live `skillOverrides` deny
 * list against the pinned skill inventory: any pinned skill no longer denied
 * (`missing`) ⇒ fail (`binding.deny-stale`); a stale read (malformed settings) is a
 * non-routable skip; otherwise pass. `extra`/`fresh` are reported; lists are sorted.
 */
export function bindingDenyListFreshnessCheck(ctx: PlanContext): Check {
  const name = "binding deny-list freshness";
  const info = bindingInfo(ctx);
  if (info.framework === undefined) {
    return skip(name, "no readable binding framework — deny-list freshness not evaluated");
  }
  if (info.framework !== "gstack") {
    return skip(
      name,
      `bound framework is "${info.framework}", not gstack — deny-list freshness not applicable`,
    );
  }
  const lockedSourceDigest = info.source?.kind === "git" ? info.source.treeDigest : undefined;
  let report: SkillDenyListReport;
  try {
    report = skillDenyListReport(
      ctx.root,
      GSTACK_PINNED_SKILL_INVENTORY,
      lockedSourceDigest !== undefined ? { lockedSourceDigest } : {},
    );
  } catch (err) {
    return skip(name, `deny-list report unavailable: ${(err as Error).message}`);
  }
  const extra =
    report.extra.length > 0
      ? `; extra (reported only): ${[...report.extra].sort().join(", ")}`
      : "";
  if (report.missing.length > 0) {
    return {
      name,
      verdict: "fail",
      code: "binding.deny-stale",
      detail: `${report.missing.length}/${report.total} pinned skills no longer denied: ${[...report.missing].sort().join(", ")} (an added/renamed skill leaks until regenerated); fresh: ${String(report.fresh)}${extra}`,
    };
  }
  return {
    name,
    verdict: "pass",
    detail: `deny-list current: all ${report.total} pinned skills denied; fresh: ${String(report.fresh)}${extra}`,
  };
}

// -- B6: per-event hook chain (home + project + local), multi-check -----------

/** Stable sort key for a hook-chain entry (no control bytes — JSON.stringify of the key fields). */
function hookSortKey(entry: {
  event: string;
  matcher?: string;
  scope: string;
  origin: string;
}): string {
  return JSON.stringify([entry.event, entry.matcher ?? "", entry.scope, entry.origin]);
}

/**
 * B6 — the per-event hook chain across the home, project, and local settings layers
 * (`probeMany`). One advisory skip per hook (`binding.hook-chain`), sorted for
 * determinism; a single pass when there are no hooks. Each detail carries the
 * event/matcher/scope plus the PATH-FREE command origin (basename) — never the raw
 * command — so it is portable and deterministic. Self-skips when no binding.
 */
export function bindingHookChainChecks(ctx: PlanContext): Check[] {
  const name = "binding hook chain";
  if (!bindingInfo(ctx).present) {
    return [skip(name, "no binding declared — hook chain not evaluated")];
  }
  const entries = collectHookChain({ home: claudeHomeDir(ctx.env), projectRoot: ctx.root });
  if (entries.length === 0) {
    return [{ name, verdict: "pass", detail: "no hooks in home/project/local settings" }];
  }
  return [...entries]
    .sort((a, b) => hookSortKey(a).localeCompare(hookSortKey(b)))
    .map((entry) => ({
      name: `${name}: ${entry.event}${entry.matcher !== undefined ? ` [${entry.matcher}]` : ""} (${entry.scope})`,
      verdict: "skip" as const,
      code: "binding.hook-chain" as const,
      detail: `${entry.event}${entry.matcher !== undefined ? ` matcher=${entry.matcher}` : ""} origin=${entry.origin} scope=${entry.scope}`,
    }));
}

// -- B7: read-only owned-settings drift (D18) --------------------------------

/**
 * B7 — read-only D18 settings drift, via the pure {@link readClaudeSettingsDrift}
 * the removal planner also calls (so they cannot disagree). Drift is REPORTED, never
 * failed (D18 preserves a user-modified owned value) ⇒ advisory skip
 * (`binding.settings-drift`); no drift ⇒ pass. Detail lists sorted repo-relative
 * targets + reasons — no absolute path, deterministic. A corrupt lock is a
 * non-routable skip (surfaced as a fail by `eccModeExclusivityCheck`).
 */
export function bindingSettingsDriftCheck(ctx: PlanContext): Check {
  const name = "binding settings drift";
  let read: BindingLockRead;
  try {
    read = readBindingLock(ctx.root);
  } catch (err) {
    return skip(
      name,
      `binding lock unreadable — settings drift not evaluated: ${(err as Error).message}`,
    );
  }
  if (!read.present) return skip(name, "no binding lock present — settings drift not evaluated");
  const drift = readClaudeSettingsDrift(ctx.root, read.lock);
  if (drift.length === 0) {
    return { name, verdict: "pass", detail: "no AIH-owned settings drift since bind" };
  }
  const list = [...drift]
    .sort((a, b) =>
      JSON.stringify([a.target, a.kind, a.reason]).localeCompare(
        JSON.stringify([b.target, b.kind, b.reason]),
      ),
    )
    .map((entry) => `${entry.target} (${entry.kind}): ${entry.reason}`)
    .join("; ");
  return {
    name,
    verdict: "skip",
    code: "binding.settings-drift",
    detail: `${drift.length} owned entr${drift.length === 1 ? "y" : "ies"} drifted (preserved, not deleted): ${list}`,
  };
}

// -- B8: MCP server inventory ------------------------------------------------

/** MCP server ids declared in a settings/`.mcp.json` text — the `scan-gate.ts` `mcpServersIn` shape. */
function mcpServerIdsIn(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseJsoncText(text);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const out: string[] = [];
  for (const key of ["mcpServers", "servers", "mcp"]) {
    const value = parsed[key];
    if (isPlainObject(value)) out.push(...Object.keys(value));
  }
  return out;
}

/**
 * B8 — MCP server inventory across the project settings, project local settings,
 * project `.mcp.json`, home settings, and home `.mcp.json` (the `mcpServersIn` shape
 * over project + home). Sorted, deduped server-id list ⇒ advisory skip
 * (`binding.mcp-inventory`) when non-empty; pass when none. Self-skips when no
 * binding. Deterministic (sorted); server ids are names, never paths.
 */
export function bindingMcpInventoryCheck(ctx: PlanContext): Check {
  const name = "binding mcp inventory";
  if (!bindingInfo(ctx).present) {
    return skip(name, "no binding declared — MCP inventory not evaluated");
  }
  const home = claudeHomeDir(ctx.env);
  const sources = [
    join(ctx.root, CLAUDE_SETTINGS_PATH),
    join(ctx.root, CLAUDE_SETTINGS_LOCAL_PATH),
    join(ctx.root, CLAUDE_MCP_PATH),
    join(home, CLAUDE_SETTINGS_PATH),
    join(home, CLAUDE_MCP_PATH),
  ];
  const servers = new Set<string>();
  for (const abs of sources) {
    const raw = readIfExists(abs);
    if (raw === undefined) continue;
    for (const id of mcpServerIdsIn(raw)) servers.add(id);
  }
  const sorted = [...servers].sort();
  if (sorted.length === 0) {
    return {
      name,
      verdict: "pass",
      detail: "no MCP servers declared in project/home settings or .mcp.json",
    };
  }
  return {
    name,
    verdict: "skip",
    code: "binding.mcp-inventory",
    detail: `${sorted.length} MCP server${sorted.length === 1 ? "" : "s"}: ${sorted.join(", ")}`,
  };
}

// -- DoctorCardInput wiring (design §A.3.3) ----------------------------------

/**
 * Derive the card's {@link DoctorCardInput} from a doctor run's `Check[]` — the seam
 * (design §A.3.3) that lets a doctor-aware caller downgrade a card's support label
 * from the B1/B3 verdicts WITHOUT the card layer importing the doctor.
 *
 * Both signals are read by their STABLE `code` (never by matching `detail`):
 *  - `contaminationClean` is false iff B1 emitted `binding.contaminated` (as a
 *    fail at enterprise or an advisory skip at vibe/team) — otherwise clean.
 *  - `inTuple` is false iff B3 emitted `binding.host-off-tuple`. A
 *    `binding.host-version-drift` is NOT off-tuple: the hard facts held and only the
 *    Claude Code provenance advanced, so it stays in-tuple for the card (design §B.3).
 *
 * Absent codes ⇒ `{ contaminationClean: true, inTuple: true }`. Passing this into
 * {@link buildFrameworkCard} still only issues STRICT when the target is
 * strict-capable (H4/O1) — a clean doctor is necessary, not sufficient.
 */
export function cardDoctorInputFromChecks(checks: readonly Check[]): DoctorCardInput {
  const hasCode = (code: Check["code"]): boolean => checks.some((check) => check.code === code);
  return {
    contaminationClean: !hasCode("binding.contaminated"),
    inTuple: !hasCode("binding.host-off-tuple"),
  };
}
