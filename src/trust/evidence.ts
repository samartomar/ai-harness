import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { Check, CheckCode } from "../internals/verify.js";

export const TRUST_POLICY_VERSION = 3;

export type TrustPolicyLevel = "BLOCK" | "REVIEW" | "WARN" | "INFORMATIONAL" | "SUPPRESSED";

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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeSourceValue(
  root: string,
  location: Check["location"] | RawScannerOccurrence["location"],
): string | undefined {
  if (location === undefined || isAbsolute(location.uri)) return undefined;
  const candidate = normalize(join(root, location.uri));
  const fromRoot = relative(normalize(root), candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
  try {
    const line = location.startLine ?? 1;
    return readFileSync(candidate, "utf8").split(/\r?\n/)[line - 1];
  } catch {
    return undefined;
  }
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
      ...(safeSourceValue(root, check.location) === undefined
        ? {}
        : { sourceValue: safeSourceValue(root, check.location) }),
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
  const autonomyText = `${finding.detail}\n${finding.sourceValue ?? ""}`;
  const autonomyValue = finding.sourceValue ?? "";
  if (
    finding.code === "trust.detector-finding" &&
    /autonomous decision making/i.test(autonomyText) &&
    (/\bautomatically\b.*\b(?:without (?:asking|confirmation|consent)|do not ask|never ask)\b/i.test(
      autonomyValue,
    ) ||
      /^\s*(?:do not|never)\s+ask\b/i.test(autonomyValue))
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
