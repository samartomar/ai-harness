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
  type FrameworkHookExecutionV1,
  type FrameworkHookHostDecisionV1,
  type FrameworkHookInventoryV1,
  type FrameworkHookUpstreamControlV1,
  type FrameworkHookV1,
  type FrameworkHostServicesV1,
  type FrameworkIdV1,
  type FrameworkOperationContextV1,
  type FrameworkOwnedArtifactV1,
  type FrameworkPluginDescriptionV1,
  type FrameworkPluginPackageNameV1,
  type FrameworkPluginV1,
  type FrameworkPolicyViewV1,
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
