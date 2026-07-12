import { lstatSync, readdirSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { Runner } from "../internals/proc.js";
import type { Platform } from "../platform/base.js";
import { checkDetectorsAvailable, type TrustDetectorName } from "../trust/detectors.js";
import {
  SKILLSPECTOR_IMAGE_DIGEST,
  SKILLSPECTOR_SOURCE_REVISION,
  type SkillSpectorImageApproval,
} from "../trust/images.js";
import { VERSION } from "../version.js";
import type { BaselineCatalogComponent } from "./catalog.js";
import type { VetBaselineCatalogOptions } from "./vet.js";

export const CISCO_SKILL_SCANNER_VERSION = "2.0.12";
export const CISCO_SKILL_SCANNER_SPEC = `cisco-ai-skill-scanner==${CISCO_SKILL_SCANNER_VERSION}`;

export const REQUIRED_BASELINE_DETECTORS = [
  "skillspector",
  "cisco",
] as const satisfies readonly TrustDetectorName[];

export const REQUIRED_BASELINE_ANALYZERS = [
  "aih-native",
  "skillspector@docker",
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
    : ["skillspector"];
}

export function baselineAnalyzerVersions(): Readonly<Record<string, string>> {
  return {
    "aih-native": VERSION,
    "skillspector@docker": `${SKILLSPECTOR_SOURCE_REVISION}@${SKILLSPECTOR_IMAGE_DIGEST}`,
    "cisco@uvx": CISCO_SKILL_SCANNER_VERSION,
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
    return `warm the uv cache once online (\`uv tool install ${CISCO_SKILL_SCANNER_SPEC}\` or \`uvx --from ${CISCO_SKILL_SCANNER_SPEC} skill-scanner --version\`); the trust scan itself always runs --offline`;
  }
  if (analyzerLabel === "skillspector@docker") {
    return "build and load the pinned SkillSpector image per docs/security/skillspector.md";
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
