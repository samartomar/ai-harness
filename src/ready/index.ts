import { type CommandSpec, digest, type PlanContext, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  computeReadiness,
  type ReadinessResult,
  renderReadinessBody,
} from "../report/readiness.js";

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
 * It lives in CAPABILITIES (not READONLY) so slice 4 can add dependency installs under
 * `--apply`; `alwaysVerify` gives bare `aih ready` its diagnose-by-default behavior.
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
  return plan(
    "ready",
    digest("Developer readiness", body, data),
    probe("readiness — no blockers", () => gateCheck(r)),
  );
}

export const command: CommandSpec = {
  name: "ready",
  summary:
    "Readiness gate — can a developer start work with an AI agent here? (graded, blocker-aware)",
  alwaysVerify: true,
  plan: readyPlan,
};
