import type { TrustDetectorName } from "./detectors.js";

/**
 * Rule ids an analyzer upgrade introduced that Core has not reviewed yet. Until a
 * rule is reviewed (mapped to a trust code in the detector's rule map, or left to
 * the generic route on purpose, and then removed from here), a finding under one of
 * these ids that every existing route leaves in the detector's generic bucket is a
 * WARN that never blocks: `trust.unreviewed-analyzer-rule`. A rule-map, message or
 * evidence route that already classifies the finding (egress, legal text, autonomy)
 * wins, unchanged.
 *
 * The list is explicit. An id that is neither mapped nor listed keeps its generic
 * route unchanged, so an unknown rule never becomes a warning just by being new.
 */
export interface UnreviewedAnalyzerRulesV1 {
  /** The analyzer release that introduced the rules. */
  readonly since: string;
  /** Where the ids were read, against the release before it. */
  readonly provenance: string;
  readonly ruleIds: readonly string[];
}

export const UNREVIEWED_ANALYZER_RULES_V1: Readonly<
  Partial<Record<TrustDetectorName, UnreviewedAnalyzerRulesV1>>
> = Object.freeze({
  skillspector: Object.freeze({
    since: "SkillSpector v2.12.0 (c7958a3268d9498644b22edb75d0f051bbc8cbfc)",
    provenance:
      "Rule ids quoted under src/skillspector at c7958a3268d9 and absent at 2d198ab910ad (v2.9.4).",
    ruleIds: Object.freeze([
      "AE1",
      "AE2",
      "AE3",
      "AE4",
      "AE5",
      "AE6",
      "AE7",
      "AST10",
      "BH1",
      "BH2",
      "BH3",
      "DS1",
      "DS2",
      "DS3",
      "DS4",
      "EA5",
      "SC9",
      "SC10",
      "TT6",
    ]),
  }),
  cisco: Object.freeze({
    since: "cisco-ai-skill-scanner 2.1.0",
    provenance:
      "Rule ids in the 2.1.0 sdist (sha256:14542712f5966a99ec86b27882ef7c5b1803e43587c1fa69e00eb63ddee1ee2e, the one Scan's uv.lock pins) and absent from the 2.0.14 sdist; YARA rules surface as YARA_<rule name>.",
    ruleIds: Object.freeze([
      "ACTIVE_DYNAMIC_EXECUTION",
      "ACTIVE_HIDDEN_HTML_INSTRUCTION",
      "ACTIVE_REMOTE_ACQUIRE_EXECUTE",
      "CORRELATED_CONFIG_URL_EXECUTION",
      "CORRELATED_HIDDEN_EXECUTABLE",
      "CORRELATED_MANIFEST_CAPABILITY_MISMATCH",
      "CORRELATED_NESTED_ARCHIVE_SCRIPT",
      "DATA_EXFIL_SENSITIVE_FILE_GLOB",
      "HARMFUL_CONTENT_EXPLICIT_INSTRUCTION",
      "MALWARE_RANSOMWARE_IMPLEMENTATION_CHAIN",
      "META_CONTEXT_BUDGET_EXCEEDED",
      "SKILL_LOAD_FALLBACK_USED",
      "SKILL_LOAD_REJECTED_LIMIT",
      "UNICODE_ANALYSIS_INCOMPLETE",
      "UNICODE_SMUGGLING_ACTIVE_INTENT",
      "YARA_SUSP_Lnx_EncodedShell_DecodeExec_Sep26",
      "YARA_SUSP_Multi_CredentialExfil_Chain_Sep26",
      "YARA_SUSP_Multi_Cron_C2_Persistence_Sep26",
      "YARA_SUSP_Multi_Cryptomining_ConfigExec_Sep26",
      "YARA_SUSP_Multi_EncodedArchive_Exec_Sep26",
      "YARA_SUSP_Multi_RawIP_DownloadExec_Sep26",
      "YARA_SUSP_Multi_RemoteConfig_StageExec_Sep26",
      "YARA_SUSP_Multi_RemoteMiner_AcquireExec_Sep26",
      "YARA_SUSP_Win_EncodedPowerShell_Exec_Sep26",
    ]),
  }),
});

/** Whether `ruleId` is a listed, not-yet-reviewed rule of `detector` (exact, case-sensitive). */
export function isUnreviewedAnalyzerRuleV1(detector: TrustDetectorName, ruleId: string): boolean {
  return UNREVIEWED_ANALYZER_RULES_V1[detector]?.ruleIds.includes(ruleId) === true;
}
