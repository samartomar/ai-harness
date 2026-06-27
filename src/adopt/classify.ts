import { existsSync } from "node:fs";
import { join } from "node:path";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../bootstrap-ai/canon.js";
import { readAihConfig } from "../config/marker.js";
import { readIfExists } from "../internals/fsxn.js";
import { extractManagedBlock } from "../internals/markers.js";

/**
 * Read-only classification of a repo's existing AI canon — the heart of
 * `aih adopt`. It answers ONE question without writing anything: is this repo
 * greenfield (use `init`), already on aih's managed model (no-op), or a
 * BROWNFIELD canon that predates aih and must be *adopted* rather than
 * overwritten? The two brownfield shapes were found in real reference repos:
 *
 *  - `marker-divergent` (eicp): the bootloader already carries an
 *    `ai-canonical:shared` block (eicp is where the marker convention comes from)
 *    but the body differs — typically a folded-in project extension a blind
 *    `bootstrap-ai --apply` would destroy.
 *  - `foreign-scheme` (syntegris): equivalent canon (a RULE_ROUTER, a hand-rolled
 *    regenerate script, a migration doc) under a DIFFERENT shape, with no aih
 *    marker in the bootloader at all.
 *
 * Everything here uses {@link readIfExists}/{@link existsSync} — no mutation, so
 * it is safe to run on any path and from `doctor` as an advisory.
 */

/**
 * Root bootloaders that can carry the `ai-canonical:shared` managed block. Cursor
 * (`.cursor/rules/*.mdc`), Windsurf (`.windsurfrules`), and Copilot
 * (`.github/copilot-instructions.md`) use other formats, so the managed-block —
 * and therefore adopt's reconcile path — only applies to these markdown files.
 */
export const MARKER_BOOTLOADERS = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] as const;

/**
 * Prior-art artifacts a hand-rolled canon ships, superseded by aih's generator.
 * Paths are relative to the context dir. Detected so `adopt` can offer to retire
 * them (Phase 2+); in Phase 1 they are reported as a signal only.
 */
const LEGACY_ARTIFACTS = [
  "scripts/regenerate-adapters.ps1",
  "scripts/regenerate-adapters.sh",
  "scripts/archive-legacy-tool-rules.ps1",
  "scripts/archive-legacy-tool-rules.sh",
  "RULE_BOOTLOADER_MIGRATION.md",
] as const;

export type CanonClass =
  /** No canon worth adopting — `aih init` / `bootstrap-ai` create path applies. */
  | "greenfield"
  /** aih marker present and body matches the current canonical block — re-run is a no-op. */
  | "already-adopted"
  /** Shares `ai-canonical:shared` but the body diverges (eicp) — reconcile, don't overwrite. */
  | "marker-divergent"
  /** Equivalent canon under a foreign shape, no aih marker (syntegris) — import + insert. */
  | "foreign-scheme";

/** Per-bootloader state used to decide the class and, later, the reconcile plan. */
export interface BootloaderState {
  /** Repo-relative path, e.g. `CLAUDE.md`. */
  path: string;
  /** Carries an `ai-canonical:shared` managed block. */
  hasMarker: boolean;
  /** The managed block body equals the current canonical body (no drift). */
  bodyMatches: boolean;
  /**
   * Diff-inferred count of on-disk block lines absent from the canonical body —
   * an estimate of the human "project extension" a reconcile must preserve.
   * Zero unless `hasMarker && !bodyMatches`.
   */
  preservedLines: number;
}

export interface CanonClassification {
  kind: CanonClass;
  /** `<contextDir>/RULE_ROUTER.md` exists. */
  routerPresent: boolean;
  /** `<contextDir>/adapters/_shared-canonical-block.md` exists. */
  sharedBlockSourcePresent: boolean;
  /** A committed `.aih-config.json` marker exists (the repo was bootstrapped by aih). */
  configPresent: boolean;
  /** State for each marker-capable bootloader present on disk. */
  bootloaders: BootloaderState[];
  /** Repo-relative paths of detected prior-art artifacts (under the context dir). */
  legacyArtifacts: string[];
}

/** Trimmed, non-empty lines of a block body — the unit the extension diff works on. */
function bodyLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Classify the canon under `root`/`contextDir`. Pure and read-only. The context
 * dir should be the committed one when present (callers pass
 * `readAihConfig(root)?.contextDir ?? ctx.contextDir`, mirroring `doctor`).
 */
export function classifyCanon(root: string, contextDir: string): CanonClassification {
  const canonicalBody = sharedCanonicalBlockBody(contextDir).trim();
  const canonicalSet = new Set(bodyLines(canonicalBody));

  const bootloaders: BootloaderState[] = [];
  for (const path of MARKER_BOOTLOADERS) {
    const text = readIfExists(join(root, path));
    if (text === undefined) continue;
    const block = extractManagedBlock(text, SHARED_MARKER);
    const hasMarker = block !== undefined;
    const bodyMatches = hasMarker && block === canonicalBody;
    const preservedLines =
      hasMarker && !bodyMatches
        ? bodyLines(block ?? "").filter((l) => !canonicalSet.has(l)).length
        : 0;
    bootloaders.push({ path, hasMarker, bodyMatches, preservedLines });
  }

  const routerPresent = existsSync(join(root, contextDir, "RULE_ROUTER.md"));
  const sharedBlockSourcePresent = existsSync(
    join(root, contextDir, "adapters", "_shared-canonical-block.md"),
  );
  const configPresent = readAihConfig(root) !== undefined;
  const legacyArtifacts = LEGACY_ARTIFACTS.filter((rel) =>
    existsSync(join(root, contextDir, rel)),
  ).map((rel) => `${contextDir}/${rel}`);

  const markered = bootloaders.filter((b) => b.hasMarker);
  const hasAnyCanonShape =
    routerPresent || sharedBlockSourcePresent || legacyArtifacts.length > 0 || markered.length > 0;

  let kind: CanonClass;
  if (!hasAnyCanonShape) {
    kind = "greenfield";
  } else if (markered.length > 0) {
    kind = markered.every((b) => b.bodyMatches) ? "already-adopted" : "marker-divergent";
  } else {
    // Canon shape exists (router / legacy script / shared-block source) but no
    // bootloader carries the aih marker — a foreign scheme to import.
    kind = "foreign-scheme";
  }

  return {
    kind,
    routerPresent,
    sharedBlockSourcePresent,
    configPresent,
    bootloaders,
    legacyArtifacts,
  };
}

/** True for the two brownfield shapes that warrant `aih adopt` (not init, not no-op). */
export function isAdoptable(kind: CanonClass): boolean {
  return kind === "marker-divergent" || kind === "foreign-scheme";
}
