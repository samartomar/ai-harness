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

/** Find a local ECC checkout whose native Kiro installer exists. */
function findEccKiroInstaller(ctx: PlanContext): string | undefined {
  const home = ctx.env.USERPROFILE || ctx.env.HOME || homedir();
  const explicit = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(home, ".claude", "ecc"),
    join(home, "ECC"),
    join(home, "everything-claude-code"),
  ];
  for (const c of candidates) {
    const sh = join(c, ".kiro", "install.sh");
    if (existsSync(sh)) return sh;
  }
  return undefined;
}

/**
 * ECC's native Kiro path. ECC ships `.kiro/install.sh` which copies its agents,
 * skills, steering, and hooks into the repo's `.kiro/` (idempotent). If a local
 * ECC checkout is found, run it under `--apply`; otherwise document the clone +
 * install. On Windows it runs through Git Bash.
 */
function kiroEccActions(ctx: PlanContext): Action[] {
  const installer = findEccKiroInstaller(ctx);
  if (installer) {
    return [
      exec(
        `Install ECC for Kiro — run ECC's native .kiro/install.sh into ${ctx.root}/.kiro/ (under --apply)`,
        ["bash", installer, ctx.root],
      ),
      doc(
        "ECC Kiro install (native installer found)",
        lines(
          `Using the ECC checkout at \`${installer.replace(/[\\/]\.kiro[\\/]install\.sh$/, "")}\`.`,
          "`.kiro/install.sh` copies ECC's agents/skills/steering/hooks into this repo's",
          "`.kiro/` (idempotent, skips existing files). On Windows it runs via Git Bash.",
        ),
      ),
    ];
  }
  return [
    doc(
      "ECC Kiro install (clone + run the native installer)",
      lines(
        "ECC ships a native Kiro installer. Clone ECC and run it against this repo:",
        "",
        "  git clone https://github.com/affaan-m/ECC.git",
        `  bash ECC/.kiro/install.sh "${ctx.root}"`,
        "",
        "It copies ECC's agents, skills, steering, and hooks into `.kiro/` (idempotent).",
        "On Windows use Git Bash. Point aih at an existing checkout with",
        "`aih ecc --cli kiro --ecc-path <dir>`.",
      ),
    ),
  ];
}

/** A short, human-readable stack summary used in the `consult` advisor prompt. */
function stackSummary(stack: RepoStack): string {
  const parts: string[] = [];
  if (stack.languages.length > 0) parts.push(stack.languages.join(" + "));
  if (stack.frameworks.length > 0) parts.push(`using ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) parts.push(`on ${stack.cloud.join("/")}`);
  return parts.length > 0 ? parts.join(" ") : "a new repository with no detected stack yet";
}

function summaryDoc(clis: string[], inputs: EccInstallInputs): Action {
  const head = inputs.installEverything
    ? "No stack detected (empty/new repo) — ECC installs its FULL profile. Re-run"
    : `Detected ${stackSummaryShort(inputs)} — ECC installs the matching language packs. Re-run`;
  return doc(
    "ECC install summary (affaan-m/ECC)",
    lines(
      `${head} \`aih ecc\` after the stack changes to re-scope the install.`,
      "",
      `Target CLIs: ${clis.join(", ")}.`,
      `Profile: ${inputs.installEverything ? "full" : inputs.profile}.`,
      inputs.installEverything
        ? "Language packs: (full profile installs all)."
        : `Language packs: ${inputs.packs.length > 0 ? inputs.packs.join(", ") : "(baseline only — no language pack matched)"}.`,
      "",
      "ECC = the agent-harness performance system: skills, instincts, persistent",
      "memory, security, and research-first development. Shell-runnable installs",
      "(codex/cursor/zed/opencode) execute under `--apply`; the Claude plugin and",
      "consult-routed targets are emitted as commands for you to run in the tool.",
    ),
  );
}

function stackSummaryShort(inputs: EccInstallInputs): string {
  return inputs.packs.length > 0 ? inputs.packs.join("/") : "the baseline stack";
}

/**
 * Install and configure affaan-m/ECC — the agent-harness optimization system —
 * customized to the repo's detected stack and the user's selected CLIs
 * (`--cli claude,codex` / `--all-tools`, default `claude`).
 *
 * Per CLI, ECC offers a different install path, so the plan mixes `exec` and
 * `doc`: the `ecc-install` CLI runs under `--apply` for the targets it supports
 * (codex/cursor/zed/opencode), while Claude's plugin path and non-target CLIs
 * are emitted as exact commands to run inside the tool. Language packs come from
 * the profiler; an empty repo installs the full profile and self-scopes on a
 * re-run once there is code.
 */
async function eccPlan(ctx: PlanContext): Promise<Plan> {
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const stack = scanRepo(ctx.root, { maxDepth: 8 });
  const { packs, installEverything } = eccLanguages(stack);
  const profile = String(ctx.options.profile ?? "core");
  const inputs: EccInstallInputs = {
    profile,
    packs,
    installEverything,
    stackSummary: stackSummary(stack),
  };

  const actions: Action[] = [];
  for (const cli of clis) {
    // Kiro has a native ECC installer (.kiro/install.sh) — use it instead of the
    // generic consult route.
    if (cli === "kiro") actions.push(...kiroEccActions(ctx));
    else actions.push(...eccActionsForCli(cli, inputs));
  }
  actions.push(eccToolsDoc());
  if (detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }
  actions.push(summaryDoc(clis, inputs));
  return plan("ecc", ...actions);
}

export const command: CommandSpec = {
  name: "ecc",
  summary:
    "Install affaan-m/ECC (skills, memory, security, research-first) for the selected CLIs, scoped to the detected stack",
  options: [
    {
      flags: "--profile <profile>",
      description: "ECC install profile: minimal|core|full",
      default: "core",
    },
    {
      flags: "--ecc-path <dir>",
      description: "path to a local ECC checkout (for --cli kiro native install)",
    },
  ],
  plan: eccPlan,
};
