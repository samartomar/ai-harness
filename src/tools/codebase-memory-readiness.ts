import type { PlanContext } from "../internals/plan.js";
import {
  defaultNativeMcpServers,
  defaultNativeRuntimeLayout,
} from "../mcp/default-native-runtime.js";
import {
  initializedMcpRequests,
  localMcpResponse,
  memoryProjectName,
  runRootAwareMcpSession,
  sameCanonicalProject,
  structuredToolResult,
  verifyToolCall,
  verifyToolsList,
} from "./developer-tools-operations.js";

export interface GraphAvailability {
  readonly available: boolean;
  readonly detail: string;
}

function sameRegistration(server: unknown, expected: unknown): boolean {
  if (server === null || typeof server !== "object" || expected === undefined) return false;
  const actual = server as { type?: unknown; command?: unknown; args?: unknown; env?: unknown };
  const wanted = expected as { type: string; command: string; args: readonly string[] };
  return (
    actual.type === wanted.type &&
    actual.command === wanted.command &&
    actual.env === undefined &&
    Array.isArray(actual.args) &&
    actual.args.length === wanted.args.length &&
    actual.args.every((arg, index) => arg === wanted.args[index])
  );
}

async function memoryCall(
  ctx: PlanContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stdout = await runRootAwareMcpSession(
    ctx,
    ctx.run,
    "codebase-memory-mcp",
    initializedMcpRequests({ name, arguments: args }),
    "Codebase Memory",
  );
  verifyToolsList(localMcpResponse(stdout, 2), [name]);
  const result = localMcpResponse(stdout, 3);
  verifyToolCall(result, `Codebase Memory ${name}`);
  return result;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The Codebase Memory counterpart of the managed Code Review Graph readiness
 * check: the exact generated registration, then real MCP calls through it. An
 * unindexed project is indexed locally once; the native payload is never
 * downloaded here, so a missing payload is reported, not repaired.
 */
export async function codebaseMemoryAvailability(
  ctx: PlanContext,
  server: unknown,
): Promise<GraphAvailability> {
  if (server === undefined) {
    return {
      available: false,
      detail:
        "no managed codebase-memory-mcp registration in .mcp.json; run `aih developer-tools --apply` for this worktree",
    };
  }
  let expected: unknown;
  let project: string;
  try {
    expected = defaultNativeMcpServers(ctx)["codebase-memory-mcp"];
    project = defaultNativeRuntimeLayout(ctx).project;
  } catch (error) {
    return {
      available: false,
      detail: `managed Codebase Memory runtime could not be located: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!sameRegistration(server, expected)) {
    return {
      available: false,
      detail:
        "managed Codebase Memory registration is stale; re-run `aih developer-tools --apply` for this worktree",
    };
  }
  try {
    const listed = await memoryCall(ctx, "list_projects", {});
    const inventory = structuredToolResult(listed, "Codebase Memory list_projects");
    let name: string;
    let indexedNow = false;
    if (inventory.total === 0) {
      const indexed = structuredToolResult(
        await memoryCall(ctx, "index_repository", { repo_path: project, mode: "fast" }),
        "Codebase Memory index_repository",
      );
      if (indexed.status !== "indexed" || typeof indexed.project !== "string") {
        throw new Error("Codebase Memory index_repository did not index the project");
      }
      name = indexed.project;
      indexedNow = true;
    } else {
      name = memoryProjectName(listed, project);
    }
    const status = structuredToolResult(
      await memoryCall(ctx, "index_status", { project: name }),
      "Codebase Memory index_status",
    );
    const nodes = count(status.nodes);
    const edges = count(status.edges);
    if (!sameCanonicalProject(status.root_path, project)) {
      throw new Error("Codebase Memory index_status answered for a foreign project");
    }
    if (nodes === undefined || edges === undefined || nodes === 0) {
      return {
        available: false,
        detail: `managed Codebase Memory index is empty (${String(status.status)}); re-run \`aih developer-tools --apply\``,
      };
    }
    return {
      available: true,
      detail: `managed codebase-memory-mcp runtime with authenticated payload and worktree state; index ${
        indexedNow ? "was empty and indexed offline" : "populated"
      } (${nodes} nodes, ${edges} edges)`,
    };
  } catch (error) {
    return {
      available: false,
      detail: `managed Codebase Memory readiness failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
