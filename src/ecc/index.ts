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
import { type EccInstallInputs, eccActionsForCli, eccToolsDoc, opencodeEccDoc } from "./install.js";
import { eccLanguages } from "./select.js";

/** Candidate roots for a local ECC checkout (explicit `--ecc-path` wins). */
function eccCheckoutRoots(ctx: PlanContext): string[] {
  const home = ctx.env.USERPROFILE || ctx.env.HOME || homedir();
  const explicit = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  return [
    ...(explicit ? [explicit] : []),
    join(home, ".claude", "ecc"),
    join(home, "ECC"),
    join(home, "everything-claude-code"),
  ];
}

/** Find a local ECC checkout containing `relPath` (a native installer script). */
function findEccScript(
  ctx: PlanContext,
  relPath: string,
): { script: string; root: string } | undefined {
  for (const root of eccCheckoutRoots(ctx)) {
    const script = join(root, relPath);
    if (existsSync(script)) return { script, root };
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
  const found = findEccScript(ctx, join(".kiro", "install.sh"));
  if (found) {
    return [
      exec(
        `Install ECC for Kiro — run ECC's native .kiro/install.sh into ${ctx.root}/.kiro/ (under --apply)`,
        ["bash", found.script, ctx.root],
      ),
      doc(
        "ECC Kiro install (native installer found)",
        lines(
          `Using the ECC checkout at \`${found.root}\`.`,
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

/**
 * ECC's native Codex path. ECC ships `scripts/sync-ecc-to-codex.sh`, which merges
 * its AGENTS.md, prompts, agents, MCP servers, and git hooks into `~/.codex/`
 * (add-only, with timestamped backups). It is NOT an `ecc-install --target`. If a
 * local ECC checkout is found, run it under `--apply`; otherwise document the
 * clone + run. Requires an existing `~/.codex/config.toml`; on Windows, Git Bash.
 */
function codexEccActions(ctx: PlanContext): Action[] {
  const found = findEccScript(ctx, join("scripts", "sync-ecc-to-codex.sh"));
  if (found) {
    return [
      exec(
        "Install ECC for Codex — run ECC's native sync-ecc-to-codex.sh into ~/.codex/ (under --apply)",
        ["bash", found.script],
      ),
      doc(
        "ECC Codex install (native sync script found)",
        lines(
          `Using the ECC checkout at \`${found.root}\`.`,
          "`scripts/sync-ecc-to-codex.sh` merges ECC's AGENTS.md, prompts, agents, MCP",
          "servers, and git hooks into `~/.codex/` (add-only — backs up, never deletes).",
          "Requires an existing `~/.codex/config.toml` and Node.js. On Windows: Git Bash.",
        ),
      ),
    ];
  }
  return [
    doc(
      "ECC Codex install (clone + run the native sync script)",
      lines(
        "ECC wires Codex via a native sync script (not `ecc-install`). Clone ECC and run it:",
        "",
        "  git clone https://github.com/affaan-m/ECC.git",
        "  cd ECC && npm install && bash scripts/sync-ecc-to-codex.sh",
        "",
        "It merges ECC's AGENTS.md, prompts, agents, MCP servers, and git hooks into",
        "`~/.codex/` (add-only, with timestamped backups). Requires an existing",
        "`~/.codex/config.toml`. Point aih at a checkout with `aih ecc --cli codex --ecc-path <dir>`.",
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
      "memory, security, and research-first development. The `ecc-install` targets",
      "(cursor/zed) execute under `--apply`; Codex and Kiro run ECC's native",
      "sync/install scripts from a local clone; the Claude plugin, OpenCode's",
      "AGENTS.md auto-detect, and consult-routed targets are emitted as commands.",
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
 * `doc`: the `ecc-install` CLI runs under `--apply` for cursor/zed; Codex and
 * Kiro run ECC's native sync/install scripts from a local clone (also `exec`);
 * Claude's plugin path, OpenCode's AGENTS.md auto-detect, and non-target CLIs are
 * emitted as exact commands to run. Language packs come from the profiler; an
 * empty repo installs the full profile and self-scopes on a re-run once there is code.
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
    // Codex, Kiro, and OpenCode are not `ecc-install` targets: Codex/Kiro have
    // native scripts (run from a local clone) and OpenCode auto-detects AGENTS.md.
    if (cli === "kiro") actions.push(...kiroEccActions(ctx));
    else if (cli === "codex") actions.push(...codexEccActions(ctx));
    else if (cli === "opencode") actions.push(opencodeEccDoc());
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
      description: "path to a local ECC checkout (for --cli kiro/codex native install)",
    },
  ],
  plan: eccPlan,
};
