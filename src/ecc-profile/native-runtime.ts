import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import {
  createContinuityHandler,
  createFileContinuityStore,
  createMcpHealthHandler,
  createRepositoryProtectionHandler,
  type McpHealthProbeResult,
} from "./default-hooks.js";
import {
  dispatchHookEvent,
  type HookClient,
  type HookDispatchResult,
  type NormalizedHookEvent,
  normalizeClaudeHookInput,
  normalizeCodexHookInput,
} from "./hook-core.js";

export interface NativeEccHookInput {
  client: HookClient;
  root: string;
  stateRoot: string;
  /** Native-client health seam. The CLI uses an honest indeterminate probe. */
  mcpHealthProbe?: (id: string, signal: AbortSignal) => Promise<McpHealthProbeResult>;
  input: unknown;
}

export type NativeEccHookOutput = {
  continue?: false;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: "deny";
    permissionDecisionReason?: string;
  };
};

function contained(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function canonicalDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(`${label} must be a real directory`);
  return realpathSync(value);
}

export function prepareOwnedStateDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const destination = resolve(value);
  const rootPath = parse(destination).root;
  const segments = relative(rootPath, destination)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let cursor = rootPath;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`${label} has a non-directory or linked path segment`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(cursor, { mode: 0o700 });
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`${label} could not be created safely`);
      }
    }
  }
  return canonicalDirectory(destination, label);
}

function prepareStateRoot(root: string, value: string): string {
  if (!isAbsolute(value)) throw new Error("native hook state root must be absolute");
  const destination = resolve(value);
  if (contained(root, destination) || contained(destination, root)) {
    throw new Error("native hook state root must be outside the project root");
  }
  const stateRoot = prepareOwnedStateDirectory(destination, "native hook state root");
  if (contained(root, stateRoot) || contained(stateRoot, root)) {
    throw new Error("native hook state root must be outside the project root");
  }
  return stateRoot;
}

function nativeOutput(event: NormalizedHookEvent, result: HookDispatchResult): NativeEccHookOutput {
  const context = result.contexts.join("\n");
  const toolDecision = event.event === "before-tool" || event.event === "permission-request";
  if (result.action === "block" && toolDecision) {
    return {
      hookSpecificOutput: {
        hookEventName: event.nativeEvent,
        permissionDecision: "deny",
        permissionDecisionReason: result.reason ?? "AIH profile policy denied the tool call.",
        ...(context.length === 0 ? {} : { additionalContext: context }),
      },
    };
  }
  if (result.action === "block") {
    return {
      continue: false,
      stopReason: result.reason ?? "AIH profile policy stopped this event.",
      ...(context.length === 0
        ? {}
        : { hookSpecificOutput: { hookEventName: event.nativeEvent, additionalContext: context } }),
    };
  }
  return context.length === 0
    ? {}
    : { hookSpecificOutput: { hookEventName: event.nativeEvent, additionalContext: context } };
}

export async function executeNativeEccHook(
  input: NativeEccHookInput,
): Promise<NativeEccHookOutput> {
  const root = canonicalDirectory(resolve(input.root), "native hook project root");
  const event =
    input.client === "claude"
      ? normalizeClaudeHookInput(input.input)
      : normalizeCodexHookInput(input.input);
  let eventRoot: string;
  try {
    eventRoot = canonicalDirectory(resolve(event.cwd), "native hook event cwd");
  } catch {
    throw new Error("native hook event cwd is not an accessible project root");
  }
  if (!contained(root, eventRoot))
    throw new Error("native hook event belongs to a foreign project root");
  const scopedEvent: NormalizedHookEvent = { ...event, cwd: root };
  const stateRoot = prepareStateRoot(root, input.stateRoot);
  const repositoryId = createHash("sha256").update(root, "utf8").digest("hex");
  const store = createFileContinuityStore({
    stateRoot,
    canonicalWorktree: root,
    repositoryId,
    harness: input.client,
  });
  const handlers = [
    createRepositoryProtectionHandler(),
    createMcpHealthHandler({
      selectedServers: [
        {
          id: "code-review-graph",
          fallback: "Continue with repository source and tests; the graph is advisory.",
        },
        {
          id: "codebase-memory-mcp",
          fallback: "Continue without graph memory and rebuild it after MCP recovery.",
        },
        {
          id: "context7",
          fallback: "Use locally installed documentation until the reviewed endpoint is available.",
        },
        {
          id: "serena",
          fallback: "Use native repository search until the hardened Serena server is available.",
        },
      ],
      probe:
        input.mcpHealthProbe ??
        (async () => ({
          ok: false,
          detail: "native client MCP initialization is not observable from the hook process",
        })),
    }),
    createContinuityHandler({
      repositoryId,
      canonicalWorktree: root,
      harness: input.client,
      store,
    }),
  ];
  return nativeOutput(scopedEvent, await dispatchHookEvent(scopedEvent, handlers));
}
