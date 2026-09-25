import { createHash } from "node:crypto";
import { readContainedRegularFile } from "../internals/contained-path.js";
import type { Check, CheckCode } from "../internals/verify.js";

export const TRUST_POLICY_VERSION = 3;
const MAX_SOURCE_EVIDENCE_BYTES = 1024 * 1024;
const MAX_SOURCE_EVIDENCE_LINE = 10_000;

export type TrustPolicyLevel = "BLOCK" | "REVIEW" | "WARN" | "INFORMATIONAL" | "SUPPRESSED";

/**
 * Whether a disposition level makes a finding a component carries (D62). BLOCK,
 * REVIEW and WARN are things the analyzers observed that the consumer should see,
 * so a component with any of them is `has-findings`. INFORMATIONAL (ordinary
 * visible Unicode, skipped optional coverage) and SUPPRESSED (non-actionable
 * heuristics whose raw occurrences are retained) are not findings about the
 * component; counting them would make every component `has-findings`.
 */
export function isFindingLevelV1(level: TrustPolicyLevel): boolean {
  return level === "BLOCK" || level === "REVIEW" || level === "WARN";
}

export interface RawScannerOccurrence {
  fingerprint: string;
  analyzer: string;
  ruleId: string;
  message: string;
  level?: string;
  location?: { uri: string; startLine?: number };
  sourceValue?: string;
}

export interface NormalizedTrustFinding {
  fingerprint: string;
  code?: CheckCode;
  checkVerdict?: Check["verdict"];
  detail: string;
  location?: { uri: string; startLine?: number };
  sourceValue?: string;
  rawOccurrenceFingerprints: string[];
}

export interface TrustPolicyDisposition {
  findingFingerprint: string;
  level: TrustPolicyLevel;
  reason: string;
  policyVersion: number;
}

const BLOCK_CODES = new Set<CheckCode>([
  "trust.auto-exec-hook",
  "trust.dependency-confusion",
  "trust.detector-unavailable",
  "trust.hidden-unicode",
  "trust.malicious-code",
  "trust.prompt-injection",
  "trust.sandbox-smoke-failed",
  "trust.sandbox-smoke-unavailable",
  "trust.source-changed",
  "trust.source-drift",
  "trust.typosquat",
  "trust.unpinned-dependency",
  "trust.unsigned-source",
]);

const REVIEW_CODES = new Set<CheckCode>([
  "trust.external-egress",
  "trust.license-missing",
  "trust.permission-risk",
  "trust.skill-metadata-license",
  "trust.untrusted-publisher",
]);

const WARN_CODES = new Set<CheckCode>(["trust.cisco-finding"]);

const INFORMATIONAL_CODES = new Set<CheckCode>(["trust.visible-unicode"]);

const SUPPRESSED_CODES = new Set<CheckCode>([
  "trust.detector-finding",
  "trust.legal-text-detector-finding",
]);

/**
 * What a trust code says (D50): a FINDING is information about the component;
 * an EVIDENCE PROBLEM says the evidence is incomplete; an INTEGRITY failure says
 * the evidence cannot be trusted. Findings and evidence problems are labels the
 * consumer decides on; only integrity failures refuse evidence.
 */
export type TrustCodeClassV1 = "finding" | "evidence-problem" | "integrity";

const TRUST_CODE_CLASSES_V1: Readonly<Record<string, TrustCodeClassV1>> = {
  "trust.auto-exec-hook": "finding",
  "trust.dependency-confusion": "finding",
  "trust.hidden-unicode": "finding",
  "trust.malicious-code": "finding",
  "trust.prompt-injection": "finding",
  "trust.typosquat": "finding",
  "trust.unpinned-dependency": "finding",
  "trust.external-egress": "finding",
  "trust.license-missing": "finding",
  "trust.permission-risk": "finding",
  "trust.skill-metadata-license": "finding",
  "trust.untrusted-publisher": "finding",
  "trust.cisco-finding": "finding",
  "trust.detector-finding": "finding",
  "trust.legal-text-detector-finding": "finding",
  "trust.visible-unicode": "finding",
  "trust.unreviewed-analyzer-rule": "finding",
  "trust.detector-unavailable": "evidence-problem",
  "trust.sandbox-smoke-unavailable": "evidence-problem",
  "trust.sandbox-smoke-failed": "evidence-problem",
  "trust.fetch-blocked": "evidence-problem",
  "trust.unsigned-source": "evidence-problem",
  "trust.source-changed": "integrity",
  "trust.source-drift": "integrity",
  "trust.fetch-metadata-missing": "integrity",
  "trust.fetch-metadata-unreadable": "integrity",
  "trust.fetch-metadata-malformed": "integrity",
  "trust.fetch-metadata-mismatched": "integrity",
};

