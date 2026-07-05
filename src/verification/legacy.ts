import { redactSecrets } from "../guardrails/redact.js";
import {
  type Check,
  type Verdict as LegacyVerdict,
  VerificationReport,
} from "../internals/verify.js";
import { MAX_VERIFICATION_STRING_FIELD_LENGTH } from "./constants.js";
import { buildEvidenceGraph } from "./graph.js";
import { mergeVerificationResults } from "./merge.js";
import type { Evidence, VerificationPipelineRun, VerificationResult } from "./types.js";
import { isWellFormedUtf16 } from "./validation.js";

export interface StructuredVerificationLegacyOptions {
  warnAs?: LegacyVerdict;
  includeMetadata?: boolean;
}

export interface StructuredVerificationRunCheckOptions extends StructuredVerificationLegacyOptions {
  name: string;
  passDetail?: string;
}

const VERIFICATION_TRUNCATION_SUFFIX = "... [truncated]";

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

function toWellFormedUtf16(value: string): string {
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isInteger(next) && next >= 0xdc00 && next <= 0xdfff) {
        text += value[index] ?? "";
        text += value[index + 1] ?? "";
        index += 1;
      } else {
        text += "\uFFFD";
      }
      continue;
    }
    text += code >= 0xdc00 && code <= 0xdfff ? "\uFFFD" : (value[index] ?? "");
  }
  return text;
}

function truncateVerificationPrefix(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let next = value.slice(0, maxLength);
  if (!isWellFormedUtf16(next)) next = toWellFormedUtf16(next);
  while (next.length > maxLength) next = next.slice(0, -1);
  return next;
}

function verificationText(value: string | undefined, fallback: string): string {
  let text = value ?? fallback;
  if (!isWellFormedUtf16(text)) text = toWellFormedUtf16(text);
  text = redactSecrets(text);
  if (text.length === 0) text = fallback;
  if (text.length <= MAX_VERIFICATION_STRING_FIELD_LENGTH) return text;
  return `${truncateVerificationPrefix(
    text,
    MAX_VERIFICATION_STRING_FIELD_LENGTH - VERIFICATION_TRUNCATION_SUFFIX.length,
  )}${VERIFICATION_TRUNCATION_SUFFIX}`;
}

function optionalVerificationText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : verificationText(value, "");
}

function isUnsafeControlCode(code: number | undefined): boolean {
  return (
    code === undefined ||
    code < 32 ||
    code === 127 ||
    (code >= 128 && code <= 159) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isUnsafeControlCode(char.codePointAt(0))) return true;
  }
  return false;
}

function isSafeFingerprint(value: string): boolean {
  if (value.length === 0 || value.length > 256 || hasControlCharacter(value)) return false;
  if (redactSecrets(value) !== value) return false;
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

function looksPathLike(uri: string): boolean {
  if (uri.includes("/")) return true;
  const last = uri.split("/").at(-1) ?? "";
  return last.startsWith(".") || last.includes(".");
}

function safeLocation(evidence: Evidence): Check["location"] | undefined {
  const rawPath = evidence.source.split("#", 1)[0]?.trim();
  if (rawPath === undefined || rawPath.length === 0 || hasControlCharacter(rawPath)) {
    return undefined;
  }
  if (redactSecrets(rawPath) !== rawPath) return undefined;
  const uri = rawPath.replaceAll("\\", "/");
  if (redactSecrets(uri) !== uri) return undefined;
  if (!looksPathLike(uri)) return undefined;
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

function isSafeLegacyLocationPart(value: string): boolean {
  for (const char of value) {
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
    if (!safe) return false;
  }
  return true;
}

function safeLegacyLocationUri(uri: string): string | undefined {
  if (uri.length === 0 || uri.trim() !== uri || hasControlCharacter(uri)) return undefined;
  if (redactSecrets(uri) !== uri) return undefined;
  const normalized = uri.replaceAll("\\", "/");
  if (redactSecrets(normalized) !== normalized) return undefined;
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    /^[A-Za-z]:/.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
  ) {
    return undefined;
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return undefined;
  }
  if (parts.some((part) => !isSafeLegacyLocationPart(part))) return undefined;
  return normalized;
}

function legacyCheckSource(check: Check): string | undefined {
  const location = check.location;
  if (location === undefined) return undefined;
  const uri = safeLegacyLocationUri(location.uri);
  if (uri === undefined) return undefined;
  const startLine = location.startLine;
  if (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) {
    return undefined;
  }
  return startLine === undefined ? uri : `${uri}#L${startLine}`;
}

function legacyCheckEvidence(check: Check): Evidence[] {
  const source = legacyCheckSource(check);
  if (source === undefined) return [];
  const id = check.fingerprint ?? check.code ?? `legacy:${source}`;
  return [
    {
      id,
      type: "legacy-check",
      source,
      ...(check.detail === undefined ? {} : { snippet: check.detail }),
    },
  ];
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
    if (safeLocation(item) === undefined) continue;
    const fingerprint = safeFingerprint(item);
    if (fingerprint !== undefined) return fingerprint;
  }
  return undefined;
}

