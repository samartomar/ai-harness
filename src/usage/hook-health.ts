import { existsSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";

/**
 * Doctor probes for the usage-capture hook layer. A committed hook that fires against
 * an absent recorder (the classic `.aih/` gitignore trap) errors on every tool call /
 * turn; a metrics hook that shells out to `aih` degrades when `aih` isn't on PATH.
 * Both are surfaced here so `aih doctor` catches the enterprise failure modes rather
 * than the agent hitting them silently on every event.
 */

const RECORDER_REL = ".aih/usage-record.mjs";
const METRICS_HOOK_REL = ".kiro/hooks/aih-metrics-on-stop.kiro.hook";

/** Hook host files that (may) invoke the usage recorder, across every supported CLI. */
const HOOK_HOSTS = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  ".antigravity/hooks.json",
  ".gemini/settings.json",
  ".copilot/hooks/aih-usage-metering.json",
  ".windsurf/hooks.json",
  ".opencode/plugins/aih-usage-metering.js",
  ".kimi/config.toml",
  ".kiro/hooks/aih-usage-metering.kiro.hook",
] as const;

/**
 * Fail-closed when a committed hook references the recorder but a fresh clone won't
 * have it — either the recorder is absent, OR it exists locally yet is still
 * git-ignored (a stale/global `.aih/` exclude), so it would never be committed. Local
 * presence alone is NOT enough: the committed hooks point at a path that must survive
 * `git clone`. Skips (never fails) when nothing references it.
 */
export async function usageRecorderCheck(ctx: PlanContext): Promise<Check> {
  const referencing = HOOK_HOSTS.filter((h) => {
    const content = readIfExists(join(ctx.root, h));
    return content?.includes("usage-record.mjs") ?? false;
  });
  if (referencing.length === 0) {
    return {
      name: "usage-recorder",
      verdict: "skip",
      detail: "no committed hooks reference the usage recorder",
    };
  }
  if (!existsSync(join(ctx.root, RECORDER_REL))) {
    return {
      name: "usage-recorder",
      verdict: "fail",
      code: "usage.recorder-missing",
      detail: `${referencing.join(", ")} reference ${RECORDER_REL} but it is absent — run \`aih usage --apply\` and commit ${RECORDER_REL} so a fresh clone has the recorder the hooks invoke`,
    };
  }
  // Present on disk — but if it's still git-ignored it won't be committed, so a fresh
  // clone hits the same missing-recorder failure. `check-ignore -q` exits 0 iff the
  // path IS ignored; a non-git dir / missing git yields a non-zero code and is treated
  // as "can't determine → don't fail" (best-effort, matches doctor's fail-open probes).
  const res = await ctx.run(["git", "check-ignore", "-q", RECORDER_REL], { cwd: ctx.root });
  if (!res.spawnError && res.code === 0) {
    return {
      name: "usage-recorder",
      verdict: "fail",
      code: "usage.recorder-missing",
      detail: `${RECORDER_REL} exists locally but is git-ignored — it won't survive a fresh clone; run \`aih usage --apply\` to narrow \`.aih/\` to \`.aih/*\` + the recorder negation, then commit it`,
    };
  }
  return {
    name: "usage-recorder",
    verdict: "pass",
    detail: `${RECORDER_REL} present and tracked for ${referencing.length} hook host(s)`,
  };
}

/**
 * Advisory (`skip`, never a hard fail — the hook is fail-open) when the Kiro
 * metrics-on-stop hook shells out to `aih` but `aih` isn't resolvable on PATH: the
 * hook then silently skips its snapshot, so `aih report` trends stop accruing. Points
 * the operator at the real fix (put the npm-global bin on PATH).
 */
export async function metricsToolCheck(ctx: PlanContext): Promise<Check> {
  const hook = readIfExists(join(ctx.root, METRICS_HOOK_REL));
  if (hook === undefined || !hook.includes("aih track")) {
    return {
      name: "metrics-hook-tool",
      verdict: "skip",
      detail: "no Kiro metrics-on-stop hook to verify",
    };
  }
  const argv = ctx.host.platform === "windows" ? ["where", "aih"] : ["which", "aih"];
  const res = await ctx.run(argv);
  const resolvable = !res.spawnError && res.code === 0 && res.stdout.trim().length > 0;
  return resolvable
    ? {
        name: "metrics-hook-tool",
        verdict: "pass",
        detail: "aih resolvable on PATH for the Kiro metrics hook",
      }
    : {
        name: "metrics-hook-tool",
        verdict: "skip",
        code: "usage.metrics-tool-missing",
        detail:
          "Kiro metrics-on-stop hook runs `aih track` but `aih` is not on PATH — the hook is fail-open (it just skips the snapshot); add the npm-global bin to PATH to capture `aih report` trends",
      };
}