/**
 * Where an observation goes in component evidence (D62): a failed EVIDENCE-PROBLEM
 * code is an evidence problem whatever its disposition level (a detector that did
 * not run is not a finding about the component); any other code is a finding when
 * its level is a finding level. Every reporter of component evidence uses this, so
 * the lock, the qualification and the occurrence report agree.
 */
export function componentLabelSlotV1(
  code: string,
  checkVerdict: Check["verdict"] | undefined,
  level: TrustPolicyLevel,
): "finding" | "evidence-problem" | undefined {
  if (trustCodeClassV1(code) === "evidence-problem") {
    return checkVerdict === "fail" ? "evidence-problem" : undefined;
  }
  return isFindingLevelV1(level) ? "finding" : undefined;
}

/**
 * The organization's own configured requirements (D67): a skill approval record
 * its posture requires (`trust.unapproved-skill`), an MCP server its MCP policy
 * denies (`mcp.policy-denied`), and its policy file drifting from the pinned copy
 * (`org-policy.drift`). They say nothing about the scanned component, so they are
 * outside TRUST_CODE_CLASSES_V1; the consumer's own policy keeps its stop. Every
 * other trust code must be classified.
 */
export const CONSUMER_POLICY_CODES_V1: ReadonlySet<string> = new Set([
  "trust.unapproved-skill",
  "mcp.policy-denied",
  "org-policy.drift",
]);

/** Whether a code is one of the organization's own configured requirements (D67). */
export function isConsumerPolicyCodeV1(code: string | undefined): boolean {
  return code !== undefined && CONSUMER_POLICY_CODES_V1.has(code);
}

