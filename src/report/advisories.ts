/**
 * Report-panel advisories — the analytics half of the support taxonomy. A
 * verification run (heal/doctor/…) turns a *broken environment* into a ticket;
 * this turns `aih report`'s own panels (over-budget context, incomplete adoption)
 * into the same routable {@link Check}s, so they flow through `findingsFrom` into
 * copy-ready self-fix notes and the dashboard's Copy buttons.
 *
 * Two contracts are preserved exactly:
 *   - `--gate` keeps the per-turn budget as the CI gate ("per-turn token budget":
 *     a `fail` flips the exit code, unchanged — now also CODED so it produces a
 *     finding). WITHOUT `--gate`, an over-budget footprint is a non-gating `skip`
 *     under a DISTINCT name, so a bare `aih report` still exits 0 and grows no
 *     gating probe.
 *   - Adoption gaps are always advisory (`skip`, never gate) and only surface in a
 *     repo that opted into the harness (a committed `.aih-config.json` marker), so
 *     `aih report` on an unrelated repo never nags about adoption.
 *
 * Pure — no I/O, no clock. The caller supplies the model + adoption snapshot it
 * already computed for the panels.
 */

import type { Check } from "../internals/verify.js";
import type { LoadGroupModel } from "./loadgroups.js";

/** The Configuration panel's adoption snapshot (present count + the absent artifact names). */
export interface AdoptionSnapshot {
  present: number;
  total: number;
  absent: string[];
}

/** The Repo Contract panel's truth snapshot — non-portable-path + known-gap counts. */
export interface ContractSnapshot {
  unportable: number;
  knownGaps: number;
}

export interface AdvisoryInput {
  /** Per-turn load-group model (local scope only; absent for `--org`). */
  model?: LoadGroupModel;
  /** Managed-artifact presence from the Configuration panel (local scope only). */
  adoption?: AdoptionSnapshot;
  /** Repo Contract truth snapshot (local scope only; absent when no contract committed). */
  contract?: ContractSnapshot;
  /** `--gate`: the per-turn budget becomes a CI gate (a `fail` flips the exit). */
  gate: boolean;
  /** Repo opted into the harness (committed marker) — gates the adoption advisory. */
  initialized: boolean;
}

/** "worst tool (claude) ~12000 tok > budget 8000" — deterministic, no paths. */
function budgetDetail(m: LoadGroupModel): string {
  const who = m.worst ? `worst tool (${m.worst.clis.join(", ")}) ` : "";
  return `${who}~${m.worstTokens} tok ${m.overBudget ? ">" : "≤"} budget ${m.budgetTokens}`;
}

/** Report-panel advisories as coded {@link Check}s, most-actionable first. */
export function reportAdvisories(input: AdvisoryInput): Check[] {
  const out: Check[] = [];
  const m = input.model;
  if (m) {
    if (input.gate) {
      // Unchanged gate semantics — the only check whose `fail` drives the exit.
      out.push(
        m.overBudget
          ? {
              name: "per-turn token budget",
              verdict: "fail",
              detail: budgetDetail(m),
              code: "report.context-over-budget",
            }
          : { name: "per-turn token budget", verdict: "pass", detail: budgetDetail(m) },
      );
    } else if (m.overBudget) {
      // Advisory only: a distinct name (so the gate probe stays gate-only) and a
      // `skip` verdict (so a bare `aih report` keeps exiting 0).
      out.push({
        name: "context budget (advisory)",
        verdict: "skip",
        detail: budgetDetail(m),
        code: "report.context-over-budget",
      });
    }
  }
  const a = input.adoption;
  if (input.initialized && a && a.absent.length > 0) {
    out.push({
      name: "harness adoption",
      verdict: "skip",
      detail: `${a.present} of ${a.total} managed artifacts present; missing: ${a.absent.join(", ")}`,
      code: "report.low-adoption",
    });
  }
  // A committed contract that hard-codes a non-portable path is "untrue" — it lies about
  // the repo on another machine. Under `--gate` it flips the exit (like the budget gate);
  // otherwise it is a non-gating `skip` advisory under a distinct name. Known gaps are the
  // contract's HONEST self-report, not untruth, so they never trigger this.
  const ct = input.contract;
  if (ct && ct.unportable > 0) {
    const detail = `${ct.unportable} non-portable path(s) in project.json — re-run \`aih contract --apply\``;
    out.push(
      input.gate
        ? { name: "contract truth", verdict: "fail", detail, code: "report.contract-untrue" }
        : {
            name: "contract truth (advisory)",
            verdict: "skip",
            detail,
            code: "report.contract-untrue",
          },
    );
  }
  return out;
}