function stripUnsafeDetailText(value: string, controlReplacement: "" | " "): string {
  const chars = Array.from(value);
  let normalized = "";
  let pendingSpace = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    if (char === "\u001b" && chars[index + 1] === "[") {
      index += 2;
      while (index < chars.length) {
        const code = chars[index]?.codePointAt(0);
        if (code !== undefined && code >= 64 && code <= 126) break;
        index += 1;
      }
      pendingSpace = controlReplacement === " ";
      continue;
    }
    if (char.codePointAt(0) === 0x9b) {
      index += 1;
      while (index < chars.length) {
        const code = chars[index]?.codePointAt(0);
        if (code !== undefined && code >= 64 && code <= 126) break;
        index += 1;
      }
      pendingSpace = controlReplacement === " ";
      continue;
    }
    const code = char.codePointAt(0);
    if (isUnsafeControlCode(code)) {
      pendingSpace = controlReplacement === " ";
      continue;
    }
    if (pendingSpace && normalized.length > 0 && !normalized.endsWith(" ")) normalized += " ";
    normalized += char;
    pendingSpace = false;
  }
  return normalized.trim();
}

function normalizeDetailText(value: string): string {
  const compact = stripUnsafeDetailText(value, "");
  const redactedCompact = redactSecrets(compact);
  if (redactedCompact !== compact) return redactedCompact.trim();
  return redactSecrets(stripUnsafeDetailText(value, " ")).trim();
}

function boundedDetail(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const normalized = normalizeDetailText(value);
  if (normalized.length === 0) return undefined;
  if (normalized.length <= MAX_VERIFICATION_STRING_FIELD_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_VERIFICATION_STRING_FIELD_LENGTH - 15)}... [truncated]`;
}

function boundedName(value: string | undefined, fallback: string): string {
  return boundedDetail(value) ?? fallback;
}

function suffixedPassName(passName: string, suffix: number): string {
  const suffixText = `#${suffix}`;
  if (passName.length + suffixText.length <= MAX_VERIFICATION_STRING_FIELD_LENGTH) {
    return `${passName}${suffixText}`;
  }
  return `${truncateVerificationPrefix(
    passName,
    MAX_VERIFICATION_STRING_FIELD_LENGTH - suffixText.length,
  )}${suffixText}`;
}

function uniqueVerificationResults(results: readonly VerificationResult[]): VerificationResult[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return results.map((result) => {
    if (!used.has(result.passName)) {
      used.add(result.passName);
      return result;
    }
    let suffix = nextSuffix.get(result.passName) ?? 2;
    let passName = suffixedPassName(result.passName, suffix);
    while (used.has(passName)) {
      suffix += 1;
      passName = suffixedPassName(result.passName, suffix);
    }
    nextSuffix.set(result.passName, suffix + 1);
    used.add(passName);
    return { ...result, passName };
  });
}

