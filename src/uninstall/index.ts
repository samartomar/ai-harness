import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../bootstrap-ai/canon.js";
import { AIH_CONFIG_FILE, readAihConfig } from "../config/marker.js";
import { bootloadersFor, entry, REGISTRY_IDS } from "../internals/cli-registry.js";
import { readIfExists } from "../internals/fsxn.js";
import { extractManagedBlock } from "../internals/markers.js";
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
import { isExternalMcp } from "../mcp/render.js";

type UninstallDisposition = "backup" | "advisory";

interface UninstallArtifact {
  path: string;
  kind: "context-dir" | "marker" | "mcp" | "cache" | "bootloader" | "kiro-steering" | "kiro-hook";
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

function read(ctx: PlanContext, relPath: string): string | undefined {
  return readIfExists(join(ctx.root, relPath));
}

function canonicalExistingRel(ctx: PlanContext, relPath: string): string | undefined {
  const parts = cleanRel(relPath).split("/");
  const actual: string[] = [];
  let current = ctx.root;
  for (const part of parts) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return undefined;
    }
    const entry =
      entries.find((name) => name === part) ??
      entries.find((name) => name.toLowerCase() === part.toLowerCase());
    if (entry === undefined) return undefined;
    actual.push(entry);
    current = join(current, entry);
  }
  const rel = actual.join("/");
  return exists(ctx, rel) ? rel : undefined;
}

function hasManagedContextEvidence(ctx: PlanContext, contextDir: string): boolean {
  const shared = read(ctx, `${contextDir}/adapters/_shared-canonical-block.md`);
  if (shared?.trim() !== sharedCanonicalBlockBody(contextDir).trim()) return false;
  return (
    read(ctx, `${contextDir}/RULE_ROUTER.md`) !== undefined &&
    read(ctx, `${contextDir}/rules/agent-behavior-core.md`) !== undefined
  );
}

function bootloaderAdvisories(ctx: PlanContext): UninstallArtifact[] {
  return bootloadersFor(REGISTRY_IDS).flatMap((path): UninstallArtifact[] => {
    const text = read(ctx, path);
    if (text === undefined || extractManagedBlock(text, SHARED_MARKER) === undefined) return [];
    return [
      {
        path,
        kind: "bootloader",
        disposition: "advisory",
        reason: "co-owned bootloader still carries an aih managed block",
      },
    ];
  });
}

function repoMcpAdvisories(ctx: PlanContext): UninstallArtifact[] {
  const paths = new Set<string>();
  for (const cli of REGISTRY_IDS) {
    const configPath = entry(cli).mcp.configPath;
    if (configPath === undefined || isExternalMcp(configPath) || !exists(ctx, configPath)) {
      continue;
    }
    paths.add(configPath);
  }
  return [...paths].map((path) => ({
    path,
    kind: "mcp",
    disposition: "advisory",
    reason: "co-owned project MCP config; entries have no on-disk ownership marker",
  }));
}

function kiroHookFiles(ctx: PlanContext): string[] {
  try {
    return readdirSync(join(ctx.root, ".kiro", "hooks"))
      .filter((name) => name.startsWith("aih-") && name.endsWith(".kiro.hook"))
      .sort()
      .map((name) => `.kiro/hooks/${name}`);
  } catch {
    return [];
  }
}

function hasKiroOwnershipEvidence(ctx: PlanContext): boolean {
  const text = read(ctx, ".kiro/steering/00-canon.md");
  return text !== undefined && extractManagedBlock(text, SHARED_MARKER) !== undefined;
}

function kiroExtraArtifacts(ctx: PlanContext, owned: boolean): UninstallArtifact[] {
  const disposition = owned ? "backup" : "advisory";
  const ownership = owned
    ? "with marker-backed Kiro ownership evidence"
    : "found, but no valid Kiro target marker proves ownership";
  const artifacts: UninstallArtifact[] = [];
  if (exists(ctx, ".kiro/steering/agent-tools.md")) {
    artifacts.push({
      path: ".kiro/steering/agent-tools.md",
      kind: "kiro-steering",
      disposition,
      reason: `aih Kiro steering extra ${ownership}`,
    });
  }
  for (const hook of kiroHookFiles(ctx)) {
    artifacts.push({
      path: hook,
      kind: "kiro-hook",
      disposition,
      reason: `aih-namespaced Kiro hook ${ownership}`,
    });
  }
  return artifacts;
}

function coreUninstallSet(ctx: PlanContext): UninstallSet {
  const marker = readAihConfig(ctx.root);
  const markerTargets = new Set((marker?.targets ?? []).map((target) => target.toLowerCase()));
  const markerContextDir = marker ? removableContextDir(marker.contextDir) : undefined;
  const artifacts: UninstallArtifact[] = [];
  let ownsContextDir = false;

  if (markerContextDir !== undefined) {
    const contextDir = canonicalExistingRel(ctx, markerContextDir);
    if (contextDir !== undefined && hasManagedContextEvidence(ctx, contextDir)) {
      ownsContextDir = true;
      artifacts.push({
        path: contextDir,
        kind: "context-dir",
        disposition: "backup",
        reason: "aih-managed canon/context tree with marker-backed ownership evidence",
      });
    } else if (contextDir !== undefined) {
      artifacts.push({
        path: contextDir,
        kind: "context-dir",
        disposition: "advisory",
        reason: "valid marker points here, but generated canon evidence is missing",
      });
    }
  } else {
    const fallbackContextDir = removableContextDir(ctx.contextDir);
    const contextDir =
      fallbackContextDir !== undefined ? canonicalExistingRel(ctx, fallbackContextDir) : undefined;
    if (contextDir !== undefined && hasManagedContextEvidence(ctx, contextDir)) {
      artifacts.push({
        path: contextDir,
        kind: "context-dir",
        disposition: "advisory",
        reason: "aih-looking context tree found, but no valid root install marker proves ownership",
      });
    }
  }

  if (exists(ctx, AIH_CONFIG_FILE)) {
    artifacts.push({
      path: AIH_CONFIG_FILE,
      kind: "marker",
      disposition: "backup",
      reason: "committed aih install marker",
    });
  }
  artifacts.push(...repoMcpAdvisories(ctx));
  artifacts.push(...bootloaderAdvisories(ctx));
  artifacts.push(
    ...kiroExtraArtifacts(ctx, markerTargets.has("kiro") && hasKiroOwnershipEvidence(ctx)),
  );

  if (exists(ctx, ".aih") && ownsContextDir) {
    artifacts.push({
      path: ".aih",
      kind: "cache",
      disposition: "backup",
      reason: "aih cache/output directory with marker-backed ownership evidence",
    });
  } else if (exists(ctx, ".aih")) {
    artifacts.push({
      path: ".aih",
      kind: "cache",
      disposition: "advisory",
      reason:
        "aih-looking cache/output directory found, but no valid root install marker proves ownership",
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
