import { join, posix } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";

export type WorkspaceEvidenceStatus =
  | "OK"
  | "WARN"
  | "MISSING"
  | "STALE"
  | "NOT_ONBOARDED"
  | "NOT_COLLECTED"
  | "PARTIAL"
  | "UNKNOWN"
  | "ERROR";

export interface WorkspaceRepo {
  id: string;
  path: string;
  kind?: string;
  /** Path to the child repo's router, relative to the child repo root. */
  router: string;
}

export interface WorkspaceEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  contractPath?: string;
  consumerPath?: string;
}

export interface WorkspaceManifest {
  status: "OK" | "ERROR";
  errors: string[];
  raw: Record<string, unknown>;
  schemaVersion?: number;
  workspaceType?: string;
  graphScope?: string;
  contextDir: string;
  repos: WorkspaceRepo[];
  edges: WorkspaceEdge[];
  git: boolean;
  lastSnapshot?: string;
  generatedBy?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function cleanPrintable(value: string, label: string): void {
  if (/[\r\n\t|]/.test(value)) {
    throw new Error(`${label} must be safe to print in workspace reports`);
  }
}

export function normalizeWorkspacePath(raw: string, label = "workspace path"): string {
  const value = raw.trim().replace(/\\/g, "/");
  if (value.length === 0) throw new Error(`${label} must be non-empty`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("//")) {
    throw new Error(`${label} must be relative to the parent workspace: ${raw}`);
  }
  cleanPrintable(value, label);
  const parts = value.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error(`${label} must not traverse parents: ${raw}`);
  }
  return parts.join("/");
}

function safeId(raw: string, label = "workspace repo id"): string {
  const value = raw.trim();
  cleanPrintable(value, label);
  if (!ID_RE.test(value)) {
    throw new Error(`${label} must be stable, unique, and path-safe: ${raw}`);
  }
  return value;
}

function idFromPath(path: string): string {
  const slug = path.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 && ID_RE.test(slug) ? slug : "repo";
}

function safeKind(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const value = raw.trim();
  cleanPrintable(value, "workspace repo kind");
  return value;
}

function defaultRouter(): string {
  return "ai-coding/RULE_ROUTER.md";
}

function normalizeRouter(raw: unknown): string {
  return typeof raw === "string" && raw.trim().length > 0
    ? normalizeWorkspacePath(raw, "workspace repo router")
    : defaultRouter();
}

function normalizeRepo(raw: unknown): WorkspaceRepo {
  if (typeof raw === "string") {
    const path = normalizeWorkspacePath(raw, "workspace repo path");
    return { id: idFromPath(path), path, router: defaultRouter() };
  }
  if (!isPlainObject(raw)) throw new Error("workspace repo entry must be a string or object");
  const pathRaw = raw.path;
  if (typeof pathRaw !== "string") throw new Error("workspace repo object needs a string path");
  const path = normalizeWorkspacePath(pathRaw, "workspace repo path");
  const id = typeof raw.id === "string" ? safeId(raw.id) : idFromPath(path);
  return {
    id,
    path,
    ...(safeKind(raw.kind) ? { kind: safeKind(raw.kind) } : {}),
    router: normalizeRouter(raw.router),
  };
}

function normalizeEdge(raw: unknown): WorkspaceEdge {
  if (!isPlainObject(raw)) throw new Error("workspace edge entry must be an object");
  const id = typeof raw.id === "string" ? safeId(raw.id, "workspace edge id") : "";
  const from = typeof raw.from === "string" ? safeId(raw.from, "workspace edge from") : "";
  const to = typeof raw.to === "string" ? safeId(raw.to, "workspace edge to") : "";
  const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
  if (id.length === 0 || from.length === 0 || to.length === 0 || kind.length === 0) {
    throw new Error("workspace edge needs id, from, to, and kind");
  }
  cleanPrintable(kind, "workspace edge kind");
  const contractPath =
    typeof raw.contractPath === "string" && raw.contractPath.trim().length > 0
      ? normalizeWorkspacePath(raw.contractPath, "workspace edge contractPath")
      : undefined;
  const consumerPath =
    typeof raw.consumerPath === "string" && raw.consumerPath.trim().length > 0
      ? normalizeWorkspacePath(raw.consumerPath, "workspace edge consumerPath")
      : undefined;
  return {
    id,
    from,
    to,
    kind,
    ...(contractPath ? { contractPath } : {}),
    ...(consumerPath ? { consumerPath } : {}),
  };
}