function maxEvidencePerResult(results: readonly VerificationResult[]): number {
  return Math.max(1, ...results.map((result) => result.evidence.length));
}

function sanitizedEvidence(evidence: Evidence, passName: string, index: number): Evidence {
  const snippet = optionalVerificationText(evidence.snippet);
  return {
    id: verificationText(evidence.id, `${passName}:evidence:${index}`),
    type: verificationText(evidence.type, "evidence"),
    source: verificationText(evidence.source, "unknown"),
    ...(snippet === undefined ? {} : { snippet }),
  };
}

function sanitizedLegacyVerificationResult(result: VerificationResult): VerificationResult {
  const passName = verificationText(result.passName, "legacy check");
  return {
    passName,
    verdict: result.verdict,
    severity: result.severity,
    confidence: result.confidence,
    evidence: result.evidence.map((evidence, evidenceIndex) =>
      sanitizedEvidence(evidence, passName, evidenceIndex),
    ),
    message: verificationText(result.message, passName),
    category: result.category,
  };
}

export function legacyCheckToVerificationResult(check: Check): VerificationResult {
  const passName = verificationText(check.name, "legacy check");
  return {
    passName,
    verdict: check.verdict === "skip" ? "warn" : check.verdict,
    severity: check.verdict === "fail" ? "high" : "info",
    confidence: "high",
    evidence: legacyCheckEvidence(check),
    message: verificationText(check.detail, passName),
    category: "other",
  };
}

export function legacyChecksToVerificationRun(
  checks: readonly Check[],
): VerificationPipelineRun | undefined {
  if (checks.length === 0) return undefined;
  const results = uniqueVerificationResults(
    checks
      .map((check) => legacyCheckToVerificationResult(check))
      .map((result) => sanitizedLegacyVerificationResult(result)),
  );
  return {
    results,
    summary: mergeVerificationResults(results),
    evidenceGraph: buildEvidenceGraph(results, {
      maxResults: results.length,
      maxEvidencePerResult: maxEvidencePerResult(results),
    }),
  };
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
    name: boundedName(result.passName, "structured verification"),
    verdict: legacyVerdictFor(result, options),
    detail: boundedDetail(result.message),
  };
  if (options.includeMetadata !== false) {
    const location = firstSafeLocation(result.evidence);
    if (location !== undefined) check.location = location;
    const fingerprint = firstSafeFingerprint(result.evidence);
    if (fingerprint !== undefined) check.fingerprint = fingerprint;
  }
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
  const entries = run.results.map((result) => ({
    result,
    check: structuredVerificationResultToCheck(result, options),
  }));
  const checks = entries.map((entry) => entry.check);
  const failing = entries.filter((entry) => legacyVerdictFor(entry.result, options) === "fail");
  const skipped = checks.filter((check) => check.verdict === "skip");
  const noteworthy =
    failing.length > 0 ? failing : entries.filter((entry) => entry.result.verdict !== "pass");
  const check: Check = {
    name: boundedName(options.name, "structured verification"),
    verdict:
      failing.length > 0
        ? "fail"
        : skipped.length > 0 && skipped.length === checks.length
          ? "skip"
          : "pass",
    detail:
      detailFromResults(noteworthy.map((entry) => entry.result)) ??
      boundedDetail(options.passDetail),
  };
  const sourceCheck =
    noteworthy.find(
      (entry) => entry.check.location !== undefined || entry.check.fingerprint !== undefined,
    )?.check ??
    (noteworthy.length > 0 ? checks.find((entry) => entry.verdict === check.verdict) : undefined);
  if (sourceCheck?.location !== undefined) check.location = sourceCheck.location;
  if (sourceCheck?.fingerprint !== undefined) check.fingerprint = sourceCheck.fingerprint;
  return check;
}
