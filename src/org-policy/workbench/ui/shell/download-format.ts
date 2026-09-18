import { stableDecisionJson } from "../decision-json.js";
import { serializePolicy } from "./policy-grammar.js";

/**
 * The bytes and names of every Workbench download (NEW-SHELL-PLAN.md §5,
 * "Byte-identical downloads"). DOM-free, so the S0 golden files can be
 * checked against exactly what `file-transfer.ts` hands to the browser.
 */

export const POLICY_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/;
export const DEFAULT_POLICY_FILENAME = "aih-org-policy.json";
export const DECISION_FILENAME = "aih-governance-decision.json";
export const PROTECTED_BUNDLE_FILENAME = "aih-policy-bundle.json";
export const ARTIFACT_INTAKE_FILENAME = "aih-artifact-intake.json";
export const PROJECT_POLICY_FILENAME = "aih-project-policy.json";

/** Imports larger than this are refused before they are read. */
export const MAX_IMPORT_BYTES = 1024 * 1024;

/** Organization policy: `JSON.stringify(policy, null, 2) + "\n"` (legacy `R()`). */
export function policyFileText(policy: unknown): string {
  return serializePolicy(policy);
}

/** Governance decision: the stable decision JSON plus a newline. */
export function decisionFileText(decision: unknown): string {
  return `${stableDecisionJson(decision)}\n`;
}

/** Protected bundle, artifact intake and project policy: two-space JSON plus a newline. */
export function jsonFileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
