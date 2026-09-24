import { isSourceRelativeSarifUriV1 } from "./trust-lint-sarif.js";

/**
 * Every SARIF log Core reads from Scan crosses a trust boundary: a delegated
 * detector run, precomputed SARIF (a Scanner annex or joined Cisco shards) and
 * each Cisco shard job's output all pass this one check before anything reads
 * them (contract C2, C2a §1.4). The log must be SARIF 2.1.0 with a runs array;
 * every run an object with a results array; every result an object whose fields
 * Core reads have the SARIF types; every artifact URI source-relative (or ".",
 * the source root). Nothing is defaulted: a missing or null collection is a
 * malformed log, never an empty one.
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

/** A parsed SARIF log from Scan, checked, or why it is refused. */
export function checkedScanSarifLogV1(log: unknown): CheckedScanSarifV1 {
  if (!isRecord(log)) return { refusal: "a SARIF log that is not a JSON object" };
  if (log.version !== "2.1.0")
    return { refusal: `SARIF version ${shown(log.version)}, expected SARIF 2.1.0` };
  if (!Array.isArray(log.runs)) return { refusal: "a SARIF log with no runs array" };
  for (const [runIndex, run] of log.runs.entries()) {
    if (!isRecord(run)) return { refusal: `SARIF whose run ${runIndex} is not an object` };
    if (!Array.isArray(run.results))
      return { refusal: `SARIF whose run ${runIndex} has no results array` };
    for (const [index, result] of run.results.entries()) {
      const refusal = resultRefusal(result, `run ${runIndex} result ${index}`);
      if (refusal !== undefined) return { refusal };
    }
  }
  return { log: log as unknown as CheckedScanSarifLogV1 };
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
