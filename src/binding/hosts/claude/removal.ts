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

export function planClaudeRemoval(root: string, lock: BindingLock): ClaudeRemovalPlan {
  const drift: ClaudeDriftEntry[] = [];
  const jsonFiles = new Map<string, JsonRemovalAccumulator>();
  const otherActions: Action[] = [];
  const removedFiles = new Set<string>();

  for (const entry of lock.ownership) {
    if (entry.kind === "json-pointer" || entry.kind === "mcp-server") {
      reconcileJsonEntry(root, entry, jsonFiles, drift);
    } else {
      const block = blockRoute(entry.target);
      if (block !== undefined) {
        reconcileBlockEntry(root, entry, block, otherActions, drift);
      } else {
        reconcileFileEntry(root, entry, otherActions, drift, removedFiles);
      }
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

function reconcileJsonEntry(
  root: string,
  entry: BindingOwnershipEntry,
  jsonFiles: Map<string, JsonRemovalAccumulator>,
  drift: ClaudeDriftEntry[],
): void {
  const { file, pointer } = jsonRoute(entry);
  if (pointer.length === 0) {
    // A json-pointer entry whose target carries no pointer is a malformed lock
    // record — conservative removal PRESERVES and reports it, never guesses.
    drift.push({
      kind: entry.kind,
      target: entry.target,
      reason: "malformed lock target (no JSON pointer) — preserved",
    });
    return;
  }
  const raw = readIfExists(join(root, file));
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : parseJsoncText(raw);
  } catch {
    drift.push({ kind: entry.kind, target: entry.target, reason: "file is not parseable JSON" });
    return;
  }
  const found = valueAtPointer(parsed, pointer);
  if (!found.present) return; // already gone — idempotent no-op
  if (!jsonEqual(found.value, entry.applied)) {
    drift.push({
      kind: entry.kind,
      target: entry.target,
      reason: "owned value modified since bind",
    });
    return;
  }
  const acc = jsonFiles.get(file) ?? newAccumulator();
  const pre = entry.preExisting;
  const parent = pointer[0] ?? "";
  const child = pointer[1] ?? "";
  if ("value" in pre) {
    if (pointer.length === 1) {
      deepSet(acc.json, [parent], pre.value);
      acc.replaceKeys.add(parent);
    } else {
      deepSet(acc.json, [parent, child], pre.value);
      addToMap(acc.replaceChildKeys, parent, child);
    }
  } else if (pointer.length === 1) {
    acc.removeTopLevel.add(parent);
  } else {
    addToMap(acc.removeChild, parent, child);
  }
  jsonFiles.set(file, acc);
}

function reconcileBlockEntry(
  root: string,
  entry: BindingOwnershipEntry,
  block: { file: string; marker: string },
  actions: Action[],
  drift: ClaudeDriftEntry[],
): void {
  const raw = readIfExists(join(root, block.file));
  const body = raw === undefined ? undefined : extractManagedBlock(raw, block.marker);
  if (raw === undefined || body === undefined) return; // fence already gone
  if (sha256Hex(body) !== entry.postApplyDigest) {
    drift.push({
      kind: entry.kind,
      target: entry.target,
      reason: "managed block edited since bind",
    });
    return;
  }
  actions.push(
    writeText(
      block.file,
      stripManagedBlock(raw, block.marker),
      "Remove Claude managed CLAUDE.md block",
    ),
  );
}

function reconcileFileEntry(
  root: string,
  entry: BindingOwnershipEntry,
  actions: Action[],
  drift: ClaudeDriftEntry[],
  removedFiles: Set<string>,
): void {
  const current = readIfExists(join(root, entry.target));
  if (current === undefined) return; // already gone
  if (sha256Hex(current) !== entry.postApplyDigest) {
    drift.push({
      kind: entry.kind,
      target: entry.target,
      reason: "owned file modified since bind",
    });
    return;
  }
  const pre = entry.preExisting;
  if ("value" in pre) {
    const contents = typeof pre.value === "string" ? pre.value : canonicalJson(pre.value);
    actions.push(writeText(entry.target, contents, `Restore pre-existing file ${entry.target}`));
  } else {
    actions.push(remove(entry.target, `Remove Claude owned file ${entry.target}`));
    removedFiles.add(entry.target);
  }
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
