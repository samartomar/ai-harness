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
} from "./admin-engine.js";
export {
  parseWorkbenchInput,
  WORKBENCH_INPUT_FORMAT,
  WORKBENCH_INPUT_VERSION,
  type WorkbenchInputDoor,
  type WorkbenchInputV1,
} from "./input-contract.js";
export type { EngineFile, EngineOutcome, EngineResult } from "./shared.js";
export {
  createUserEngine,
  type UserCheckAgainstV1,
  type UserCheckResultV1,
  type UserEngine,
  userModelFromImportedPolicy,
} from "./user-engine.js";
