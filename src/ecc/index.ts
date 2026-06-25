import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectFallbackNotice, resolveTargets } from "../internals/cli-detect.js";
import {
  type Action,
  type CommandSpec,
  doc,
  exec,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";
import { scanRepo } from "../profile/scan.js";
import { type EccInstallInputs, eccActionsForCli, eccToolsDoc } from "./install.js";
import { eccLanguages } from "./select.js";

const ECC_REPO_URL = "https://github.com/affaan-m/ECC.git";

/** Cache dir for ECC's git checkout (Kiro isn't on npm, so it needs the repo). */
function eccCacheDir(ctx: PlanContext): string {
  const home = ctx.env.USERPROFILE || ctx.env.HOME || homedir();
  return join(home, ".claude", "ecc");
}

/**
 * ECC's Kiro path. Kiro content isn't on npm, so aih uses a git checkout of ECC
 * and runs its native `.kiro/install.sh` (which copies ECC's curated Kiro
 * agents/skills/steering/hooks/scripts/settings into the repo's `.kiro/`,
 * idempotent). To stay on the LATEST version with no pre-existing checkout: a
 * shallow `git clone` into a cache dir on first run, `git pull` to refresh on
 * later runs. `--ecc-path <dir>` overrides with an existing local checkout. Every
 * step is an `exec` that runs only under `--apply`; on Windows it uses Git Bash.
 */
function kiroEccActions(ctx: PlanContext): Action[] {
  const explicit = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  const dir = explicit || eccCacheDir(ctx);
  const posix = dir.replace(/\\/g, "/");
  const installExec = exec(
    `Install ECC for Kiro — run ${posix}/.kiro/install.sh into ${ctx.root}/.kiro/ (under --apply)`,
    ["bash", join(dir, ".kiro", "install.sh"), ctx.root],
  );

  if (explicit) {
    return [
      installExec,
      doc(
        "ECC Kiro install (local checkout via --ecc-path)",
        lines(
          `Using the ECC checkout at \`${posix}\`. \`.kiro/install.sh\` copies ECC's curated`,
          "Kiro agents/skills/steering/hooks/scripts/settings into this repo's `.kiro/`",
          "(idempotent). On Windows it runs via Git Bash.",
        ),
      ),
    ];
  }

  // Fresh machine: shallow-clone ECC into the cache on first run, pull to refresh
  // to the latest on later runs, then run the native installer.
  const hasCache = existsSync(join(dir, ".git"));
  const fetchExec = hasCache
    ? exec(
        `Update cached ECC to latest — git -C ${posix} pull (under --apply)`,
        ["git", "-C", dir, "pull", "--ff-only"],
        { allowFailure: true },
      )
    : exec(`Clone ECC (latest, shallow) into ${posix} — git clone --depth 1 (under --apply)`, [
        "git",
        "clone",
        "--depth",
        "1",
        ECC_REPO_URL,
        dir,
      ]);

  return [
    fetchExec,
    installExec,
    doc(
      "ECC Kiro install (latest via cached git checkout)",
      lines(
        "Kiro content isn't on npm, so aih keeps a shallow git checkout of ECC at",
        `\`${posix}\` — ${hasCache ? "refreshed to the latest with `git pull`" : "cloned with `git clone --depth 1`"}`,
        "on this run — and runs ECC's native `.kiro/install.sh` to copy its curated Kiro",
        "agents, skills, steering, hooks, scripts, and settings into this repo's `.kiro/`",
        "(idempotent). Requires git + Git Bash on PATH. Point at an existing checkout instead",
        "with `--ecc-path <dir>`.",
      ),
    ),
  ];
}

/** A short, human-readable stack summary for the advisor + summary docs. */
function stackSummary(stack: RepoStack): string {
  const parts: string[] = [];
  if (stack.languages.length > 0) parts.push(stack.languages.join(" + "));
  if (stack.frameworks.length > 0) parts.push(`using ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) parts.push(`on ${stack.cloud.join("/")}`);
  return parts.length > 0 ? parts.join(" ") : "a new repository with no detected stack yet";
}

function summaryDoc(clis: string[], inputs: EccInstallInputs, stack: RepoStack): Action {
  const { packs, installEverything } = eccLanguages(stack);
  const scope = installEverything
    ? "no stack detected yet (empty/new repo)"
    : packs.length > 0
      ? `stack packs: ${packs.join(", ")}`
      : "baseline stack (no language pack matched)";
  return doc(
    "ECC install summary (affaan-m/ECC — latest, via ECC's own installer)",
    lines(
      `Target CLIs: ${clis.join(", ")}.  Profile: ${inputs.profile}.  Detected ${scope}.`,
      "",
      "aih runs ECC's OWN installer at the LATEST version — it assembles nothing itself:",
      `  • npm targets → npx ecc-install --target <cli> --profile ${inputs.profile}  (no clone)`,
      "  • Kiro → cached git checkout of ECC (clone/pull to latest) + native .kiro/install.sh",
      "",
      "Re-run after the stack changes to re-scope. For finer component control (specific",
      `skills/agents/capabilities) ask the advisor:  npx ecc consult "${inputs.stackSummary}" --target <cli>`,
    ),
  );
}

/**
 * Install affaan-m/ECC — the agent-harness optimization system — for the user's
 * selected CLIs (`--cli claude,codex` / `--all-tools`, default `claude`), at the
 * LATEST published version, scoped by `--profile`.
 *
 * aih never assembles ECC content: it runs ECC's own installer. npm-target CLIs
 * use `npx ecc-install --target <cli>` (latest from npm, no checkout needed);
 * Kiro (not on npm) uses a cached git checkout + ECC's native `.kiro/install.sh`;
 * CLIs ECC has no direct installer for are routed through the `consult` advisor.
 * Every network/install step is an `exec` that runs only under `--apply`.
 */
async function eccPlan(ctx: PlanContext): Promise<Plan> {
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const profile = String(ctx.options.profile ?? "core");
  const inputs: EccInstallInputs = { profile, stackSummary: stackSummary(stack) };

  const actions: Action[] = [];
  for (const cli of clis) {
    if (cli === "kiro") actions.push(...kiroEccActions(ctx));
    else actions.push(...eccActionsForCli(cli, inputs));
  }
  actions.push(eccToolsDoc());
  if (detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }
  actions.push(summaryDoc(clis, inputs, stack));
  return plan("ecc", ...actions);
}

export const command: CommandSpec = {
  name: "ecc",
  summary:
    "Install affaan-m/ECC (latest) for the selected CLIs via ECC's own installer — npx ecc-install, or a cached git checkout for Kiro",
  options: [
    {
      flags: "--profile <profile>",
      description: "ECC install profile: minimal|core|full",
      default: "core",
    },
    {
      flags: "--ecc-path <dir>",
      description: "use an existing local ECC checkout for --cli kiro (instead of clone/pull)",
    },
  ],
  plan: eccPlan,
};
