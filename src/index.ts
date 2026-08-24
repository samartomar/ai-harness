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
export * from "./internals/envfile.js";
export * from "./internals/execute.js";
export * from "./internals/fsxn.js";
export * from "./internals/merge.js";
export * from "./internals/plan.js";
export * from "./internals/proc.js";
export * from "./internals/render.js";
export * from "./internals/verify.js";
export * from "./org-policy/governance-decision-v2.js";
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
