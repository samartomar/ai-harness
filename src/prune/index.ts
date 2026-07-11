import { join } from "node:path";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../bootstrap-ai/canon.js";
import { AIH_CONFIG_FILE } from "../config/marker.js";
import {
  codexAgentsBlockRemovalAction,
  codexConfigRemovalAction,
  codexInstallStateCleanupAction,
} from "../ecc/codex.js";
import { ECC_NPM_CLI_BIN, ECC_NPM_PACKAGE, isAihDirectEccInstallTarget } from "../ecc/install.js";
import { eccPruneReconciliationActions } from "../ecc/prune-reconcile.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import { extractManagedBlock, stripManagedBlock } from "../internals/markers.js";
import {
  type Action,
  type CommandSpec,
  digest,
  exec,
  type Plan,
  type PlanContext,
  plan,
  remove,
  writeText,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { execArgv } from "../tools/install.js";
import {
  type PruneArtifact,
  type StalePruneSet,
  stalePruneSet,
  unrunnableTargets,
} from "./detect.js";

/**
 * `aih prune` — remove the stale per-CLI artifacts a repo carries for CLIs it no
 * longer targets ({@link stalePruneSet}). Dry-run by default (like every aih
 * mutator); `--apply` executes. Each artifact is handled by its proven-safe
 * disposition:
 *
 *  - `file`     → a `remove` action: aih owns the whole file, so `--apply` MOVES it
 *                 to gitignored `.aih/legacy/<path>` (reversible — move it back).
 *  - `block`    → a `write` action: the bootloader's `<!-- BEGIN/END … -->` fence
 *                 proves ownership, so aih subtracts JUST that block in place
 *                 ({@link stripManagedBlock}) and keeps the tool preamble + any human
 *                 edits (backed up to `.aih.bak`). The file is never deleted.
 *  - `advisory` → NO auto-edit: a repo MCP JSON / settings hook has no on-disk marker
 *                 separating aih's entries from the user's, so `--apply` only PRINTS
 *                 what to remove by hand (surfaced in the digest), never touching it.
 *
 * The stale set is diffed against COMMITTED INTENT only (the `.aih-config.json`
 * marker), so a bare `aih prune` is safe anywhere: with no committed target set it
 * reports nothing rather than guessing what to delete. Removals go through the
 * dirty-worktree preflight (a dirty/untracked target refuses without `--force`).
 */

const SOURCE_LABEL: Record<StalePruneSet["source"], string> = {
  marker: ".aih-config.json",
  ctx: "init orchestrator",
  none: "none",
};

const KIND_LABEL: Record<PruneArtifact["kind"], string> = {
  adapter: "adapter note",
  bootloader: "bootloader canon block",
  mcp: "MCP config",
  settings: "settings",
  "kiro-steering": "Kiro steering",
  "kiro-hook": "Kiro hook",
};

/**
 * The subtracted content of a co-owned bootloader (aih's canon block removed), or
 * `undefined` when there is nothing safe to subtract. It only acts when the on-disk
 * block body EQUALS aih's freshly generated canonical body — the same ownership
 * signal the drift check uses. So a user's look-alike `<!-- BEGIN … -->` example, a
 * block a human edited inside the fence, or a repo whose block already drifted is
 * left untouched (never corrupted) rather than blindly stripped. Read at plan time
 * (pure fs, no spawn) so the `write` action carries the exact bytes to land.
 */
function bootloaderMinusBlock(ctx: PlanContext, rel: string): string | undefined {
  const text = readIfExists(join(ctx.root, rel));
  if (text === undefined) return undefined;
  const onDisk = extractManagedBlock(text, SHARED_MARKER);
  if (onDisk === undefined) return undefined; // no aih block present
  if (onDisk !== sharedCanonicalBlockBody(ctx.contextDir).trim()) return undefined; // not aih's / drifted
  const stripped = stripManagedBlock(text, SHARED_MARKER);
  return stripped === text ? undefined : stripped;
}

/** The manual-review advisory lines for the artifacts aih can't safely auto-edit. */
function advisoryLines(set: StalePruneSet): string[] {
  const advisory = set.artifacts.filter((a) => a.disposition === "advisory");
  if (advisory.length === 0) return [];
  return [
    "",
    "Manual review — aih can't safely edit these (its entries carry no on-disk marker,",
    "and names may collide with yours), so it will NOT touch them:",
    ...advisory.map(
      (a) => `  [manual] ${a.path}  — remove ${a.clis.join(", ")}'s entries by hand if unused`,
    ),
  ];
}

/** The loud `--unrunnable` warning: a PATH problem looks identical to a dropped CLI. */
function unrunnableLines(set: StalePruneSet): string[] {
  if (set.unrunnable.length === 0) return [];
  return [
    "",
    `!! --unrunnable: treating ${set.unrunnable.join(", ")} as dropped because no binary is`,
    "on PATH. A PATH problem (fresh shell, VDI, not-yet-installed tool) looks IDENTICAL",
    "to a truly dropped CLI — prune these only if you actually stopped using them.",
    "Targets in .aih-config.json are unchanged; re-target via `aih bootstrap-ai`.",
  ];
}

/** Selection flags are shared CLI surface, but prune only trusts committed intent. */
function ignoredSelectionFlags(ctx: PlanContext): string[] {
  const flags: string[] = [];
  if (typeof ctx.options.cli === "string" && ctx.options.cli.trim().length > 0) {
    flags.push("--cli");
  }
  if (ctx.options.allTools === true) flags.push("--all-tools");
  if (ctx.options.detect === true) flags.push("--detect");
  return flags;
}

function ignoredSelectionLines(flags: readonly string[]): string[] {
  if (flags.length === 0) return [];
  return [
    "",
    `Selection flag(s) ignored by prune: ${flags.join(", ")}.`,
    "Prune diffs committed intent only (.aih-config.json); re-target with `aih bootstrap-ai --apply --cli <list>` first.",
  ];
}

/** The context digest: kept/dropped summary + the manual-review advisory. The
 * `file`/`block` changes are carried by their own action preview lines. */
function contextBody(
  set: StalePruneSet,
  moved: number,
  subtracted: number,
  hardDelete: boolean,
  ignoredFlags: readonly string[],
): string {
  if (set.source === "none") {
    return lines(
      "No committed target set (.aih-config.json) to diff against — nothing is treated",
      "as stale. Run `aih bootstrap-ai` to record which CLIs this repo targets, then",
      "`aih prune` will remove artifacts for any CLI you later drop.",
      ...ignoredSelectionLines(ignoredFlags),
    );
  }
  if (set.unknownTargets.length > 0) {
    return lines(
      `!! ${AIH_CONFIG_FILE} lists target(s) aih does not recognize: ${set.unknownTargets.join(", ")}.`,
      "A typo here could make prune treat a CLI you MEANT TO KEEP as dropped, so nothing",
      "is treated as stale until the marker is fixed. Valid targets: see `aih prune --help`;",
      "re-write the marker via `aih bootstrap-ai --apply --cli <list>`.",
      ...ignoredSelectionLines(ignoredFlags),
    );
  }
  if (set.dropped.length === 0) {
    return lines(
      "No stale per-CLI artifacts — every CLI wired into this repo is still targeted.",
      `Kept (${SOURCE_LABEL[set.source]}): ${set.targeted.join(", ") || "none"}.`,
      ...ignoredSelectionLines(ignoredFlags),
    );
  }
  const disposal = hardDelete
    ? `${moved} file(s) hard-delete (single-slot <path>.aih.bak backup), ${subtracted} bootloader block(s)`
    : `${moved} file(s) move to .aih/legacy/ (reversible), ${subtracted} bootloader block(s)`;
  return lines(
    `Kept (${SOURCE_LABEL[set.source]}): ${set.targeted.join(", ") || "none"}`,
    `Dropped: ${set.dropped.join(", ")}`,
    ...unrunnableLines(set),
    ...ignoredSelectionLines(ignoredFlags),
    "",
    disposal,
    "subtracted in place; the actions above list each. Pass --apply to execute.",
    ...advisoryLines(set),
  );
}

/** The action for one artifact, or `undefined` when there is nothing safe/needed to do. */
function actionFor(ctx: PlanContext, a: PruneArtifact, hardDelete: boolean): Action | undefined {
  const who = `${a.clis.join(", ")} dropped`;
  if (a.disposition === "file") {
    return remove(a.path, `stale ${KIND_LABEL[a.kind]} (${who})`, { hardDelete });
  }
  if (a.disposition === "block") {
    const stripped = bootloaderMinusBlock(ctx, a.path);
    return stripped === undefined
      ? undefined // block already absent — nothing to subtract
      : writeText(a.path, stripped, `subtract aih canon block from ${a.path} (${who})`);
  }
  return undefined; // advisory → surfaced in the digest, never an auto-action
}

function eccUninstallAction(ctx: PlanContext, cli: Cli): Action {
  return exec(
    `Remove ECC-managed ${cli} footprint recorded in ECC install-state (under --apply)`,
    execArgv(ctx.host.platform, [
      "npx",
      "--yes",
      "--package",
      ECC_NPM_PACKAGE,
      ECC_NPM_CLI_BIN,
      "uninstall",
      "--target",
      cli,
    ]),
  );
}

async function prunePlan(ctx: PlanContext): Promise<Plan> {
  // `--unrunnable` is the ONLY path that probes PATH (which/where, read-only,
  // plan-purity-allowlisted); a default or report-driven scan never does.
  const treatAsDropped = ctx.options.unrunnable === true ? await unrunnableTargets(ctx) : undefined;
  const hardDelete = ctx.options.delete === true;
  const set = stalePruneSet(ctx, { treatAsDropped });
  const actions: Action[] = [];
  // Ensure `.aih/` is gitignored BEFORE any file moves into `.aih/legacy/`
  // (idempotent — records `unchanged` when the pattern is already there). Hard-delete
  // needs it too: `*.aih.bak` is in the same managed ignore block.
  if (set.artifacts.some((a) => a.disposition === "file")) {
    actions.push(aihIgnoreWrite(ctx.root));
  }
  let moved = 0;
  let subtracted = 0;
  for (const a of set.artifacts) {
    const action = actionFor(ctx, a, hardDelete);
    if (!action) continue;
    actions.push(action);
    if (action.kind === "remove") moved += 1;
    else if (action.kind === "write") subtracted += 1;
  }
  for (const cli of set.dropped) {
    if (isAihDirectEccInstallTarget(cli)) actions.push(eccUninstallAction(ctx, cli));
    if (cli === "codex") {
      const codexConfig = codexConfigRemovalAction(ctx);
      if (codexConfig) actions.push(codexConfig);
      const codexBlock = codexAgentsBlockRemovalAction(ctx);
      if (codexBlock) {
        actions.push(codexBlock);
        subtracted += 1;
      }
      const codexStateCleanup = codexInstallStateCleanupAction(ctx);
      if (codexStateCleanup) actions.push(codexStateCleanup);
    }
  }
  actions.push(...eccPruneReconciliationActions(ctx, set.dropped));
  const headline =
    set.dropped.length > 0
      ? `Stale artifacts — ${set.artifacts.length} for ${set.dropped.length} dropped CLI(s)`
      : "Stale artifacts — none";
  actions.push(
    digest(
      headline,
      contextBody(set, moved, subtracted, hardDelete, ignoredSelectionFlags(ctx)),
      set,
    ),
  );
  return plan("prune", ...actions);
}

export const command: CommandSpec = {
  name: "prune",
  summary: "Remove stale per-CLI artifacts left by CLIs this repo no longer targets",
  options: [
    {
      flags: "--delete",
      description:
        "hard-delete stale files (single-slot <path>.aih.bak backup) instead of the reversible .aih/legacy/ move",
    },
    {
      flags: "--unrunnable",
      description:
        "ALSO treat targeted CLIs with no binary on PATH as prunable (loud opt-in — a PATH problem looks identical to a dropped CLI)",
    },
  ],
  plan: prunePlan,
};
