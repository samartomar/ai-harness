/**
 * `@aihq/core/framework-host` — the versioned host API framework plugins build on.
 *
 * A framework plugin (`@aihq/framework-ecc`, `@aihq/framework-superpowers`)
 * imports Core ONLY through this subpath, plus Node built-ins and its own
 * files. Everything here is either a type or a pure helper; effectful services
 * (evidence-gated installs, plan execution, progress) reach a plugin through
 * the {@link FrameworkOperationContextV1} the calling Core builds, never
 * through an import, so a plugin always acts through the Core that invoked it.
 *
 * Versioning: {@link FRAMEWORK_HOST_API_VERSION} changes only for a breaking
 * change to an export below. A plugin reports the version it was built against
 * as `hostApiVersion`; Core refuses a plugin built against another version.
 */

/** The version of this host API. A plugin built against another version is incompatible. */
export const FRAMEWORK_HOST_API_VERSION = 1;

// ---- contract ---------------------------------------------------------------

/**
 * The framework plugin contract (C3): the plugin export's shape, the operation
 * context Core builds, the effectful services Core binds, and the closed
 * framework/package/command vocabulary.
 */
export {
  FRAMEWORK_IDS_V1,
  FRAMEWORK_PLUGIN_COMMANDS,
  FRAMEWORK_PLUGIN_CONTRACT_VERSION,
  FRAMEWORK_PLUGIN_PACKAGE_NAMES,
  type FrameworkCommandPathV1,
  type FrameworkCommandV1,
  type FrameworkComponentsV1,
  type FrameworkComponentV1,
  type FrameworkCoreRuntimeV1,
  type FrameworkDescriptorBytesV1,
  type FrameworkDoctorHookV1,
  type FrameworkEvidenceAuthorizationV1,
  type FrameworkEvidenceComponentV1,
  type FrameworkEvidenceGatedInstallRequestV1,
  type FrameworkEvidenceHeldComponentV1,
  type FrameworkHookControlAuthorityV1,
  type FrameworkHookControlDecisionV1,
  type FrameworkHookControlPlanV1,
  type FrameworkHookControlRequestV1,
  type FrameworkHookDeclarationV1,
  type FrameworkHookDisableRequestV1,
  type FrameworkHookEnforcementV1,
  type FrameworkHookEnvironmentPatchV1,
  type FrameworkHookExecutionV1,
  type FrameworkHookHostDecisionV1,
  type FrameworkHookInventoryV1,
  type FrameworkHookProfileRequestV1,
  type FrameworkHookProfileV1,
  type FrameworkHookUpstreamControlV1,
  type FrameworkHookV1,
  type FrameworkHostServicesV1,
  type FrameworkIdV1,
  type FrameworkOperationContextV1,
  type FrameworkOwnedArtifactV1,
  type FrameworkPluginDescriptionV1,
  type FrameworkPluginPackageNameV1,
  type FrameworkPluginV1,
  type FrameworkPolicyDeliveryCommitV1,
  type FrameworkPolicyDeliveryHookV1,
  type FrameworkPolicyViewV1,
  type FrameworkPreparedPolicyDeliveryV1,
  type FrameworkPruneHookV1,
  type FrameworkReceiptV1,
  type FrameworkReportHookV1,
  type FrameworkReportPanelV1,
  type FrameworkUninstallHookV1,
  type FrameworkUninstallResultV1,
  type FrameworkUpstreamV1,
  type FrameworkVerifiedSourceV1,
  frameworkDescriptorSubpathV1,
} from "../framework-plugin/contract-v1.js";

// ---- hosts ------------------------------------------------------------------

