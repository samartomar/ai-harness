import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CODE_REVIEW_GRAPH_ALLOWED_TOOLS = [
  "build_or_update_graph_tool",
  "get_impact_radius_tool",
  "get_affected_flows_tool",
  "get_review_context_tool",
  "detect_changes_tool",
] as const;

const ALLOWED_TOOLS = new Set<string>(CODE_REVIEW_GRAPH_ALLOWED_TOOLS);

/**
 * Variables needed to execute a local uv-managed child. Everything else stays at
 * the parent boundary, including credentials for every provider supported by
 * Code Review Graph and credentials belonging to unrelated developer tools.
 */
const LOCAL_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export function isolatedCodeReviewGraphEnvironment(
  env: NodeJS.ProcessEnv,
  stateRoot: string,
  cacheRoot: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_CHILD_ENV_KEYS) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  if (next.PATH === undefined && next.Path !== undefined) next.PATH = next.Path;
  next.CRG_DATA_DIR = stateRoot;
  next.UV_CACHE_DIR = cacheRoot;
  next.UV_PROJECT_ENVIRONMENT = join(stateRoot, "runtime-env");
  next.UV_OFFLINE = "1";
  next.UV_NO_ENV_FILE = "1";
  // The approved closure omits embedding extras. Keep any future optional model
  // loader offline too, including Windows' automatic prewarm path.
  next.HF_HUB_OFFLINE = "1";
  next.TRANSFORMERS_OFFLINE = "1";
  return next;
}

function canonicalDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(value);
}

function requestId(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  throw new Error("malformed Code Review Graph tools/call request id");
}

function refusal(id: string | number | null, code: number, message: string) {
  return {
    forward: false as const,
    response: { jsonrpc: "2.0" as const, id, error: { code, message } },
  };
}

interface ToolDescription {
  name: string;
  [key: string]: unknown;
}

/**
 * Protocol boundary for the exact five AIH-reviewed CRG operations. The upstream
 * `serve --repo` argument supplies the canonical root when clients omit it; an
 * explicit client root may only repeat that identity. Cloud embedding controls
 * are refused by property presence, before the request reaches Python.
 */
export class CodeReviewGraphMcpPolicyGuard {
  readonly #project: string;

  constructor(project: string) {
    this.#project = canonicalDirectory(project, "Code Review Graph project");
  }

  inspectClientRequest(value: unknown): { forward: true } | ReturnType<typeof refusal> {
    if (value === null || typeof value !== "object") {
      throw new Error("malformed Code Review Graph request");
    }
    const request = value as { id?: unknown; method?: unknown; params?: unknown };
    if (request.method !== "tools/call") return { forward: true };
    const id = requestId(request.id);
    if (request.params === null || typeof request.params !== "object") {
      throw new Error("malformed Code Review Graph tools/call request");
    }
    const params = request.params as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string") {
      throw new Error("malformed Code Review Graph tools/call request");
    }
    if (!ALLOWED_TOOLS.has(params.name)) {
      return refusal(id, -32601, `Code Review Graph tool '${params.name}' is not enabled by AIH`);
    }
    if (
      params.arguments !== undefined &&
      (params.arguments === null ||
        typeof params.arguments !== "object" ||
        Array.isArray(params.arguments))
    ) {
      throw new Error("malformed Code Review Graph tool arguments");
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (
      params.name === "build_or_update_graph_tool" &&
      (Object.hasOwn(args, "embedding_provider") || Object.hasOwn(args, "embedding_model"))
    ) {
      return refusal(
        id,
        -32003,
        "AIH local-only Code Review Graph blocks explicit cloud embedding refresh",
      );
    }
    if (Object.hasOwn(args, "repo_root")) {
      if (typeof args.repo_root !== "string") {
        return refusal(id, -32002, "Code Review Graph repo_root must identify this project");
      }
      try {
        if (canonicalDirectory(args.repo_root, "Code Review Graph repo_root") !== this.#project) {
          return refusal(id, -32002, "Code Review Graph repo_root is outside this project");
        }
      } catch {
        return refusal(id, -32002, "Code Review Graph repo_root is outside this project");
      }
    }
    return { forward: true };
  }

  filterToolsList(value: unknown): { tools: ToolDescription[] } {
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray((value as { tools?: unknown }).tools)
    ) {
      throw new Error("Code Review Graph tools/list response is malformed");
    }
    const byName = new Map<string, ToolDescription>();
    for (const item of (value as { tools: unknown[] }).tools) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof (item as { name?: unknown }).name !== "string"
      ) {
        throw new Error("Code Review Graph tools/list contains a malformed tool");
      }
      const tool = item as ToolDescription;
      if (byName.has(tool.name)) {
        throw new Error(`Code Review Graph tools/list contains duplicate '${tool.name}'`);
      }
      byName.set(tool.name, tool);
    }
    const missing = CODE_REVIEW_GRAPH_ALLOWED_TOOLS.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Code Review Graph tools/list is missing reviewed tools: ${missing.join(", ")}`,
      );
    }
    return {
      tools: CODE_REVIEW_GRAPH_ALLOWED_TOOLS.map((name) => byName.get(name) as ToolDescription),
    };
  }
}
