import { posix } from "node:path";
import { AihError } from "../errors.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { plan, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { readWorkspaceManifest, type WorkspaceEdge, type WorkspaceRepo } from "./manifest.js";

const KIND_ORDER: Record<string, number> = {
  api: 10,
  backend: 10,
  service: 10,
  worker: 20,
  shared: 30,
  frontend: 40,
  ui: 40,
  infra: 50,
  docs: 60,
};

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace-task";
}

function timestampSlug(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function printableTask(raw: string): string {
  return raw
    .replace(/[\r\n\t|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repoOrder(repo: WorkspaceRepo): number {
  const kind = repo.kind?.toLowerCase();
  if (kind && KIND_ORDER[kind] !== undefined) return KIND_ORDER[kind];
  const id = repo.id.toLowerCase();
  if (id.includes("backend") || id.includes("api")) return 10;
  if (id.includes("worker")) return 20;
  if (id.includes("shared")) return 30;
  if (id.includes("ui") || id.includes("web") || id.includes("front")) return 40;
  if (id.includes("infra")) return 50;
  return 100;
}

function orderedRepos(repos: readonly WorkspaceRepo[]): WorkspaceRepo[] {
  return [...repos].sort((a, b) => repoOrder(a) - repoOrder(b) || a.id.localeCompare(b.id));
}

function affectedContracts(edges: readonly WorkspaceEdge[]): string[] {
  if (edges.length === 0) return ["- _No explicit workspace contract edges declared yet._"];
  return edges.map((edge) => {
    const bits = [
      edge.contractPath ? `contract: ${edge.contractPath}` : undefined,
      edge.consumerPath ? `consumer: ${edge.consumerPath}` : undefined,
    ].filter((v): v is string => v !== undefined);
    return `- ${edge.id} (${edge.from} -> ${edge.to}, ${edge.kind})${bits.length > 0 ? ` - ${bits.join("; ")}` : ""}`;
  });
}

function taskPlanDoc(
  task: string,
  repos: readonly WorkspaceRepo[],
  edges: readonly WorkspaceEdge[],
): string {
  const readOrder = orderedRepos(repos);
  return lines(
    "# Workspace Plan",
    "",
    `Task: ${task}`,
    "",
    "## Repos Touched",
    "",
    ...(repos.length > 0 ? repos.map((repo) => `- ${repo.id}`) : ["- _none declared_"]),
    "",
    "## Read Order",
    "",
    ...(readOrder.length > 0
      ? readOrder.map((repo, i) => `${i + 1}. ${repo.path}/${repo.router}`)
      : ["1. _Add repos to `.aih-workspace.json` first._"]),
    "",
    "## Contracts Affected",
    "",
    affectedContracts(edges),
    "",
    "## Implementation Order",
    "",
    "1. Read the affected child routers.",
    "2. Update explicit contract files first.",
    "3. Implement producer-side changes.",
    "4. Implement consumer-side changes.",
    "5. Update deployment or infrastructure wiring if needed.",
    "",
    "## Test Order",
    "",
    "1. Run producer repo unit and contract tests.",
    "2. Run consumer repo unit and integration tests.",
    "3. Run cross-repo end-to-end verification.",
    "4. Run `aih report --workspace` from the parent workspace.",
    "",
    "## Rollback",
    "",
    ...orderedRepos(repos).map((repo) => `- ${repo.id} commit:`),
  );
}

async function workspaceTaskPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const manifest = readWorkspaceManifest(ctx.root, ctx.contextDir);
  if (!manifest) throw new AihError("workspace plan requires .aih-workspace.json", "AIH_WORKSPACE");
  if (manifest.status === "ERROR") {
    throw new AihError(
      `workspace plan requires a valid .aih-workspace.json: ${manifest.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const taskRaw =
    typeof ctx.options.task === "string" && ctx.options.task.trim().length > 0
      ? ctx.options.task.trim()
      : undefined;
  const task = taskRaw ? printableTask(taskRaw) : undefined;
  if (!task) throw new AihError("workspace plan requires a task description", "AIH_WORKSPACE");
  const file = posix.join(".aih", "workspace-plans", `${timestampSlug()}-${slugify(task)}.md`);
  return plan(
    "workspace plan",
    writeText(
      file,
      taskPlanDoc(task, manifest.repos, manifest.edges),
      `workspace task plan → ${file}`,
    ),
    aihIgnoreWrite(ctx.root),
  );
}

export const taskPlanCommand: CommandSpec = {
  name: "plan",
  summary: "Create a federated multi-repo task plan",
  plan: workspaceTaskPlan,
};
