import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AihError } from "../errors.js";
import type { ScanExecutionAdapterV1 } from "../org-policy/governance-input-v1.js";
import {
  SCAN_PACKAGE_INSTALL_COMMAND,
  SCAN_PACKAGE_PROJECT_INSTALL_COMMAND,
  ScanPackageRefusalError,
} from "../scan-package/load-scan-package.js";
import { startTrackedScanCall } from "../scan-package/settlement.js";
import {
  delegatedDetectorResult,
  delegatedScanCompletionRefusalV1,
  resolveScanExecutionV1,
  TrustScanCancelledError,
} from "../trust/detectors.js";
import {
  declaredScanAnalyzerIdentityRefusalV1,
  executedScanAnalyzerIdentityRefusalV1,
} from "../trust/scan-analyzer-identity.js";
import { checkedScanSarifTextV1 } from "../trust/scan-sarif.js";
import type { DimensionReport, ScanCoverage, ScanFinding, ScanSeverity } from "./scan-gate.js";

// The binding scan gate's FAST-tier inspection is Scan's `detector.aih-binding-gate`
// (C2a decision 3): Core sends its binding inventory of the resolved tree and
// reads back one SARIF result per finding plus every dimension's status. Core
// keeps source resolution, digests, identity coverage, acceptance, closure
// classification, the typography overlay and the decision. Nothing here detects.

export const BINDING_GATE_DETECTOR_ID = "detector.aih-binding-gate";
export const BINDING_GATE_EXECUTION_PROFILE = "in-process-binding-gate-v1";

/** The eleven D12 FAST-tier dimensions, in the order Scan reports them. */
export const BINDING_GATE_DIMENSIONS: readonly string[] = Object.freeze([
  "structure",
  "scripts",
  "binaries",
  "hooks",
  "mcp",
  "licenses",
  "hidden-unicode",
  "suspicious-execution",
  "network-update",
  "telemetry",
  "write-destinations",
]);

const FACTS_KEY = "aih-binding-gate/v1";
const SEVERITIES: readonly ScanSeverity[] = ["info", "low", "medium", "high", "critical"];
const COVERAGES: readonly ScanCoverage[] = ["complete", "incomplete"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Scan's per-file `classifyFileTypography` verdict for a `trust.hidden-unicode` file. */
export interface BindingTypographyFact {
  readonly demote: boolean;
  readonly contextClass?: string;
}

/** The inspection did not complete; the gate has nothing to decide on. */
export class BindingGateScanError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_SCAN");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hostOs(): string {
  if (process.platform === "win32") return "windows";
  return process.platform;
}

function hostArchitecture(): string {
  return process.arch === "x64" ? "amd64" : process.arch;
}

/** The binding-gate capability when it declares the gate's profile for this host, else undefined. */
function capabilityDeclaringProfile(
  adapter: ScanExecutionAdapterV1,
): Record<string, unknown> | undefined {
  let capabilities: unknown;
  try {
    capabilities = adapter.listDetectorCapabilitiesV1();
  } catch {
    return undefined;
  }
  if (!Array.isArray(capabilities)) return undefined;
  const capability = capabilities
    .map(asRecord)
    .find((entry) => entry?.detectorId === BINDING_GATE_DETECTOR_ID);
  const profiles = Array.isArray(capability?.executionProfiles) ? capability.executionProfiles : [];
  const profile = profiles
    .map(asRecord)
    .find((entry) => entry?.id === BINDING_GATE_EXECUTION_PROFILE);
  const declared =
    Array.isArray(profile?.supportedPlatforms) &&
    profile.supportedPlatforms.some((host) => {
      const supported = asRecord(host);
      return supported?.os === hostOs() && supported.architecture === hostArchitecture();
    });
  return declared ? capability : undefined;
}

function refuse(detail: string): { readonly refusal: string } {
  return { refusal: `${BINDING_GATE_DETECTOR_ID} ${detail}` };
}

