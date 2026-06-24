import type { Cli } from "../internals/clis.js";
import { type Action, doc, exec } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * Per-CLI install of obra/Superpowers — the agent-behavior layer (brainstorm ->
 * plan -> TDD -> subagent review skills). Commands are verified against
 * Superpowers v6. Some CLIs install via a shell binary (`agy`, `copilot`) so we
 * emit an `exec` that runs under `--apply`; others install via slash commands
 * inside the tool's own TUI (`/plugin`, `/plugins`) which a shell can't drive,
 * so those are emitted as `doc` commands to run in the tool.
 */

/** Claude Code: official-marketplace plugin (simplest) + the marketplace alt. */
function claudeDoc(): Action {
  return doc(
    "Install Superpowers for Claude Code (plugin)",
    lines(
      "Run inside Claude Code (slash commands, not shell):",
      "",
      "  /plugin install superpowers@claude-plugins-official",
      "",
      "Alternative via the Superpowers marketplace:",
      "  /plugin marketplace add obra/superpowers-marketplace",
      "  /plugin install superpowers@superpowers-marketplace",
    ),
  );
}

/** Codex / Kimi: plugin picker TUI (`/plugins`). */
function pluginsTuiDoc(label: string): Action {
  return doc(
    `Install Superpowers for ${label}`,
    lines(
      `Run \`/plugins\` inside ${label}, search "superpowers", then choose`,
      "Install Plugin. (The plugin picker is a TUI, so this can't be shell-run.)",
    ),
  );
}

/** Antigravity: `agy plugin install <repo>` (shell-runnable). */
function antigravityExec(): Action {
  return exec("Install Superpowers for Antigravity (agy plugin install) — runs under --apply", [
    "agy",
    "plugin",
    "install",
    "https://github.com/obra/superpowers",
  ]);
}

/** Copilot CLI: marketplace add + install (two shell commands). */
function copilotExecs(): Action[] {
  return [
    exec("Add the Superpowers marketplace to Copilot CLI — runs under --apply", [
      "copilot",
      "plugin",
      "marketplace",
      "add",
      "obra/superpowers-marketplace",
    ]),
    exec("Install Superpowers for Copilot CLI — runs under --apply", [
      "copilot",
      "plugin",
      "install",
      "superpowers@superpowers-marketplace",
    ]),
  ];
}

/** CLIs without a first-class Superpowers path yet: point at the INSTALL guide. */
function genericDoc(cli: Cli): Action {
  return doc(
    `Install Superpowers for ${cli} (see INSTALL guide)`,
    lines(
      `${cli} is not a first-class Superpowers target yet. Follow the current`,
      "per-tool steps in the Superpowers install guide:",
      "",
      "  https://github.com/obra/superpowers  (see INSTALL.md)",
    ),
  );
}

/** Build the Superpowers install action(s) for one CLI. */
export function superpowersActionsForCli(cli: Cli): Action[] {
  switch (cli) {
    case "claude":
      return [claudeDoc()];
    case "codex":
      return [pluginsTuiDoc("Codex CLI")];
    case "kimi":
      return [pluginsTuiDoc("Kimi CLI")];
    case "antigravity":
      return [antigravityExec()];
    case "copilot":
      return copilotExecs();
    default:
      // cursor, gemini, windsurf, opencode, zed
      return [genericDoc(cli)];
  }
}

/** What Superpowers is + how it complements ECC, emitted once. */
export function superpowersOverviewDoc(): Action {
  return doc(
    "Superpowers overview (obra/Superpowers)",
    lines(
      "Superpowers installs a disciplined SDLC as agent skills: brainstorm ->",
      "plan -> test-driven implementation -> subagent review, plus a library of",
      "reusable skills. It pairs with ECC (`aih ecc`): ECC supplies stack-aware",
      "rules/agents/memory; Superpowers supplies the behavioral loop that uses them.",
      "",
      "Shell-installable targets (Antigravity, Copilot) run under `--apply`; plugin-",
      "TUI targets (Claude, Codex, Kimi) are emitted as commands to run in the tool.",
    ),
  );
}
