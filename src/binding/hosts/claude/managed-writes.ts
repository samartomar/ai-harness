import { join } from "node:path";
import { readIfExists } from "../../../internals/fsxn.js";
import {
  extractManagedBlock,
  type ManagedBlock,
  mergeManagedBlock,
} from "../../../internals/markers.js";
import { isPlainObject, parseJsoncText } from "../../../internals/merge.js";
import { type Action, writeJson, writeText } from "../../../internals/plan.js";
import { ensureTrailingNewline } from "../../../internals/render.js";
import type { BindingLock, BindingOwnershipEntry, BindingWrite } from "../../lock.js";
import {
  assertOwnedFilePath,
  assertSafeKey,
  assertSharedJsonFile,
  CLAUDE_BINDING_BLOCK_NOTE,
  CLAUDE_BINDING_MARKER,
  CLAUDE_BLOCK_TARGET,
  CLAUDE_BOOTLOADER_PATH,
  CLAUDE_MCP_KEY,
  CLAUDE_MCP_PATH,
  ClaudeHostWriteError,
  canonicalJson,
  parseJsonPointer,
  sha256Hex,
  valueAtPointer,
} from "./surfaces.js";

/**
 * The D18 managed-write engine for the Claude project-scope host adapter — the
 * foundation every binding write flows through. Plan/apply are SEPARATE (D14):
 * this engine only PLANS. Callers hand its {@link ClaudeManagedPlan.actions} to
 * the shared `executePlan`, then seal ownership with {@link finalizeClaudeOwnership}.
 *
 * D18 ownership model (verbatim): shared JSON files (`.claude/settings.json`,
 * `.claude/settings.local.json`, `.mcp.json`) are owned by FIELD, never by file;
 * the CLAUDE.md managed block is owned by a text marker; rules/skills/agents are
 * owned as FILES with source digests. Every owned slot records the pre-existing
 * value (or its explicit absence) captured at plan time, so conservative removal
 * can restore the world. Shared JSON files are ALWAYS merge-written (targeted keys
 * only) — a whole-file replacement never happens.
 */

/** The three D18 ownership mechanisms, mirroring the lock's `OWNERSHIP_KINDS`. */
export type ClaudeOwnershipKind = "json-pointer" | "mcp-server" | "file";

/** D18: the pre-existing value AIH observed, or an explicit record of its absence. */
export type ClaudePreExisting = { absent: true } | { value: unknown };

/**
 * A planned ownership record — everything the lock needs EXCEPT the post-apply
 * digest, which {@link finalizeClaudeOwnership} seals by re-reading after apply.
 * Carries the structured routing (file + pointer / block marker) the finalizer
 * uses; the final {@link BindingOwnershipEntry.target} string re-encodes that
 * routing so conservative removal can re-locate the slot from the lock alone.
 */
export interface ClaudeOwnershipIntent {
  kind: ClaudeOwnershipKind;
  /** Final lock target: file-qualified pointer, MCP server id, file path, or `CLAUDE.md#block:<marker>`. */
  target: string;
  /** Repo-relative POSIX file whose content this ownership is read back from. */
  file: string;
  /** JSON pointer segments (json-pointer / mcp-server only). */
  pointer?: string[];
  /** Block marker id (CLAUDE.md fence ownership only; kind is `file`). */
  blockMarker?: string;
  preExisting: ClaudePreExisting;
  /** JSON value (pointer/server) or a source digest (file/block). */
  applied: unknown;
}

/**
 * The plan bundle: actions to execute, the per-slot writes, and the ownership
 * intents. `writes` has one entry per jsonField/mcpServer/block/file call;
 * `ownership` may be SHORTER when depth-2 leaves under a freshly-created parent
 * collapse into a single parent-container entry (D18 "own what you created").
 */
export interface ClaudeManagedPlan {
  actions: Action[];
  writes: BindingWrite[];
  ownership: ClaudeOwnershipIntent[];
}

