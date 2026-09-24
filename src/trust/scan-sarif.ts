import type { ScanSubjectDigestV1 } from "./scan-subject-files.js";
import { isSourceRelativeSarifUriV1 } from "./trust-lint-sarif.js";

/**
 * Every SARIF log Core reads from Scan crosses a trust boundary: a delegated
 * detector run, precomputed SARIF (a Scanner annex or joined Cisco shards) and
 * each Cisco shard job's output all pass this one check before anything reads
 * them (contract C2, C2a §1.4). The log must be SARIF 2.1.0 with a non-empty
 * runs array; every run an object with a results array; every result an object
 * whose fields Core reads have the SARIF types; every artifact URI
 * source-relative (or ".", the source root). Nothing is defaulted: a missing or
 * null collection is a malformed log, never an empty one.
 *
 * The same check is the completion predicate (owner principle: zero findings
 * count only when the analyzer's own output proves the subject was analyzed).
 * Every run names a tool driver and reports a non-empty list of invocations,
 * each `executionSuccessful: true`, whose notification lists are well formed and
 * hold no `error`-level notification. A bare "succeeded" from Scan proves
 * nothing, so a log without that proof is refused, never read as no findings.
 */
export interface CheckedScanSarifLogV1 {
  readonly version: "2.1.0";
  readonly runs: readonly { readonly results: readonly Record<string, unknown>[] }[];
}

/** Why a log was refused, phrased to follow "returned" or "holds". */
export type CheckedScanSarifV1 =
  | { readonly log: CheckedScanSarifLogV1 }
  | { readonly refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refusal text reaches a report, so bound it and keep control characters out. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? "missing";
  const visible = text.replace(/[\p{C}]/gu, " ");
  return visible.length > 120 ? `${visible.slice(0, 117)}...` : visible;
}

function locationRefusal(location: unknown, at: string): string | undefined {
  if (!isRecord(location)) return `SARIF whose ${at} has a location that is not an object`;
  const physical = location.physicalLocation;
  if (physical === undefined) return undefined;
  if (!isRecord(physical)) return `SARIF whose ${at} has a malformed physical location`;
  const artifact = physical.artifactLocation;
  if (artifact !== undefined) {
    if (!isRecord(artifact)) return `SARIF whose ${at} has a malformed artifact location`;
    const uri = artifact.uri;
    if (
      uri !== undefined &&
      uri !== "." &&
      (typeof uri !== "string" || !isSourceRelativeSarifUriV1(uri))
    )
      return `SARIF artifact URI ${shown(uri)}, which is not relative to the declared source root`;
  }
  const region = physical.region;
  if (region === undefined) return undefined;
  if (!isRecord(region)) return `SARIF whose ${at} has a malformed region`;
  const startLine = region.startLine;
  if (
    startLine !== undefined &&
    (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1)
  )
    return `SARIF whose ${at} has a start line that is not a positive integer`;
  return undefined;
}

