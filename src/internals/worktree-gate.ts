import { isAbsolute, relative, resolve } from "node:path";
import { gitRead } from "./git.js";
import type { Plan, PlanContext } from "./plan.js";

/** Normalize a repo-relative path for comparison: forward slashes, no leading `./`. */
export function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The set of repo-relative paths with uncommitted changes (`git status --porcelain`):
 * modified, staged, or untracked. A rename maps to its destination (what's on disk).
 * Routed through the read-only {@link gitRead} seam, so it stays hermetic in tests and
 * cross-platform. Empty when git is absent / not a repo (`gitRead` → undefined): with
 * no git history there is no uncommitted work to clobber.
 *
 * `-uall` matters for the REMOVAL gate: default porcelain collapses an entirely
 * untracked directory to one `?? dir/` entry, so a FILE inside it would never appear
 * in this set and a `remove`/`--delete` of it would sail past the gate. `-uall` lists
 * every untracked file individually (ignored files stay excluded, so it stays cheap).
 *
 * `-z` (NUL-delimited) matters just as much: without it git C-QUOTES any path with an
 * "unusual" byte (an embedded newline, a `"`, or a non-ASCII byte becomes `"a\nb"`,
 * `"a\"b"`, `\NNN`). The old human-format parser kept those escapes (and `normalizeRel`
 * then rewrote the backslashes), so the dirty entry would NOT equal the real on-disk
 * path the remove plan targets — a dirty/untracked removal target with a quoted name
 * would slip past the gate, letting `--delete` move an uncommitted file without
 * `--force`. In `-z` git emits RAW, unquoted bytes and drops the ` -> ` rename arrow,
 * reversing the fields to `<dest>\0<src>\0`, so paths match exactly with no unquoting.
 */
export async function dirtyPaths(ctx: PlanContext): Promise<Set<string>> {
  const out = await gitRead(ctx, ["status", "--porcelain", "-z", "-uall"]);
  const set = new Set<string>();
  if (typeof out !== "string") return set;
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry === undefined || entry.length < 4) continue; // "XY path" = 2 cols + space + ≥1 char
    const status = entry.slice(0, 2);
    const path = entry.slice(3); // drop the 2 status columns and the separating space
    // A rename/copy (R or C in either status column) emits its SOURCE as a separate
    // NUL-terminated token right after this one; consume it so the old name is never
    // added. In -z the entry's own path is already the destination (the on-disk file).
    if (status.includes("R") || status.includes("C")) i += 1;
    if (path.length > 0) set.add(normalizeRel(path));
  }
  return set;
}

/**
 * True when the worktree has ANY uncommitted change. (Kept as the simple predicate;
 * the `--apply` gate uses the precise {@link dirtyWriteTargets} instead.)
 */
export async function isWorktreeDirty(ctx: PlanContext): Promise<boolean> {
  return (await dirtyPaths(ctx)).size > 0;
}

/**
 * The repo-relative paths a plan would write that ALSO have uncommitted changes — the
 * precise "this apply would clobber your work" set that gates `--apply`.
 *
 * Only repo-local `write`/`doc`/`envblock` targets count; an `external` write (a
 * home/system file like `~/.codex/config.toml`) is never part of the repo worktree.
 * Crucially, a path aih writes that is NOT itself dirty — a brand-new file, or a clean
 * tracked one — is SAFE to write even when other, unrelated files in the repo are
 * dirty. So `aih mcp --apply --cli opencode` creating a new `opencode.json` is allowed
 * on a repo that merely has an untracked `codex/` dir elsewhere, while regenerating a
 * `CLAUDE.md` you have uncommitted edits to still gates. Empty under a clean/absent git
 * worktree.
 */
export async function dirtyWriteTargets(plan: Plan, ctx: PlanContext): Promise<string[]> {
  const targets: string[] = [];
  for (const a of plan.actions) {
    const p =
      a.kind === "write" && a.external !== true
        ? a.path
        : a.kind === "doc" && typeof a.path === "string"
          ? a.path
          : a.kind === "envblock"
            ? a.path
            : undefined;
    if (p === undefined) continue;
    const rel = relative(ctx.root, resolve(ctx.root, p));
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel))
      targets.push(normalizeRel(rel));
  }
  if (targets.length === 0) return [];
  const dirty = await dirtyPaths(ctx);
  return targets.filter((t) => dirty.has(t));
}

/**
 * The repo-relative paths a plan would REMOVE that ALSO have uncommitted changes —
 * the "this apply would delete your uncommitted work" set. Unlike writes, a removal
 * has no content-equality escape: deleting a dirty or untracked file always destroys
 * it, so this gates on dirty-set membership. Empty under a clean/absent git worktree,
 * so `--force` is never needed on a committed tree.
 *
 * A removal target may be a DIRECTORY (e.g. `aih skill remove` moves a whole skill
 * dir in one action). A dirty file lives in the set under its own path, never under
 * the parent dir's, so an exact-match test alone would let a dir removal clobber an
 * uncommitted file INSIDE it without `--force`. So a target also gates when any dirty
 * path is a descendant of it (`<target>/…`) — the dir carries its dirty children.
 */
export async function dirtyRemoveTargets(plan: Plan, ctx: PlanContext): Promise<string[]> {
  const targets: string[] = [];
  for (const a of plan.actions) {
    if (a.kind !== "remove") continue;
    const rel = relative(ctx.root, resolve(ctx.root, a.path));
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel))
      targets.push(normalizeRel(rel));
  }
  if (targets.length === 0) return [];
  const dirty = await dirtyPaths(ctx);
  const dirtyUnder = (target: string): boolean => {
    if (dirty.has(target)) return true; // the target file itself is dirty
    const prefix = `${target}/`; // …or a dirty file lives inside a removal directory
    for (const d of dirty) if (d.startsWith(prefix)) return true;
    return false;
  };
  return targets.filter(dirtyUnder);
}
