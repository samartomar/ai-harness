import { lstatSync, readdirSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { Platform } from "../platform/base.js";
import {
  loadScanExecutionAdapterV1,
  type ScanPackageImporterV1,
  ScanPackageRefusalError,
} from "../scan-package/load-scan-package.js";
import { probeScanDetectorsV1 } from "../trust/detector-availability.js";
import {
  DEFAULT_UV_EXECUTION_PROFILE,
  resolveCiscoScanConcurrency,
  SCAN_DETECTOR_IDS,
  type TrustDetectorName,
  type UvExecutionProfileIdV1,
} from "../trust/detectors.js";
import type { SkillSpectorImageApproval } from "../trust/images.js";
import {
  acceptedScanAnalyzerIdentityV1,
  declaredScanAnalyzerIdentityRefusalV1,
  observedScanAnalyzerVersionV1,
} from "../trust/scan-analyzer-identity.js";
import {
  CISCO_MCP_SCANNER_ANALYZER,
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_ANALYZER,
  CISCO_SKILL_SCANNER_VERSION,
  SEMGREP_ANALYZER,
  SEMGREP_VERSION,
  SNYK_AGENT_SCAN_ANALYZER,
  SNYK_AGENT_SCAN_VERSION,
} from "../trust/scanner-runtime-identity.js";
import type { BaselineCatalogComponent } from "./catalog.js";
import { nativeAnalyzerIdentity } from "./native-identity.js";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "./scanner-profile.js";
import type { VetBaselineCatalogOptions } from "./vet.js";

export {
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_VERSION,
  SEMGREP_VERSION,
  SNYK_AGENT_SCAN_VERSION,
};

export const CISCO_SKILL_SCANNER_SPEC = `cisco-ai-skill-scanner==${CISCO_SKILL_SCANNER_VERSION}`;

export const REQUIRED_BASELINE_DETECTORS = [
  "skillspector",
  "semgrep",
  "cisco",
] as const satisfies readonly TrustDetectorName[];

export const REQUIRED_BASELINE_ANALYZERS = [
  "aih-native",
  "skillspector@docker",
  "semgrep@uv:1.173.0",
  "cisco@uvx",
] as const;

function treeContainsSkillFile(path: string): boolean {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  if (stats.isFile()) return basename(path) === "SKILL.md";
  if (!stats.isDirectory()) return false;
  return readdirSync(path, { withFileTypes: true }).some((entry) => {
    if (entry.isSymbolicLink()) return false;
    return treeContainsSkillFile(join(path, entry.name));
  });
}

function containsSkillContent(
  component: Pick<BaselineCatalogComponent, "paths" | "skillContent">,
  sourceRoot?: string,
): boolean {
  if (component.skillContent === true) return true;
  if (
    component.paths.some((path) =>
      path.split("/").some((segment) => segment === "skills" || segment === "SKILL.md"),
    )
  ) {
    return true;
  }
  return (
    sourceRoot !== undefined &&
    component.paths.some((path) => treeContainsSkillFile(join(sourceRoot, ...path.split("/"))))
  );
}

export function requiredBaselineAnalyzersForComponent(
  component: Pick<BaselineCatalogComponent, "paths" | "skillContent">,
  sourceRoot?: string,
): readonly string[] {
  return containsSkillContent(component, sourceRoot)
    ? REQUIRED_BASELINE_ANALYZERS
    : REQUIRED_BASELINE_ANALYZERS.filter((name) => name !== "cisco@uvx");
}

export function requiredBaselineDetectorsForComponent(
  component: Pick<BaselineCatalogComponent, "paths" | "skillContent">,
  sourceRoot?: string,
): readonly TrustDetectorName[] {
  return containsSkillContent(component, sourceRoot)
    ? REQUIRED_BASELINE_DETECTORS
    : REQUIRED_BASELINE_DETECTORS.filter((name) => name !== "cisco");
}

/**
 * The analyzer identities committed baseline evidence is checked against. They
 * are pinned: Cisco and Semgrep are the protected Scanner publisher's, and the
 * MCP and Snyk identities are the uv.lock digests Core shipped before Scan
 * owned those environments.
 */
export function baselineAnalyzerVersions(): Readonly<Record<string, string>> {
  return {
    ...SCANNER_BASELINE_ANALYZER_VERSIONS,
    [CISCO_MCP_SCANNER_ANALYZER]: "4.8.2+uvlock.92846b24c170",
    [SNYK_AGENT_SCAN_ANALYZER]: "0.5.17+uvlock.49064889ec53",
  };
}

const UV_ANALYZER_LABELS = [
  ["cisco", CISCO_SKILL_SCANNER_ANALYZER],
  ["semgrep", SEMGREP_ANALYZER],
  ["mcp-scanner", CISCO_MCP_SCANNER_ANALYZER],
  ["snyk-agent-scan", SNYK_AGENT_SCAN_ANALYZER],
] as const satisfies readonly (readonly [TrustDetectorName, string])[];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Analyzer identities for a fresh vet through the installed `@aihq/scan`: the
 * native identity is Core's policy digest, SkillSpector is the pinned image,
 * and each uv analyzer is the identity Core accepts for `executionProfileId`
 * (`ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1`), never Scan's declaration. Scan must
 * declare exactly that identity: a required analyzer it does not refuses the
 * vet, and an optional one is not named (so a receipt from it is unattributed).
 */
export function scanBaselineAnalyzerVersionsV1(
  capabilities: readonly unknown[],
  executionProfileId: UvExecutionProfileIdV1,
): { readonly versions: Readonly<Record<string, string>>; readonly ciscoLockSha256: string } {
  const versions: Record<string, string> = {
    // A content digest, not the package VERSION (see native-identity.ts): the
    // identity's job is behavioral discrimination, and a version prefix would
    // invalidate all receipts at every release version bump even when no
    // detector source changed, forcing a full re-vet in every release PR.
    "aih-native": nativeAnalyzerIdentity(),
    "skillspector@docker": SCANNER_BASELINE_ANALYZER_VERSIONS["skillspector@docker"],
  };
  let ciscoLockSha256: string | undefined;
  for (const [detector, label] of UV_ANALYZER_LABELS) {
    const detectorId = SCAN_DETECTOR_IDS[detector];
    const capability = capabilities.map(asRecord).find((entry) => entry?.detectorId === detectorId);
    const identity = acceptedScanAnalyzerIdentityV1(detectorId, executionProfileId);
    const refusal =
      capability === undefined
        ? `the installed @aihq/scan declares no ${detectorId} capability`
        : declaredScanAnalyzerIdentityRefusalV1(capability, detectorId, executionProfileId);
    if (refusal !== undefined || identity?.lockSha256 == null) {
      if (REQUIRED_BASELINE_DETECTORS.some((required) => required === detector))
        throw new ScanPackageRefusalError({
          reason: "scan-package-incompatible",
          detail: `${refusal ?? `Core pins no uv.lock for ${detectorId}`}; a baseline vet cannot name the analyzer it runs.`,
        });
      continue;
    }
    versions[label] = observedScanAnalyzerVersionV1(identity);
    if (detector === "cisco") ciscoLockSha256 = identity.lockSha256;
  }
  if (ciscoLockSha256 === undefined) throw new Error("Cisco analyzer lock was not resolved");
  return { versions, ciscoLockSha256 };
}

export async function requiredBaselineVetOptions(runtime: {
  platform: Platform;
  env: NodeJS.ProcessEnv;
  uvExecutionProfileId?: UvExecutionProfileIdV1;
  progress?: (message: string) => void;
  /** Test seam: resolves the package namespace. Production imports the installed peer. */
  importer?: ScanPackageImporterV1;
}): Promise<VetBaselineCatalogOptions> {
  const loaded = await loadScanExecutionAdapterV1(runtime.importer);
  if (!loaded.ok) throw new ScanPackageRefusalError(loaded.refusal);
  const executionProfileId = runtime.uvExecutionProfileId ?? DEFAULT_UV_EXECUTION_PROFILE;
  const identity = scanBaselineAnalyzerVersionsV1(
    loaded.adapter.listDetectorCapabilitiesV1(),
    executionProfileId,
  );
  return {
    scanOptions: {
      platform: runtime.platform,
      env: runtime.env,
      scanExecution: loaded.adapter,
      uvExecutionProfileId: executionProfileId,
      progress: runtime.progress,
    },
    requiredAnalyzers: requiredBaselineAnalyzersForComponent,
    requiredDetectorsForComponent: requiredBaselineDetectorsForComponent,
    analyzerVersions: identity.versions,
    sourceWideScan: true,
    sourceWideCisco: {
      analyzerLockSha256: identity.ciscoLockSha256,
      workerConcurrency: resolveCiscoScanConcurrency(runtime.env),
      ...(runtime.importer === undefined ? {} : { importer: runtime.importer }),
    },
  };
}

export interface BaselinePreflightRuntime {
  platform: Platform;
  env: NodeJS.ProcessEnv;
  uvExecutionProfileId?: UvExecutionProfileIdV1;
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
  signal?: AbortSignal;
  /** Test seam: resolves the package namespace. Production imports the installed peer. */
  importer?: ScanPackageImporterV1;
}

function analyzerProvisioningHint(analyzerLabel: string): string {
  if (analyzerLabel === "skillspector@docker") {
    return "build and load the pinned SkillSpector image per docs/security/skillspector.md";
  }
  if (analyzerLabel === "cisco@uvx" || analyzerLabel === "semgrep@uv:1.173.0") {
    return "provision the analyzer's uv environment through the installed @aihq/scan once online; the trust scan itself always runs offline";
  }
  return "provision the analyzer toolchain before vetting";
}

/**
 * Fail fast, before a multi-minute vet, when a REQUIRED baseline analyzer is not
 * actually runnable in this environment (for example, an offline uv cache that no
 * longer resolves the pinned Cisco skill-scanner). The installed @aihq/scan
 * answers (C2a §3.8): it probes without a subject and never pulls. This
 * preserves fail-closed — an unprovisioned required analyzer still blocks — while
 * replacing the opaque mid-vet "missing required baseline analyzers" abort with an
 * actionable provisioning error. It never fabricates a receipt, skips an
 * analyzer, or lowers the required-analyzer floor.
 */
export async function preflightRequiredBaselineAnalyzers(
  runtime: BaselinePreflightRuntime,
): Promise<void> {
  const unavailable = await probeScanDetectorsV1(REQUIRED_BASELINE_DETECTORS, runtime);
  if (unavailable.length === 0) return;
  const detail = unavailable
    .map(
      (probe) =>
        `${probe.analyzerLabel} unavailable (${probe.reason}); ${analyzerProvisioningHint(probe.analyzerLabel)}`,
    )
    .join(" | ");
  throw new Error(`baseline vet preflight: required analyzer(s) not provisioned — ${detail}`);
}
