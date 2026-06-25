import { lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Action,
  type CommandSpec,
  doc,
  envBlock,
  exec,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import { assertNoCmdInjection } from "../internals/shell-safety.js";
import { redirectEnv } from "./redirects.js";

const SCOPE = "vdi";

/** The on-disk state of the code-review-graph link path (decides redirect safety). */
type LinkState = "absent" | "correct" | "wrong-link" | "directory" | "file";

/** Compare two link targets tolerantly (strip Windows `\\?\`, normalize, case-fold on win32). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const stripped = resolve(p.replace(/^\\\\\?\\/, ""));
    return process.platform === "win32" ? stripped.toLowerCase() : stripped;
  };
  return norm(a) === norm(b);
}

/**
 * Classify what already lives at the link path. `readlink` succeeds for BOTH POSIX
 * symlinks and Windows junctions (so a correct junction re-reads as `correct`, not
 * `directory`); a real directory/file throws EINVAL and falls through.
 */
function linkState(linkPath: string, target: string): LinkState {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(linkPath);
  } catch {
    return "absent";
  }
  try {
    return samePath(readlinkSync(linkPath), target) ? "correct" : "wrong-link";
  } catch {
    // not a link — a real directory or file occupies the path
  }
  return st.isDirectory() ? "directory" : "file";
}

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
        `This host shows no VDI markers (${vdi.reason}), so caches and the code-review-graph database stay in place. Re-run aih vdi inside a Citrix/WorkSpaces/AVD/Horizon/RES/RDP session to redirect them onto local scratch — or, when imaging a fleet where the platform can't be sniffed from the environment (Amazon WorkSpaces, AVD), declare it with AIH_VDI_KIND=<citrix|workspaces|res|rdp|generic>.`,
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

  // On Windows the scratch path flows into `cmd /c mkdir` and `mklink /J`, both of
  // which let cmd.exe re-parse the argument — reject command-injection metacharacters.
  if (ctx.host.platform === "windows") assertNoCmdInjection(scratch, "--scratch");

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
    redirectAction(ctx, crgLink, crgTarget),
    probe("VDI detection", () => ({
      name: "VDI detection",
      verdict: "pass",
      detail: `${vdi.reason} → scratch ${scratch}`,
    })),
  );
}

/**
 * Choose the code-review-graph redirect action by the link path's current state —
 * never blindly emit a junction/symlink (mklink /J fails if the path exists; POSIX
 * `ln -sfn target dir` would nest the link INSIDE an existing directory). Only link
 * when absent; no-op when already correct; refuse + instruct when something else
 * occupies the path (fail closed, never clobber the operator's data).
 */
function redirectAction(ctx: PlanContext, crgLink: string, crgTarget: string): Action {
  const state = linkState(crgLink, crgTarget);
  if (state === "absent") {
    return exec(
      "redirect code-review-graph to scratch (junction/symlink)",
      ctx.host.symlinkDirArgv(crgLink, crgTarget),
    );
  }
  if (state === "correct") {
    return doc(
      "code-review-graph already redirected (no-op)",
      `${crgLink} already points at ${crgTarget} — nothing to do.`,
    );
  }
  const what = state === "wrong-link" ? "a link to a different target" : `an existing ${state}`;
  return doc(
    "code-review-graph redirect needs manual migration",
    `${crgLink} is ${what}; aih will not overwrite it. Move its contents to ${crgTarget}, ` +
      `remove ${crgLink}, then re-run \`aih vdi --apply\` to create the redirect.`,
  );
}

export const command: CommandSpec = {
  name: "vdi",
  summary: "Detect VDI environments and redirect caches/SQLite to local scratch",
  options: [{ flags: "--scratch <dir>", description: "override the local scratch root" }],
  plan: vdiPlan,
};
