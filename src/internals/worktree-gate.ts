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
 */
export async function dirtyPaths(ctx: PlanContext): Promise<Set<string>> {
  const out = await gitRead(ctx, ["status", "--porcelain", "-uall"]);
  const set = new Set<string>();
  if (typeof out !== "string") return set;
  for (const line of out.split("\n")) {
    if (line.length < 4) continue; // "XY path" needs the 2 status cols + a space + a char
    let p = line.slice(3); // drop the 2 status columns and the separating space
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4); // a rename: the destination is the on-disk file
    p = p.trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes odd paths
    if (p.length > 0) set.add(normalizeRel(p));
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
 * it, so this gates on plain dirty-set membership. Empty under a clean/absent git
 * worktree, so `--force` is never needed on a committed tree.
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
  return targets.filter((t) => dirty.has(t));
}