type Slot =
  | {
      type: "json";
      kind: "json-pointer" | "mcp-server";
      file: string;
      pointer: string[];
      pointerStr: string;
      value: unknown;
      target: string;
      preExisting: ClaudePreExisting;
      /** Depth-2 only: the parent container was ABSENT on disk at plan time. */
      parentAbsent: boolean;
    }
  | {
      type: "block";
      file: string;
      marker: string;
      bodyTrimmed: string;
      merged: string;
      preExisting: ClaudePreExisting;
    }
  | {
      type: "file";
      file: string;
      contents: string;
      preExisting: ClaudePreExisting;
    };

export class ClaudeManagedWriteEngine {
  private readonly slots: Slot[] = [];

  constructor(private readonly root: string) {}

  /** Read + tolerantly parse a repo-relative JSON file's current state, or `undefined`. */
  private readJson(file: string): unknown {
    const raw = readIfExists(join(this.root, file));
    return raw === undefined ? undefined : parseJsoncText(raw);
  }

  /**
   * Capture, from ONE read of the current file, both the slot's pre-existing value
   * and — for a depth-2 pointer — whether the PARENT container is absent on disk.
   * An absent parent means AIH will IMPLICITLY create the container, so build()
   * records ownership of the whole container ("own what you created") rather than
   * just the leaf, and removal can take the empty container with it (D18).
   */
  private captureJsonSlot(
    file: string,
    pointer: string[],
  ): { preExisting: ClaudePreExisting; parentAbsent: boolean } {
    const current = this.readJson(file);
    const found = valueAtPointer(current, pointer);
    const preExisting: ClaudePreExisting = found.present
      ? { value: found.value }
      : { absent: true };
    const parentAbsent =
      pointer.length >= 2 && !valueAtPointer(current, [pointer[0] ?? ""]).present;
    return { preExisting, parentAbsent };
  }

  /**
   * Own a single FIELD in a shared JSON file, addressed by a JSON pointer (depth 1
   * or 2 — every Claude settings/MCP owned field fits). Merge/targeted-key write:
   * unrelated siblings survive; the owned leaf is REPLACED (never array-unioned) so
   * re-binds are deterministic. Refuses any file outside the D18 shared surfaces.
   */
  jsonField(file: string, pointer: string, value: unknown): this {
    assertSharedJsonFile(file);
    if (value === undefined) {
      throw new ClaudeHostWriteError(`jsonField value for ${file}${pointer} must be defined`);
    }
    const segments = parseJsonPointer(pointer);
    if (segments.length < 1 || segments.length > 2) {
      throw new ClaudeHostWriteError(
        `unsupported JSON pointer depth for ${JSON.stringify(pointer)} — only depth 1 or 2 owned fields are supported`,
      );
    }
    this.slots.push({
      type: "json",
      kind: "json-pointer",
      file,
      pointer: segments,
      pointerStr: pointer,
      value,
      target: `${file}#${pointer}`,
      ...this.captureJsonSlot(file, segments),
    });
    return this;
  }

  /**
   * Own an MCP server entry (`mcpServers.<id>`) in `.mcp.json` (D18 kind
   * `mcp-server`). The server id is the ownership target; the write preserves every
   * other server already present.
   */
  mcpServer(id: string, config: unknown): this {
    assertSafeKey(id);
    if (config === undefined) {
      throw new ClaudeHostWriteError(`mcpServer config for ${JSON.stringify(id)} must be defined`);
    }
    const pointer = [CLAUDE_MCP_KEY, id];
    this.slots.push({
      type: "json",
      kind: "mcp-server",
      file: CLAUDE_MCP_PATH,
      pointer,
      pointerStr: `/${CLAUDE_MCP_KEY}/${id}`,
      value: config,
      target: id,
      ...this.captureJsonSlot(CLAUDE_MCP_PATH, pointer),
    });
    return this;
  }

