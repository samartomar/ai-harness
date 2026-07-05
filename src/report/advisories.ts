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

import type { Check, CheckCode } from "../internals/verify.js";
import { buildEvidenceGraph } from "../verification/graph.js";
import { structuredVerificationRunToChecks } from "../verification/legacy.js";
import { mergeVerificationResults } from "../verification/merge.js";
import type {
  Evidence,
  Verdict as StructuredVerdict,
  VerificationPipelineRun,
  VerificationResult,
} from "../verification/types.js";
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

const REPORT_ADVISORY_CODES = [
  "report.context-over-budget",
  "report.low-adoption",
  "report.contract-untrue",
] as const satisfies readonly CheckCode[];

type ReportAdvisoryCode = (typeof REPORT_ADVISORY_CODES)[number];

function isReportAdvisoryCode(value: string | undefined): value is ReportAdvisoryCode {
  return value !== undefined && (REPORT_ADVISORY_CODES as readonly string[]).includes(value);
}

function reportEvidence(code: ReportAdvisoryCode): Evidence {
  return { id: code, type: code, source: "report" };
}

function reportResult(
  passName: string,
  verdict: StructuredVerdict,
  message: string,
  code?: ReportAdvisoryCode,
): VerificationResult {
  return {
    passName,
    verdict,
    severity: verdict === "fail" ? "high" : verdict === "warn" ? "low" : "info",
    confidence: "high",
    evidence: code === undefined ? [] : [reportEvidence(code)],
    message,
    category: "other",
  };
}

function reportCodeFrom(result: VerificationResult): ReportAdvisoryCode | undefined {
  for (const entry of result.evidence) {
    if (isReportAdvisoryCode(entry.type)) return entry.type;
  }
  return undefined;
}

function reportAdvisoryRun(input: AdvisoryInput): VerificationPipelineRun | undefined {
  const results = reportAdvisoryResults(input);
  if (results.length === 0) return undefined;
  return {
    results,
    summary: mergeVerificationResults(results),
    evidenceGraph: buildEvidenceGraph(results),
  };
}

/** Report-panel advisories as structured verification results, most-actionable first. */
export function reportAdvisoryResults(input: AdvisoryInput): VerificationResult[] {
  const out: VerificationResult[] = [];
  const m = input.model;
  if (m) {
    const detail = budgetDetail(m);
    if (input.gate) {
      // Unchanged gate semantics — the only check whose `fail` drives the exit.
      out.push(
        m.overBudget
          ? reportResult("per-turn token budget", "fail", detail, "report.context-over-budget")
          : reportResult("per-turn token budget", "pass", detail),
      );
    } else if (m.overBudget) {
      // Advisory only: a distinct name (so the gate probe stays gate-only) and a
      // `skip` verdict (so a bare `aih report` keeps exiting 0).
      out.push(
        reportResult("context budget (advisory)", "warn", detail, "report.context-over-budget"),
      );
    }
  }
  const a = input.adoption;
  if (input.initialized && a && a.absent.length > 0) {
    out.push(
      reportResult(
        "harness adoption",
        "warn",
        `${a.present} of ${a.total} managed artifacts present; missing: ${a.absent.join(", ")}`,
        "report.low-adoption",
      ),
    );
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
        ? reportResult("contract truth", "fail", detail, "report.contract-untrue")
        : reportResult("contract truth (advisory)", "warn", detail, "report.contract-untrue"),
    );
  }
  return out;
}

/** Report-panel advisories as coded legacy {@link Check}s, most-actionable first. */
export function reportAdvisories(input: AdvisoryInput): Check[] {
  const run = reportAdvisoryRun(input);
  if (run === undefined) return [];
  return structuredVerificationRunToChecks(run, {
    warnAs: "skip",
    includeMetadata: false,
  }).map((check, index) => {
    const result = run.results[index];
    if (result === undefined) return check;
    const code = reportCodeFrom(result);
    return code === undefined ? check : { ...check, code };
  });
}
