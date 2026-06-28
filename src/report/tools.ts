import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * HARNESS ADOPTION — which agent shell tools are installed on PATH. The harness's
 * agent guidance leans on these for fast, precise work (ripgrep, ast-grep, fd, …);
 * this surfaces which are actually available here. Probes run through the Runner
 * seam (`where`/`which`), so tests stay hermetic. Read-only, no mutation.
 */

/**
 * CORE tools the agent guidance actually leans on (fast search + JSON) — their
 * absence is a real gap. OPTIONAL tools are nice-to-haves (structural search,
 * tree view, GitHub CLI, the graph engine); their absence is NOT a shortfall, so
 * a personal box without `sg`/`comby` shouldn't read as "2 missing".
 */
const CORE_TOOLS = ["rg", "fd", "jq"] as const;
const OPTIONAL_TOOLS = ["sg", "comby", "tree", "gh", "code-review-graph"] as const;

async function onPath(ctx: PlanContext, bin: string): Promise<boolean> {
  const argv = ctx.host.platform === "windows" ? ["where", bin] : ["which", bin];
  const res = await ctx.run(argv);
  return !res.spawnError && res.code === 0 && res.stdout.trim().length > 0;
}

export async function toolsInstalledDigest(ctx: PlanContext): Promise<DigestAction> {
  const check = (name: string) => onPath(ctx, name).then((present) => ({ name, present }));
  const core = await Promise.all(CORE_TOOLS.map(check));
  const optional = await Promise.all(OPTIONAL_TOOLS.map(check));
  const corePresent = core.filter((r) => r.present);
  const optPresent = optional.filter((r) => r.present);
  const optMissing = optional.filter((r) => !r.present).length;

  const body = lines(
    "Agent shell tools on PATH — CORE (fast search + JSON; absence is a real gap)",
    "vs OPTIONAL (nice-to-have; absence is fine, not a shortfall):",
    "",
    "  Core:",
    ...core.map((r) => `    ${r.present ? "✓" : "✗"} ${r.name}`),
    "  Optional:",
    ...optional.map(
      (r) => `    ${r.present ? "✓" : "·"} ${r.name}${r.present ? "" : "  (optional)"}`,
    ),
  );
  return digest(
    `Tools installed — ${corePresent.length}/${core.length} core${optMissing > 0 ? ` · ${optPresent.length}/${optional.length} optional` : " · all optional too"} on PATH`,
    body,
    {
      // `present`/`absent` keep the old shape (all tools) for the dashboard pills;
      // `core`/`optional` let the renderer style optional-absence as fine, not failed.
      present: [...corePresent, ...optPresent].map((r) => r.name),
      absent: [...core, ...optional].filter((r) => !r.present).map((r) => r.name),
      core: CORE_TOOLS.slice(),
      optional: OPTIONAL_TOOLS.slice(),
      coreMissing: core.filter((r) => !r.present).map((r) => r.name),
      total: core.length + optional.length,
    },
  );
}
