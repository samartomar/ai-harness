import type { PlanContext } from "./plan.js";

/**
 * Run a read-only git command scoped to the repo root, through the injected
 * Runner (so tests stay hermetic). Returns trimmed stdout, or `undefined` when
 * git is absent / the command fails — callers branch on `undefined` rather than
 * inspecting exit codes.
 */
export async function gitRead(ctx: PlanContext, args: string[]): Promise<string | undefined> {
  const res = await ctx.run(["git", "-C", ctx.root, ...args]);
  if (res.spawnError || res.code !== 0) return undefined;
  return res.stdout.replace(/\s+$/, "");
}

/** Parse a base-10 int from possibly-undefined git output; `fallback` on miss. */
export function gitInt(s: string | undefined, fallback = 0): number {
  const n = Number.parseInt((s ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}
