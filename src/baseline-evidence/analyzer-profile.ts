import type { Runner } from "../internals/proc.js";
import type { Platform } from "../platform/base.js";
import type { TrustDetectorName } from "../trust/detectors.js";
import { SKILLSPECTOR_IMAGE_DIGEST, SKILLSPECTOR_SOURCE_REVISION } from "../trust/images.js";
import { VERSION } from "../version.js";
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
}): VetBaselineCatalogOptions {
  return {
    scanOptions: {
      run: runtime.run,
      platform: runtime.platform,
      env: runtime.env,
      requiredDetectors: REQUIRED_BASELINE_DETECTORS,
    },
    requiredAnalyzers: REQUIRED_BASELINE_ANALYZERS,
    analyzerVersions: baselineAnalyzerVersions(),
  };
}