function resultRefusal(result: unknown, at: string): string | undefined {
  if (!isRecord(result)) return `SARIF whose ${at} is not an object`;
  if (result.ruleId !== undefined && typeof result.ruleId !== "string")
    return `SARIF whose ${at} has a rule id that is not a string`;
  if (result.level !== undefined && typeof result.level !== "string")
    return `SARIF whose ${at} has a level that is not a string`;
  const message = result.message;
  if (
    message !== undefined &&
    (!isRecord(message) || (message.text !== undefined && typeof message.text !== "string"))
  )
    return `SARIF whose ${at} has a message that is not text`;
  const locations = result.locations;
  if (locations === undefined) return undefined;
  if (!Array.isArray(locations)) return `SARIF whose ${at} has locations that are not a list`;
  for (const location of locations) {
    const refusal = locationRefusal(location, at);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

const NOTIFICATION_LEVELS: ReadonlySet<string> = new Set(["none", "note", "warning", "error"]);
const NOTIFICATION_LISTS = [
  "toolExecutionNotifications",
  "toolConfigurationNotifications",
] as const;

/** A SARIF message object: `text` or `id` (each a string), `markdown` a string, `arguments` strings. */
function isMessage(message: unknown): boolean {
  if (!isRecord(message) || (message.text === undefined && message.id === undefined)) return false;
  return (
    (message.text === undefined || typeof message.text === "string") &&
    (message.id === undefined || typeof message.id === "string") &&
    (message.markdown === undefined || typeof message.markdown === "string") &&
    (message.arguments === undefined ||
      (Array.isArray(message.arguments) &&
        message.arguments.every((argument) => typeof argument === "string")))
  );
}

function isNotification(notification: unknown): boolean {
  return (
    isRecord(notification) &&
    (notification.level === undefined ||
      (typeof notification.level === "string" && NOTIFICATION_LEVELS.has(notification.level))) &&
    (notification.message === undefined || isMessage(notification.message))
  );
}

/** Why a run does not prove its analyzer completed, or undefined when it does. */
function completionRefusal(run: Record<string, unknown>, runIndex: number): string | undefined {
  const driver = isRecord(run.tool) ? run.tool.driver : undefined;
  if (!isRecord(driver) || typeof driver.name !== "string" || driver.name.length === 0)
    return `SARIF whose run ${runIndex} names no tool driver`;
  const invocations = run.invocations;
  if (!Array.isArray(invocations) || invocations.length === 0)
    return `SARIF whose run ${runIndex} reports no invocation, so nothing proves the analyzer completed`;
  for (const [index, invocation] of invocations.entries()) {
    const at = `run ${runIndex} invocation ${index}`;
    if (!isRecord(invocation) || invocation.executionSuccessful !== true)
      return `SARIF whose ${at} is not executionSuccessful: true`;
    // A malformed notification is reported before an error-level one (C2a §1.4).
    for (const key of NOTIFICATION_LISTS) {
      const list = invocation[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every(isNotification))
        return `SARIF whose ${at} has malformed ${key}`;
    }
    for (const key of NOTIFICATION_LISTS) {
      const list = invocation[key];
      if (Array.isArray(list) && list.some((notification) => notification.level === "error"))
        return `SARIF whose ${at} reports an error-level notification in ${key}`;
    }
  }
  return undefined;
}

/** A parsed SARIF log from Scan, checked, or why it is refused. */
export function checkedScanSarifLogV1(log: unknown): CheckedScanSarifV1 {
  if (!isRecord(log)) return { refusal: "a SARIF log that is not a JSON object" };
  if (log.version !== "2.1.0")
    return { refusal: `SARIF version ${shown(log.version)}, expected SARIF 2.1.0` };
  if (!Array.isArray(log.runs)) return { refusal: "a SARIF log with no runs array" };
  if (log.runs.length === 0) return { refusal: "a SARIF log with no runs" };
  for (const [runIndex, run] of log.runs.entries()) {
    if (!isRecord(run)) return { refusal: `SARIF whose run ${runIndex} is not an object` };
    if (!Array.isArray(run.results))
      return { refusal: `SARIF whose run ${runIndex} has no results array` };
    for (const [index, result] of run.results.entries()) {
      const refusal = resultRefusal(result, `run ${runIndex} result ${index}`);
      if (refusal !== undefined) return { refusal };
    }
    const incomplete = completionRefusal(run, runIndex);
    if (incomplete !== undefined) return { refusal: incomplete };
  }
  return { log: log as unknown as CheckedScanSarifLogV1 };
}

/** The key under which Scan states, in `invocations[0].properties`, the subject it proved analyzed. */
export const SCAN_COMPLETION_PROPERTY_V1 = "aihScanCompletionV1";

/** What Core expects a run's completion evidence to state, all of it from Core's own side. */
export interface ExpectedScanCompletionV1 {
  /** The detector Core requested ("detector.cisco" for a shard job). */
  readonly detectorId: string;
  /** Recomputed by Core over the files it submitted (`scan-subject-files.ts`). */
  readonly subject: ScanSubjectDigestV1;
  /** Whether the detector completes on an empty source, so zero analyzed files may be stated. */
  readonly emptyAllowed: boolean;
  /** The analyzer identity Core accepted for this run. */
  readonly analyzer: { readonly version: string; readonly lockSha256: string | null };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function lockText(lock: string | null): string {
  return lock === null ? "no uv.lock" : `uv.lock ${lock}`;
}

/**
 * Why a checked log's completion evidence v1 (C2a §1.6) does not bind the run
 * to what Core requested, or undefined when it does. Every run carries an equal
 * `invocations[0].properties.aihScanCompletionV1` of exactly
 * `{detectorId, subjectTreeSha256, analyzedFileCount, analyzer: {version, lockSha256}}`;
 * the detector is the one Core requested, the subject digest and count equal
 * Core's recomputation, zero files only where the detector completes on an
 * empty source, and the analyzer is the identity Core accepted.
 */
export function scanCompletionRefusalV1(
  log: CheckedScanSarifLogV1,
  expected: ExpectedScanCompletionV1,
): string | undefined {
  let stated: Record<string, unknown> | undefined;
  let statedText: string | undefined;
  for (const [runIndex, run] of log.runs.entries()) {
    const invocations = (run as unknown as Record<string, unknown>).invocations;
    const first = Array.isArray(invocations) ? invocations[0] : undefined;
    const properties = isRecord(first) ? first.properties : undefined;
    const evidence = isRecord(properties) ? properties[SCAN_COMPLETION_PROPERTY_V1] : undefined;
    if (evidence === undefined)
      return `SARIF whose run ${runIndex} carries no ${SCAN_COMPLETION_PROPERTY_V1} completion evidence`;
    const analyzer = isRecord(evidence) ? evidence.analyzer : undefined;
    if (
      !isRecord(evidence) ||
      !hasExactKeys(evidence, [
        "detectorId",
        "subjectTreeSha256",
        "analyzedFileCount",
        "analyzer",
      ]) ||
      typeof evidence.detectorId !== "string" ||
      typeof evidence.subjectTreeSha256 !== "string" ||
      !SHA256_HEX.test(evidence.subjectTreeSha256) ||
      typeof evidence.analyzedFileCount !== "number" ||
      !Number.isSafeInteger(evidence.analyzedFileCount) ||
      evidence.analyzedFileCount < 0 ||
      !isRecord(analyzer) ||
      !hasExactKeys(analyzer, ["version", "lockSha256"]) ||
      typeof analyzer.version !== "string" ||
      analyzer.version.length === 0 ||
      !(
        analyzer.lockSha256 === null ||
        (typeof analyzer.lockSha256 === "string" && SHA256_HEX.test(analyzer.lockSha256))
      )
    )
      return `SARIF whose run ${runIndex} carries malformed ${SCAN_COMPLETION_PROPERTY_V1} completion evidence`;
    const text = JSON.stringify([
      evidence.detectorId,
      evidence.subjectTreeSha256,
      evidence.analyzedFileCount,
      analyzer.version,
      analyzer.lockSha256,
    ]);
    if (statedText !== undefined && text !== statedText)
      return `SARIF whose runs carry different ${SCAN_COMPLETION_PROPERTY_V1} completion evidence`;
    stated = evidence;
    statedText = text;
  }
  if (stated === undefined) return "a SARIF log with no runs";
  const analyzer = stated.analyzer as { version: string; lockSha256: string | null };
  if (stated.detectorId !== expected.detectorId)
    return `completion evidence for ${shown(stated.detectorId)}, not the requested ${expected.detectorId}`;
  if (
    stated.subjectTreeSha256 !== expected.subject.subjectTreeSha256 ||
    stated.analyzedFileCount !== expected.subject.analyzedFileCount
  )
    return `completion evidence for ${String(stated.analyzedFileCount)} files with subject tree ${String(stated.subjectTreeSha256)}; the subject Core submitted has ${expected.subject.analyzedFileCount} files with subject tree ${expected.subject.subjectTreeSha256}`;
  if (stated.analyzedFileCount === 0 && !expected.emptyAllowed)
    return `completion evidence of zero analyzed files, and ${expected.detectorId} does not complete on an empty source`;
  if (
    analyzer.version !== expected.analyzer.version ||
    analyzer.lockSha256 !== expected.analyzer.lockSha256
  )
    return `completion evidence for analyzer ${shown(analyzer.version)} with ${lockText(analyzer.lockSha256)}; Core accepts ${expected.analyzer.version} with ${lockText(expected.analyzer.lockSha256)}`;
  return undefined;
}

/** SARIF text from Scan, parsed and checked, or why it is refused. */
export function checkedScanSarifTextV1(text: string): CheckedScanSarifV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { refusal: "bytes that are not JSON" };
  }
  return checkedScanSarifLogV1(parsed);
}