function emptyManifest(defaultContextDir: string, errors: string[]): WorkspaceManifest {
  return {
    status: "ERROR",
    errors,
    raw: {},
    contextDir: defaultContextDir,
    repos: [],
    edges: [],
    git: false,
  };
}

export function parseWorkspaceManifest(
  raw: unknown,
  defaultContextDir = "ai-coding",
): WorkspaceManifest {
  if (!isPlainObject(raw))
    return emptyManifest(defaultContextDir, ["workspace manifest must be an object"]);
  const errors: string[] = [];
  const contextDir = (() => {
    if (typeof raw.contextDir !== "string" || raw.contextDir.trim().length === 0) {
      return defaultContextDir;
    }
    try {
      return normalizeWorkspacePath(raw.contextDir, "workspace contextDir");
    } catch (err) {
      errors.push((err as Error).message);
      return defaultContextDir;
    }
  })();
  const repos: WorkspaceRepo[] = [];
  const seenRepoIds = new Set<string>();
  const rawRepos = raw.repos;
  if (rawRepos !== undefined && !Array.isArray(rawRepos)) {
    errors.push("workspace manifest repos must be an array");
  }
  for (const entry of Array.isArray(rawRepos) ? rawRepos : []) {
    try {
      const repo = normalizeRepo(entry);
      if (seenRepoIds.has(repo.id)) {
        errors.push(`duplicate repo id in workspace manifest: ${repo.id}`);
        continue;
      }
      seenRepoIds.add(repo.id);
      repos.push(repo);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  const edges: WorkspaceEdge[] = [];
  const seenEdgeIds = new Set<string>();
  const rawEdges = raw.edges;
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    errors.push("workspace manifest edges must be an array");
  }
  for (const entry of Array.isArray(rawEdges) ? rawEdges : []) {
    try {
      const edge = normalizeEdge(entry);
      if (seenEdgeIds.has(edge.id)) {
        errors.push(`duplicate edge id in workspace manifest: ${edge.id}`);
        continue;
      }
      seenEdgeIds.add(edge.id);
      edges.push(edge);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  let lastSnapshot: string | undefined;
  if (typeof raw.lastSnapshot === "string" && raw.lastSnapshot.trim().length > 0) {
    try {
      lastSnapshot = normalizeWorkspacePath(raw.lastSnapshot, "workspace lastSnapshot");
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return {
    status: errors.length > 0 ? "ERROR" : "OK",
    errors,
    raw,
    ...(typeof raw.schemaVersion === "number" ? { schemaVersion: raw.schemaVersion } : {}),
    ...(typeof raw.workspaceType === "string" ? { workspaceType: raw.workspaceType } : {}),
    ...(typeof raw.graphScope === "string" ? { graphScope: raw.graphScope } : {}),
    contextDir,
    repos,
    edges,
    git: raw.git === true,
    ...(lastSnapshot ? { lastSnapshot } : {}),
    ...(typeof raw.generatedBy === "string" ? { generatedBy: raw.generatedBy } : {}),
  };
}

export function readWorkspaceManifest(
  root: string,
  defaultContextDir = "ai-coding",
): WorkspaceManifest | undefined {
  const raw = readIfExists(join(root, ".aih-workspace.json"));
  if (raw === undefined) return undefined;
  try {
    return parseWorkspaceManifest(parseJsoncText(raw), defaultContextDir);
  } catch (err) {
    return emptyManifest(defaultContextDir, [(err as Error).message]);
  }
}

export function workspaceManifestExists(root: string): boolean {
  return readIfExists(join(root, ".aih-workspace.json")) !== undefined;
}

export function workspaceReposFromPaths(
  paths: readonly string[],
  router = defaultRouter(),
): WorkspaceRepo[] {
  return paths.map((raw) => {
    const path = normalizeWorkspacePath(raw, "workspace repo path");
    return { id: idFromPath(path), path, router: posix.normalize(router).replace(/\\/g, "/") };
  });
}
