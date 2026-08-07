import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readRegularFile } from "../internals/fsxn.js";
import { hasSymlinkParent, occupied } from "../mcp/managed-projection.js";

/**
 * The hook registrar's paths, byte bounds, and the ONE guarded read both of its
 * files go through. Split out of the projector because it is a cohesive layer
 * with no dependency on projection, drift, or the receipt shape.
 */

/** The one destination this projector owns. */
export const HOOK_REGISTRAR_DESTINATION = ".claude/settings.json";
export const HOOK_REGISTRAR_RECEIPT_PATH = ".aih/org-policy-hook-registrar-receipt.json";
export const HOOK_REGISTRAR_RECEIPT_FORMAT = "aih-org-policy-hook-registrar-receipt";

/**
 * The largest destination the receipt can carry as prior evidence — ONE
 * constant, used by both the read that captures those bytes and the schema that
 * has to parse them back. The two paths disagreeing is not a cosmetic defect:
 * a receipt recorded above what the schema accepts can never be read again, and
 * a receipt that cannot be read is a projected third-party entry that can never
 * be revoked. A4 keeps the prior bytes as evidence, so dropping them silently is
 * not an alternative; a destination this large is refused up front instead.
 *
 * The read is capped in BYTES and the schema in UTF-16 code units, which is safe
 * in this direction: UTF-8 never spends fewer bytes than the code units it
 * encodes, so bytes within the cap can never decode to a longer string than it.
 */
export const HOOK_REGISTRAR_MAX_DESTINATION_BYTES = 4 * 1024 * 1024;

/** Receipt entries the schema admits, and the room one entry can occupy. */
export const HOOK_REGISTRAR_MAX_RECEIPT_ENTRIES = 512;
const MAX_RECEIPT_ENTRY_BYTES = 32 * 1024;
/** A JSON string escape can spend six characters on one input byte (``). */
const JSON_ESCAPE_WORST_CASE = 6;

/**
 * The receipt's own bound, DERIVED from what a legitimate receipt can hold
 * rather than guessed: the prior bytes at their worst-case JSON escaping, plus
 * every entry at its own cap, plus room for the envelope. Without it a
 * multi-gigabyte file at the receipt path escapes as a raw Node error instead of
 * the typed refusal every caller here is written to handle.
 */
export const HOOK_REGISTRAR_MAX_RECEIPT_BYTES =
  HOOK_REGISTRAR_MAX_DESTINATION_BYTES * JSON_ESCAPE_WORST_CASE +
  HOOK_REGISTRAR_MAX_RECEIPT_ENTRIES * MAX_RECEIPT_ENTRY_BYTES +
  64 * 1024;

/**
 * What a guarded read found. `unreadable` is deliberately NOT collapsed into
 * `absent`: `absent` is a load-bearing verdict on both of this projector's
 * files — it authorizes deleting the destination, it skips the unowned-entry
 * check, and on the receipt it means AIH never projected here at all. A path
 * AIH merely failed to read must never reach any of those. Callers refuse.
 */
export type GuardedRead =
  | { state: "absent" }
  | { state: "present"; contents: string }
  | { state: "unreadable"; reason: string };

/** The size of a regular file at `abs`, or `undefined` for anything else. */
function regularFileSize(abs: string): number | undefined {
  try {
    const stats = lstatSync(abs);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a path under `root` cannot be read as AIH's own, or `undefined` when it
 * can. The no-follow read guards the leaf; this guards the parents, which the
 * executor refuses outright — so a verdict reached through a redirected `.aih`
 * or `.claude` would name a removal that is guaranteed to fail in the action
 * loop, and would report content from outside the root as if it were in it.
 */
export function symlinkedParentReason(root: string, rel: string): string | undefined {
  return hasSymlinkParent(root, rel)
    ? `${rel} is reached through a symlinked parent directory, and AIH never reads or edits through one`
    : undefined;
}

/**
 * ONE guarded read for BOTH files this projector owns. They fail open in the
 * same way for the same reason, so they are read the same way: a directory, a
 * symlink, a FIFO, an unreadable file or a redirected parent all make a plain
 * read return nothing, and calling any of them `absent` is the fail-open the
 * invariants forbid.
 */
export function readGuardedFile(
  root: string,
  rel: string,
  options: { maxBytes: number },
): GuardedRead {
  const unsafeParent = symlinkedParentReason(root, rel);
  if (unsafeParent !== undefined) return { state: "unreadable", reason: unsafeParent };
  const abs = join(root, ...rel.split("/"));
  const contents = readRegularFile(abs, options)?.toString("utf8");
  if (contents !== undefined) return { state: "present", contents };
  const size = regularFileSize(abs);
  if (size !== undefined && size > options.maxBytes) {
    return {
      state: "unreadable",
      reason:
        `${rel} is ${size} bytes, larger than the ${options.maxBytes} bytes ` +
        "a hook registrar receipt can carry",
    };
  }
  // PRESENCE only, and NO-FOLLOW — the peer's shape (`occupied`, used by the
  // managed-MCP projection for exactly this).
  if (occupied(abs)) {
    return {
      state: "unreadable",
      reason:
        `${rel} is not a readable regular file (a directory, a symlink, ` +
        "a special file, or one AIH cannot read), and AIH never records or edits through one",
    };
  }
  return { state: "absent" };
}

export function readDestination(root: string): GuardedRead {
  return readGuardedFile(root, HOOK_REGISTRAR_DESTINATION, {
    maxBytes: HOOK_REGISTRAR_MAX_DESTINATION_BYTES,
  });
}

export function readReceipt(root: string): GuardedRead {
  return readGuardedFile(root, HOOK_REGISTRAR_RECEIPT_PATH, {
    maxBytes: HOOK_REGISTRAR_MAX_RECEIPT_BYTES,
  });
}