  /**
   * Own the single marker-delimited CLAUDE.md block (D18: text marker). Whole-block
   * replace on re-bind, all content OUTSIDE the fence preserved verbatim (EOL style
   * kept). Ownership kind is `file` with the block-target convention
   * `CLAUDE.md#block:<marker>` so removal STRIPS the fence rather than deleting the
   * file — the region outside the fence is never AIH's to delete.
   */
  claudeMdBlock(body: string, opts: { note?: string; preamble?: string } = {}): this {
    const existing = readIfExists(join(this.root, CLAUDE_BOOTLOADER_PATH));
    const block: ManagedBlock = {
      marker: CLAUDE_BINDING_MARKER,
      note: opts.note ?? CLAUDE_BINDING_BLOCK_NOTE,
      body,
    };
    const rendered = mergeManagedBlock(existing, block, opts.preamble ?? "");
    // A fresh file with an empty preamble would lead with blank lines; trim them.
    const merged = existing === undefined ? rendered.replace(/^\r?\n+/, "") : rendered;
    this.slots.push({
      type: "block",
      file: CLAUDE_BOOTLOADER_PATH,
      marker: CLAUDE_BINDING_MARKER,
      bodyTrimmed: body.trim(),
      merged,
      // The fence is AIH's by definition; content outside it is preserved by the
      // strip, so there is no non-AIH pre-existing fenced body to restore.
      preExisting: { absent: true },
    });
    return this;
  }

  /**
   * Own a whole FILE under `.claude/rules/`, `.claude/skills/`, or `.claude/agents/`
   * (D18: file-level ownership with a source digest). Refuses any path outside those
   * roots, and a non-POSIX / traversing / drive path at the schema boundary.
   */
  ownedFile(relPath: string, contents: string): this {
    assertOwnedFilePath(relPath);
    const prior = readIfExists(join(this.root, relPath));
    this.slots.push({
      type: "file",
      file: relPath,
      contents: ensureTrailingNewline(contents),
      preExisting: prior === undefined ? { absent: true } : { value: prior },
    });
    return this;
  }

