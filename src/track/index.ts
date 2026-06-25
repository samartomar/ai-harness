import { aihIgnoreWrite } from "../internals/gitignore.js";
import { type CommandSpec, digest, type PlanContext, plan } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { collectSnapshot, historyWrite } from "../report/history.js";

/**
 * `aih track` — record one metrics sample (git + repo state) to
 * `.aih/history.jsonl`, the time-series that powers `aih report` trends. Dry-run
 * previews the sample; `--apply` appends it (idempotent per commit — re-running on
 * the same commit is a byte-stable no-op). Read-only and network-free: it only
 * reads local git/filesystem. Wire it into a commit / agent-stop hook so history
 * accumulates automatically (the Kiro `metrics-on-stop` hook does exactly this).
 */
async function trackPlan(ctx: PlanContext) {
  const snap = await collectSnapshot(ctx);
  if (!snap) {
    return plan(
      "track",
      digest(
        "track — not a git repository",
        lines(
          "`aih track` samples git + repo state, but the target root is not a git repo.",
          "Run it inside a repository (or from a commit hook).",
        ),
        { recorded: false },
      ),
    );
  }
  const preview = lines(
    `commit ${snap.sha} (${snap.ts})`,
    `  branch ${snap.branch} · ${snap.branches} local branch(es) · ${snap.sourceFiles} tracked files`,
    `  commits(7d) ${snap.commits7d} · LOC +${snap.loc.added}/-${snap.loc.removed} (net ${snap.loc.net})`,
    `  adoption ${snap.adoptionScore}/100 · context ~${snap.contextTokens} tokens`,
  );
  return plan(
    "track",
    digest(`track — sample for ${snap.sha} (appended under --apply)`, preview, snap),
    historyWrite(ctx, snap),
    aihIgnoreWrite(ctx.root),
  );
}

export const command: CommandSpec = {
  name: "track",
  summary:
    "Record a metrics sample (git + repo state) to .aih/history.jsonl — powers `aih report` trends",
  plan: trackPlan,
};
