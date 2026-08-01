import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type ActiveManagedMcpProjectionOwnership,
  AIH_CONFIG_FILE,
  AihConfigSchema,
  isActiveManagedMcpProjectionOwnership,
  type ManagedMcpProjectionOwnership,
  managedMcpProjectionConfigJsonFromRaw,
  managedMcpProjectionOwnership,
  revokedManagedMcpProjectionOwnership,
} from "../config/marker.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists, readRegularFile } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import { type Action, type PlanContext, type WriteAction, writeJson } from "../internals/plan.js";
import type { ManagedMcpAllowlistSettings } from "./allowlist.js";

/**
 * THE ONE managed-MCP projection lifecycle. Every command that records, subtracts,
 * or reports the Claude managed-MCP allowlist shares this module — `aih policy
 * project`, `aih mcp`, `aih prune`, `aih uninstall`, and the doctor probes — so the
 * ownership rules exist in exactly one place (issues #566, #567, #568). It replaces
 * the copies that had grown in `src/org-policy/project.ts` and `src/mcp/index.ts`.
 *
 * The rules are bounded by what the marker actually proves:
 *
 *  - The marker records the exact expected VALUES plus a hash for exactly two keys,
 *    `allowManagedMcpServersOnly` and `allowedMcpServers`, so key-level subtraction
 *    of those two is authorized on an exact match and NOTHING else is.
 *  - FILE DELETION IS NEVER AUTHORIZED. The marker proves two keys, never the file.
 *  - `organizationPolicy` / `sandbox` are never subtracted: no provenance is
 *    recorded, and `sandbox` is co-written by `aih guardrails` and `aih sandbox`.
 *  - A missing, malformed, revoked, or hash-invalid marker — or a live pair that
 *    drifted from the record — is REPORT-ONLY. The claim is revoked; the file is
 *    never mutated.
 *
 * Ordering mirrors the ECC reconciliation driver (`src/ecc/reconcile-driver.ts:485`,
 * `:511`, `:514`): owned content first, ownership state next, ledger last. Clearing
 * the ownership record before the subtraction lands would destroy the only evidence
 * that the residue was ever aih's. Every action here carries an apply-time content
 * pin, and the executor stages them all in ONE filesystem transaction, so an
 * interrupted apply leaves either the old state or the new one — never a cleared
 * marker beside unsubtracted content.
 */

/**
 * The ONLY two keys the ownership marker records provenance for, so the only two
 * aih may ever subtract. `organizationPolicy` / `sandbox` carry no provenance (and
 * `sandbox` is co-written by `aih guardrails` and `aih sandbox`), so they are
 * reported but never removed.
 */
export const MANAGED_MCP_PROJECTION_KEYS = [
  "allowManagedMcpServersOnly",
  "allowedMcpServers",
] as const;

/** The one projected managed-settings path; its owning CLI scopes every probe on it. */
export const MANAGED_SETTINGS_PATH = ".claude/managed-settings.json";

/**
 * Return the Claude managed-MCP fields only when their on-disk pair exactly
 * matches an AIH projection. This excludes same-key operator configuration.
 */
export function matchingGeneratedManagedMcpProjectionKeys(
  value: unknown,
  generated: ManagedMcpAllowlistSettings,
): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const actual = value as Record<string, unknown>;
  if (
    actual.allowManagedMcpServersOnly !== generated.allowManagedMcpServersOnly ||
    JSON.stringify(actual.allowedMcpServers) !== JSON.stringify(generated.allowedMcpServers)
  ) {
    return [];
  }
  return MANAGED_MCP_PROJECTION_KEYS;
}

export function matchesManagedMcpProjectionOwnership(
  value: unknown,
  ownership: ManagedMcpProjectionOwnership | undefined,
): ownership is ManagedMcpProjectionOwnership {
  return (
    isActiveManagedMcpProjectionOwnership(ownership) &&
    matchingGeneratedManagedMcpProjectionKeys(value, ownership.expected).length > 0
  );
}

