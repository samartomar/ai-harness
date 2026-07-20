/**
 * Claude project-scope host adapter — W3a foundation: host/project-root detection
 * and the D18 managed-write engine (plan) + conservative removal (plan) every
 * later binding write flows through. Library only; no CLI registration, no
 * FrameworkAdapter, no `claude` CLI invocation (W3b+).
 */

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
  CLAUDE_BINDING_MARKER,
  CLAUDE_BOOTLOADER_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_OWNED_FILE_ROOTS,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SHARED_JSON_FILES,
  ClaudeHostWriteError,
} from "./surfaces.js";