  /** Produce the plan bundle: grouped actions + per-slot writes + ownership intents. */
  build(): ClaudeManagedPlan {
    const writes: BindingWrite[] = [];
    const ownership: ClaudeOwnershipIntent[] = [];
    const jsonFiles = new Map<string, JsonFileAccumulator>();
    // Depth-2 slots whose parent AIH creates collapse into ONE ownership entry per
    // (file, parent): removal takes the whole container AIH added, not just the leaf.
    const parentGroups = new Map<string, { container: Record<string, unknown> }>();
    const blockActions: Action[] = [];
    const fileActions: Action[] = [];

    for (const slot of this.slots) {
      if (slot.type === "json") {
        // Writes stay per-slot (one BindingWrite per jsonField/mcpServer call).
        writes.push({
          path: slot.file,
          mechanism: slot.kind,
          contentDigest: sha256Hex(canonicalJson(slot.value)),
        });
        accumulateJson(jsonFiles, slot.file, slot.pointer, slot.value);
        if (slot.pointer.length === 2 && slot.parentAbsent) {
          // Own the PARENT container AIH is about to create (D18: own what you
          // created). Aggregate every leaf under the same absent parent into one
          // entry whose `applied` is the merged container.
          const parent = slot.pointer[0] ?? "";
          const child = slot.pointer[1] ?? "";
          const groupKey = `${slot.file} ${parent}`;
          let group = parentGroups.get(groupKey);
          if (group === undefined) {
            const container: Record<string, unknown> = {};
            group = { container };
            parentGroups.set(groupKey, group);
            ownership.push({
              kind: "json-pointer",
              target: `${slot.file}#/${parent}`,
              file: slot.file,
              pointer: [parent],
              preExisting: { absent: true },
              // Same object reference as group.container; filled as children arrive.
              applied: container,
            });
          }
          group.container[child] = slot.value;
        } else {
          // Leaf ownership: depth-1, or depth-2 with a pre-existing parent (today's
          // behavior — the leaf is pruned/restored on its own, siblings untouched).
          ownership.push({
            kind: slot.kind,
            target: slot.target,
            file: slot.file,
            pointer: slot.pointer,
            preExisting: slot.preExisting,
            applied: slot.value,
          });
        }
      } else if (slot.type === "block") {
        const digest = sha256Hex(slot.bodyTrimmed);
        writes.push({ path: slot.file, mechanism: "file", contentDigest: digest });
        ownership.push({
          kind: "file",
          target: CLAUDE_BLOCK_TARGET,
          file: slot.file,
          blockMarker: slot.marker,
          preExisting: slot.preExisting,
          applied: digest,
        });
        blockActions.push(writeText(slot.file, slot.merged, "Bind Claude managed CLAUDE.md block"));
      } else {
        const digest = sha256Hex(slot.contents);
        writes.push({ path: slot.file, mechanism: "file", contentDigest: digest });
        ownership.push({
          kind: "file",
          target: slot.file,
          file: slot.file,
          preExisting: slot.preExisting,
          applied: digest,
        });
        fileActions.push(
          writeText(slot.file, slot.contents, `Bind Claude owned file ${slot.file}`),
        );
      }
    }

    const jsonActions: Action[] = [];
    for (const [file, acc] of jsonFiles) {
      jsonActions.push(
        writeJson(file, acc.json, `Bind Claude owned fields in ${file}`, {
          merge: true,
          ...(acc.replaceKeys.size > 0 ? { replaceJsonKeys: [...acc.replaceKeys] } : {}),
          ...(acc.replaceChildKeys.size > 0
            ? { replaceJsonChildKeys: mapOfSetsToRecord(acc.replaceChildKeys) }
            : {}),
        }),
      );
    }

    return { actions: [...jsonActions, ...blockActions, ...fileActions], writes, ownership };
  }
}

interface JsonFileAccumulator {
  json: Record<string, unknown>;
  replaceKeys: Set<string>;
  replaceChildKeys: Map<string, Set<string>>;
}

function accumulateJson(
  files: Map<string, JsonFileAccumulator>,
  file: string,
  pointer: string[],
  value: unknown,
): void {
  const acc = files.get(file) ?? {
    json: {},
    replaceKeys: new Set<string>(),
    replaceChildKeys: new Map<string, Set<string>>(),
  };
  deepSet(acc.json, pointer, value);
  if (pointer.length === 1) {
    acc.replaceKeys.add(pointer[0] ?? "");
  } else {
    const parent = pointer[0] ?? "";
    const child = pointer[1] ?? "";
    const children = acc.replaceChildKeys.get(parent) ?? new Set<string>();
    children.add(child);
    acc.replaceChildKeys.set(parent, children);
  }
  files.set(file, acc);
}

/** Set `value` at `segments` in `obj`, creating intermediate plain objects. */
export function deepSet(obj: Record<string, unknown>, segments: string[], value: unknown): void {
  let current = obj;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index] ?? "";
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] ?? ""] = value;
}

function mapOfSetsToRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, set] of map) out[key] = [...set];
  return out;
}

/**
 * Seal ownership after `executePlan` has run the actions: re-read each owned slot
 * and compute its post-apply digest, producing lock-ready
 * {@link BindingOwnershipEntry} records (D18's post-apply digest). The engine does
 * NOT write the lock — the caller does.
 */
export function finalizeClaudeOwnership(
  root: string,
  intents: readonly ClaudeOwnershipIntent[],
): BindingOwnershipEntry[] {
  return intents.map((intent) => ({
    kind: intent.kind,
    target: intent.target,
    preExisting: intent.preExisting,
    applied: intent.applied,
    postApplyDigest: postApplyDigest(root, intent),
  }));
}

