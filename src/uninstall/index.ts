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
import {
  MANAGED_MCP_PROJECTION_KEYS,
  MANAGED_SETTINGS_PATH,
  type ManagedMcpProjectionResidue,
  managedMcpProjectionOnDisk,
  managedMcpSubtractionAction,
  unprovableResidueReason,
} from "../mcp/managed-projection.js";
import { isExternalMcp } from "../mcp/render.js";

type UninstallDisposition = "backup" | "subtract" | "advisory";

interface UninstallArtifact {
  path: string;
  kind:
    | "context-dir"
    | "marker"
    | "mcp"
    | "cache"
    | "bootloader"
    | "kiro-steering"
    | "kiro-hook"
    | "managed-settings";
  disposition: UninstallDisposition;
  reason: string;
}

interface UninstallSet {
  artifacts: UninstallArtifact[];
  /**
   * Content whose ownership ONLY the marker proves. Uninstall removes that marker,
   * so this must be reconciled — or reported as about to become unattributable —
   * BEFORE the marker goes (issue #567).
   */
  managedMcp?: ManagedMcpProjectionResidue;
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

/** The projected managed-settings path, normalized to the repo-relative POSIX form. */
function managedMcpSettingsPath(): string {
  return cleanRel(MANAGED_SETTINGS_PATH);
}

/** Repo-relative paths this run would remove wholesale (directories included). */
function removedTrees(artifacts: readonly UninstallArtifact[]): string[] {
  return artifacts.filter((a) => a.disposition === "backup").map((a) => cleanRel(a.path));
}

/** True when `path` IS `tree` or lives beneath it — segment-wise, never a substring. */
function isUnderTree(path: string, tree: string): boolean {
  return path === tree || path.startsWith(`${tree}/`);
}

/**
 * The managed-MCP artifact, if any. The projected `.claude/managed-settings.json`
 * is not in the registered per-CLI artifact set, so nothing else here would ever
 * look at it — yet the marker uninstall is about to remove is the ONLY record of
 * which of its keys aih wrote. Exact match → subtract those two keys. Anything
 * else → report what is about to become unattributable, and touch nothing.
 */
function managedMcpArtifact(residue: ManagedMcpProjectionResidue): UninstallArtifact {
  if (residue.matches) {
    return {
      path: residue.path,
      kind: "managed-settings",
      disposition: "subtract",
      reason: `marker-proven aih managed-MCP keys (${MANAGED_MCP_PROJECTION_KEYS.join(", ")}); every other key is preserved`,
    };
  }
  return {
    path: residue.path,
    kind: "managed-settings",
    disposition: "advisory",
    reason: `aih managed-MCP residue becomes unattributable once the marker is removed — ${unprovableResidueReason(residue.unprovable ?? "pair-drifted")}`,
  };
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

  // Marker-proven content comes BEFORE the marker itself, in the artifact list and
  // in the plan: once `.aih-config.json` is gone nothing can attribute these keys
  // again (issue #567). An absent/malformed/revoked/hash-invalid marker yields no
  // residue at all — there was never a provable claim to reconcile.
  //
  // Skipped entirely when the projected file sits INSIDE a tree this run already
  // removes — a repo bootstrapped with `--context-dir .claude` is the real case.
  // Subtracting two keys from a file that is about to be moved wholesale is at best
  // futile and at worst a false promise in the preview ("every other key is
  // preserved" while the whole directory goes to backup).
  const managedMcp = removedTrees(artifacts).some((tree) =>
    isUnderTree(managedMcpSettingsPath(), tree),
  )
    ? undefined
    : managedMcpProjectionOnDisk(ctx.root);
  if (managedMcp !== undefined && managedMcp.unprovable !== "settings-absent") {
    artifacts.push(managedMcpArtifact(managedMcp));
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

  return { artifacts, ...(managedMcp === undefined ? {} : { managedMcp }) };
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
    ...(set.artifacts.some((a) => a.disposition === "subtract")
      ? ["Keys marked [subtract] are removed in place; their file is never deleted."]
      : []),
  );
}

function uninstallPlan(ctx: PlanContext): Plan {
  const set = coreUninstallSet(ctx);
  const actions: Action[] = [];
  // Owned content whose ownership only the marker proves is subtracted FIRST — the
  // established owned-content -> ownership-state -> ledger-last order
  // (`src/ecc/reconcile-driver.ts:485`, `:511`, `:514`). The executor stages this
  // write and the removals below in ONE transaction (writes commit before removals,
  // and a failure rolls both back), so an interrupted uninstall can never leave a
  // removed marker beside unsubtracted content. Clearing the marker's ownership
  // record is unnecessary here: the whole marker is being removed.
  if (set.managedMcp?.matches === true) {
    actions.push(
      managedMcpSubtractionAction(
        set.managedMcp,
        "subtract the aih-owned Claude managed-MCP keys before removing the ownership marker",
      ),
    );
  }
  for (const artifact of set.artifacts) {
    if (artifact.disposition !== "backup") continue;
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
