import { join } from "node:path";
import {
  type CommandSpec,
  doc,
  envBlock,
  exec,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import { redirectEnv } from "./redirects.js";

const SCOPE = "vdi";

/** Resolve the scratch root: explicit `--scratch` wins, else the host default. */
function resolveScratch(ctx: PlanContext, user: string): string {
  const override = ctx.options.scratch;
  if (typeof override === "string" && override.length > 0) return override;
  return ctx.host.scratchDir(user);
}

/**
 * Compute the VDI redirection plan.
 *
 * On a non-VDI host this is a no-op: a single `doc` explains why nothing was
 * redirected (carrying `detectVdi().reason`) and a `probe` records the negative
 * detection — no files are written and no commands run.
 *
 * On a VDI host it redirects heavy caches and the code-review-graph SQLite DB
 * onto local scratch so they never traverse the profile-sync boundary:
 *  - merge redirect env vars into the shell profile (idempotent managed block);
 *  - create the scratch root (`mkdir`, allowed to fail if it already exists);
 *  - junction/symlink `~/.code-review-graph` onto scratch.
 * All mutation stays local — there is no remote step, so nothing belongs in a
 * `doc` here beyond verification context.
 */
function vdiPlan(ctx: PlanContext) {
  const vdi = ctx.host.detectVdi();

  if (!vdi.isVdi) {
    return plan(
      SCOPE,
      doc(
        "no VDI detected — no cache redirection needed",
        `This host shows no VDI markers (${vdi.reason}), so caches and the code-review-graph database stay in place. Re-run aih vdi inside a Citrix/WorkSpaces/RES/RDP session to redirect them onto local scratch.`,
      ),
      probe("VDI detection", () => ({
        name: "VDI detection",
        verdict: "skip",
        detail: `not a VDI host (${vdi.reason})`,
      })),
    );
  }

  const user = ctx.env.USERNAME || ctx.env.USER || "dev";
  const scratch = resolveScratch(ctx, user);
  const home = ctx.env.USERPROFILE || ctx.env.HOME || "";

  const shell = ctx.host.envShell();
  const profilePath = ctx.host.shellProfilePaths()[0] ?? "";

  const mkdirArgv =
    ctx.host.platform === "windows" ? ["cmd", "/c", "mkdir", scratch] : ["mkdir", "-p", scratch];

  const crgLink = join(home, ".code-review-graph");
  const crgTarget = join(scratch, "code-review-graph");

  return plan(
    SCOPE,
    envBlock(
      profilePath,
      SCOPE,
      shell,
      redirectEnv(scratch),
      `redirect caches/SQLite onto local scratch (${vdi.reason})`,
    ),
    exec("create local scratch root", mkdirArgv, { allowFailure: true }),
    exec(
      "redirect code-review-graph to scratch (junction/symlink)",
      ctx.host.symlinkDirArgv(crgLink, crgTarget),
    ),
    probe("VDI detection", () => ({
      name: "VDI detection",
      verdict: "pass",
      detail: `${vdi.reason} → scratch ${scratch}`,
    })),
  );
}

export const command: CommandSpec = {
  name: "vdi",
  summary: "Detect VDI environments and redirect caches/SQLite to local scratch",
  options: [{ flags: "--scratch <dir>", description: "override the local scratch root" }],
  plan: vdiPlan,
};
