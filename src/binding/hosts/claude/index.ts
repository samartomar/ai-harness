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
