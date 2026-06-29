import { join } from "node:path";
import { readIfExists } from "./internals/fsxn.js";
import { gitRead } from "./internals/git.js";
import { type DigestAction, digest, type PlanContext } from "./internals/plan.js";
import { lines } from "./internals/render.js";
import type { Check } from "./internals/verify.js";

export const LARGE_REPO_FILE_THRESHOLD = 1000;

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

function repoMcpHasCodeReviewGraph(ctx: PlanContext): boolean {
  const raw = readIfExists(join(ctx.root, ".mcp.json"));
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers?.["code-review-graph"] !== undefined;
  } catch {
    return false;
  }
}

async function codeReviewGraphAvailability(ctx: PlanContext): Promise<{
  available: boolean;
  detail: string;
}> {
  if (await onPath(ctx, "code-review-graph")) {
    return { available: true, detail: "code-review-graph binary on PATH" };
  }
  const mcpConfigured = repoMcpHasCodeReviewGraph(ctx);
  const uvPresent = await onPath(ctx, "uv");
  if (mcpConfigured && uvPresent) {
    return { available: true, detail: "repo MCP code-review-graph configured and uv is on PATH" };
  }
  if (mcpConfigured) {
    return {
      available: false,
      detail: "repo MCP code-review-graph configured, but uv is not on PATH",
    };
  }
  return {
    available: false,
    detail: "no code-review-graph binary and no repo MCP code-review-graph server",
  };
}

export async function scaleSafetyCheck(ctx: PlanContext): Promise<Check> {
  const files = await trackedFileCount(ctx);
  const name = "large-repo graph safety";
  if (files === undefined) {
    return { name, verdict: "skip", detail: "not a git repo or git unavailable" };
  }
  if (files < LARGE_REPO_FILE_THRESHOLD) {
    return {
      name,
      verdict: "pass",
      detail: `${files} tracked files < ${LARGE_REPO_FILE_THRESHOLD}; bounded rg/fd reconnaissance is acceptable`,
    };
  }
  const graph = await codeReviewGraphAvailability(ctx);
  if (graph.available) {
    return {
      name,
      verdict: "pass",
      detail: `${files} tracked files; ${graph.detail}`,
    };
  }
  return {
    name,
    verdict: "fail",
    code: "scale.code-review-graph-missing",
    detail:
      `${files} tracked files >= ${LARGE_REPO_FILE_THRESHOLD}; ${graph.detail}. ` +
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
