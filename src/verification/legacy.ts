import {
  type Check,
  type Verdict as LegacyVerdict,
  VerificationReport,
} from "../internals/verify.js";
import { MAX_VERIFICATION_STRING_FIELD_LENGTH } from "./constants.js";
import type { Evidence, VerificationPipelineRun, VerificationResult } from "./types.js";

export interface StructuredVerificationLegacyOptions {
  warnAs?: LegacyVerdict;
}

export interface StructuredVerificationRunCheckOptions extends StructuredVerificationLegacyOptions {
  name: string;
  passDetail?: string;
}

function legacyWarnVerdict(options: StructuredVerificationLegacyOptions): LegacyVerdict {
  const warnAs = options.warnAs ?? "pass";
  if (warnAs !== "pass" && warnAs !== "fail" && warnAs !== "skip") {
    throw new Error(`invalid legacy warning verdict: ${String(warnAs)}`);
  }
  return warnAs;
}

function legacyVerdictFor(
  result: VerificationResult,
  options: StructuredVerificationLegacyOptions,
): LegacyVerdict {
  if (result.verdict === "pass") return "pass";
  if (result.verdict === "fail") return "fail";
  return legacyWarnVerdict(options);
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 32 || code === 127) return true;
  }
  return false;
}

function isSafeFingerprint(value: string): boolean {
  if (value.length === 0 || value.length > 256 || hasControlCharacter(value)) return false;
  for (const char of value) {
    const code = char.codePointAt(0);
    const safe =
      code !== undefined &&
      ((code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        char === "." ||
        char === "_" ||
        char === ":" ||
        char === "@" ||
        char === "/" ||
        char === "#" ||
        char === "-");
    if (!safe) return false;
  }
  return true;
}

function safeFingerprint(evidence: Evidence): string | undefined {
  return isSafeFingerprint(evidence.id) ? evidence.id : undefined;
}

function safeLocation(evidence: Evidence): Check["location"] | undefined {
  if (evidence.type !== "file") return undefined;
  const rawPath = evidence.source.split("#", 1)[0]?.trim();
  if (rawPath === undefined || rawPath.length === 0 || hasControlCharacter(rawPath)) {
    return undefined;
  }
  const uri = rawPath.replaceAll("\\", "/");
  if (
    uri.startsWith("/") ||
    uri.startsWith("~") ||
    /^[A-Za-z]:/.test(uri) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)
  ) {
    return undefined;
  }
  const parts = uri.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return undefined;
  for (const part of parts) {
    for (const char of part) {
      const code = char.codePointAt(0);
      const safe =
        code !== undefined &&
        ((code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          char === "." ||
          char === "_" ||
          char === "@" ||
          char === "+" ||
          char === "-");
      if (!safe) return undefined;
    }
  }
  return { uri };
}

function firstSafeLocation(evidence: readonly Evidence[]): Check["location"] | undefined {
  for (const item of evidence) {
    const location = safeLocation(item);
    if (location !== undefined) return location;
  }
  return undefined;
}

function firstSafeFingerprint(evidence: readonly Evidence[]): string | undefined {
  for (const item of evidence) {
    if (item.type === "file" && safeLocation(item) === undefined) continue;
    const fingerprint = safeFingerprint(item);
    if (fingerprint !== undefined) return fingerprint;
  }
  return undefined;
}

function boundedDetail(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length <= MAX_VERIFICATION_STRING_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_VERIFICATION_STRING_FIELD_LENGTH - 15)}... [truncated]`;
}

function detailFromResults(results: readonly VerificationResult[]): string | undefined {
  if (results.length === 0) return undefined;
  return boundedDetail(results.map((result) => `${result.passName}: ${result.message}`).join("; "));
}

export function structuredVerificationResultToCheck(
  result: VerificationResult,
  options: StructuredVerificationLegacyOptions = {},
): Check {
  const check: Check = {
    name: result.passName,
    verdict: legacyVerdictFor(result, options),
    detail: boundedDetail(result.message),
  };
  const location = firstSafeLocation(result.evidence);
  if (location !== undefined) check.location = location;
  const fingerprint = firstSafeFingerprint(result.evidence);
  if (fingerprint !== undefined) check.fingerprint = fingerprint;
  return check;
}

export function structuredVerificationRunToChecks(
  run: VerificationPipelineRun,
  options: StructuredVerificationLegacyOptions = {},
): Check[] {
  return run.results.map((result) => structuredVerificationResultToCheck(result, options));
}

export function structuredVerificationRunToReport(
  run: VerificationPipelineRun,
  options: StructuredVerificationLegacyOptions = {},
): VerificationReport {
  const report = new VerificationReport();
  for (const check of structuredVerificationRunToChecks(run, options)) report.add(check);
  return report;
}

export function structuredVerificationRunToCheck(
  run: VerificationPipelineRun,
  options: StructuredVerificationRunCheckOptions,
): Check {
  const checks = structuredVerificationRunToChecks(run, options);
  const failing = run.results.filter((result) => legacyVerdictFor(result, options) === "fail");
  const skipped = checks.filter((check) => check.verdict === "skip");
  const noteworthy =
    failing.length > 0 ? failing : run.results.filter((result) => result.verdict !== "pass");
  const check: Check = {
    name: options.name,
    verdict:
      failing.length > 0
        ? "fail"
        : skipped.length > 0 && skipped.length === checks.length
          ? "skip"
          : "pass",
    detail: detailFromResults(noteworthy) ?? options.passDetail,
  };
  const sourceCheck = checks.find((entry) => entry.verdict === check.verdict) ?? checks[0];
  if (sourceCheck?.location !== undefined) check.location = sourceCheck.location;
  if (sourceCheck?.fingerprint !== undefined) check.fingerprint = sourceCheck.fingerprint;
  return check;
}
