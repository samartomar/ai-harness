import { join, resolve } from "node:path";
import { readIfExists } from "./internals/fsxn.js";
import { gitRead } from "./internals/git.js";
import { type DigestAction, digest, type PlanContext } from "./internals/plan.js";
import { lines } from "./internals/render.js";
import type { Check } from "./internals/verify.js";
import { aihWorkspaceGraphRepo } from "./workspace/templates.js";

export const LARGE_REPO_FILE_THRESHOLD = 1000;
const CODE_REVIEW_GRAPH_PACKAGE = "code-review-graph@2.3.6";
const UVX_OFFLINE_FLAGS = ["--offline", "--no-python-downloads", "--no-env-file"] as const;

async function onPath(ctx: PlanContext, bin: string): Promise<boolean> {
  const argv = ctx.host.platform === "windows" ? ["where", bin] : ["which", bin];
  const res = await ctx.run(argv);
  return !res.spawnError && res.code === 0 && res.stdout.trim().length > 0;
}

export async function trackedFileCount(ctx: PlanContext): Promise<number | undefined> {
  const ls = await gitRead(ctx, ["ls-files"]);
  if (ls === undefined) return undefined;
  return ls.split("\n").filter(Boolean).length;
}

function readMcpServers(root: string): Record<string, unknown> | undefined {
  const raw = readIfExists(join(root, ".mcp.json"));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers;
  } catch {
    return undefined;
  }
}

function readRepoMcpCodeReviewGraph(mcpRoot: string): unknown | undefined {
  return readMcpServers(mcpRoot)?.["code-review-graph"];
}

function repoMcpHasCodeReviewGraph(mcpRoot: string): boolean {
  return readRepoMcpCodeReviewGraph(mcpRoot) !== undefined;
}

function repoMcpCodeReviewGraphPackage(mcpRoot: string): string {
  const server = readRepoMcpCodeReviewGraph(mcpRoot);
  if (!server || typeof server !== "object") return CODE_REVIEW_GRAPH_PACKAGE;
  const args = (server as { args?: unknown }).args;
  if (!Array.isArray(args)) return CODE_REVIEW_GRAPH_PACKAGE;
  return (
    args.find(
      (arg): arg is string => typeof arg === "string" && arg.startsWith("code-review-graph@"),
    ) ?? CODE_REVIEW_GRAPH_PACKAGE
  );
}

function workspaceMcpCodeReviewGraphPackage(mcpRoot: string, repoRoot: string): string | undefined {
  const servers = readMcpServers(mcpRoot) ?? {};
  const wanted = resolve(repoRoot);
  for (const server of Object.values(servers)) {
    const graphRepo = aihWorkspaceGraphRepo(server);
    if (graphRepo === undefined || resolve(mcpRoot, graphRepo) !== wanted) continue;
    const args = (server as { args?: unknown }).args;
    if (!Array.isArray(args)) return CODE_REVIEW_GRAPH_PACKAGE;
    return (
      args.find(
        (arg): arg is string => typeof arg === "string" && arg.startsWith("code-review-graph@"),
      ) ?? CODE_REVIEW_GRAPH_PACKAGE
    );
  }
  return undefined;
}

interface GraphStatus {
  nodes?: number;
  files?: number;
}

function parseCodeReviewGraphStatus(stdout: string): GraphStatus {
  return {
    nodes: parseStatusCount(stdout, "Nodes"),
    files: parseStatusCount(stdout, "Files"),
  };
}

