import { posix } from "node:path";
import { AihError } from "../errors.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { plan, probe, writeJson, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  assertWorkspacePrintable,
  normalizeWorkspacePath,
  parseWorkspaceManifest,
  readWorkspaceManifest,
  type WorkspaceEdge,
  type WorkspaceManifest,
  type WorkspaceRepo,
  workspaceReposFromPaths,
} from "./manifest.js";
import { workspaceContractsDoc, workspaceRouterDoc } from "./templates.js";

function optionString(ctx: PlanContext, name: string): string | undefined {
  const value = ctx.options[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safePrintableOption(ctx: PlanContext, name: string, label: string): string | undefined {
  const value = optionString(ctx, name);
  if (value === undefined) return undefined;
  assertWorkspacePrintable(value, label);
  return value;
}

function defaultManifest(ctx: PlanContext): Record<string, unknown> {
  return {
    workspaceType: "multi-repo",
    graphScope: "combined-child-repos",
    contextDir: ctx.contextDir,
    repos: [],
    generatedBy: "aih workspace",
  };
}

function existingManifest(ctx: PlanContext): WorkspaceManifest | undefined {
  const manifest = readWorkspaceManifest(ctx.root, ctx.contextDir);
  if (manifest?.status === "ERROR") {
    throw new AihError(
      `workspace link requires a valid .aih-workspace.json: ${manifest.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  return manifest;
}

function repoFromRaw(entry: unknown, contextDir: string): WorkspaceRepo | undefined {
  const parsed = parseWorkspaceManifest({ contextDir, repos: [entry] }, contextDir);
  return parsed.status === "OK" ? parsed.repos[0] : undefined;
}

function repoIdFromPath(path: string, router: string): string {
  return workspaceReposFromPaths([path], router)[0]?.id ?? "repo";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LinkRepoInput {
  id?: string;
  path: string;
  kind?: string;
  owner?: string;
  router: string;
  hasMetadata: boolean;
}

function repoEntry(input: LinkRepoInput, existing: unknown): unknown {
  if (!input.hasMetadata && existing !== undefined) return existing;
  if (!input.hasMetadata) return input.path;
  const base = isObjectRecord(existing) ? { ...existing } : {};
  return {
    ...base,
    id:
      input.id ??
      (typeof base.id === "string" ? base.id : repoIdFromPath(input.path, input.router)),
    path: input.path,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    router: optionOrExistingRouter(input.router, base.router),
  };
}

function optionOrExistingRouter(router: string, existing: unknown): string {
  return typeof existing === "string" && existing.trim().length > 0 ? existing : router;
}

function upsertRepo(rawRepos: unknown[], contextDir: string, input: LinkRepoInput): unknown[] {
  let replaced = false;
  const next = rawRepos.map((entry) => {
    const repo = repoFromRaw(entry, contextDir);
    if (repo === undefined || (repo.path !== input.path && repo.id !== input.id)) return entry;
    replaced = true;
    return repoEntry(input, entry);
  });
  return replaced ? next : [...next, repoEntry(input, undefined)];
}

function edgeRequested(ctx: PlanContext): boolean {
  return ["from", "to", "kind", "contract", "consumer"].some((name) => optionString(ctx, name));
}

function edgeId(edge: Pick<WorkspaceEdge, "from" | "to" | "kind">): string {
  const slug = `${edge.from}-${edge.to}-${edge.kind}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace-edge";
}

function edgeInput(ctx: PlanContext): WorkspaceEdge | undefined {
  if (!edgeRequested(ctx)) return undefined;
  const from = optionString(ctx, "from");
  const to = optionString(ctx, "to");
  const kind = safePrintableOption(ctx, "kind", "workspace edge kind");
  if (from === undefined || to === undefined || kind === undefined) {
    throw new AihError(
      "workspace link edge creation requires --from <repo-id>, --to <repo-id>, and --kind <label>",
      "AIH_WORKSPACE",
    );
  }
  return {
    id: edgeId({ from, to, kind }),
    from,
    to,
    kind,
    ...(optionString(ctx, "contract")
      ? {
          contractPath: normalizeWorkspacePath(
            optionString(ctx, "contract") ?? "",
            "workspace edge contractPath",
          ),
        }
      : {}),
    ...(optionString(ctx, "consumer")
      ? {
          consumerPath: normalizeWorkspacePath(
            optionString(ctx, "consumer") ?? "",
            "workspace edge consumerPath",
          ),
        }
      : {}),
  };
}

function upsertEdge(rawEdges: unknown[], edge: WorkspaceEdge | undefined): unknown[] {
  if (edge === undefined) return rawEdges;
  let replaced = false;
  const next = rawEdges.map((entry) => {
    if (!isObjectRecord(entry) || entry.id !== edge.id) return entry;
    replaced = true;
    return { ...entry, ...edge };
  });
  return replaced ? next : [...next, edge];
}

function missingRepoIds(manifest: WorkspaceManifest): string[] {
  const ids = new Set(manifest.repos.map((repo) => repo.id));
  return [
    ...new Set(manifest.edges.flatMap((edge) => [edge.from, edge.to]).filter((id) => !ids.has(id))),
  ];
}

function missingRepoProbe(missing: readonly string[]): ReturnType<typeof probe> {
  return probe(
    "workspace link edge repo IDs",
    (): Check => ({
      name: "workspace-link-edge-repos",
      verdict: "fail",
      detail: `edge references undeclared repo id${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      location: { uri: ".aih-workspace.json", startLine: 1 },
    }),
  );
}

async function workspaceLinkPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const rawPath = optionString(ctx, "path");
  if (rawPath === undefined) {
    throw new AihError("workspace link requires a child repo path", "AIH_WORKSPACE");
  }
  const manifest = existingManifest(ctx);
  const raw = { ...(manifest?.raw ?? defaultManifest(ctx)) };
  const contextDir =
    typeof raw.contextDir === "string" && raw.contextDir.trim().length > 0
      ? normalizeWorkspacePath(raw.contextDir, "workspace contextDir")
      : ctx.contextDir;
  raw.contextDir = contextDir;

  const path = normalizeWorkspacePath(rawPath, "workspace repo path");
  const router = optionString(ctx, "router")
    ? normalizeWorkspacePath(optionString(ctx, "router") ?? "", "workspace repo router")
    : posix.join(contextDir, "RULE_ROUTER.md");
  const repo: LinkRepoInput = {
    path,
    router,
    id: optionString(ctx, "id"),
    kind: safePrintableOption(ctx, "repoKind", "workspace repo kind"),
    owner: safePrintableOption(ctx, "owner", "workspace repo owner"),
    hasMetadata:
      optionString(ctx, "id") !== undefined ||
      optionString(ctx, "repoKind") !== undefined ||
      optionString(ctx, "router") !== undefined ||
      optionString(ctx, "owner") !== undefined,
  };
  raw.repos = upsertRepo(Array.isArray(raw.repos) ? raw.repos : [], contextDir, repo);
  raw.edges = upsertEdge(Array.isArray(raw.edges) ? raw.edges : [], edgeInput(ctx));
  raw.generatedBy = typeof raw.generatedBy === "string" ? raw.generatedBy : "aih workspace";

  const parsed = parseWorkspaceManifest(raw, contextDir);
  if (parsed.status === "ERROR") {
    throw new AihError(
      `workspace link produced an invalid .aih-workspace.json: ${parsed.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const missing = missingRepoIds(parsed);
  if (missing.length > 0) return plan("workspace link", missingRepoProbe(missing));

  return plan(
    "workspace link",
    writeJson(".aih-workspace.json", raw, `workspace link manifest (${path})`),
    writeText(
      posix.join(parsed.contextDir, "workspace-router.md"),
      workspaceRouterDoc(parsed.repos),
      "workspace router (federated child repo table of contents)",
    ),
    writeText(
      posix.join(parsed.contextDir, "workspace-contracts.md"),
      workspaceContractsDoc(parsed.edges),
      "workspace contracts (parent-owned cross-repo dependency index)",
    ),
  );
}

export const workspaceLinkCommand: CommandSpec = {
  name: "link",
  summary: "Register a child repo and optional cross-repo contract edge in the workspace manifest",
  alwaysVerify: true,
  options: [
    { flags: "--id <id>", description: "stable child repo id (defaults from path)" },
    { flags: "--repo-kind <kind>", description: "child repo role label, e.g. frontend or api" },
    { flags: "--router <path>", description: "child router path relative to the child repo" },
    { flags: "--owner <team>", description: "team or owner accountable for the child repo" },
    { flags: "--from <id>", description: "edge producer/source repo id" },
    { flags: "--to <id>", description: "edge consumer/target repo id" },
    { flags: "--kind <kind>", description: "edge contract kind, e.g. api-contract" },
    { flags: "--contract <path>", description: "parent-relative contract evidence file" },
    { flags: "--consumer <path>", description: "parent-relative consumer evidence path" },
  ],
  plan: workspaceLinkPlan,
};
