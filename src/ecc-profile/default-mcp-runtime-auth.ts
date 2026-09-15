import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import {
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
  DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256,
  DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256,
} from "./default-mcp-runtime-lock.js";

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/** Authenticate the packaged lock and keep it disjoint from mutable project state. */
export function authenticateDefaultMcpRuntimeRoot(
  value: string,
  project?: string,
  stateRoots: readonly string[] = [],
): string {
  if (!isAbsolute(value)) throw new Error("default MCP runtime lock root must be absolute");
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("default MCP runtime lock root must be a real directory");
  }
  const root = realpathSync(value);
  if (
    (project !== undefined && (contains(project, root) || contains(root, project))) ||
    stateRoots.some((state) => contains(state, root) || contains(root, state))
  ) {
    throw new Error("default MCP runtime lock root must be disjoint from project and state roots");
  }
  const identities = [
    ["pyproject.toml", DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256],
    ["uv.lock", DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256],
  ] as const;
  const verified: string[] = [];
  for (const [name, expected] of identities) {
    const opened = readRegularFileWithStats(join(root, name), { maxBytes: 8 * 1024 * 1024 });
    if (!opened || opened.stats.nlink > 1) {
      throw new Error(`default MCP runtime ${name} must be an unambiguous regular file`);
    }
    const actual = createHash("sha256").update(opened.contents).digest("hex");
    if (actual !== expected) throw new Error(`default MCP runtime ${name} failed authentication`);
    verified.push(actual);
  }
  const aggregate = createHash("sha256").update(verified.join("\0")).digest("hex");
  if (aggregate !== DEFAULT_MCP_DEPENDENCY_LOCK_SHA256) {
    throw new Error("default MCP runtime dependency closure failed authentication");
  }
  return root;
}