/** Why aih cannot prove it owns what is on disk — the escalation reason an agent reads. */
export type UnprovableReason =
  | "no-ownership-record"
  | "not-a-regular-file"
  | "settings-absent"
  | "pair-drifted";

export interface ManagedMcpProjectionResidue {
  /** Repo-relative path of the projected managed settings. */
  path: string;
  /** The recorded, still-active ownership claim (an inactive claim never reaches here). */
  ownership: ActiveManagedMcpProjectionOwnership;
  /** True only when the live pair EXACTLY matches the recorded projection. */
  matches: boolean;
  /** Why `matches` is false — `undefined` when it is true. */
  unprovable: Exclude<UnprovableReason, "no-ownership-record"> | undefined;
  /** Marker bytes observed while planning (the apply-time pin for marker writes). */
  markerSource: string | undefined;
  /** Managed-settings bytes observed while planning (the apply-time pin for the subtraction). */
  settingsSource: string | undefined;
}

/** Human-readable escalation reason for a residue aih must not touch. */
export function unprovableResidueReason(reason: UnprovableReason): string {
  switch (reason) {
    case "no-ownership-record":
      return `${AIH_CONFIG_FILE} records no active managed-MCP ownership (absent, malformed, revoked, or hash-invalid), so no aih command can prove which keys aih wrote`;
    case "not-a-regular-file":
      return "the path is not a readable regular file (symlink or directory), and aih never edits through one";
    case "settings-absent":
      return "the projected file is no longer on disk, so there is nothing to subtract";
    case "pair-drifted":
      return "the live managed-MCP pair no longer matches the recorded projection, so it is operator-owned now";
  }
}

