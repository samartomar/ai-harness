/**
 * Library surface. The CLI (`src/cli.ts`) is the executable entry; this module
 * re-exports the reusable core so the harness can be embedded programmatically.
 */

export {
  ALL_COMMANDS,
  builtinCommandNames,
  CAPABILITIES,
  READONLY,
  registerCommands,
} from "./commands/index.js";
export * from "./config/settings.js";
export * from "./errors.js";
export * from "./internals/envfile.js";
export * from "./internals/execute.js";
export * from "./internals/fsxn.js";
export * from "./internals/merge.js";
export * from "./internals/plan.js";
export * from "./internals/proc.js";
export * from "./internals/render.js";
export * from "./internals/verify.js";
export * from "./platform/base.js";
export * from "./platform/detect.js";
export * from "./platform/parse.js";
export * from "./plugins/registry.js";
export { buildProgram, buildProgramWithPlugins, VERSION } from "./program.js";
export {
  type Confidence as VerificationConfidence,
  compareVerificationResults,
  type Evidence as VerificationEvidence,
  mergeVerificationResults,
  runVerificationPipeline,
  type Severity as VerificationSeverity,
  type Verdict as VerificationVerdict,
  type VerificationCategory,
  type VerificationInput,
  type VerificationPass,
  type VerificationPipelineOptions,
  type VerificationPipelineRun,
  VerificationRegistry,
  type VerificationRegistrySelection,
  type VerificationResult,
  type VerificationSummary,
} from "./verification/index.js";
