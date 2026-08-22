import type { PlanContext } from "./plan.js";

export interface GitReadOptions {
  /** Preserve exact stdout bytes when Git itself supplies record delimiters. */
  trim?: boolean;
}

/**
 * Run a read-only git command scoped to the repo root, through the injected
 * Runner (so tests stay hermetic). Returns trimmed stdout, or `undefined` when
 * git is absent / the command fails — callers branch on `undefined` rather than
 * inspecting exit codes.
 */
export async function gitRead(
  ctx: PlanContext,
  args: string[],
  options: GitReadOptions = {},
): Promise<string | undefined> {
  const res = await ctx.run(["git", "-C", ctx.root, ...args]);
  if (res.spawnError || res.code !== 0) return undefined;
  return options.trim === false ? res.stdout : res.stdout.replace(/\s+$/, "");
}

/** Parse a complete, non-negative, safe base-10 integer from Git output. */
export function gitInt(s: string | undefined): number | undefined {
  if (s === undefined || !/^[0-9]+$/.test(s)) return undefined;
  const value = Number(s);
  return Number.isSafeInteger(value) ? value : undefined;
}
