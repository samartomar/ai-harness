import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * Phase 2 — code-review-graph panels (Code Graph Health + Build/Analysis times).
 * GATED on real data: aih reads a simple contract file it owns (`.aih/graph.json`).
 * When the contract file is absent or invalid the panels are OMITTED — never
 * fabricated and never discovered by spawning a process during report planning.
 * The demo mode showcases what they look like.
 */

export interface GraphStats {
  nodes?: number;
  edges?: number;
  files?: number; // files indexed by the graph
  density?: number; // edges / nodes
  buildMs?: number; // graph build time in ms
}

function parseStats(text: string): GraphStats | undefined {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const n = (k: string): number | undefined =>
      typeof v[k] === "number" ? (v[k] as number) : undefined;
    const stats: GraphStats = {
      nodes: n("nodes"),
      edges: n("edges"),
      files: n("files") ?? n("filesIndexed"),
      density: n("density"),
      buildMs: n("buildMs") ?? n("buildTimeMs"),
    };
    return stats.nodes !== undefined || stats.edges !== undefined ? stats : undefined;
  } catch {
    return undefined;
  }
}

/** Read graph stats from the `.aih/graph.json` contract, else undefined. */
function readGraph(ctx: PlanContext): GraphStats | undefined {
  const file = readIfExists(join(ctx.root, ".aih", "graph.json"));
  return file ? parseStats(file) : undefined;
}

/** Phase 2 digests (code graph health + build times) — empty when no real graph data. */
export async function graphDigests(ctx: PlanContext): Promise<DigestAction[]> {
  const g = readGraph(ctx);
  if (!g) return [];
  const density = g.density ?? (g.nodes && g.nodes > 0 && g.edges ? g.edges / g.nodes : undefined);
  const out: DigestAction[] = [
    digest(
      `Code graph health — ${g.nodes ?? "?"} nodes · ${g.edges ?? "?"} edges`,
      lines(
        `Nodes (functions/classes): ${g.nodes ?? "—"}`,
        `Edges (relationships):     ${g.edges ?? "—"}`,
        `Files indexed:             ${g.files ?? "—"}`,
        `Edge density:              ${density !== undefined ? density.toFixed(1) : "—"}`,
      ),
      { nodes: g.nodes, edges: g.edges, files: g.files, density },
    ),
  ];
  if (g.buildMs !== undefined || g.files !== undefined) {
    out.push(
      digest(
        `Build & analysis — ${g.buildMs !== undefined ? `${(g.buildMs / 1000).toFixed(1)}s` : "—"}`,
        lines(
          `Graph build time: ${g.buildMs !== undefined ? `${(g.buildMs / 1000).toFixed(2)}s` : "—"}`,
          `Files tracked by graph: ${g.files ?? "—"}`,
        ),
        { buildMs: g.buildMs, files: g.files },
      ),
    );
  }
  return out;
}
