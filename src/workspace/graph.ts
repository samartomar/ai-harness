import { posix } from "node:path";
import { AihError } from "../errors.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { digest, plan, writeJson } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import {
  assertWorkspacePrintable,
  readWorkspaceManifest,
  type WorkspaceEdge,
  type WorkspaceManifest,
} from "./manifest.js";

/**
 * `aih workspace graph` (#505) — project the workspace's OWN declared contract
 * relations (`.aih-workspace.json` `repos[]` + `edges[]`) into a queryable
 * cross-repo graph. Declared topology is the source of truth; graph-tool
 * inference (the workspace graph MCP servers) is optional enrichment and is
 * never required to answer "what depends on what" for declared contracts.
 *
 * The projection is a PURE function of the manifest: no child checkout, no
 * indexing, no tool execution, no timestamps — the same manifest always yields
 * a byte-identical artifact.
 */

export const WORKSPACE_GRAPH_PATH = posix.join(".aih", "workspace-graph.json");

export interface WorkspaceGraphNode {
  id: string;
  path: string;
  kind?: string;
  owner?: string;
  router: string;
}

export interface WorkspaceGraphEdge extends WorkspaceEdge {
  /** Where this edge came from. Declared edges are authored, never inferred. */
  provenance: "declared";
}

export interface WorkspaceGraph {
  schemaVersion: 1;
  /** The single source of truth this graph is projected from. */
  source: ".aih-workspace.json";
  /** Declared-over-inferred posture marker: every edge here was authored. */
  topology: "declared";
  generatedBy: "aih workspace graph";
  nodes: WorkspaceGraphNode[];
  edges: WorkspaceGraphEdge[];
}

export interface WorkspaceGraphQuery {
  /** Match edges touching this repo id in either direction. */
  repo?: string;
  /** Match edges declared from this repo id. */
  from?: string;
  /** Match edges declared to this repo id. */
  to?: string;
  /** Match edges with exactly this contract kind label. */
  kind?: string;
}

/**
 * Project the declared manifest into graph form. Fails closed on an edge whose
 * endpoint is not a declared repo id: a dangling edge is a manifest bug, and
 * silently emitting it would let a typo masquerade as topology.
 */
export function projectWorkspaceGraph(manifest: WorkspaceManifest): WorkspaceGraph {
  const declared = new Set(manifest.repos.map((repo) => repo.id));
  const dangling = [
    ...new Set(
      manifest.edges.flatMap((edge) => [edge.from, edge.to]).filter((id) => !declared.has(id)),
    ),
  ];
  if (dangling.length > 0) {
    throw new AihError(
      `workspace graph cannot project an edge that references an undeclared repo id: ${dangling.join(
        ", ",
      )} — declare the repo in .aih-workspace.json (aih workspace link) or fix the edge`,
      "AIH_WORKSPACE",
    );
  }
  return {
    schemaVersion: 1,
    source: ".aih-workspace.json",
    topology: "declared",
    generatedBy: "aih workspace graph",
    nodes: manifest.repos.map((repo) => ({
      id: repo.id,
      path: repo.path,
      ...(repo.kind ? { kind: repo.kind } : {}),
      ...(repo.owner ? { owner: repo.owner } : {}),
      router: repo.router,
    })),
    edges: manifest.edges.map((edge) => ({ ...edge, provenance: "declared" })),
  };
}

/** A query option must be a printable, non-empty string — never coerced. */
function queryOption(ctx: PlanContext, name: string, label: string): string | undefined {
  const value = ctx.options[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AihError(`${label} must be a non-empty string`, "AIH_WORKSPACE");
  }
  const trimmed = value.trim();
  assertWorkspacePrintable(trimmed, label);
  return trimmed;
}