/** Core's acceptance pin: sha256 of the file's UTF-8 text, CRLF-normalized to LF. */
function normalizedTextSha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function typographyFact(value: unknown): BindingTypographyFact | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.demote !== "boolean") return undefined;
  if (record.contextClass !== undefined && typeof record.contextClass !== "string")
    return undefined;
  return record.contextClass === undefined
    ? { demote: record.demote }
    : { demote: record.demote, contextClass: record.contextClass };
}

/**
 * Scan's binding-gate SARIF as Core's dimension reports, in Scan's dimension
 * and finding order (Core's multiplicity). Anything Core cannot account for —
 * a missing or reordered dimension, a result count that disagrees with its
 * dimension, a pin on a path Core did not send, a typography fact on the wrong
 * code, or two facts for one file that disagree — refuses the whole run.
 *
 * A content pin is the acceptance key, so Core never takes Scan's word for it:
 * it recomputes each pinned file's normalized content hash under `sourceRoot`
 * and refuses a pin that differs, so an approval of old content never accepts
 * a finding in changed content.
 */
export function bindingGateReportsFromSarifV1(
  sarifText: string,
  selectedPaths: readonly string[],
  sourceRoot: string,
): { readonly reports: DimensionReport[] } | { readonly refusal: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sarifText);
  } catch {
    return refuse("returned SARIF that is not JSON");
  }
  const log = asRecord(parsed);
  if (log?.version !== "2.1.0" || !Array.isArray(log.runs) || log.runs.length !== 1)
    return refuse("must return a SARIF 2.1.0 log with exactly one run");
  const run = asRecord(log.runs[0]);
  const report = asRecord(asRecord(run?.properties)?.[FACTS_KEY]);
  if (report?.format !== "aih-binding-gate-report" || report.version !== 1)
    return refuse("run carries no aih-binding-gate-report facts");
  const dimensions = Array.isArray(report.dimensions) ? report.dimensions.map(asRecord) : [];
  if (
    dimensions.length !== BINDING_GATE_DIMENSIONS.length ||
    dimensions.some((dimension, index) => dimension?.name !== BINDING_GATE_DIMENSIONS[index])
  )
    return refuse(`must report exactly the dimensions ${BINDING_GATE_DIMENSIONS.join(", ")}`);
  const results = Array.isArray(run?.results) ? run.results : undefined;
  if (results === undefined) return refuse("run has no results array");
  const selected = new Set(selectedPaths);
  const computedPins = new Map<string, string | undefined>();
  const computedPin = (path: string): string | undefined => {
    if (!computedPins.has(path)) {
      let pin: string | undefined;
      try {
        pin = normalizedTextSha256(readFileSync(join(sourceRoot, path), "utf8"));
      } catch {
        pin = undefined;
      }
      computedPins.set(path, pin);
    }
    return computedPins.get(path);
  };
  const typography = new Map<string, BindingTypographyFact>();
  const dottedI = new Map<string, boolean>();
  const findingsByDimension = BINDING_GATE_DIMENSIONS.map((): ScanFinding[] => []);
  let lastDimension = 0;
  for (const [index, raw] of results.entries()) {
    const result = asRecord(raw);
    const code = result?.ruleId;
    const detail = asRecord(result?.message)?.text;
    const facts = asRecord(asRecord(result?.properties)?.[FACTS_KEY]);
    const dimension = BINDING_GATE_DIMENSIONS.indexOf(String(facts?.dimension));
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      typeof detail !== "string" ||
      facts === undefined ||
      dimension < 0 ||
      !SEVERITIES.includes(facts.severity as ScanSeverity) ||
      !COVERAGES.includes(facts.coverage as ScanCoverage)
    )
      return refuse(`result ${index} is not a binding-gate finding`);
    if (dimension < lastDimension) return refuse(`result ${index} is out of dimension order`);
    lastDimension = dimension;
    const finding: ScanFinding = {
      code,
      severity: facts.severity as ScanSeverity,
      detail,
      coverage: facts.coverage as ScanCoverage,
    };
    const path = facts.path;
    const contentSha256 = facts.contentSha256;
    if (path !== undefined || contentSha256 !== undefined) {
      if (typeof path !== "string" || !selected.has(path))
        return refuse(`result ${index} pins a path Core did not send`);
      if (typeof contentSha256 !== "string" || !SHA256_HEX.test(contentSha256))
        return refuse(`result ${index} pins ${path} without a content sha256`);
      const computed = computedPin(path);
      if (computed !== contentSha256)
        return refuse(
          `result ${index} pins ${path} at ${contentSha256}, but Core computed ${computed ?? "nothing (the file is unreadable)"}`,
        );
      finding.path = path;
      finding.contentSha256 = contentSha256;
    }
    if (facts.typography !== undefined) {
      const fact = typographyFact(facts.typography);
      if (code !== "trust.hidden-unicode" || finding.path === undefined || fact === undefined)
        return refuse(`result ${index} carries a typography verdict Core cannot place`);
      const previous = typography.get(finding.path);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(fact))
        return refuse(`two typography verdicts disagree for ${finding.path}`);
      typography.set(finding.path, fact);
    }
    if (facts.dottedIBlocking !== undefined) {
      if (
        code !== "trust.visible-unicode" ||
        finding.path === undefined ||
        typeof facts.dottedIBlocking !== "boolean"
      )
        return refuse(`result ${index} carries a dotted-I fact Core cannot place`);
      const previous = dottedI.get(finding.path);
      if (previous !== undefined && previous !== facts.dottedIBlocking)
        return refuse(`two dotted-I facts disagree for ${finding.path}`);
      dottedI.set(finding.path, facts.dottedIBlocking);
    }
    findingsByDimension[dimension]?.push(finding);
  }
  const reports: DimensionReport[] = [];
  for (const [index, name] of BINDING_GATE_DIMENSIONS.entries()) {
    const dimension = dimensions[index];
    const findings = findingsByDimension[index] ?? [];
    if (dimension?.findingCount !== findings.length)
      return refuse(
        `dimension ${name} reports ${String(dimension?.findingCount)} findings but carries ${findings.length}`,
      );
    if (dimension.status === "missing") {
      if (typeof dimension.reason !== "string" || findings.length > 0)
        return refuse(`missing dimension ${name} must state a reason and carry no findings`);
      reports.push({ dimension: name, status: "missing", reason: dimension.reason, findings });
      continue;
    }
    if (dimension.status !== "produced") return refuse(`dimension ${name} has no status`);
    const typographyHere = Object.fromEntries(
      findings.flatMap((finding) => {
        const fact = finding.path === undefined ? undefined : typography.get(finding.path);
        return finding.code === "trust.hidden-unicode" && fact !== undefined
          ? [[finding.path as string, fact]]
          : [];
      }),
    );
    const dottedIHere = Object.fromEntries(
      findings.flatMap((finding) => {
        const fact = finding.path === undefined ? undefined : dottedI.get(finding.path);
        return finding.code === "trust.visible-unicode" && fact !== undefined
          ? [[finding.path as string, fact]]
          : [];
      }),
    );
    reports.push({
      dimension: name,
      status: "produced",
      findings,
      ...(Object.keys(typographyHere).length === 0 ? {} : { typography: typographyHere }),
      ...(Object.keys(dottedIHere).length === 0 ? {} : { dottedIBlocking: dottedIHere }),
    });
  }
  return { reports };
}

