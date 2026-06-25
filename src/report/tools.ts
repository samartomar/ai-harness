import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * HARNESS ADOPTION — which agent shell tools are installed on PATH. The harness's
 * agent guidance leans on these for fast, precise work (ripgrep, ast-grep, fd, …);
 * this surfaces which are actually available here. Probes run through the Runner
 * seam (`where`/`which`), so tests stay hermetic. Read-only, no mutation.
 */

/** Tools the harness recommends; `code-review-graph` powers the (gated) graph panels. */
const DEV_TOOLS = ["rg", "sg", "fd", "tree", "comby", "jq", "gh", "code-review-graph"] as const;

async function onPath(ctx: PlanContext, bin: string): Promise<boolean> {
  const argv = ctx.host.platform === "windows" ? ["where", bin] : ["which", bin];
  const res = await ctx.run(argv);
  return !res.spawnError && res.code === 0 && res.stdout.trim().length > 0;
}

export async function toolsInstalledDigest(ctx: PlanContext): Promise<DigestAction> {
  const results = await Promise.all(
    DEV_TOOLS.map(async (name) => ({ name, present: await onPath(ctx, name) })),
  );
  const present = results.filter((r) => r.present);
  return digest(
    `Tools installed — ${present.length} of ${results.length} on PATH`,
    lines(
      "Agent shell tools on PATH:",
      "",
      ...results.map((r) => `  ${r.present ? "✓" : "·"} ${r.name}`),
    ),
    {
      present: present.map((r) => r.name),
      absent: results.filter((r) => !r.present).map((r) => r.name),
      total: results.length,
    },
  );
}
