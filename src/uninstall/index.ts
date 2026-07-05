import { existsSync } from "node:fs";
import { join } from "node:path";
import { AIH_CONFIG_FILE, readAihConfig } from "../config/marker.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  remove,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";

type UninstallDisposition = "backup" | "advisory";

interface UninstallArtifact {
  path: string;
  kind: "context-dir" | "marker" | "mcp" | "cache";
  disposition: UninstallDisposition;
  reason: string;
}

interface UninstallSet {
  artifacts: UninstallArtifact[];
}

function cleanRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function removableContextDir(path: string): string | undefined {
  const rel = cleanRel(path);
  const parts = rel.split("/");
  if (
    rel.length === 0 ||
    rel === "." ||
    rel.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return undefined;
  }
  return rel;
}

function exists(ctx: PlanContext, relPath: string): boolean {
  return existsSync(join(ctx.root, relPath));
}

function coreUninstallSet(ctx: PlanContext): UninstallSet {
  const marker = readAihConfig(ctx.root);
  const contextDir = removableContextDir(marker?.contextDir ?? ctx.contextDir);
  const artifacts: UninstallArtifact[] = [];

  if (contextDir !== undefined && exists(ctx, contextDir)) {
    artifacts.push({
      path: contextDir,
      kind: "context-dir",
      disposition: "backup",
      reason: "aih-managed canon/context tree",
    });
  }
  if (exists(ctx, AIH_CONFIG_FILE)) {
    artifacts.push({
      path: AIH_CONFIG_FILE,
      kind: "marker",
      disposition: "backup",
      reason: "committed aih install marker",
    });
  }
  if (exists(ctx, ".mcp.json")) {
    artifacts.push({
      path: ".mcp.json",
      kind: "mcp",
      disposition: "advisory",
      reason: "co-owned project MCP config; entries have no on-disk ownership marker",
    });
  }
  if (exists(ctx, ".aih")) {
    artifacts.push({
      path: ".aih",
      kind: "cache",
      disposition: "backup",
      reason: "aih cache/output directory",
    });
  }

  return { artifacts };
}

function body(set: UninstallSet): string {
  if (set.artifacts.length === 0) {
    return "No aih core install footprint found.";
  }
  const owned = set.artifacts.filter((a) => a.disposition !== "advisory");
  const advisory = set.artifacts.filter((a) => a.disposition === "advisory");
  return lines(
    "Core install footprint preview:",
    ...owned.map((a) => `  [${a.disposition}] ${a.path} - ${a.reason}`),
    ...(advisory.length > 0
      ? [
          "",
          "Manual review - co-owned files are never auto-removed:",
          ...advisory.map((a) => `  [advisory] ${a.path} - ${a.reason}`),
        ]
      : []),
    "",
    "Dry-run by default; pass --apply to move owned paths to reversible *.aih.bak backups.",
  );
}

function uninstallPlan(ctx: PlanContext): Plan {
  const set = coreUninstallSet(ctx);
  const actions: Action[] = [];
  for (const artifact of set.artifacts) {
    if (artifact.disposition === "advisory") continue;
    actions.push(remove(artifact.path, artifact.reason, { hardDelete: true }));
  }
  actions.push(digest("core install footprint", body(set), set));
  return plan("uninstall", ...actions);
}

export const command: CommandSpec = {
  name: "uninstall",
  aliases: ["clean"],
  summary: "Remove the core aih install footprint from this repo (dry-run by default)",
  plan: uninstallPlan,
};
