import { join } from "node:path";
import { SHARED_MARKER } from "../bootstrap-ai/canon.js";
import { readIfExists } from "../internals/fsxn.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import { stripManagedBlock } from "../internals/markers.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  remove,
  writeText,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { type PruneArtifact, type StalePruneSet, stalePruneSet } from "./detect.js";

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

/** The subtracted content of a co-owned bootloader (aih's canon block removed), or
 * `undefined` when the block is absent / nothing would change. Read at plan time
 * (pure fs, no spawn) so the `write` action carries the exact bytes to land. */
function bootloaderMinusBlock(ctx: PlanContext, rel: string): string | undefined {
  const text = readIfExists(join(ctx.root, rel));
  if (text === undefined) return undefined;
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

/** The context digest: kept/dropped summary + the manual-review advisory. The
 * `file`/`block` changes are carried by their own action preview lines. */
function contextBody(set: StalePruneSet, moved: number, subtracted: number): string {
  if (set.source === "none") {
    return lines(
      "No committed target set (.aih-config.json) to diff against — nothing is treated",
      "as stale. Run `aih bootstrap-ai` to record which CLIs this repo targets, then",
      "`aih prune` will remove artifacts for any CLI you later drop.",
    );
  }
  if (set.dropped.length === 0) {
    return lines(
      "No stale per-CLI artifacts — every CLI wired into this repo is still targeted.",
      `Kept (${SOURCE_LABEL[set.source]}): ${set.targeted.join(", ") || "none"}.`,
    );
  }
  return lines(
    `Kept (${SOURCE_LABEL[set.source]}): ${set.targeted.join(", ")}`,
    `Dropped: ${set.dropped.join(", ")}`,
    "",
    `${moved} file(s) move to .aih/legacy/ (reversible), ${subtracted} bootloader block(s)`,
    "subtracted in place; the actions above list each. Pass --apply to execute.",
    ...advisoryLines(set),
  );
}

/** The action for one artifact, or `undefined` when there is nothing safe/needed to do. */
function actionFor(ctx: PlanContext, a: PruneArtifact): Action | undefined {
  const who = `${a.clis.join(", ")} dropped`;
  if (a.disposition === "file") {
    return remove(a.path, `stale ${KIND_LABEL[a.kind]} (${who})`);
  }
  if (a.disposition === "block") {
    const stripped = bootloaderMinusBlock(ctx, a.path);
    return stripped === undefined
      ? undefined // block already absent — nothing to subtract
      : writeText(a.path, stripped, `subtract aih canon block from ${a.path} (${who})`);
  }
  return undefined; // advisory → surfaced in the digest, never an auto-action
}

function prunePlan(ctx: PlanContext): Plan {
  const set = stalePruneSet(ctx);
  const actions: Action[] = [];
  // Ensure `.aih/` is gitignored BEFORE any file moves into `.aih/legacy/`
  // (idempotent — records `unchanged` when the pattern is already there).
  if (set.artifacts.some((a) => a.disposition === "file")) {
    actions.push(aihIgnoreWrite(ctx.root));
  }
  let moved = 0;
  let subtracted = 0;
  for (const a of set.artifacts) {
    const action = actionFor(ctx, a);
    if (!action) continue;
    actions.push(action);
    if (action.kind === "remove") moved += 1;
    else if (action.kind === "write") subtracted += 1;
  }
  const headline =
    set.dropped.length > 0
      ? `Stale artifacts — ${set.artifacts.length} for ${set.dropped.length} dropped CLI(s)`
      : "Stale artifacts — none";
  actions.push(digest(headline, contextBody(set, moved, subtracted), set));
  return plan("prune", ...actions);
}

export const command: CommandSpec = {
  name: "prune",
  summary: "Remove stale per-CLI artifacts left by CLIs this repo no longer targets",
  plan: prunePlan,
};