export interface ScanBindingGateOptionsV1 {
  /** Test seam: Scan's execution functions. Production loads the installed package. */
  readonly scanExecution?: ScanExecutionAdapterV1;
  readonly signal?: AbortSignal;
}

// A function, so the check after the await is not narrowed away by the one before it.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Runs `detector.aih-binding-gate` over Core's binding inventory of `treePath`.
 * A missing or incompatible Scan throws `ScanPackageRefusalError`; a cancelled
 * run throws `TrustScanCancelledError`; a refusal, failure or SARIF Core cannot
 * account for throws `BindingGateScanError`. The gate never decides on a
 * partial inspection, and nothing is cached from one.
 */
export async function inspectTreeThroughScanV1(
  treePath: string,
  selectedPaths: readonly string[],
  options: ScanBindingGateOptionsV1 = {},
): Promise<DimensionReport[]> {
  const scan = await resolveScanExecutionV1(options.scanExecution);
  if ("refusal" in scan) throw new ScanPackageRefusalError(scan.refusal);
  const capability = capabilityDeclaringProfile(scan.adapter);
  if (capability === undefined)
    throw new ScanPackageRefusalError({
      reason: "scan-package-incompatible",
      detail: `the ${scan.source === "installed-package" ? "installed @aihq/scan" : "injected scan execution adapter"} declares no ${BINDING_GATE_DETECTOR_ID} ${BINDING_GATE_EXECUTION_PROFILE} profile for ${hostOs()}/${hostArchitecture()}, so Core cannot inspect a binding source. Install it with: ${SCAN_PACKAGE_INSTALL_COMMAND} (in a project: ${SCAN_PACKAGE_PROJECT_INSTALL_COMMAND}).`,
    });
  const declared = declaredScanAnalyzerIdentityRefusalV1(
    capability,
    BINDING_GATE_DETECTOR_ID,
    BINDING_GATE_EXECUTION_PROFILE,
  );
  if (declared !== undefined) throw new BindingGateScanError(declared);
  if (aborted(options.signal))
    throw new TrustScanCancelledError(`before ${BINDING_GATE_DETECTOR_ID} started`);
  const sourceRoot = realpathSync(treePath);
  let raw: unknown;
  try {
    raw = await startTrackedScanCall(options.signal, BINDING_GATE_DETECTOR_ID, () =>
      scan.adapter.runDetectorV1({
        detectorId: BINDING_GATE_DETECTOR_ID,
        executionProfileId: BINDING_GATE_EXECUTION_PROFILE,
        subject: {
          kind: "source-tree",
          sourceRoot,
          selectedClosurePaths: [...selectedPaths],
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  } catch (error) {
    if (aborted(options.signal))
      throw new TrustScanCancelledError(`${BINDING_GATE_DETECTOR_ID} was running`);
    throw new BindingGateScanError(
      `${BINDING_GATE_DETECTOR_ID} failed: ${(error as Error)?.message ?? "unknown error"}`,
    );
  }
  if (aborted(options.signal))
    throw new TrustScanCancelledError(`${BINDING_GATE_DETECTOR_ID} was running`);
  const result = delegatedDetectorResult(raw);
  if (!("sarif" in result))
    throw new BindingGateScanError(
      `${BINDING_GATE_DETECTOR_ID} ${result.outcome}: ${result.unavailable}`,
    );
  if (result.executionProfileId !== BINDING_GATE_EXECUTION_PROFILE)
    throw new BindingGateScanError(
      `${BINDING_GATE_DETECTOR_ID} ran under ${result.executionProfileId ?? "an unstated profile"} instead of ${BINDING_GATE_EXECUTION_PROFILE}`,
    );
  const executed = executedScanAnalyzerIdentityRefusalV1(
    raw,
    BINDING_GATE_DETECTOR_ID,
    BINDING_GATE_EXECUTION_PROFILE,
  );
  if (executed !== undefined) throw new BindingGateScanError(executed);
  // Zero findings count only when the SARIF proves the selection was analyzed.
  const checked = checkedScanSarifTextV1(result.sarif);
  if ("refusal" in checked)
    throw new BindingGateScanError(`${BINDING_GATE_DETECTOR_ID} returned ${checked.refusal}`);
  const completion = delegatedScanCompletionRefusalV1(raw, checked.log, {
    detectorId: BINDING_GATE_DETECTOR_ID,
    executionProfileId: BINDING_GATE_EXECUTION_PROFILE,
    sourceRoot,
    selectedClosurePaths: selectedPaths,
  });
  if (completion !== undefined)
    throw new BindingGateScanError(`${BINDING_GATE_DETECTOR_ID} returned ${completion}`);
  const mapped = bindingGateReportsFromSarifV1(result.sarif, selectedPaths, sourceRoot);
  if ("refusal" in mapped) throw new BindingGateScanError(mapped.refusal);
  return mapped.reports;
}