/** The class of a trust code, or undefined for a code outside the trust lane. */
export function trustCodeClassV1(code: string | undefined): TrustCodeClassV1 | undefined {
  return code === undefined || !Object.hasOwn(TRUST_CODE_CLASSES_V1, code)
    ? undefined
    : TRUST_CODE_CLASSES_V1[code];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeSourceValue(
  root: string,
  location: Check["location"] | RawScannerOccurrence["location"],
): string | undefined {
  if (location === undefined) return undefined;
  const line = location.startLine ?? 1;
  if (!Number.isSafeInteger(line) || line < 1 || line > MAX_SOURCE_EVIDENCE_LINE) return undefined;
  const source = readContainedRegularFile(root, location.uri, {
    maxBytes: MAX_SOURCE_EVIDENCE_BYTES,
  });
  if (source.state !== "present") return undefined;
  const lines = source.contents.toString("utf8").split(/\r?\n/);
  // split() represents a terminal newline as one synthetic trailing empty item;
  // it is not a source line that an evidence location may address.
  if (line > lines.length || (line === lines.length && lines.at(-1) === "")) return undefined;
  return lines[line - 1];
}

function inferredCode(check: Check): CheckCode | undefined {
  if (check.code !== undefined) return check.code;
  return check.name.startsWith("trust.") ? (check.name as CheckCode) : undefined;
}

function matchingRaw(
  check: Check,
  occurrences: readonly RawScannerOccurrence[],
): RawScannerOccurrence[] {
  if (check.location === undefined) return [];
  const located = occurrences.filter(
    (occurrence) =>
      occurrence.location?.uri === check.location?.uri &&
      (occurrence.location?.startLine ?? 1) === (check.location?.startLine ?? 1),
  );
  const code = inferredCode(check);
  const detail = check.detail ?? check.name;
  const detector = located.filter(
    (occurrence) =>
      occurrence.analyzer !== "aih-native" &&
      occurrence.message.length > 0 &&
      detail.includes(occurrence.message),
  );
  if (detector.length > 0) return detector;
  const native = located.filter(
    (occurrence) => occurrence.analyzer === "aih-native" && occurrence.ruleId === code,
  );
  if (native.length > 0) return native;
  return [];
}

function normalizedFindingKey(finding: NormalizedTrustFinding): string | undefined {
  if (finding.code === undefined || finding.location === undefined) return undefined;
  return JSON.stringify([
    finding.code,
    finding.location.uri,
    finding.location.startLine ?? 1,
    finding.sourceValue ?? null,
  ]);
}

function mergeNormalizedFinding(
  findings: NormalizedTrustFinding[],
  byKey: Map<string, number>,
  candidate: NormalizedTrustFinding,
): void {
  const key = normalizedFindingKey(candidate);
  const existingIndex = key === undefined ? undefined : byKey.get(key);
  if (existingIndex === undefined) {
    if (key !== undefined) byKey.set(key, findings.length);
    findings.push(candidate);
    return;
  }
  const existing = findings[existingIndex];
  if (existing === undefined) throw new Error(`normalized finding ${existingIndex} is missing`);
  existing.rawOccurrenceFingerprints = [
    ...new Set([...existing.rawOccurrenceFingerprints, ...candidate.rawOccurrenceFingerprints]),
  ];
}

export function normalizeTrustFindings(
  root: string,
  checks: readonly Check[],
  rawOccurrences: readonly RawScannerOccurrence[],
): NormalizedTrustFinding[] {
  const findings: NormalizedTrustFinding[] = [];
  const findingsByKey = new Map<string, number>();
  const consumed = new Set<string>();
  for (const check of checks) {
    const code = inferredCode(check);
    if (code === undefined && check.fingerprint === undefined) continue;
    const raw = matchingRaw(check, rawOccurrences);
    for (const occurrence of raw) consumed.add(occurrence.fingerprint);
    const detail = check.detail ?? check.name;
    const sourceValue = safeSourceValue(root, check.location);
    mergeNormalizedFinding(findings, findingsByKey, {
      fingerprint:
        check.fingerprint ??
        `trust-normalized:${sha256(
          JSON.stringify([code ?? null, check.location ?? null, detail]),
        )}`,
      ...(code === undefined ? {} : { code }),
      checkVerdict: check.verdict,
      detail,
      ...(check.location === undefined ? {} : { location: check.location }),
      ...(sourceValue === undefined ? {} : { sourceValue }),
      rawOccurrenceFingerprints: raw.map((occurrence) => occurrence.fingerprint),
    });
  }
  for (const occurrence of rawOccurrences) {
    if (consumed.has(occurrence.fingerprint)) continue;
    mergeNormalizedFinding(findings, findingsByKey, {
      fingerprint: `trust-normalized:${sha256(occurrence.fingerprint)}`,
      detail: `retained raw detector result: ${occurrence.message}`,
      ...(occurrence.location === undefined ? {} : { location: occurrence.location }),
      ...(occurrence.sourceValue === undefined ? {} : { sourceValue: occurrence.sourceValue }),
      rawOccurrenceFingerprints: [occurrence.fingerprint],
    });
  }
  return findings;
}

/** A generic detector finding's one evidence route out of SUPPRESSED: credible broad autonomy. */
function isCredibleAutonomy(detail: string, sourceValue: string | undefined): boolean {
  const autonomyValue = sourceValue ?? "";
  return (
    /autonomous decision making/i.test(`${detail}\n${autonomyValue}`) &&
    (/\bautomatically\b.*\b(?:without (?:asking|confirmation|consent)|do not ask|never ask)\b/i.test(
      autonomyValue,
    ) ||
      /^\s*(?:do not|never)\s+ask\b/i.test(autonomyValue))
  );
}

/** Whether a `trust.detector-finding` with this detail at `location` takes the autonomy REVIEW. */
export function isCredibleAutonomyFindingV1(
  root: string,
  location: Check["location"],
  detail: string,
): boolean {
  return isCredibleAutonomy(detail, safeSourceValue(root, location));
}

export function dispositionForTrustFinding(
  finding: NormalizedTrustFinding,
): TrustPolicyDisposition {
  if (finding.checkVerdict === "skip") {
    return {
      findingFingerprint: finding.fingerprint,
      level: "INFORMATIONAL",
      reason: "optional or posture-nonmandatory coverage was skipped; retained without gating",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  if (finding.code !== undefined && BLOCK_CODES.has(finding.code)) {
    return {
      findingFingerprint: finding.fingerprint,
      level: "BLOCK",
      reason: "AIH rule proves executable, integrity, or mandatory-coverage danger",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  if (finding.code !== undefined && REVIEW_CODES.has(finding.code)) {
    return {
      findingFingerprint: finding.fingerprint,
      level: "REVIEW",
      reason:
        "credible unresolved permission, egress, credential, publisher, or licensing behavior",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  if (finding.code === "trust.unreviewed-analyzer-rule") {
    return {
      findingFingerprint: finding.fingerprint,
      level: "WARN",
      reason:
        "new analyzer rule, not yet reviewed; next: review it at the analyzer's pinned release, then map it in Core's detector rule map or confirm its generic route and remove it from src/trust/unreviewed-analyzer-rules.ts; it never blocks until then",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  if (finding.code !== undefined && WARN_CODES.has(finding.code)) {
    return {
      findingFingerprint: finding.fingerprint,
      level: "WARN",
      reason: "meaningful non-blocking third-party condition requiring operator attention",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  if (finding.code !== undefined && INFORMATIONAL_CODES.has(finding.code)) {
    return {
      findingFingerprint: finding.fingerprint,
      level: "INFORMATIONAL",
      reason: "ordinary visible Unicode or prose typography retained as informational evidence",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  if (
    finding.code === "trust.detector-finding" &&
    isCredibleAutonomy(finding.detail, finding.sourceValue)
  ) {
    return {
      findingFingerprint: finding.fingerprint,
      level: "REVIEW",
      reason:
        "credible broad autonomous behavior requires an explicit consent and side-effect decision",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  if (finding.code !== undefined && SUPPRESSED_CODES.has(finding.code)) {
    return {
      findingFingerprint: finding.fingerprint,
      level: "SUPPRESSED",
      reason:
        "non-actionable lexical, documentation, legal-text, or generic detector heuristic; raw evidence retained",
      policyVersion: TRUST_POLICY_VERSION,
    };
  }
  return {
    findingFingerprint: finding.fingerprint,
    level: finding.rawOccurrenceFingerprints.length > 0 ? "SUPPRESSED" : "INFORMATIONAL",
    reason:
      finding.rawOccurrenceFingerprints.length > 0
        ? "raw detector occurrence retained; contextual normalization found no actionable contradiction"
        : "informational scan evidence",
    policyVersion: TRUST_POLICY_VERSION,
  };
}

export function rawNativeOccurrences(
  root: string,
  checks: readonly Check[],
): RawScannerOccurrence[] {
  return checks
    .filter((check) => check.location !== undefined && inferredCode(check) !== undefined)
    .map((check, index) => {
      const location = check.location;
      const sourceValue = safeSourceValue(root, location);
      const code = inferredCode(check);
      const message = check.detail ?? check.name;
      return {
        fingerprint:
          check.fingerprint ??
          `trust-raw:${sha256(
            JSON.stringify(["aih-native", code ?? check.name, location, message, index]),
          )}`,
        analyzer: "aih-native",
        ruleId: code ?? check.name,
        message,
        ...(location === undefined ? {} : { location }),
        ...(sourceValue === undefined ? {} : { sourceValue }),
      };
    });
}
