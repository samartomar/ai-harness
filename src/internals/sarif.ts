// SARIF 2.1.0 envelope/shape adapted from @razroo/isolint (MIT,
// https://github.com/razroo/isolint) — dist/lint/report.js `formatSARIF`. The
// structure ($schema, runs[].tool.driver{name,version,rules}, results[]) is the
// SARIF spec; aih's verdict→level mapping and driver identity are our own.

import { VERSION } from "../program.js";
import type { Verdict, VerificationReport } from "./verify.js";

/** Public schema URL GitHub code-scanning validates SARIF uploads against. */
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

/** Where a reader can learn what `aih` is (SARIF `driver.informationUri`). */
const INFORMATION_URI = "https://github.com/samartomar/ai-harness";

/**
 * aih verdict → SARIF result level. A failed probe is a real defect (`error`,
 * which fails GitHub code-scanning); a `skip` (tool/artifact absent) and a `pass`
 * are both informational (`note`) so the full check ledger surfaces without
 * flipping the scan red on anything that isn't a hard failure.
 */
function level(verdict: Verdict): "error" | "note" {
  return verdict === "fail" ? "error" : "note";
}

/**
 * Render a {@link VerificationReport} (drift / doctor / future scan probes) as a
 * SARIF 2.1.0 document GitHub code-scanning can ingest. Pure — no I/O. Every check
 * becomes one result; each distinct check name becomes one rule. Results carry no
 * `locations` because aih's probes are repo-global (drift, presence, lint roll-up),
 * not line-anchored — a location-less result is valid SARIF and renders as a
 * repo-level annotation.
 */
export function reportToSarif(report: VerificationReport, toolName = "aih"): string {
  const ruleIds = [...new Set(report.checks.map((c) => c.name))];
  const rules = ruleIds.map((id) => ({
    id,
    name: id,
    shortDescription: { text: id },
    defaultConfiguration: { level: "warning" as const },
  }));
  const results = report.checks.map((c) => ({
    ruleId: c.name,
    level: level(c.verdict),
    message: { text: c.detail ?? c.name },
    locations: [] as const,
  }));
  const sarif = {
    $schema: SARIF_SCHEMA,
    version: "2.1.0" as const,
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            informationUri: INFORMATION_URI,
            version: VERSION,
            rules,
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