function postApplyDigest(root: string, intent: ClaudeOwnershipIntent): string {
  if (intent.pointer !== undefined) {
    const raw = readIfExists(join(root, intent.file));
    const found = valueAtPointer(
      raw === undefined ? undefined : parseJsoncText(raw),
      intent.pointer,
    );
    return sha256Hex(canonicalJson(found.present ? found.value : null));
  }
  if (intent.blockMarker !== undefined) {
    const raw = readIfExists(join(root, intent.file)) ?? "";
    return sha256Hex(extractManagedBlock(raw, intent.blockMarker) ?? "");
  }
  return sha256Hex(readIfExists(join(root, intent.file)) ?? "");
}

/**
 * Re-provision pre-existing preservation for a SINGLE-slot managed plan —
 * shared by every caller that re-binds one `jsonField()` owner across a
 * re-provision (the Claude host's own `enabledPlugins` field in
 * `hosts/claude/plugins.ts`'s `bindPlugin`, and the Superpowers adapter's
 * telemetry env field). Previously duplicated verbatim in both call sites
 * (`plugins.ts`'s private `preservePriorPreExisting` and
 * `frameworks/superpowers.ts`'s private `preserveAcrossRebind`); this is the
 * one shared implementation both now call.
 *
 * `managedPlan` must have been built from EXACTLY the one `jsonField()` call
 * being re-provisioned — `ownership[0]` is the intent mutated in place.
 * `target` is that field's LEAF target string (`<file>#<pointer>`, e.g.
 * `.claude/settings.json#/enabledPlugins/ecc@ecc-mkt`), matching the
 * convention the original `jsonField()` call used, REGARDLESS of whether
 * `build()` already collapsed it to parent-container ownership this time.
 *
 * Two shapes the prior lock may have recorded for that leaf:
 *  - the prior lock owns the LEAF (the container pre-existed at first bind):
 *    carry its `preExisting` onto the new intent verbatim;
 *  - the prior lock owns the PARENT container (`<file>#/<parent>` with
 *    `preExisting` absent — AIH created the container at first bind):
 *    RE-ASSERT parent ownership on the re-bind intent. The engine now sees
 *    the container as present (the first bind wrote it) and would otherwise
 *    record a leaf whose "pre-existing" is the FIRST bind's own value, so a
 *    later removal from a re-bind lock would restore the binding instead of
 *    pruning the container AIH created.
 *
 * A no-op when there is no prior lock, no ownership intent to mutate, the
 * intent isn't a depth-2 pointer, or neither shape is found in the prior
 * lock (nothing to carry forward — the fresh disk-read `preExisting` the
 * engine already captured stands).
 */
export function carryForwardOwnership(
  managedPlan: ClaudeManagedPlan,
  previousLock: BindingLock | undefined,
  target: string,
): void {
  if (previousLock === undefined) return;
  const intent = managedPlan.ownership[0];
  if (intent === undefined) return;
  const prior = previousLock.ownership.find((entry) => entry.target === target);
  if (prior !== undefined) {
    intent.preExisting = prior.preExisting;
    return;
  }
  if (intent.pointer === undefined || intent.pointer.length !== 2) return;
  const hash = target.indexOf("#");
  if (hash < 0) return;
  const file = target.slice(0, hash);
  const segments = parseJsonPointer(target.slice(hash + 1));
  const parent = segments[0];
  const child = segments[1];
  if (parent === undefined || child === undefined) return;
  const parentTarget = `${file}#/${parent}`;
  const parentPrior = previousLock.ownership.find((entry) => entry.target === parentTarget);
  if (parentPrior === undefined) return;
  intent.target = parentTarget;
  intent.pointer = [parent];
  intent.preExisting = parentPrior.preExisting;
  intent.applied = { [child]: intent.applied };
}
