/**
 * Library surface. The CLI (`src/cli.ts`) is the executable entry; this module
 * re-exports the reusable core so the harness can be embedded programmatically.
 */

export * from "./capability/package-graph/index.js";
export * from "./capability/package-manager/index.js";
export {
  ALL_COMMANDS,
  builtinCommandNames,
  CAPABILITIES,
  READONLY,
  registerCommands,
} from "./commands/index.js";
export * from "./config/settings.js";
export * from "./context/index.js";
export * from "./errors.js";
export * from "./init/v3.js";
export { type Cli, SUPPORTED_CLIS } from "./internals/clis.js";
export * from "./internals/envfile.js";
export * from "./internals/execute.js";
export * from "./internals/fsxn.js";
export * from "./internals/merge.js";
export * from "./internals/plan.js";
export * from "./internals/proc.js";
export * from "./internals/render.js";
export * from "./internals/verify.js";
export {
  ASSESSMENT_MATERIAL_FORMAT_V1,
  type AssessmentMaterialBindingBoundV1,
  type AssessmentMaterialBindingRefusalV1,
  type AssessmentMaterialBindingV1,
  MAX_ASSESSMENT_BYTES_V1,
  type VerifyAssessmentMaterialBindingV1Input,
  verifyAssessmentMaterialBindingV1,
} from "./org-policy/assessment-material-binding-v1.js";
export {
  type PolicyAuthorityReceiptV3,
  PolicyAuthorityReceiptV3Schema,
} from "./org-policy/authority-v3.js";
export * from "./org-policy/bundle.js";
export * from "./org-policy/governance-decision-v2.js";
export {
  type AssessmentMaterialResolverV1,
  type ConsumeGovernanceInputV1Input,
  type ConsumeGovernanceInputV1Result,
  canonicalGovernanceInputV1,
  claimsScanEvidenceV1,
  consumeGovernanceInputV1,
  DEFAULT_GOVERNANCE_EVIDENCE_PATH_V1,
  GOVERNANCE_INPUT_V1_FORMAT,
  type GovernanceInputArtifactV1,
  type GovernanceInputDiagnosticV1,
  type GovernanceInputRefusalV1,
  type GovernanceInputStatusV1,
  type GovernanceInputV1,
  GovernanceInputV1Schema,
  governanceInputDigestV1,
  MAX_GOVERNANCE_INPUT_BYTES_V1,
  type PrepareGovernanceInputV1Input,
  type PrepareGovernanceInputV1Result,
  parseGovernanceInputV1Bytes,
  prepareGovernanceInputV1,
  SCAN_ATTESTATION_EVIDENCE_KIND_V1,
  type ScanVerificationAdapterV1,
  type ScanVerificationRequestV1,
  type SubjectContentBindingRefusalV1,
  type SubjectContentBindingV1,
  verifySubjectContentBindingV1,
} from "./org-policy/governance-input-v1.js";
export {
  canonicalOrganizationEvidenceEnvelopeV1,
  MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1,
  type OrganizationEvidenceEnvelopeV1,
  OrganizationEvidenceEnvelopeV1Schema,
  organizationEvidenceEnvelopeDigestV1,
  parseOrganizationEvidenceEnvelopeV1Bytes,
} from "./org-policy/qualification-v1.js";
export {
  AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH,
  type AihSupportedQualificationArtifactVerificationV2,
  type AihSupportedQualificationReceiptV2,
  AihSupportedQualificationReceiptV2Schema,
  canonicalAihSupportedQualificationReceiptV2,
  MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
  parseAihSupportedQualificationReceiptV2Bytes,
  type VerifyAihSupportedQualificationArtifactV2Input,
  verifyAihSupportedQualificationArtifactV2,
} from "./org-policy/supported-qualification-receipt-v2.js";
export {
  canonicalUpstreamArtifactManifestV1,
  MAX_UPSTREAM_ARTIFACT_FILES_V1,
  MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1,
  parseUpstreamArtifactManifestV1Bytes,
  type UpstreamArtifactManifestV1,
  UpstreamArtifactManifestV1Schema,
  upstreamArtifactManifestDigestV1,
} from "./org-policy/upstream-artifact-manifest-v1.js";
export {
  canonicalUpstreamObservationReceiptV1,
  MAX_UPSTREAM_OBSERVATION_WINDOW_MS,
  parseUpstreamObservationReceiptV1,
  type UpstreamObservationReceiptV1,
  UpstreamObservationReceiptV1Schema,
  upstreamObservationReceiptDigestV1,
} from "./org-policy/upstream-observation-receipt-v1.js";
export * from "./platform/base.js";
export * from "./platform/detect.js";
export * from "./platform/parse.js";
export * from "./plugins/registry.js";
export { buildProgram, buildProgramWithPlugins, VERSION } from "./program.js";
export * from "./security/index.js";
export {
  createSessionGuardrailPasses,
  runSessionGuardrails,
  SESSION_GUARDRAIL_PASS_NAMES,
  type SessionGuardInput,
  type SessionGuardOptions,
  type SessionGuardReport,
} from "./session/index.js";
export {
  buildEvidenceGraph,
  type Confidence as VerificationConfidence,
  compareVerificationResults,
  createStructuredVerificationPasses,
  createStructuredVerificationRegistry,
  type Evidence as VerificationEvidence,
  mergeVerificationResults,
  runVerificationPipeline,
  type Severity as VerificationSeverity,
  STRUCTURED_VERIFICATION_PASS_NAMES,
  type StructuredVerificationLegacyOptions,
  type StructuredVerificationRunCheckOptions,
  structuredVerificationResultToCheck,
  structuredVerificationRunToCheck,
  structuredVerificationRunToChecks,
  structuredVerificationRunToReport,
  type Verdict as VerificationVerdict,
  type VerificationCategory,
  type VerificationEvidenceGraph,
  type VerificationEvidenceGraphEdge,
  type VerificationEvidenceGraphFindingNode,
  type VerificationEvidenceGraphNode,
  type VerificationEvidenceGraphOptions,
  type VerificationEvidenceGraphSourceNode,
  type VerificationInput,
  type VerificationPass,
  type VerificationPipelineOptions,
  type VerificationPipelineRun,
  VerificationRegistry,
  type VerificationRegistrySelection,
  type VerificationResult,
  type VerificationSummary,
} from "./verification/index.js";
