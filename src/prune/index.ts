import { type CommandSpec, digest, type Plan, type PlanContext, plan } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { type PruneArtifact, type StalePruneSet, stalePruneSet } from "./detect.js";

/**
 * `aih prune` — preview the stale per-CLI artifacts a repo carries for CLIs it no
 * longer targets ({@link stalePruneSet}). This release is PREVIEW-ONLY: it emits a
 * grouped digest of exactly what a later `--apply` would remove, and writes nothing.
 * Removal (the fail-closed `remove` action: `.aih/legacy/` move for `file`
 * artifacts, in-place block-subtract for `block` artifacts, with a dirty-worktree
 * guard and per-file backups) lands in the next slice — so the flag surface here
 * never over-promises.
 *
 * The stale set is diffed against COMMITTED INTENT only (the `.aih-config.json`
 * marker), so a bare `aih prune` is safe to run anywhere: with no committed target
 * set it reports nothing rather than guessing what to delete.
 */

const SOURCE_LABEL: Record<StalePruneSet["source"], string> = {
  marker: ".aih-config.json",
  ctx: "init orchestrator",
  none: "none",
};

const DISPOSITION_TAG: Record<PruneArtifact["disposition"], string> = {
  file: "file ",
  block: "block",
};

/** One preview line per artifact: disposition tag, path, owning CLI(s), and — for a
 * co-owned `block` — the reassurance that hand-edits survive the subtract. */
function artifactLine(a: PruneArtifact): string {
  const note = a.disposition === "block" ? "  (managed block; hand-edits preserved)" : "";
  return `  [${DISPOSITION_TAG[a.disposition]}] ${a.path}  — ${a.clis.join(", ")}${note}`;
}

function renderPreview(set: StalePruneSet): string {
  if (set.source === "none") {
    return lines(
      "No committed target set (.aih-config.json) to diff against — nothing is treated",
      "as stale. Run `aih bootstrap-ai` to record which CLIs this repo targets, then",
      "`aih prune` will preview artifacts for any CLI you later drop.",
    );
  }
  if (set.dropped.length === 0) {
    return lines(
      "No stale per-CLI artifacts — every CLI wired into this repo is still targeted.",
      `Kept (${SOURCE_LABEL[set.source]}): ${set.targeted.join(", ") || "none"}.`,
    );
  }
  return lines(
    "Stale per-CLI artifacts — CLIs bootstrapped into this repo but no longer in the",
    "committed target set. `file` = aih-exclusive (a clean remove); `block` = an",
    "aih-managed block inside a co-owned file (subtracted in place, never deleted).",
    "",
    `Kept (${SOURCE_LABEL[set.source]}): ${set.targeted.join(", ")}`,
    `Dropped: ${set.dropped.join(", ")}`,
    "",
    ...set.artifacts.map(artifactLine),
    "",
    "Preview only — this release removes nothing. `aih prune --apply` (next slice)",
    "moves `file` artifacts to .aih/legacy/ (reversible) and subtracts `block`",
    "artifacts in place, behind a dirty-worktree guard with per-file backups.",
  );
}

function prunePlan(ctx: PlanContext): Plan {
  const set = stalePruneSet(ctx);
  const headline =
    set.dropped.length > 0
      ? `Stale artifacts — ${set.artifacts.length} for ${set.dropped.length} dropped CLI(s)`
      : "Stale artifacts — none";
  return plan("prune", digest(headline, renderPreview(set), set));
}

export const command: CommandSpec = {
  name: "prune",
  summary: "Preview stale per-CLI artifacts left by CLIs this repo no longer targets",
  // Preview-only in this release: the plan is a single read-only digest and writes
  // nothing, so the dirty-worktree preflight has no write targets to guard. When
  // removal lands, drop this and let the executor gate the remove actions.
  skipWorktreeGate: true,
  plan: prunePlan,
};
