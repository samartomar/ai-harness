import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Action, digest, type PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { captured, type HealStep } from "./common.js";
import { pathFixDoc } from "./templates.js";

/** The conventional per-user tool dir aih and many installers drop binaries into. */
function userBinDir(ctx: PlanContext): string {
  const home = ctx.env.HOME ?? ctx.env.USERPROFILE ?? ctx.root;
  return join(home, ".local", "bin");
}

/** PATH membership, tolerant of the Windows `Path` casing and `;` vs `:` separators. */
function onPath(ctx: PlanContext, dir: string): boolean {
  const raw = ctx.env.PATH ?? ctx.env.Path ?? "";
  const sep = ctx.host.platform === "windows" ? ";" : ":";
  const norm = (p: string) =>
    ctx.host.platform === "windows" ? p.replace(/\\/g, "/").toLowerCase() : p;
  const target = norm(dir).replace(/[/\\]+$/, "");
  return raw
    .split(sep)
    .map((p) => norm(p.trim()).replace(/[/\\]+$/, ""))
    .includes(target);
}

/**
 * PATH self-heal. The fix is emitted as reviewed guidance (a `digest`), not an
 * auto-edit: prepending to PATH needs shell-variable expansion that the env-block
 * primitive deliberately quotes away, and a raw profile write would clobber the
 * composed `certs` block. So heal diagnoses and hands over the exact, correct line.
 */
async function planPathHeal(ctx: PlanContext): Promise<Action[]> {
  const dir = userBinDir(ctx);
  const exists = existsSync(dir);
  const present = exists && onPath(ctx, dir);

  let check: Check;
  if (!exists) {
    check = {
      name: "path: ~/.local/bin",
      verdict: "skip",
      detail: `${dir} not present (nothing installed there)`,
    };
  } else if (present) {
    check = { name: "path: ~/.local/bin", verdict: "pass", detail: `${dir} on PATH` };
  } else {
    check = {
      name: "path: ~/.local/bin",
      verdict: "fail",
      detail: `${dir} exists but is not on PATH`,
    };
  }

  const actions: Action[] = [captured(check)];
  if (check.verdict === "fail") {
    actions.push(digest("heal: add the tool dir to PATH", pathFixDoc(dir, ctx.host.envShell())));
  }
  return actions;
}

export const pathStep: HealStep = {
  key: "path",
  title: "PATH resolution",
  plan: planPathHeal,
};
