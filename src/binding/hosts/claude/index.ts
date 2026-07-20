/**
 * Claude project-scope host adapter (W3) — host/project-root detection, the D18
 * managed-write engine + conservative removal, plugin-binding services with D7
 * loaded-tree identity verification, skillOverrides deny-list management (D11),
 * user-scope contamination reporting, previewed cleanup remediation with
 * backup/rollback, and context-cost inventory. Library only; no CLI registration
 * and no FrameworkAdapter — W4 adapters compose these services.
 */

export {
  applyClaudeCleanup,
  type ClaudeCleanupAction,
  type ClaudeCleanupApplyDeps,
  type ClaudeCleanupApplyResult,
  type ClaudeCleanupEdit,
  ClaudeCleanupError,
  type ClaudeCleanupManifest,
  type ClaudeCleanupPlan,
  type ClaudeCleanupPlanOptions,
  type ClaudeCleanupRollbackDeps,
  type ClaudeCleanupRollbackResult,
  type ClaudeCleanupStep,
  planClaudeCleanup,
  rollbackClaudeCleanup,
} from "./cleanup.js";
export {
  type ClaudeContaminationParams,
  type ClaudeContaminationReport,
  type ContaminationEntry,
  type ContaminationLeakage,
  type ContaminationSurface,
  claudeContaminationReport,
  type FrameworkAttribution,
} from "./contamination.js";
export {
  type ContextCostEvidenceSource,
  type ContextCostReport,
  contextCostFromPluginDetails,
  estimateContextCostFromTree,
} from "./context-cost.js";
export {
  type ClaudeHostDetectDeps,
  type ClaudeHostReport,
  detectClaudeHost,
} from "./detect.js";
export {
  type ClaudeManagedPlan,
  ClaudeManagedWriteEngine,
  type ClaudeOwnershipIntent,
  type ClaudeOwnershipKind,
  type ClaudePreExisting,
  finalizeClaudeOwnership,
} from "./managed-writes.js";
export {
  CLAUDE_PLUGINS_CACHE_REL,
  CLAUDE_PLUGINS_CONFIG_REL,
  CLAUDE_PLUGINS_DIR_REL,
  CLAUDE_PLUGINS_MARKETPLACES_KEY,
  ClaudePluginCacheMissingError,
  ClaudePluginError,
  ClaudePluginIdentityError,
  claudeHomeDir,
  defaultPluginCacheLocator,
  HOME_OWNERSHIP_PREFIX,
  hashLoadedPluginTree,
  homeMarketplaceTarget,
  homePluginCacheTarget,
  isHomeScopedTarget,
  type PluginCacheLocator,
  type PluginCacheLocatorParams,
  type PluginIdentity,
  verifyPluginIdentity,
} from "./plugin-identity.js";
// W3b — Claude host plugin-binding services (bind/verify/remove lifecycle) + D7
// plugin-content identity verification. Host SERVICES a W4 host-plugin adapter calls.
export {
  assertSafePluginName,
  type BindPluginDeps,
  type BindPluginRequest,
  type BindPluginResult,
  bindPlugin,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  marketplaceAdd,
  marketplaceRemove,
  type PluginCliDeps,
  type PluginScope,
  pluginDetails,
  pluginEnableKey,
  type RemovePluginDeps,
  type RemovePluginRequest,
  type RemovePluginResult,
  removePlugin,
  settingsFileForScope,
  uninstallPlugin,
} from "./plugins.js";
export {
  type ClaudeDriftEntry,
  type ClaudeRemovalPlan,
  planClaudeRemoval,
} from "./removal.js";
export {
  type PinnedSkillInventory,
  queueSkillDenyList,
  type SkillDenyListReport,
  skillDenyListReport,
} from "./skill-overrides.js";
export {
  CLAUDE_BINDING_MARKER,
  CLAUDE_BOOTLOADER_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_OWNED_FILE_ROOTS,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SHARED_JSON_FILES,
  ClaudeHostWriteError,
} from "./surfaces.js";