function parseStatusCount(stdout: string, label: string): number | undefined {
  const match = stdout.match(new RegExp(`^${label}:\\s*(\\d+)\\s*$`, "m"));
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

function graphIsPopulated(status: GraphStatus): boolean {
  return (status.nodes ?? 0) > 0 && (status.files ?? 0) > 0;
}

function graphStatusSummary(status: GraphStatus): string {
  const nodes = status.nodes ?? 0;
  const files = status.files ?? 0;
  return `${files} files, ${nodes} nodes`;
}

async function ensureCodeReviewGraphPopulated(
  ctx: PlanContext,
  detail: string,
  argvFor: (command: "status" | "build") => string[],
): Promise<{ available: boolean; detail: string }> {
  const statusArgv = argvFor("status");
  const first = await ctx.run(statusArgv, { cwd: ctx.root, timeoutMs: 120_000 });
  if (first.spawnError || first.code !== 0) {
    return {
      available: false,
      detail: `${detail}; code-review-graph status failed (${first.stderr.trim() || first.stdout.trim() || "no output"})`,
    };
  }

  const firstStatus = parseCodeReviewGraphStatus(first.stdout);
  if (graphIsPopulated(firstStatus)) {
    return {
      available: true,
      detail: `${detail}; graph populated (${graphStatusSummary(firstStatus)})`,
    };
  }

  const buildArgv = argvFor("build");
  const build = await ctx.run(buildArgv, { cwd: ctx.root, timeoutMs: 300_000 });
  if (build.spawnError || build.code !== 0) {
    return {
      available: false,
      detail:
        `${detail}; graph status was empty (${graphStatusSummary(firstStatus)}) and offline rebuild failed ` +
        `(${build.stderr.trim() || build.stdout.trim() || "no output"})`,
    };
  }

  const second = await ctx.run(statusArgv, { cwd: ctx.root, timeoutMs: 120_000 });
  const secondStatus = parseCodeReviewGraphStatus(second.stdout);
  if (!second.spawnError && second.code === 0 && graphIsPopulated(secondStatus)) {
    return {
      available: true,
      detail: `${detail}; graph was empty (${graphStatusSummary(firstStatus)}) and rebuilt offline (${graphStatusSummary(secondStatus)})`,
    };
  }

  return {
    available: false,
    detail:
      `${detail}; graph status was empty (${graphStatusSummary(firstStatus)}) and offline rebuild did not populate the graph ` +
      `(${graphStatusSummary(secondStatus)})`,
  };
}

async function codeReviewGraphAvailabilityFor(
  ctx: PlanContext,
  repoRoot: string,
  mcpRoot: string,
): Promise<{
  available: boolean;
  detail: string;
}> {
  if (await onPath(ctx, "code-review-graph")) {
    return ensureCodeReviewGraphPopulated(ctx, "code-review-graph binary on PATH", (command) => [
      "code-review-graph",
      command,
      "--repo",
      repoRoot,
    ]);
  }
  const uvxPresent = await onPath(ctx, "uvx");
  const workspacePackage = workspaceMcpCodeReviewGraphPackage(mcpRoot, repoRoot);
  let workspaceGraphUnavailable: string | undefined;
  if (workspacePackage !== undefined) {
    if (uvxPresent) {
      return ensureCodeReviewGraphPopulated(
        ctx,
        "workspace MCP code-review-graph scoped to child repo and uvx is on PATH",
        (command) => ["uvx", ...UVX_OFFLINE_FLAGS, workspacePackage, command, "--repo", repoRoot],
      );
    }
    workspaceGraphUnavailable =
      "workspace MCP code-review-graph scoped to child repo, but uvx is not on PATH";
  }

  const mcpConfigured = repoMcpHasCodeReviewGraph(mcpRoot);
  const uvPresent = uvxPresent ? false : await onPath(ctx, "uv");
  if (mcpConfigured && (uvxPresent || uvPresent)) {
    const packageArg = repoMcpCodeReviewGraphPackage(mcpRoot);
    const prefix = uvxPresent
      ? ["uvx", ...UVX_OFFLINE_FLAGS]
      : ["uv", "tool", "run", ...UVX_OFFLINE_FLAGS];
    return ensureCodeReviewGraphPopulated(
      ctx,
      `repo MCP code-review-graph configured and ${uvxPresent ? "uvx" : "uv tool run"} is on PATH`,
      (command) => [...prefix, packageArg, command, "--repo", repoRoot],
    );
  }
  if (workspaceGraphUnavailable) {
    return {
      available: false,
      detail: workspaceGraphUnavailable,
    };
  }
  if (mcpConfigured) {
    return {
      available: false,
      detail: "repo MCP code-review-graph configured, but neither uvx nor uv is on PATH",
    };
  }
  return {
    available: false,
    detail: "no code-review-graph binary and no repo MCP code-review-graph server",
  };
}

export interface ScaleSafetyCheckOptions {
  detailPrefix?: string;
  mcpRoot?: string;
  name?: string;
  requireGraph?: boolean;
  repoRoot?: string;
}

export async function scaleSafetyCheck(
  ctx: PlanContext,
  options: ScaleSafetyCheckOptions = {},
): Promise<Check> {
  const repoRoot = options.repoRoot ?? ctx.root;
  const files = await trackedFileCount({ ...ctx, root: repoRoot });
  const name = options.name ?? "large-repo graph safety";
  const detailPrefix = options.detailPrefix ? `${options.detailPrefix}: ` : "";
  if (files === undefined) {
    return { name, verdict: "skip", detail: `${detailPrefix}not a git repo or git unavailable` };
  }
  if (files < LARGE_REPO_FILE_THRESHOLD && !options.requireGraph) {
    return {
      name,
      verdict: "pass",
      detail: `${detailPrefix}${files} tracked files < ${LARGE_REPO_FILE_THRESHOLD}; bounded rg/fd reconnaissance is acceptable`,
    };
  }
  const graph = await codeReviewGraphAvailabilityFor(ctx, repoRoot, options.mcpRoot ?? repoRoot);
  if (graph.available) {
    return {
      name,
      verdict: "pass",
      detail: `${detailPrefix}${files} tracked files; ${graph.detail}`,
    };
  }
  if (files < LARGE_REPO_FILE_THRESHOLD) {
    return {
      name,
      verdict: "skip",
      code: "scale.code-review-graph-missing",
      detail:
        `${detailPrefix}${files} tracked files < ${LARGE_REPO_FILE_THRESHOLD}, but workspace graph coverage is unverified; ${graph.detail}. ` +
        "Re-run `aih workspace --apply` to emit per-child graph MCP servers, or use bounded rg/fd reads only.",
    };
  }
  return {
    name,
    verdict: "fail",
    code: "scale.code-review-graph-missing",
    detail:
      `${detailPrefix}${files} tracked files >= ${LARGE_REPO_FILE_THRESHOLD}; ${graph.detail}. ` +
      "Install/enable code-review-graph before broad analysis: `aih mcp --apply` and `aih tools --apply`. " +
      "Until then, use bounded rg/fd reads only.",
  };
}

export async function scaleSafetyDigest(ctx: PlanContext): Promise<DigestAction | undefined> {
  const check = await scaleSafetyCheck(ctx);
  if (check.detail?.includes(` < ${LARGE_REPO_FILE_THRESHOLD}`)) return undefined;
  if (check.verdict === "skip") return undefined;
  const ok = check.verdict === "pass";
  return digest(
    ok
      ? "Scale safety — graph available for large repo"
      : "Scale safety — graph missing for large repo",
    lines(
      ok
        ? "Large-repo analysis has a graph path available, so agents can inspect impact radius without reading the whole tree."
        : "Large-repo analysis is at risk of burning the context budget if an agent falls back to broad file reads.",
      "",
      check.detail ?? "",
    ),
    { ok, code: check.code, detail: check.detail },
  );
}
