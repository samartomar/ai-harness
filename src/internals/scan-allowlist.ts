/**
 * A gitignore-honoring file allowlist + a changed-since filter, for aih's scans.
 *
 * Algorithm and git argv adapted from @razroo/isolint (MIT,
 * https://github.com/razroo/isolint) — `dist/lint/scanner.js gitAllowlist` and
 * `dist/lint/git-diff.js changedFilesSince`. Reimplemented against aih's async
 * Runner seam (`gitRead`) instead of isolint's `execFileSync`, so the scanners
 * stay sync + pure and tests stay hermetic (no real process spawn).
 */

import { gitRead } from "./git.js";
import type { PlanContext } from "./plan.js";

/** Repo-relative POSIX paths git considers tracked OR untracked-but-not-ignored. */
export interface Allowlist {
  files: ReadonlySet<string>;
}

/** Normalize a git-reported path to repo-relative POSIX (git already emits POSIX). */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The set of paths in `ctx.root`'s repo that are tracked OR
 * untracked-but-not-ignored, via the injected Runner. `undefined` when the root
 * isn't a git repo / git is absent — callers then fall back to a raw FS walk.
 * `-z` (NUL-delimited) keeps paths with spaces/newlines intact.
 */
export async function gitTrackedSet(ctx: PlanContext): Promise<Allowlist | undefined> {
  const raw = await gitRead(ctx, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (raw === undefined) return undefined;
  const files = new Set<string>();
  for (const p of raw.split("\0")) if (p) files.add(norm(p));
  // An empty result (not a populated repo / git produced nothing useful) is
  // indistinguishable from "no allowlist" — fall back to a full scan rather than
  // filtering every file away to an empty footprint.
  return files.size > 0 ? { files } : undefined;
}

/**
 * Repo-relative POSIX paths git considers COMMITTED (tracked) — `git ls-files`.
 * Narrower than {@link gitTrackedSet}, which also counts untracked-not-ignored:
 * adopt's team-pollution guard treats ONLY committed content as "shared" (a
 * developer's uncommitted personal file must stay silent), so it needs the
 * tracked-only set. `undefined` when not a git repo / git absent / the set is
 * empty — callers then treat content as shared (can't prove it's personal),
 * mirroring {@link gitTrackedSet}'s empty→undefined fallback.
 */
export async function gitCommittedSet(ctx: PlanContext): Promise<ReadonlySet<string> | undefined> {
  const raw = await gitRead(ctx, ["ls-files", "-z"]);
  if (raw === undefined) return undefined;
  const files = new Set<string>();
  for (const p of raw.split("\0")) if (p) files.add(norm(p));
  return files.size > 0 ? files : undefined;
}

/**
 * Paths changed since `ref` — committed (`ref...HEAD`), working tree, and
 * untracked-not-ignored — for fast PR CI (`--since`). `undefined` when the root
 * isn't a git repo. Returns the empty set (not undefined) for a valid ref with no
 * changes; callers treat `undefined` as "not a repo → full scan".
 */
export async function changedSince(
  ctx: PlanContext,
  ref: string,
): Promise<ReadonlySet<string> | undefined> {
  const inRepo = (await gitRead(ctx, ["rev-parse", "--show-toplevel"])) !== undefined;
  if (!inRepo) return undefined;
  const out = new Set<string>();
  const add = (s: string | undefined): void => {
    for (const line of (s ?? "").split("\n")) {
      const t = line.trim();
      if (t) out.add(norm(t));
    }
  };
  // ref...HEAD committed (skip deletes), then working tree, then untracked.
  add(await gitRead(ctx, ["diff", "--name-only", "--diff-filter=ACMR", `${ref}...HEAD`]));
  add(await gitRead(ctx, ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]));
  add(await gitRead(ctx, ["ls-files", "--others", "--exclude-standard"]));
  return out;
}

/** Predicate: keep `rel` only if the allowlist contains it (or there is no allowlist). */
export function acceptIn(allow: Allowlist | undefined): (rel: string) => boolean {
  if (!allow) return () => true;
  return (rel) => allow.files.has(norm(rel));
}

/** Intersect an allowlist predicate with a changed-set (for `--since`). */
export function acceptChanged(
  allow: Allowlist | undefined,
  changed: ReadonlySet<string> | undefined,
): (rel: string) => boolean {
  const inAllow = acceptIn(allow);
  if (!changed) return inAllow;
  return (rel) => inAllow(rel) && changed.has(norm(rel));
}
