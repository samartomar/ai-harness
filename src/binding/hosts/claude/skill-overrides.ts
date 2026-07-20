import { join } from "node:path";
import { readIfExists } from "../../../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../../../internals/merge.js";
import type { ClaudeManagedWriteEngine } from "./managed-writes.js";
import {
  assertSafeKey,
  CLAUDE_SETTINGS_PATH,
  ClaudeHostWriteError,
  valueAtPointer,
} from "./surfaces.js";

/**
 * D11 groundwork: `skillOverrides` deny-list management for the Claude
 * project-scope host. `skillOverrides` lives at
 * `.claude/settings.json#/skillOverrides` as an exact-name deny list —
 * `{ "<exact-skill-name>": "off" }`. `"off"` hides the skill and blocks
 * invocation; an ABSENT name defaults to ON.
 *
 * Host caveat (the boundary this module respects): `skillOverrides` affects
 * ONLY skills loaded from a raw skills-checkout tree — the surface a framework
 * like gstack binds under `.claude/skills/`. It has NO effect on plugin-provided
 * skills, and this module never reasons about plugins; it is deny-list
 * bookkeeping for the raw-checkout surface only.
 *
 * Binding consequence this groundwork exists for: a skill added or renamed
 * upstream silently leaks into every project (an absent name defaults to ON)
 * until the deny list is REGENERATED from a freshly pinned skill-name
 * inventory. Bind, update, and doctor all reuse the same two entry points here
 * — {@link queueSkillDenyList} to (re)write the deny list from a pinned
 * inventory, and {@link skillDenyListReport} to verify current state against
 * one — so regeneration and re-verification always stay a single code path.
 */

/** A pinned skill-name inventory: exact names + the digest of the tree scanned. */
export interface PinnedSkillInventory {
  /** Exact skill names present in the pinned framework tree. */
  names: readonly string[];
  /** sha256 of the tree the names were inventoried from (ties freshness to the scanned digest). */
  sourceDigest: string;
}

/** Read-only comparison of current `skillOverrides` state against a pinned inventory. */
export interface SkillDenyListReport {
  /** Inventoried names that are NOT currently `"off"` in `skillOverrides`. */
  missing: string[];
  /** `"off"` entries in `skillOverrides` that are NOT in the inventory (candidate stale entries). */
  extra: string[];
  /** Whether a provided lock/inventory digest matches `inventory.sourceDigest`. */
  fresh: boolean | "unknown";
  /** Total number of pinned names the inventory carries. */
  total: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Fail closed on a `sourceDigest` that is not an exact sha256 hex digest. */
function assertValidSourceDigest(sourceDigest: string): void {
  if (!SHA256_HEX.test(sourceDigest)) {
    throw new ClaudeHostWriteError(
      `invalid pinned skill inventory sourceDigest ${JSON.stringify(sourceDigest)} — must be a sha256 hex digest`,
    );
  }
}

/**
 * Fail closed on a skill name unsafe as an object key (shared with every other
 * Claude host surface via {@link assertSafeKey}), OR one carrying a JSON-pointer
 * metacharacter (`/`, `~`). Metacharacter names are REJECTED rather than
 * `~1`/`~0`-escaped: `skillOverrides` is an exact-name deny list, so a name that
 * would need pointer-escaping is refused outright instead of risking a
 * silently-mismatched skill identity.
 */
function assertSafeSkillName(name: string): void {
  assertSafeKey(name);
  if (name.includes("/") || name.includes("~")) {
    throw new ClaudeHostWriteError(
      `refusing skill name with a JSON-pointer metacharacter: ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Queue one owned `"off"` deny entry per pinned name onto an existing engine
 * instance — depth-2 `/skillOverrides/<name>` pointers, one ownership entry per
 * skill so conservative removal (`planClaudeRemoval`) restores any pre-existing
 * per-name value independently (a name the user had already set `"off"` is
 * restored to `"off"`; a name with no prior value is pruned entirely).
 *
 * Fails closed before queuing anything if the inventory's digest is malformed;
 * each name is validated via {@link assertSafeSkillName} before it is queued —
 * a hostile name aborts the whole call (whatever was already queued on `engine`
 * by earlier names in the list stays queued, matching the engine's own
 * chained-call semantics).
 */
export function queueSkillDenyList(
  engine: ClaudeManagedWriteEngine,
  inventory: PinnedSkillInventory,
): { denied: string[] } {
  assertValidSourceDigest(inventory.sourceDigest);
  const denied: string[] = [];
  for (const name of inventory.names) {
    assertSafeSkillName(name);
    engine.jsonField(CLAUDE_SETTINGS_PATH, `/skillOverrides/${name}`, "off");
    denied.push(name);
  }
  return { denied };
}

/**
 * Compare the CURRENT `.claude/settings.json` state against a pinned skill
 * inventory (pure read — never writes). `missing` names need a bind/update to
 * regenerate the deny list; `extra` `"off"` entries are reported only — never
 * auto-deleted, since they may be user-authored. `fresh` is `"unknown"` without
 * a `lockedSourceDigest`, `true`/`false` on an exact/mismatched digest compare.
 *
 * Fails closed (typed {@link ClaudeHostWriteError}) on an invalid inventory
 * digest, a hostile inventory name, settings JSON that does not parse, or a
 * `skillOverrides` value that is present but not an object — no silent
 * coercion of malformed state into a default.
 */
export function skillDenyListReport(
  root: string,
  inventory: PinnedSkillInventory,
  opts: { lockedSourceDigest?: string } = {},
): SkillDenyListReport {
  assertValidSourceDigest(inventory.sourceDigest);
  for (const name of inventory.names) assertSafeSkillName(name);

  const raw = readIfExists(join(root, CLAUDE_SETTINGS_PATH));
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : parseJsoncText(raw);
  } catch (err) {
    throw new ClaudeHostWriteError(
      `cannot compute skill deny-list report — ${CLAUDE_SETTINGS_PATH} is not valid JSON/JSONC: ${(err as Error).message}`,
    );
  }

  const found = valueAtPointer(parsed, ["skillOverrides"]);
  let current: Record<string, unknown> = {};
  if (found.present) {
    if (!isPlainObject(found.value)) {
      throw new ClaudeHostWriteError(
        `cannot compute skill deny-list report — ${CLAUDE_SETTINGS_PATH}#/skillOverrides is not an object`,
      );
    }
    current = found.value;
  }

  const pinned = new Set(inventory.names);
  const missing = inventory.names.filter((name) => current[name] !== "off");
  const extra = Object.entries(current)
    .filter(([name, value]) => value === "off" && !pinned.has(name))
    .map(([name]) => name);

  const fresh: boolean | "unknown" =
    opts.lockedSourceDigest === undefined
      ? "unknown"
      : opts.lockedSourceDigest === inventory.sourceDigest;

  return { missing, extra, fresh, total: inventory.names.length };
}
