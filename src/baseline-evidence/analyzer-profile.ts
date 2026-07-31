import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { Runner } from "../internals/proc.js";
import type { Platform } from "../platform/base.js";
import {
  CISCO_MCP_SCANNER_PROJECT,
  CISCO_SKILL_SCANNER_PROJECT,
  checkDetectorsAvailable,
  resolveCiscoScanConcurrency,
  SEMGREP_PROJECT,
  SNYK_AGENT_SCAN_PROJECT,
  type TrustDetectorName,
} from "../trust/detectors.js";
import {
  SKILLSPECTOR_IMAGE_DIGEST,
  SKILLSPECTOR_SOURCE_REVISION,
  type SkillSpectorImageApproval,
} from "../trust/images.js";
import type { BaselineCatalogComponent } from "./catalog.js";
import { nativeAnalyzerIdentity } from "./native-identity.js";
import type { VetBaselineCatalogOptions } from "./vet.js";

export { CISCO_SKILL_SCANNER_PROJECT };

export const CISCO_SKILL_SCANNER_VERSION = "2.0.12";
export const CISCO_SKILL_SCANNER_SPEC = `cisco-ai-skill-scanner==${CISCO_SKILL_SCANNER_VERSION}`;
export const CISCO_MCP_SCANNER_VERSION = "4.8.1";
export const SEMGREP_VERSION = "1.172.0";
export const SNYK_AGENT_SCAN_VERSION = "0.5.15";

export const CISCO_SKILL_SCANNER_LOCK = join(CISCO_SKILL_SCANNER_PROJECT, "uv.lock");
export const CISCO_MCP_SCANNER_LOCK = join(CISCO_MCP_SCANNER_PROJECT, "uv.lock");
export const SEMGREP_LOCK = join(SEMGREP_PROJECT, "uv.lock");
export const SNYK_AGENT_SCAN_LOCK = join(SNYK_AGENT_SCAN_PROJECT, "uv.lock");

export function ciscoSkillScannerLockSha256(): string {
  return createHash("sha256").update(readFileSync(CISCO_SKILL_SCANNER_LOCK)).digest("hex");
}

function uvLockIdentity(version: string, lock: string): string {
  const lockDigest = createHash("sha256").update(readFileSync(lock)).digest("hex");
  return `${version}+uvlock.${lockDigest.slice(0, 12)}`;
}

export const REQUIRED_BASELINE_DETECTORS = [
  "skillspector",
  "semgrep",
  "cisco",
] as const satisfies readonly TrustDetectorName[];

export const REQUIRED_BASELINE_ANALYZERS = [
  "aih-native",
  "skillspector@docker",
  "semgrep@uv:1.172.0",
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

export function baselineAnalyzerVersions(): Readonly<Record<string, string>> {
  return {
    // A content digest, not the package VERSION (see native-identity.ts): the
    // identity's job is behavioral discrimination, and a version prefix would
    // invalidate all receipts at every release version bump even when no
    // detector source changed, forcing a full re-vet in every release PR.
    "aih-native": nativeAnalyzerIdentity(),
    "skillspector@docker": `${SKILLSPECTOR_SOURCE_REVISION}@${SKILLSPECTOR_IMAGE_DIGEST}`,
    "cisco@uvx": uvLockIdentity(CISCO_SKILL_SCANNER_VERSION, CISCO_SKILL_SCANNER_LOCK),
    "mcp-scanner@uv:4.8.1": uvLockIdentity(CISCO_MCP_SCANNER_VERSION, CISCO_MCP_SCANNER_LOCK),
    "semgrep@uv:1.172.0": uvLockIdentity(SEMGREP_VERSION, SEMGREP_LOCK),
    "snyk-agent-scan@uv:0.5.15": uvLockIdentity(SNYK_AGENT_SCAN_VERSION, SNYK_AGENT_SCAN_LOCK),
  };
}

export function requiredBaselineVetOptions(runtime: {
  run: Runner;
  platform: Platform;
  env: NodeJS.ProcessEnv;
  progress?: (message: string) => void;
}): VetBaselineCatalogOptions {
  return {
    scanOptions: {
      run: runtime.run,
      platform: runtime.platform,
      env: runtime.env,
      progress: runtime.progress,
    },
    requiredAnalyzers: requiredBaselineAnalyzersForComponent,
    requiredDetectorsForComponent: requiredBaselineDetectorsForComponent,
    analyzerVersions: baselineAnalyzerVersions(),
    sourceWideScan: true,
    sourceWideCisco: {
      analyzerLockSha256: ciscoSkillScannerLockSha256(),
      workerConcurrency: resolveCiscoScanConcurrency(runtime.env),
    },
  };
}

export interface BaselinePreflightRuntime {
  run: Runner;
  platform: Platform;
  env: NodeJS.ProcessEnv;
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
}

function analyzerProvisioningHint(analyzerLabel: string): string {
  if (analyzerLabel === "cisco@uvx") {
    return "warm the committed Cisco runtime once online (`uv run --project tools/cisco-skill-scanner --locked --isolated --python 3.12 --no-env-file --no-python-downloads skill-scanner --version`); the trust scan itself always runs --offline";
  }
  if (analyzerLabel === "skillspector@docker") {
    return "build and load the pinned SkillSpector image per docs/security/skillspector.md";
  }
  if (analyzerLabel === "semgrep@uv:1.172.0") {
    return "warm the committed Semgrep runtime once online (`uv run --project tools/trust-scanners/semgrep --locked --isolated --python 3.12 --no-env-file --no-python-downloads semgrep --version`); the trust scan itself always runs --offline";
  }
  return "provision the analyzer toolchain before vetting";
}

/**
 * Fail fast, before a multi-minute vet, when a REQUIRED baseline analyzer is not
 * actually runnable in this environment (for example, an offline uv cache that no
 * longer resolves the pinned Cisco skill-scanner). This preserves fail-closed —
 * an unprovisioned required analyzer still blocks — while replacing the opaque
 * mid-vet "missing required baseline analyzers" abort with an actionable
 * provisioning error. It never fabricates a receipt, skips an analyzer, or lowers
 * the required-analyzer floor.
 */
export async function preflightRequiredBaselineAnalyzers(
  runtime: BaselinePreflightRuntime,
): Promise<void> {
  const unavailable = await checkDetectorsAvailable(REQUIRED_BASELINE_DETECTORS, runtime);
  if (unavailable.length === 0) return;
  const detail = unavailable
    .map(
      (probe) =>
        `${probe.analyzerLabel} unavailable (${probe.reason}); ${analyzerProvisioningHint(probe.analyzerLabel)}`,
    )
    .join(" | ");
  throw new Error(`baseline vet preflight: required analyzer(s) not provisioned — ${detail}`);
}
