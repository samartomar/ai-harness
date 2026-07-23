import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "../../../internals/fsxn.js";
import { extractManagedBlock, stripManagedBlock } from "../../../internals/markers.js";
import { parseJsoncText } from "../../../internals/merge.js";
import { type Action, remove, writeJson, writeText } from "../../../internals/plan.js";
import type { BindingLock, BindingOwnershipEntry } from "../../lock.js";
import { deepSet } from "./managed-writes.js";
import {
  CLAUDE_MCP_KEY,
  CLAUDE_MCP_PATH,
  CLAUDE_OWNED_FILE_ROOTS,
  canonicalJson,
  jsonEqual,
  parseJsonPointer,
  sha256Hex,
  valueAtPointer,
} from "./surfaces.js";

/**
 * Conservative D18 removal for the Claude project-scope host. For each owned entry
 * in the lock it re-reads the CURRENT state and decides:
 *  - the slot still equals the applied value  → schedule a targeted removal
 *    (restore the pre-existing value, or prune the AIH-added key / strip the fence
 *    / delete the file);
 *  - the slot drifted (user-modified)          → PRESERVE it and report the drift;
 *  - the slot is already gone                   → no-op (idempotent).
 *
 * Unrelated content is untouched by construction: shared JSON files are merge-
 * written with targeted key prunes/restores (a whole shared JSON file is NEVER
 * replaced), and the CLAUDE.md fence is stripped in place. Plan/apply stay separate
 * (D14) — this returns Actions; the caller runs `executePlan`.
 */

/** A drifted owned entry: preserved, never silently deleted, and reported. */
export interface ClaudeDriftEntry {
  kind: BindingOwnershipEntry["kind"];
  target: string;
  reason: string;
}

export interface ClaudeRemovalPlan {
  actions: Action[];
  drift: ClaudeDriftEntry[];
}

interface JsonRemovalAccumulator {
  json: Record<string, unknown>;
  replaceKeys: Set<string>;
  replaceChildKeys: Map<string, Set<string>>;
  removeTopLevel: Set<string>;
  removeChild: Map<string, Set<string>>;
}

function newAccumulator(): JsonRemovalAccumulator {
  return {
    json: {},
    replaceKeys: new Set(),
    replaceChildKeys: new Map(),
    removeTopLevel: new Set(),
    removeChild: new Map(),
  };
}

/** Route a lock entry back to its file + JSON pointer (json-pointer / mcp-server). */
function jsonRoute(entry: BindingOwnershipEntry): { file: string; pointer: string[] } {
  if (entry.kind === "mcp-server") {
    return { file: CLAUDE_MCP_PATH, pointer: [CLAUDE_MCP_KEY, entry.target] };
  }
  const hash = entry.target.indexOf("#");
  if (hash < 0) {
    return { file: entry.target, pointer: [] };
  }
  return {
    file: entry.target.slice(0, hash),
    pointer: parseJsonPointer(entry.target.slice(hash + 1)),
  };
}

/** A `file`-kind entry is a CLAUDE.md fence when its target carries the block convention. */
function blockRoute(target: string): { file: string; marker: string } | undefined {
  const sep = target.indexOf("#block:");
  if (sep < 0) return undefined;
  return { file: target.slice(0, sep), marker: target.slice(sep + "#block:".length) };
}

/**
 * The read-only classification of ONE owned entry — what conservative removal will
 * do with it. Both {@link readClaudeSettingsDrift} (drift half) and
 * {@link planClaudeRemoval} (action half) consume this SAME classification, so they
 * can never disagree about which entries drifted (W7 §B.7).
 */
type OwnershipDisposition =
  | { kind: "drift"; drift: ClaudeDriftEntry }
  /** Already gone / no owned value to reconcile — idempotent no-op. */
  | { kind: "noop" }
  /** Reconcile a JSON pointer / MCP server slot by restoring or pruning it. */
  | {
      kind: "json-remove";
      file: string;
      parent: string;
      child: string;
      single: boolean;
      preExisting: BindingOwnershipEntry["preExisting"];
    }
  /** Strip an AIH-managed CLAUDE.md fence. */
  | { kind: "block-strip"; file: string; marker: string; raw: string }
  /** Restore a file's pre-existing content. */
  | { kind: "file-restore"; target: string; contents: string }
  /** Remove an AIH-created file that had no pre-existing content. */
  | { kind: "file-remove"; target: string };

