import type { Cli } from "../internals/clis.js";
import { type Action, doc } from "../internals/plan.js";
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
function evidenceNote(pin?: string): string[] {
  if (pin === undefined) return [];
  return [
    "",
    `aih verified obra/Superpowers@${pin}, but the marketplace/TUI selection below`,
    "cannot prove it consumes those exact bytes and is therefore not evidence-covered.",
    "No install is executed by aih; require an exact local/commit adapter before automation.",
  ];
}

function claudeDoc(pin?: string): Action {
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
      ...evidenceNote(pin),
    ),
  );
}

/** Codex / Kimi: plugin picker TUI (`/plugins`). */
function pluginsTuiDoc(label: string, pin?: string): Action {
  return doc(
    `Install Superpowers for ${label}`,
    lines(
      `Run \`/plugins\` inside ${label}, search "superpowers", then choose`,
      "Install Plugin. (The plugin picker is a TUI, so this can't be shell-run.)",
      ...evidenceNote(pin),
    ),
  );
}

function evidenceBoundManualDoc(cli: "Antigravity" | "Copilot CLI", pin?: string): Action {
  const exact = pin ?? "the aih baseline pin";
  return doc(
    `Superpowers for ${cli} — exact-source adapter required`,
    lines(
      `aih's reviewed source is obra/Superpowers@${exact}.`,
      "The available plugin command fetches mutable repository/marketplace content and cannot",
      "bind the installed bytes to that commit, so aih deliberately does not run it.",
      "That marketplace selection is not evidence-covered. Use an organization-approved local",
      "checkout adapter pinned to the commit above, or keep this target uninstalled.",
    ),
  );
}

/** CLIs without a first-class Superpowers path yet: point at the INSTALL guide. */
function genericDoc(cli: Cli, pin?: string): Action {
  return doc(
    `Install Superpowers for ${cli} (see INSTALL guide)`,
    lines(
      `${cli} is not a first-class Superpowers target yet. Follow the current`,
      "per-tool steps in the Superpowers install guide:",
      "",
      "  https://github.com/obra/superpowers  (see INSTALL.md)",
      ...evidenceNote(pin),
    ),
  );
}

/** Build the Superpowers install action(s) for one CLI. */
export function superpowersActionsForCli(cli: Cli, pin?: string): Action[] {
  switch (cli) {
    case "claude":
      return [claudeDoc(pin)];
    case "codex":
      return [pluginsTuiDoc("Codex CLI", pin)];
    case "kimi":
      return [pluginsTuiDoc("Kimi CLI", pin)];
    case "antigravity":
      return [evidenceBoundManualDoc("Antigravity", pin)];
    case "copilot":
      return [evidenceBoundManualDoc("Copilot CLI", pin)];
    default:
      // cursor, gemini, windsurf, opencode, zed
      return [genericDoc(cli, pin)];
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
      "All marketplace/TUI targets are guidance-only because those installers cannot prove",
      "they consumed the evidence-verified commit. aih runs no mutable remote plugin install.",
    ),
  );
}

/** Advisory for shell-runnable Superpowers installs that fetch mutable remote plugin content. */
export function superpowersSupplyChainDoc(): Action {
  return doc(
    "Superpowers supply chain — shell installs fetch remote plugin content",
    lines(
      "Antigravity and Copilot plugin commands fetch mutable remote content, so aih does not",
      "execute them. Their marketplace selections are not covered by evidence for a different",
      "checkout; pin or mirror an exact local adapter before a governed rollout.",
    ),
  );
}
