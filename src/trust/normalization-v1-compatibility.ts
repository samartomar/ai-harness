import { baselineAnalyzerVersions } from "../baseline-evidence/analyzer-profile.js";
import {
  CISCO_SKILL_SCANNER_ANALYZER,
  SEMGREP_ANALYZER,
  SNYK_AGENT_SCAN_ANALYZER,
} from "./detectors.js";
import {
  deriveNormalizationCompatibilityV1,
  type NormalizationCompatibilityDescriptorV1,
  type NormalizationCompatibilityV1,
  type NormalizationProfileV1,
} from "./normalization-v1.js";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const analyzerVersions = baselineAnalyzerVersions();

function analyzerIdentity(label: string): string {
  const identity = analyzerVersions[label];
  if (identity === undefined) throw new TypeError(`missing current analyzer identity for ${label}`);
  return identity;
}

export const CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1 = deepFreeze([
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    analyzerIdentity: analyzerIdentity("skillspector@docker"),
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "skillspector",
      analyzerLabel: "skillspector@docker",
      analyzerIdentity: analyzerIdentity("skillspector@docker"),
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "skillspector",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: [
        "SC4",
        "YR4",
        "autonomous-decision-making",
        "skillspector.auto-exec",
        "skillspector.autonomous-decision-making",
        "skillspector.prompt-injection",
        "unbounded-resource-access",
      ],
    },
  },
  {
    detectorClass: "semgrep",
    analyzerLabel: SEMGREP_ANALYZER,
    analyzerIdentity: analyzerIdentity(SEMGREP_ANALYZER),
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "semgrep",
      analyzerLabel: SEMGREP_ANALYZER,
      analyzerIdentity: analyzerIdentity(SEMGREP_ANALYZER),
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "semgrep",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: ["semgrep.malicious-code", "semgrep.prompt-injection"],
    },
  },
  {
    detectorClass: "snyk-agent-scan",
    analyzerLabel: SNYK_AGENT_SCAN_ANALYZER,
    analyzerIdentity: analyzerIdentity(SNYK_AGENT_SCAN_ANALYZER),
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "snyk-agent-scan",
      analyzerLabel: SNYK_AGENT_SCAN_ANALYZER,
      analyzerIdentity: analyzerIdentity(SNYK_AGENT_SCAN_ANALYZER),
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "snyk-agent-scan",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: ["E001", "W012"],
    },
  },
  {
    detectorClass: "cisco",
    analyzerLabel: CISCO_SKILL_SCANNER_ANALYZER,
    analyzerIdentity: analyzerIdentity(CISCO_SKILL_SCANNER_ANALYZER),
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "cisco",
      analyzerLabel: CISCO_SKILL_SCANNER_ANALYZER,
      analyzerIdentity: analyzerIdentity(CISCO_SKILL_SCANNER_ANALYZER),
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "cisco",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: ["YARA_command_injection_generic"],
    },
  },
] as const satisfies readonly NormalizationCompatibilityDescriptorV1[]);

const compatibilityByDetector = new Map<string, NormalizationCompatibilityV1>(
  CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1.map((descriptor) => [
    descriptor.detectorClass,
    deriveNormalizationCompatibilityV1(descriptor),
  ]),
);

function compatibilityFor(detectorClass: string): NormalizationCompatibilityV1 {
  const compatibility = compatibilityByDetector.get(detectorClass);
  if (compatibility === undefined) {
    throw new TypeError(`missing normalization compatibility for ${detectorClass}`);
  }
  return compatibility;
}

const compatibilityRows = [
  ["skillspector", "skillspector.prompt-injection"],
  ["skillspector", "skillspector.auto-exec"],
  ["skillspector", "skillspector.autonomous-decision-making"],
  ["skillspector", "autonomous-decision-making"],
  ["skillspector", "unbounded-resource-access"],
  ["skillspector", "SC4"],
  ["skillspector", "YR4"],
  ["semgrep", "semgrep.prompt-injection"],
  ["semgrep", "semgrep.malicious-code"],
  ["snyk-agent-scan", "E001"],
  ["snyk-agent-scan", "W012"],
  ["cisco", "YARA_command_injection_generic"],
] as const;

export const CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1 = deepFreeze(
  compatibilityRows.map(([detectorClass, nativeRuleId]) => ({
    detectorClass,
    nativeRuleId,
    compatibility: compatibilityFor(detectorClass),
    grouping:
      nativeRuleId === "SC4" || nativeRuleId === "YR4"
        ? "one-retained-finding-per-raw-occurrence"
        : "canonical-code+path+start-line+source-value",
    finalCanonicalCode: "trust.detector-finding" as const,
    contextualEvaluationOutcome: "suppressed-non-actionable" as const,
    currentDisposition: "SUPPRESSED" as const,
  })),
);

export const CURRENT_NORMALIZATION_PROFILE_V1: NormalizationProfileV1 = deepFreeze({
  protocol: "NormalizationProfileV1",
  mappings: CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1.map((row) => ({
    detectorClass: row.detectorClass,
    nativeRuleId: row.nativeRuleId,
    canonicalCode: row.finalCanonicalCode,
    compatibility: row.compatibility,
  })),
});