/** Classify a JSON-pointer / MCP-server entry (pure read; drift is PRESERVED, never deleted). */
function classifyJsonEntry(root: string, entry: BindingOwnershipEntry): OwnershipDisposition {
  const { file, pointer } = jsonRoute(entry);
  if (pointer.length === 0) {
    // A json-pointer entry whose target carries no pointer is a malformed lock
    // record — conservative removal PRESERVES and reports it, never guesses.
    return {
      kind: "drift",
      drift: {
        kind: entry.kind,
        target: entry.target,
        reason: "malformed lock target (no JSON pointer) — preserved",
      },
    };
  }
  const raw = readIfExists(join(root, file));
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : parseJsoncText(raw);
  } catch {
    return {
      kind: "drift",
      drift: { kind: entry.kind, target: entry.target, reason: "file is not parseable JSON" },
    };
  }
  const found = valueAtPointer(parsed, pointer);
  if (!found.present) return { kind: "noop" }; // already gone — idempotent no-op
  if (!jsonEqual(found.value, entry.applied)) {
    return {
      kind: "drift",
      drift: { kind: entry.kind, target: entry.target, reason: "owned value modified since bind" },
    };
  }
  return {
    kind: "json-remove",
    file,
    parent: pointer[0] ?? "",
    child: pointer[1] ?? "",
    single: pointer.length === 1,
    preExisting: entry.preExisting,
  };
}

/** Classify a CLAUDE.md managed-block entry (pure read). */
function classifyBlockEntry(
  root: string,
  entry: BindingOwnershipEntry,
  block: { file: string; marker: string },
): OwnershipDisposition {
  const raw = readIfExists(join(root, block.file));
  const body = raw === undefined ? undefined : extractManagedBlock(raw, block.marker);
  if (raw === undefined || body === undefined) return { kind: "noop" }; // fence already gone
  if (sha256Hex(body) !== entry.postApplyDigest) {
    return {
      kind: "drift",
      drift: { kind: entry.kind, target: entry.target, reason: "managed block edited since bind" },
    };
  }
  return { kind: "block-strip", file: block.file, marker: block.marker, raw };
}

/** Classify a whole-file entry (pure read). */
function classifyFileEntry(root: string, entry: BindingOwnershipEntry): OwnershipDisposition {
  const current = readIfExists(join(root, entry.target));
  if (current === undefined) return { kind: "noop" }; // already gone
  if (sha256Hex(current) !== entry.postApplyDigest) {
    return {
      kind: "drift",
      drift: { kind: entry.kind, target: entry.target, reason: "owned file modified since bind" },
    };
  }
  const pre = entry.preExisting;
  if ("value" in pre) {
    const contents = typeof pre.value === "string" ? pre.value : canonicalJson(pre.value);
    return { kind: "file-restore", target: entry.target, contents };
  }
  return { kind: "file-remove", target: entry.target };
}

/** Route one owned entry to its per-kind classifier (json / block / file). */
function classifyOwnershipEntry(root: string, entry: BindingOwnershipEntry): OwnershipDisposition {
  if (entry.kind === "json-pointer" || entry.kind === "mcp-server") {
    return classifyJsonEntry(root, entry);
  }
  const block = blockRoute(entry.target);
  if (block !== undefined) return classifyBlockEntry(root, entry, block);
  return classifyFileEntry(root, entry);
}

/**
 * The pure, READ-ONLY D18 settings-drift half of {@link planClaudeRemoval} (W7
 * §B.7). Returns the owned entries whose live value diverged from the applied
 * value since bind — the ones conservative removal PRESERVES rather than deletes —
 * in lock-ownership order. `planClaudeRemoval` CALLS this for its `drift`, so the
 * removal planner and the doctor's read-only settings-drift probe cannot disagree.
 */
export function readClaudeSettingsDrift(root: string, lock: BindingLock): ClaudeDriftEntry[] {
  const drift: ClaudeDriftEntry[] = [];
  for (const entry of lock.ownership) {
    const disposition = classifyOwnershipEntry(root, entry);
    if (disposition.kind === "drift") drift.push(disposition.drift);
  }
  return drift;
}

/** Apply one `json-remove` disposition's restore/prune to a file's accumulator. */
function applyJsonRemoval(
  acc: JsonRemovalAccumulator,
  d: OwnershipDisposition & { kind: "json-remove" },
): void {
  const pre = d.preExisting;
  if ("value" in pre) {
    if (d.single) {
      deepSet(acc.json, [d.parent], pre.value);
      acc.replaceKeys.add(d.parent);
    } else {
      deepSet(acc.json, [d.parent, d.child], pre.value);
      addToMap(acc.replaceChildKeys, d.parent, d.child);
    }
  } else if (d.single) {
    acc.removeTopLevel.add(d.parent);
  } else {
    addToMap(acc.removeChild, d.parent, d.child);
  }
}

