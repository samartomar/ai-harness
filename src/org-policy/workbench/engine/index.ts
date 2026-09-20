/**
 * The Policy Workbench engine entry: the ONLY import a React UI uses for
 * policy behaviour (Policy Workbench UI delivery, "Preview slice").
 *
 * Pure by contract: no DOM, no `window`, no `document`, no Node built-ins, no
 * host imports anywhere under `engine/`. It wraps the existing pure modules
 * and changes no policy semantics, schema, or byte rule. Malformed input
 * gives an error result; nothing thrown crosses this entry.
 */

// First, before any schema is built: the engine never evaluates a string as
// code, not even as a capability probe, so it runs under `script-src` without
// `unsafe-eval`.
import "../ui/browser-validation.js";

export {
  DEFAULT_POLICY_FILENAME,
  MAX_IMPORT_BYTES,
  PROJECT_POLICY_FILENAME,
} from "../ui/shell/download-format.js";
export type {
  DiffHunkGap,
  DiffLine,
  DiffLineKind,
} from "../ui/shell/policy-diff.js";
export type {
  TrimUseV1,
  UserDoorSaveInputV1,
  UserDoorSaveResultV1,
  UserDoorTrimItemV1,
  UserDoorViewModelV1,
} from "../ui/user-door-model.js";
export {
  type AdminAiTool,
  type AdminCatalogGroup,
  type AdminCatalogItem,
  type AdminCheckResult,
  type AdminEngine,
  type AdminFramework,
  type AdminState,
  createAdminEngine,
  isPolicyFileName,
} from "./admin-engine.js";
// ADDING A FEATURE: one more export line here, for its public types.
// Lane D (Additions screen: rows 15, 16, 17).
export type {
  AdditionFieldProblemV1,
  AdditionFieldV1,
  AdditionsFeature,
  AdditionsOutcomeV1,
  AdditionsViewV1,
  CurationInputV1,
  CurationRowV1,
  CurationTargetV1,
  CustomMcpInputV1,
  CustomRowV1,
  EccMcpApprovalRowV1,
  EccMcpOptionV1,
  RemoteMcpInputV1,
} from "./features/additions.js";
export type { ChangesFeature } from "./features/changes.js";
export type { ClearPolicyFeature } from "./features/clear-policy.js";
export type { AdminEngineContext } from "./features/context.js";
// Lane B (drafts and repairs, inventory rows 19-21).
export type {
  AdminComparisonChangeV1,
  AdminComparisonV1,
  AdminDraftCountV1,
  AdminDraftEntryV1,
  AdminDraftReviewV1,
  AdminExposureItemV1,
  AdminPolicyExposureV1,
  AdminRepairV1,
  AdminTemplateOptionV1,
  AdminTemplatePreviewV1,
  DraftsFeature,
} from "./features/drafts.js";
// Lane E (rows 22, 18, 23): intake and protected authoring.
export type { SkillDiscoveryV1 } from "./features/github-skill-discovery.js";
export {
  type AdminIntakeV1,
  type AdminProtectedV1,
  INTAKE_DOWNLOAD_STARTED_MESSAGE,
  type IntakeAuthorityFeature,
  type IntakeDraftV1,
  type IntakeRowV1,
  PROTECTED_DOWNLOAD_STARTED_MESSAGE,
  type ProtectedDecisionRowV1,
  type ProtectedOutcomeV1,
} from "./features/intake-authority.js";
// LANE C (organization screen).
export type {
  AdoptionRoleV1,
  DeveloperToolActionV1,
  DeveloperToolRowV1,
  DeveloperToolStateV1,
  DeveloperToolsV1,
  EccHookControlsV1,
  EccHookGroupV1,
  EccHookRowV1,
  EvidenceDeliveryV1,
  OrgFeature,
  OrgViewV1,
  ProvenanceLinesV1,
} from "./features/org.js";
export type {
  ProtectedDigestFn,
  ProtectedFieldsV1,
} from "./features/protected-authority-model.js";
export type { AdminScanV1, ScanFeature } from "./features/scan.js";
// LANE A (Sources screen: rows 7, 11, 12).
export type {
  CatalogBrowseViewV1,
  CatalogFiltersV1,
  CatalogOptionV1,
  ItemFactV1,
  ItemInspectionV1,
  ItemSecurityV1,
  KindLedgerEntryV1,
  SourcesFeature,
} from "./features/sources.js";
export {
  parseWorkbenchInput,
  WORKBENCH_INPUT_FORMAT,
  WORKBENCH_INPUT_VERSION,
  type WorkbenchInputDoor,
  type WorkbenchInputV1,
} from "./input-contract.js";
export type {
  ScanGlance,
  ScanReceiptRowV1,
} from "./scan-presentation.js";
export type { EngineFile, EngineOutcome, EngineResult } from "./shared.js";
export {
  createUserEngine,
  type UserCheckAgainstV1,
  type UserCheckResultV1,
  type UserEngine,
  userModelFromImportedPolicy,
} from "./user-engine.js";