/** The AI CLIs (hosts) Core can target; a plugin names hosts only from this set. */
export { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";

// ---- plans ------------------------------------------------------------------

/** What Core's executor returns for a plan, and what a plugin command returns to Core. */
export type { PlanResult } from "../internals/execute.js";
/**
 * Plan builders and types. A plugin describes its work as a {@link Plan} of
 * actions; Core's transactional executor (reached through the operation
 * context's host services) is the only thing that performs them:
 * - `doc`: guidance printed for a human (optionally also written to a doc file);
 * - `digest`: a read-only computed result, echoed into `--json` as `data`;
 * - `writeText`: a target-contained text file write (transactional, backed up);
 * - `plan`: a named plan from actions.
 */
export {
  type Action,
  type DigestAction,
  type DocAction,
  digest,
  doc,
  type Plan,
  plan,
  type WriteAction,
  writeText,
} from "../internals/plan.js";

/** One verification outcome, as doctor hooks report it. */
export type { Check } from "../internals/verify.js";

// ---- render -----------------------------------------------------------------

/**
 * Deterministic text helpers: `lines` joins parts with exactly one trailing
 * newline; `frontmatter` renders an ordered YAML frontmatter block.
 */
export { frontmatter, lines } from "../internals/render.js";

// ---- errors -----------------------------------------------------------------

/**
 * The error base Core reports with a stable machine `code` (`error [CODE]: …`
 * in text mode, `{ error: { code, message } }` under `--json`).
 */
export { AihError } from "../errors.js";

// ---- strict JSON ------------------------------------------------------------

/**
 * Parse one strict JSON object: duplicate keys, non-finite numbers, negative
 * zero and non-NFC strings are refused. The caller enforces its byte cap first.
 */
export { parseNativeStrictJsonObjectV1 } from "../contract/native-strict-json-object-v1.js";

// ---- Core library for framework implementations ------------------------------

export {
  type Node as JsoncNode,
  type ParseError as JsoncParseError,
  parse as parseJsonc,
  parseTree as parseJsoncTree,
} from "jsonc-parser";
export { parse as parseToml } from "smol-toml";
export { parse as parseYaml } from "yaml";
export { z } from "zod";
/**
 * The Core modules a framework implementation builds on: plan builders and
 * types, deterministic rendering, contained-path and file helpers, the CLI and
 * MCP registries, policy grammar parsing and types, baseline-evidence types and
 * tree hashing, Core-owned receipts (the materialization receipt, the install
 * manifest drift engine) and the runtime-descriptor schema, plus the parsing
 * libraries Core ships (zod, yaml, jsonc-parser, smol-toml) so a plugin never
 * bundles a second copy.
 *
 * Nothing here executes a plan, verifies evidence, acquires a source, or reads
 * the invocation's policy or environment: those run only through the Core
 * runtime bound to one invocation (`FrameworkHostServicesV1.runtime`).
 */
export type { AcceptanceTuple } from "../baseline-evidence/acceptance.js";
export {
  type BaselineCatalog,
  defineBaselineCatalog,
} from "../baseline-evidence/catalog.js";
export {
  type BaselineTreeHash,
  hashComponentTree,
} from "../baseline-evidence/hash.js";
export { componentIdentityPaths } from "../baseline-evidence/license.js";
export type {
  ResolveOrgBaselineEvidenceResult,
  resolveOrgBaselineEvidence,
} from "../baseline-evidence/org.js";
export type { BaselineEvidencePipelineDeps } from "../baseline-evidence/pipeline.js";
export type { BaselineEvidenceLock } from "../baseline-evidence/schema.js";
export type {
  BaselineAuthorization,
  BaselineHeldComponent,
  BaselineVerificationResult,
} from "../baseline-evidence/verify.js";
export {
  CATALOG_PACKAGE_NAME,
  type CatalogPackageAccessV1,
  CatalogPackageRefusalError,
} from "../catalog-package/load-catalog-package.js";
export {
  type Posture,
  postureFromContext,
} from "../config/posture.js";
export {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../contract/strict-json-v1.js";
export {
  type EccInstallMechanism,
  eccInstallDriftForRoot,
  eccInstallManifestPath,
  walkManagedRoot,
} from "../ecc/install-manifest.js";
export {
  commitMaterializationSteps,
  type DestinationExpectation,
  type DestinationRead,
  inspectDestination,
  MATERIALIZATION_RECEIPT_MODE,
  MATERIALIZED_CONTENT_MODE,
  MAX_MATERIALIZED_FILE_BYTES,
  materializationRoot,
} from "../ecc/materialization-fs.js";
export {
  AuthorizationSchema,
  assertComponentSourcePath,
  assertEccMaterializationEvidenceBinding,
  assertMaterializedComponentId,
  assertOwnedJsonKey,
  assertOwnedRelativePath,
  destinationIdentity,
  displaySafe,
  ECC_KIRO_RUNTIME_COMPONENT_ID,
  ECC_MATERIALIZATION_RECEIPT_FORMAT,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  type EccComponentProvenance,
  type EccCoreDerivedEvidenceReferenceV1,
  type EccCoreDerivedEvidenceV2,
  type EccMaterializationOperation,
  type EccMaterializationReceipt,
  EccMaterializationTargetsSchema,
  type EccMaterializedComponent,
  type EccOwnedFile,
  eccMaterializationAuthorizationSchema,
  eccMaterializationReceiptPath,
  exceedsJsonDepth,
  MAX_MATERIALIZATION_RECEIPT_BYTES,
  MAX_MATERIALIZED_COMPONENTS,
  MAX_MATERIALIZED_FILES_PER_COMPONENT,
  ownedFileSha256,
  ownedFragmentSha256,
  readEccMaterializationReceipt,
  serializeEccMaterializationReceipt,
} from "../ecc/materialization-receipt.js";
export {
  ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
  type EccMcpExplicitAddReceipt,
  type EccMcpExplicitAddRecord,
  emptyExplicitAddReceipt,
  explicitAddDigest,
  parseExplicitAddReceipt,
  receiptJson,
} from "../ecc/mcp-explicit-add-receipt.js";
export {
  type InstalledComponentRegistration,
  machineRegistrationUnion,
  mergeRegistrationLedger,
  type ProjectRegistration,
  parseRegistrationLedger,
  type RegistrationLedger,
  type RegistrationUnion,
  readRegistrationLedger,
  readRegistrationLedgerSnapshot,
  serializeRegistrationLedger,
} from "../ecc/registration.js";
export {
  assertEccRuntimeDescriptorCustodyV1,
  type EccRuntimeDescriptorV1,
  inspectEccRuntimeDescriptorSealV1,
} from "../ecc/runtime-descriptor.js";
export { deriveEccRuntimeDeclaredEvaluationV1 } from "../ecc/runtime-descriptor-evaluation.js";
export {
  buildNativeEccRegistration,
  NATIVE_ECC_REGISTRATION_SCOPE,
  type NativeEccRegistration,
  planInstalledNativeEccRegistration,
  planNativeEccRegistration,
} from "../ecc-profile/native-registration.js";
export { SettingsError } from "../errors.js";
export {
  detectFallbackNotice,
  homeDir,
} from "../internals/cli-detect.js";
export { entry as cliRegistryEntry } from "../internals/cli-registry.js";
export { resolveClis } from "../internals/clis.js";
export {
  inspectContainedRelativePath,
  readContainedRegularFile,
} from "../internals/contained-path.js";
export {
  removeManagedBlock,
  upsertTextBlock,
} from "../internals/envfile.js";
export {
  FsTransaction,
  readIfExists,
  readRegularFile,
  readRegularFileWithStats,
  retryTransient,
} from "../internals/fsxn.js";
export { HERMETIC_GIT_ENV_SCRIPT_LINE } from "../internals/git-env.js";
export { stripManagedBlock } from "../internals/markers.js";
export {
  isPlainObject,
  parseJsoncText,
} from "../internals/merge.js";
export {
  type CommandSpec,
  type ExecAction,
  exec,
  type FileAssertion,
  type PlanContext,
  parseCommitNotAfter,
  probe,
  type RemoveAction,
  remove,
  writeJson,
} from "../internals/plan.js";
export {
  beginMarker,
  endMarker,
} from "../internals/render.js";
export {
  existingMcpTomlNames,
  isExternalMcp,
  type McpEntry,
  mcpConfigAbs,
  mcpEntries,
  mcpEntryFor,
  mcpTomlBody,
  removeMcpTomlServers,
} from "../mcp/render.js";
export {
  type HttpServer,
  type McpServer,
  mcpServers,
} from "../mcp/servers.js";
export { resolveEccMcpApproval } from "../org-policy/ecc-mcp-approval.js";
export {
  ECC_MCP_CATALOG_PROVENANCE,
  type EccMcpCatalogEntry,
  eccExternalMcpCatalog,
} from "../org-policy/ecc-mcp-catalog.js";
export {
  type EffectiveOrgPolicy,
  resolveEffectiveOrgPolicy,
} from "../org-policy/effective.js";
export {
  type PolicyRequiredGuidancePlan,
  planPolicyRequiredGuidance,
} from "../org-policy/required-guidance.js";
export {
  governanceOwnsAihSurfaces,
  type OrgPolicy,
  parseOrgPolicy,
} from "../org-policy/schema.js";
export type { Platform } from "../platform/base.js";
export {
  type RepoStack,
  scanRepo,
} from "../profile/scan.js";
export { execArgv } from "../tools/install.js";
export {
  assertTrustTreeSafe,
  readTrustFetchMetadata,
  type TrustSource,
  trustFetchExec,
} from "../trust/fetch.js";
