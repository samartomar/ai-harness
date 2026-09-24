import { postureGradeCheck } from "../config/governance.js";
import type { Posture } from "../config/posture.js";
import type { Check, CheckCode } from "../internals/verify.js";
import { MCP_SECRET_RULE, SECRET_RULE } from "../secrets/probes.js";
import { gradeTrustCheck } from "./grade.js";

/**
 * Scan's `detector.aih-trust-lint` reports Core's native security findings as
 * SARIF 2.1.0 bytes, one result per finding, in Core's own emission order:
 *
 * - `ruleId`: the Core check code (`trust.prompt-injection`, `secrets.plaintext-detected`, ...);
 * - `message.text`: the finding's detail, before any posture grading;
 * - the first location: the source-relative POSIX path and its 1-based start line;
 * - `fingerprints["aih-trust/v1"]`: Core's content fingerprint for the finding, which
 *   persisted trust acknowledgements are keyed on.
 *
 * Core keeps the policy half: it names each check and grades it by posture exactly
 * as its native scan grades the same finding. The bytes are never trusted: an
 * unknown rule id, a missing field or a path outside the source root refuses the
 * whole result. Nothing is read partially and nothing is coerced.
 */
export const TRUST_LINT_FINGERPRINT_KEY = "aih-trust/v1";

type TrustLintGrading = "trust" | "secrets" | "none";

interface TrustLintRule {
  readonly name: string;
  readonly grading: TrustLintGrading;
}

const trust = (name: CheckCode): TrustLintRule => ({ name, grading: "trust" });
const ungraded = (name: CheckCode): TrustLintRule => ({ name, grading: "none" });

/**
 * Every code the native scan can emit, with the grading Core's native scan applies
 * to it: lint and unpinned-dependency findings go through `gradeTrustCheck`,
 * manifest, typosquat, dependency-confusion and malicious-code findings are
 * emitted ungraded, and secrets are graded as the `secrets` control.
 */
const TRUST_LINT_RULES: ReadonlyMap<string, TrustLintRule> = new Map<string, TrustLintRule>([
  ["trust.prompt-injection", trust("trust.prompt-injection")],
  ["trust.external-egress", trust("trust.external-egress")],
  ["trust.hidden-unicode", trust("trust.hidden-unicode")],
  ["trust.visible-unicode", trust("trust.visible-unicode")],
  ["trust.unpinned-dependency", trust("trust.unpinned-dependency")],
  ["trust.auto-exec-hook", ungraded("trust.auto-exec-hook")],
  ["trust.permission-risk", ungraded("trust.permission-risk")],
  ["trust.typosquat", ungraded("trust.typosquat")],
  ["trust.dependency-confusion", ungraded("trust.dependency-confusion")],
  ["trust.malicious-code", ungraded("trust.malicious-code")],
  ["secrets.plaintext-detected", { name: SECRET_RULE, grading: "secrets" }],
  ["mcp.hardcoded-secret", { name: MCP_SECRET_RULE, grading: "secrets" }],
  ["mcp.config-invalid", { name: "mcp-config-invalid", grading: "secrets" }],
]);

export type TrustLintSarifMappingV1 = { readonly checks: Check[] } | { readonly refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refusal text reaches a report, so bound it and keep control characters out. */
function shown(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const visible = text.replace(/[\p{C}]/gu, " ");
  return visible.length > 120 ? `${visible.slice(0, 117)}...` : visible;
}

/**
 * A SARIF artifact URI that names a path under the declared source root, in POSIX
 * form, as C2 requires of every URI Scan returns.
 */
export function isSourceRelativeSarifUriV1(uri: string): boolean {
  if (uri.length === 0 || uri.includes("\\") || uri.startsWith("/")) return false;
  // A drive letter, a URL (file:///..., https://...) or a file: URI never names a source path.
  if (/^[A-Za-z]:/.test(uri) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(uri) || /^file:/i.test(uri))
    return false;
  return !uri.split("/").some((part) => part === ".." || part === "." || part.length === 0);
}

function gradeTrustLintCheck(check: Check, grading: TrustLintGrading, posture: Posture): Check {
  if (grading === "trust") return gradeTrustCheck(check, posture);
  if (grading === "secrets") return postureGradeCheck(check, "secrets", posture);
  return check;
}

function mapResult(
  result: unknown,
  index: number,
  posture: Posture,
): { readonly check: Check } | { readonly refusal: string } {
  const at = `result ${index}`;
  if (!isRecord(result)) return { refusal: `${at} is not an object` };
  const ruleId = result.ruleId;
  if (typeof ruleId !== "string") return { refusal: `${at} has no rule id` };
  const rule = TRUST_LINT_RULES.get(ruleId);
  if (rule === undefined) return { refusal: `${at} has unknown rule id ${shown(ruleId)}` };
  const message = isRecord(result.message) ? result.message.text : undefined;
  if (typeof message !== "string" || message.length === 0)
    return { refusal: `${at} (${ruleId}) has no message text` };
  const locations = result.locations;
  const physical =
    Array.isArray(locations) && isRecord(locations[0]) && isRecord(locations[0].physicalLocation)
      ? locations[0].physicalLocation
      : undefined;
  const uri = isRecord(physical?.artifactLocation) ? physical.artifactLocation.uri : undefined;
  if (typeof uri !== "string" || !isSourceRelativeSarifUriV1(uri))
    return { refusal: `${at} (${ruleId}) has no source-relative location: ${shown(uri)}` };
  const startLine = isRecord(physical?.region) ? physical.region.startLine : undefined;
  if (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1)
    return { refusal: `${at} (${ruleId}) has no 1-based start line` };
  const fingerprint = isRecord(result.fingerprints)
    ? result.fingerprints[TRUST_LINT_FINGERPRINT_KEY]
    : undefined;
  if (typeof fingerprint !== "string" || fingerprint.length === 0)
    return { refusal: `${at} (${ruleId}) has no ${TRUST_LINT_FINGERPRINT_KEY} fingerprint` };
  const check: Check = {
    name: rule.name,
    verdict: "fail",
    detail: message,
    code: ruleId as CheckCode,
    location: { uri, startLine },
    fingerprint,
  };
  return { check: gradeTrustLintCheck(check, rule.grading, posture) };
}

/** Scan's native-finding SARIF as Core's graded native checks, or why it was refused. */
export function trustLintChecksFromSarifV1(
  sarif: string,
  posture: Posture,
): TrustLintSarifMappingV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sarif);
  } catch {
    return { refusal: "detector.aih-trust-lint returned bytes that are not JSON" };
  }
  if (!isRecord(parsed) || parsed.version !== "2.1.0" || !Array.isArray(parsed.runs))
    return { refusal: "detector.aih-trust-lint returned JSON that is not a SARIF 2.1.0 log" };
  const checks: Check[] = [];
  let index = 0;
  for (const run of parsed.runs) {
    if (!isRecord(run)) return { refusal: "detector.aih-trust-lint returned a malformed run" };
    const results = run.results ?? [];
    if (!Array.isArray(results))
      return { refusal: "detector.aih-trust-lint returned a run whose results are not a list" };
    for (const result of results) {
      const mapped = mapResult(result, index, posture);
      if ("refusal" in mapped)
        return { refusal: `detector.aih-trust-lint SARIF ${mapped.refusal}` };
      checks.push(mapped.check);
      index++;
    }
  }
  return { checks };
}
