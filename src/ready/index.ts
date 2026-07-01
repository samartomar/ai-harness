import {
  type Action,
  type CommandSpec,
  digest,
  doc,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  computeReadiness,
  coreToolsMissing,
  type ReadinessResult,
  renderReadinessBody,
} from "../report/readiness.js";
import {
  detectPms,
  installActionsFor,
  TOOLS,
  type ToolSpec,
  verifyTool,
} from "../tools/install.js";

/**
 * `aih ready` — the readiness GATE. Answers one question: can a developer start work
 * with an AI agent in THIS repo, on THIS machine, right now? It reuses the developer-
 * readiness composition ({@link computeReadiness}) — every signal is one of aih's
 * existing read-only probes (heal's node/npm/TLS ladder, per-CLI loadability, the
 * contract truth check, the secret scan) — and surfaces it two ways at once:
 *
 *  - a rich DIGEST (the graded banner, blockers, per-dimension lines, warn count) —
 *    identical to what `aih report` renders, so the two never drift; and
 *  - ONE gate PROBE that fails iff there are blockers. `alwaysVerify` runs the probe on
 *    every invocation, so a bare `aih ready` DIAGNOSES by default (like `heal`) and
 *    exits non-zero when an agent cannot start here.
 *
 * A single "readiness gate" probe (not one probe per check) keeps the exit signal
 * crisp: the digest already enumerates each blocker; the probe just gates on their
 * count. It NEVER runs the declared first command — it only names it in the handoff.
 *
 * ONE blocker is auto-fixable here: MISSING CORE SHELL TOOLS (rg/fd/jq). Under
 * `--apply` (or an interactive `y`), `aih ready` appends the same install ExecActions
 * `aih tools` emits ({@link installActionsFor} + {@link verifyTool}) so the executor
 * installs them — the confirmation model aih already uses. Every OTHER blocker stays
 * DOC-ONLY: node/npm/TLS/PATH are too destructive to auto-run (their `aih heal` fix is
 * already in the digest), a committed secret is NEVER auto-fixed, and `wontLoad` keeps
 * its `aih bootstrap-ai --apply` guidance rather than recursing into a bootstrap here.
 * The install actions are ADDITIVE: the digest + gate probe print in every mode, and
 * the gate verdict reflects the PRE-install diagnosis (the plan is computed once) — so
 * after a successful `--apply` install the output notes that re-running confirms.
 */

/** The signature "your first command" handoff — names the real work; never runs it. */
function handoffLine(firstCommand: string | null): string {
  return firstCommand
    ? `Your first command:  ${firstCommand}   (declared in the repo — this runs the real work; aih stops here)`
    : "No runnable command declared — see setup.md before starting.";
}

/** The gate probe's {@link Check}: fail with the blocker roll-up, or pass clean. */
function gateCheck(r: ReadinessResult): Check {
  const name = "readiness — no blockers";
  if (r.blockers.length > 0) {
    return {
      name,
      verdict: "fail",
      detail: `${r.blockers.length} blocker(s): ${r.blockers.map((b) => b.id).join(", ")}`,
      code: "ready.blocked",
    };
  }
  return { name, verdict: "pass", detail: "no blockers — an agent can start here" };
}

/** Map the missing core bin names (rg/fd/jq) to their {@link ToolSpec}s, in canonical order. */
function specsForMissing(missingBins: readonly string[]): ToolSpec[] {
  const want = new Set(missingBins);
  return TOOLS.filter((t) => want.has(t.bin));
}

/**
 * Whether to auto-install the missing core tools now. `--apply` IS the confirmation in
 * aih's model — the user opted in. Otherwise, in an interactive TTY with a wired
 * {@link PlanContext.prompter}, prompt `Install rg, fd, jq now? [y/N]` and install only
 * on an explicit `y`/`yes` (mirroring {@link confirmDetectedClis}). Non-TTY with no
 * `--apply` → diagnose only (the digest already shows the install command).
 */
async function shouldInstall(ctx: PlanContext, bins: readonly string[]): Promise<boolean> {
  if (ctx.apply) return true;
  if (!ctx.prompter) return false;
  const answer = await ctx.prompter.ask(`Install ${bins.join(", ")} now? [y/N]: `);
  const yes = answer.trim().toLowerCase();
  return yes === "y" || yes === "yes";
}

/**
 * The install ExecActions + verify probes for the missing core tools, plus a note that
 * re-running `aih ready` confirms the fix (the gate verdict here reflects the PRE-install
 * diagnosis, since the plan is computed once). Reuses the exact `aih tools` machinery.
 */
async function coreToolInstallActions(ctx: PlanContext, specs: ToolSpec[]): Promise<Action[]> {
  const pms = await detectPms(ctx);
  const actions: Action[] = installActionsFor(ctx, specs, pms);
  // Verify each AFTER the execs (the executor runs execs before probes); a still-missing
  // CORE tool fails with `env.tool-install-blocked`, which the support layer renders as a
  // ticket — the same escalation `aih tools` uses when no package manager can install it.
  for (const t of specs) {
    actions.push(probe(`${t.tool} installed`, (c: PlanContext) => verifyTool(c, t, pms)));
  }
  actions.push(
    doc(
      "core tools — re-run to confirm",
      "Installed the missing core shell tools. Re-run `aih ready` to confirm the readiness gate now passes.",
    ),
  );
  return actions;
}

async function readyPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const r = await computeReadiness(ctx);
  const body = `${renderReadinessBody(r)}\n${handoffLine(r.firstCommand)}\n`;
  const data = {
    banner: r.banner,
    blockers: r.blockers,
    warns: r.warns,
    score: r.score,
    rawScore: r.rawScore,
    grade: r.grade,
    firstCommand: r.firstCommand,
  };
  // The digest + gate probe always print (installs are ADDITIVE, never replace the report).
  const actions: Action[] = [
    digest("Developer readiness", body, data),
    probe("readiness — no blockers", () => gateCheck(r)),
  ];

  // The ONE auto-fixable blocker: missing core shell tools (rg/fd/jq). Recompute the
  // missing set with the same `which`/`where` probe the `core-shell-tools` gate uses, so
  // the install targets exactly what it flagged. Install under `--apply`, or an
  // interactive `y`; non-TTY without `--apply` diagnoses only.
  const missingCore = await coreToolsMissing(ctx);
  if (missingCore.length > 0 && (await shouldInstall(ctx, missingCore))) {
    // An interactive "yes" IS apply-consent for the scoped install — aih runs dry
    // until the user opts in, and here the prompt is that opt-in, equivalent to
    // `--apply`. The executor only runs the install execs under `ctx.apply`, so a
    // confirmed prompt on a bare `aih ready` must flip it. Safe because ready's plan
    // has no file writes — the flip enables ONLY the install execs appended below.
    ctx.apply = true;
    actions.push(...(await coreToolInstallActions(ctx, specsForMissing(missingCore))));
  }

  return plan("ready", ...actions);
}

export const command: CommandSpec = {
  name: "ready",
  summary:
    "Readiness gate — can a developer start work with an AI agent here? (graded, blocker-aware)",
  alwaysVerify: true,
  // Offer the "Install rg, fd, jq now? [y/N]" confirmation on a bare `aih ready` in a
  // TTY (not just under `--detect`) — the install is what a first-time repo opener wants.
  wantsInstallPrompt: true,
  plan: readyPlan,
};
