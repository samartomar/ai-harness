import { gitRead } from "../internals/git.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * PERFORMANCE / repository information — tracked file count, git object size, and a
 * file-type breakdown by extension. Derived from `git ls-files` + `git
 * count-objects` (no per-file reads, so it's fast even on large repos). Byte-stable,
 * zero-dep. Total lines-of-code is intentionally NOT computed here (it requires
 * reading every file) — the OUTPUT VELOCITY LOC-30d panel carries the line signal.
 */

const TOP_TYPES = 8;

function ext(p: string): string {
  const i = p.lastIndexOf(".");
  const slash = p.lastIndexOf("/");
  return i > slash && i >= 0 ? p.slice(i + 1).toLowerCase() : "(none)";
}

export async function repoInfoDigest(ctx: PlanContext): Promise<DigestAction | undefined> {
  const ls = await gitRead(ctx, ["ls-files"]);
  if (ls === undefined) return undefined;
  const files = ls.split("\n").filter(Boolean);
  if (files.length === 0) return undefined;

  const byExt = new Map<string, number>();
  for (const f of files) byExt.set(ext(f), (byExt.get(ext(f)) ?? 0) + 1);
  const types = [...byExt.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TYPES)
    .map(([name, count]) => ({ name, count }));

  // git object-store size (human units) — one cheap call, no working-tree walk.
  const co = await gitRead(ctx, ["count-objects", "-vH"]);
  const size =
    (/size-pack:\s*([^\n]+)/.exec(co ?? "") ?? /size:\s*([^\n]+)/.exec(co ?? ""))?.[1]?.trim() ??
    "—";

  return digest(
    `Repository information — ${files.length} files`,
    lines(
      `Repository: ${files.length} tracked files · git size ${size}`,
      "",
      "File types:",
      ...types.map((t) => `  ${t.name.padEnd(10)} ${t.count}`),
    ),
    { files: files.length, size, types },
  );
}