/** Repo-relative POSIX path → absolute path under `root`. */
function absolute(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

/**
 * NO-FOLLOW presence: does anything at all occupy this path? `lstat`, never
 * `existsSync` (which follows links, so a DANGLING symlink would read as absent and
 * the stale ownership claim would survive untouched) and never a content read (which
 * throws EISDIR on a directory).
 */
function occupied(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The projected managed-settings bytes, or `undefined` when the path is anything
 * other than a readable regular file. Callers that need the on-disk content for an
 * apply-time pin must use THIS, not `readIfExists`: a directory planted at the path
 * makes a plain content read throw EISDIR and take the whole command down.
 */
export function readManagedSettings(
  root: string,
  settingsRel: string = MANAGED_SETTINGS_PATH,
): string | undefined {
  return readRegularFile(absolute(root, settingsRel))?.toString("utf8");
}

/**
 * The on-disk managed-MCP ownership state, or `undefined` when the marker records no
 * ACTIVE claim (absent / malformed / revoked / hash-invalid) — the case where aih has
 * nothing to reconcile and must not touch the file.
 *
 * The settings read is a no-follow, regular-file read ({@link readRegularFile}), not
 * a plain `readIfExists`: a symlink substituted for the projected path is refused
 * rather than followed, so a subtraction can never be redirected onto a file the
 * ownership claim does not cover.
 */
export function managedMcpProjectionOnDisk(
  root: string,
  settingsRel: string = MANAGED_SETTINGS_PATH,
): ManagedMcpProjectionResidue | undefined {
  const markerSource = readIfExists(join(root, AIH_CONFIG_FILE));
  let ownership: ManagedMcpProjectionOwnership | undefined;
  try {
    ownership =
      markerSource === undefined
        ? undefined
        : AihConfigSchema.parse(JSON.parse(markerSource)).managedMcpProjection;
  } catch {
    return undefined;
  }
  if (!isActiveManagedMcpProjectionOwnership(ownership)) return undefined;
  const base = { path: settingsRel, ownership, markerSource };
  const abs = absolute(root, settingsRel);
  const settingsSource = readRegularFile(abs)?.toString("utf8");
  if (settingsSource === undefined) {
    // PRESENCE only, and NO-FOLLOW. A content read would throw EISDIR on a directory
    // planted here, taking down the whole command before it could report the residue
    // it exists to report; `existsSync` would call a dangling symlink absent and
    // silently leave the stale ownership claim standing.
    return {
      ...base,
      matches: false,
      unprovable: occupied(abs) ? "not-a-regular-file" : "settings-absent",
      settingsSource: undefined,
    };
  }
  let matches = false;
  try {
    matches = matchesManagedMcpProjectionOwnership(parseJsoncText(settingsSource), ownership);
  } catch {
    matches = false;
  }
  return { ...base, matches, unprovable: matches ? undefined : "pair-drifted", settingsSource };
}

/** Bind a write to the exact bytes observed while planning (apply-time content pin). */
export function withExpectedContents(
  action: WriteAction,
  contents: string | undefined,
): WriteAction {
  return {
    ...action,
    expect:
      contents === undefined
        ? { absent: true }
        : { sha256: createHash("sha256").update(contents, "utf8").digest("hex") },
  };
}

/**
 * Subtract ONLY the two marker-proven keys, in place. Never a delete: every other
 * key in the file — operator content, `organizationPolicy`, `sandbox` — is
 * merge-preserved byte-for-byte.
 */
export function managedMcpSubtractionAction(
  residue: ManagedMcpProjectionResidue,
  describe = "subtract the aih-owned Claude managed-MCP allowlist keys",
): WriteAction {
  return withExpectedContents(
    writeJson(residue.path, {}, describe, {
      merge: true,
      removeJsonTopLevelKeys: [...MANAGED_MCP_PROJECTION_KEYS],
    }),
    residue.settingsSource,
  );
}

/** Record ownership of a freshly projected managed-MCP pair. */
export function managedMcpProjectionOwnershipAction(
  ctx: PlanContext,
  targets: readonly Cli[] | readonly string[],
  generated: ManagedMcpAllowlistSettings,
): Action {
  const source = readIfExists(join(ctx.root, AIH_CONFIG_FILE));
  return withExpectedContents(
    writeJson(
      AIH_CONFIG_FILE,
      managedMcpProjectionConfigJsonFromRaw(
        source,
        ctx.contextDir,
        [...targets],
        managedMcpProjectionOwnership(generated),
      ),
      "record Claude managed-MCP projection ownership",
      { merge: true },
    ),
    source,
  );
}

/** Drop the ownership record after its content was successfully subtracted. */
export function clearManagedMcpProjectionOwnershipAction(source: string | undefined): Action {
  return withExpectedContents(
    writeJson(AIH_CONFIG_FILE, {}, "clear Claude managed-MCP projection ownership", {
      merge: true,
      removeJsonTopLevelKeys: ["managedMcpProjection"],
    }),
    source,
  );
}

/** Give up the claim on content aih can no longer prove it wrote, without touching it. */
export function revokeManagedMcpProjectionOwnershipAction(
  ownership: ManagedMcpProjectionOwnership,
  source: string | undefined,
): Action {
  return withExpectedContents(
    writeJson(
      AIH_CONFIG_FILE,
      { managedMcpProjection: revokedManagedMcpProjectionOwnership(ownership) },
      "revoke Claude managed-MCP projection ownership after operator change",
      { merge: true },
    ),
    source,
  );
}

/**
 * The ordered deactivation pair: owned-content subtraction FIRST, ownership state
 * SECOND. An unprovable residue yields the revoke alone — the file is left exactly
 * as the operator left it.
 */
export function managedMcpDeactivationActions(
  residue: ManagedMcpProjectionResidue,
  describe?: string,
): Action[] {
  return residue.matches
    ? [
        managedMcpSubtractionAction(residue, describe),
        clearManagedMcpProjectionOwnershipAction(residue.markerSource),
      ]
    : [revokeManagedMcpProjectionOwnershipAction(residue.ownership, residue.markerSource)];
}
