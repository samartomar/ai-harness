import { posix } from "node:path";
import { AihError } from "../errors.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { plan, writeJson } from "../internals/plan.js";
import { readWorkspaceManifest } from "./manifest.js";
import { collectWorkspaceSnapshot } from "./state.js";

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

function timestampSlug(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

async function workspaceSnapshotPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const manifest = readWorkspaceManifest(ctx.root, ctx.contextDir);
  if (!manifest) {
    throw new AihError("workspace snapshot requires .aih-workspace.json", "AIH_WORKSPACE");
  }
  if (manifest.status === "ERROR") {
    throw new AihError(
      `workspace snapshot requires a valid .aih-workspace.json: ${manifest.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const label = typeof ctx.options.label === "string" ? ctx.options.label.trim() : "";
  const snapshot = await collectWorkspaceSnapshot(ctx, manifest, {
    ...(label.length > 0 ? { label } : {}),
  });
  const suffix = label.length > 0 ? `-${slugify(label)}` : "";
  const localPath = posix.join(".aih", "workspace-snapshots", `${timestampSlug()}${suffix}.json`);
  const actions = [
    writeJson(
      localPath,
      snapshot,
      `workspace child repo snapshot → ${localPath.replace(/\\/g, "/")}`,
    ),
    aihIgnoreWrite(ctx.root),
  ];
  if (ctx.options.lock === true) {
    actions.push(
      writeJson(
        posix.join(manifest.contextDir, "workspace-lock.json"),
        snapshot,
        "shared known-good workspace lock",
      ),
    );
  }
  return plan("workspace snapshot", ...actions);
}

export const snapshotCommand: CommandSpec = {
  name: "snapshot",
  summary: "Record the current child repo branch/SHA set for a federated workspace",
  options: [
    { flags: "--label <label>", description: "human label for the snapshot filename/body" },
    {
      flags: "--lock",
      description: "also write the shared known-good lock under the workspace context dir",
    },
  ],
  plan: workspaceSnapshotPlan,
};