function workspaceGraphQuery(ctx: PlanContext): WorkspaceGraphQuery | undefined {
  const repo = queryOption(ctx, "repo", "workspace graph --repo");
  const from = queryOption(ctx, "from", "workspace graph --from");
  const to = queryOption(ctx, "to", "workspace graph --to");
  const kind = queryOption(ctx, "kind", "workspace graph --kind");
  const query: WorkspaceGraphQuery = {
    ...(repo !== undefined ? { repo } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  return Object.keys(query).length > 0 ? query : undefined;
}

function assertDeclaredRepoId(graph: WorkspaceGraph, id: string, label: string): void {
  if (graph.nodes.some((node) => node.id === id)) return;
  const declared = graph.nodes.map((node) => node.id).join(", ");
  throw new AihError(
    `${label} does not match a declared repo id: ${id} (declared: ${declared.length > 0 ? declared : "none"})`,
    "AIH_WORKSPACE",
  );
}

/**
 * Filter declared edges. Repo-id filters fail closed on an undeclared id (a
 * typo must not read as "no dependencies"); `kind` is a free-form label, so a
 * zero-match kind is answered honestly instead of rejected.
 */
export function filterWorkspaceGraph(
  graph: WorkspaceGraph,
  query: WorkspaceGraphQuery,
): WorkspaceGraphEdge[] {
  if (query.repo !== undefined) assertDeclaredRepoId(graph, query.repo, "workspace graph --repo");
  if (query.from !== undefined) assertDeclaredRepoId(graph, query.from, "workspace graph --from");
  if (query.to !== undefined) assertDeclaredRepoId(graph, query.to, "workspace graph --to");
  return graph.edges.filter(
    (edge) =>
      (query.repo === undefined || edge.from === query.repo || edge.to === query.repo) &&
      (query.from === undefined || edge.from === query.from) &&
      (query.to === undefined || edge.to === query.to) &&
      (query.kind === undefined || edge.kind === query.kind),
  );
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function describeGraph(
  graph: WorkspaceGraph,
  query: WorkspaceGraphQuery | undefined,
  matches: readonly WorkspaceGraphEdge[],
): string {
  const base = `Workspace graph — ${count(graph.nodes.length, "repo")} · ${count(
    graph.edges.length,
    "declared edge",
    "declared edges",
  )}`;
  return query === undefined ? base : `${base} · ${count(matches.length, "match", "matches")}`;
}

function queryLabel(query: WorkspaceGraphQuery): string {
  return (["repo", "from", "to", "kind"] as const)
    .filter((key) => query[key] !== undefined)
    .map((key) => `${key}=${query[key]}`)
    .join(" · ");
}

function renderGraphText(
  graph: WorkspaceGraph,
  query: WorkspaceGraphQuery | undefined,
  matches: readonly WorkspaceGraphEdge[],
): string {
  const edgeRows =
    matches.length > 0
      ? [
          "| Edge | From | To | Kind | Contract | Consumer |",
          "|---|---|---|---|---|---|",
          ...matches.map(
            (edge) =>
              `| ${edge.id} | ${edge.from} | ${edge.to} | ${edge.kind} | ${edge.contractPath ?? ""} | ${edge.consumerPath ?? ""} |`,
          ),
        ]
      : [
          graph.edges.length === 0
            ? "No declared edges. Author one with `aih workspace link <path> --from <id> --to <id> --kind <label> --apply`."
            : "No declared edges match the query.",
        ];
  return lines(
    "Declared topology is the source of truth: these cross-repo edges are projected",
    "from `.aih-workspace.json` alone — no tool inference required. The workspace",
    "graph MCP servers are optional enrichment on top of this declared baseline.",
    "",
    `Repos: ${graph.nodes.map((node) => `${node.id} (${node.path}/)`).join(", ") || "none declared"}`,
    "",
    ...(query === undefined
      ? []
      : [
          `Query: ${queryLabel(query)} — ${matches.length} of ${count(
            graph.edges.length,
            "declared edge",
            "declared edges",
          )}`,
          "",
        ]),
    edgeRows,
  );
}

async function workspaceGraphPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const manifest = readWorkspaceManifest(ctx.root, ctx.contextDir);
  if (!manifest) {
    throw new AihError("workspace graph requires .aih-workspace.json", "AIH_WORKSPACE");
  }
  if (manifest.status === "ERROR") {
    throw new AihError(
      `workspace graph requires a valid .aih-workspace.json: ${manifest.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const graph = projectWorkspaceGraph(manifest);
  const query = workspaceGraphQuery(ctx);
  const matches = query === undefined ? graph.edges : filterWorkspaceGraph(graph, query);
  return plan(
    "workspace graph",
    writeJson(
      WORKSPACE_GRAPH_PATH,
      graph,
      "queryable cross-repo graph projected from declared workspace contracts",
    ),
    aihIgnoreWrite(ctx.root),
    digest(describeGraph(graph, query, matches), renderGraphText(graph, query, matches), {
      graph,
      ...(query === undefined ? {} : { query, matches }),
    }),
  );
}

export const workspaceGraphCommand: CommandSpec = {
  name: "graph",
  summary:
    "Project declared cross-repo contract edges into a queryable workspace graph (declared over inferred)",
  options: [
    {
      flags: "--repo <id>",
      description: "show only declared edges touching this repo id (either direction)",
    },
    { flags: "--from <id>", description: "show only declared edges from this repo id" },
    { flags: "--to <id>", description: "show only declared edges to this repo id" },
    { flags: "--kind <kind>", description: "show only declared edges with this contract kind" },
  ],
  plan: workspaceGraphPlan,
};