export function planClaudeRemoval(root: string, lock: BindingLock): ClaudeRemovalPlan {
  // The drift half is the pure {@link readClaudeSettingsDrift} — one source of the
  // drift decision, shared with the doctor's B7 probe. The action half re-uses the
  // SAME {@link classifyOwnershipEntry} so a drifted entry is preserved identically.
  const drift = readClaudeSettingsDrift(root, lock);
  const jsonFiles = new Map<string, JsonRemovalAccumulator>();
  const otherActions: Action[] = [];
  const removedFiles = new Set<string>();

  for (const entry of lock.ownership) {
    const disposition = classifyOwnershipEntry(root, entry);
    switch (disposition.kind) {
      case "drift":
      case "noop":
        break; // drift is collected by readClaudeSettingsDrift; a no-op does nothing
      case "json-remove": {
        const acc = jsonFiles.get(disposition.file) ?? newAccumulator();
        applyJsonRemoval(acc, disposition);
        jsonFiles.set(disposition.file, acc);
        break;
      }
      case "block-strip":
        otherActions.push(
          writeText(
            disposition.file,
            stripManagedBlock(disposition.raw, disposition.marker),
            "Remove Claude managed CLAUDE.md block",
          ),
        );
        break;
      case "file-restore":
        otherActions.push(
          writeText(
            disposition.target,
            disposition.contents,
            `Restore pre-existing file ${disposition.target}`,
          ),
        );
        break;
      case "file-remove":
        otherActions.push(
          remove(disposition.target, `Remove Claude owned file ${disposition.target}`),
        );
        removedFiles.add(disposition.target);
        break;
    }
  }

  const jsonActions: Action[] = [];
  for (const [file, acc] of jsonFiles) {
    if (!accumulatorHasWork(acc)) continue;
    jsonActions.push(
      writeJson(file, acc.json, `Remove Claude owned fields from ${file}`, {
        merge: true,
        ...(acc.replaceKeys.size > 0 ? { replaceJsonKeys: [...acc.replaceKeys] } : {}),
        ...(acc.replaceChildKeys.size > 0
          ? { replaceJsonChildKeys: mapToRecord(acc.replaceChildKeys) }
          : {}),
        ...(acc.removeChild.size > 0 ? { removeJsonKeys: mapToRecord(acc.removeChild) } : {}),
        ...(acc.removeTopLevel.size > 0 ? { removeJsonTopLevelKeys: [...acc.removeTopLevel] } : {}),
      }),
    );
  }

  // Owned files removed above may empty a directory AIH created under
  // `.claude/rules|skills|agents/` (D18 "own what you created" — a clean tree keeps
  // no orphaned empty dir). Removal is CONSERVATIVE: a dir is scheduled only when
  // every current entry is itself being removed, so a user file left beside an owned
  // one keeps its directory. Staged AFTER the file removals so the files move first.
  const dirActions = planEmptyOwnedDirRemovals(root, removedFiles);

  return { actions: [...jsonActions, ...otherActions, ...dirActions], drift };
}

/**
 * Directories under an owned-file root that BECOME empty once `removedFiles` are
 * gone, deepest first. A dir qualifies only when every entry it currently holds is
 * in the removal set (an already-scheduled deeper dir counts), so a user-authored
 * neighbour always keeps the directory. Symlinked dirs are skipped (the executor
 * would refuse them anyway); the owned-file roots themselves are never removed.
 */
function planEmptyOwnedDirRemovals(root: string, removedFiles: ReadonlySet<string>): Action[] {
  if (removedFiles.size === 0) return [];
  const candidates = new Set<string>();
  for (const file of removedFiles) {
    const ownedRoot = CLAUDE_OWNED_FILE_ROOTS.find((r) => file.startsWith(r));
    if (ownedRoot === undefined) continue;
    const parts = file.split("/");
    for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
      const dir = parts.slice(0, depth).join("/");
      if (dir.startsWith(ownedRoot)) candidates.add(dir);
    }
  }
  const removedPaths = new Set(removedFiles);
  const toRemove: string[] = [];
  const deepestFirst = [...candidates].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const dir of deepestFirst) {
    const abs = join(root, dir);
    let entries: string[];
    try {
      if (lstatSync(abs).isSymbolicLink()) continue;
      entries = readdirSync(abs);
    } catch {
      continue; // absent or unreadable — nothing to remove
    }
    if (entries.every((name) => removedPaths.has(`${dir}/${name}`))) {
      toRemove.push(dir);
      removedPaths.add(dir);
    }
  }
  return toRemove.map((dir) => remove(dir, `Remove empty Claude owned directory ${dir}`));
}

function accumulatorHasWork(acc: JsonRemovalAccumulator): boolean {
  return (
    Object.keys(acc.json).length > 0 || acc.removeTopLevel.size > 0 || acc.removeChild.size > 0
  );
}

function addToMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

function mapToRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, set] of map) out[key] = [...set];
  return out;
}
