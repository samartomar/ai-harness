import type { Cli } from "../internals/clis.js";
import { type Action, doc, exec } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * ECC is installed by running ECC's OWN published installer — aih assembles no ECC
 * content itself. `npx --yes ecc-install` fetches the LATEST `ecc-universal` from
 * npm and installs it for the target CLI, so a fresh machine with no ECC checkout
 * and no user setup still gets the current version. aih only passes the target +
 * profile (the selection); ECC's installer does the rest.
 *
 * Source of truth: ECC's `SUPPORTED_INSTALL_TARGETS` in `scripts/install-apply.js`
 * (v2) — claude, claude-project, cursor, antigravity, codex, gemini, opencode,
 * qwen, zed. Intersected with the harness's own CLIs, the direct `--target`s are
 * the seven below. Kiro is NOT an `ecc-install` target (it ships only in the git
 * repo's `.kiro/`) — index.ts fetches the repo and runs ECC's `.kiro/install.sh`.
 * copilot / windsurf / kimi are NOT ECC targets — they route through the `consult`
 * advisor rather than fabricating a `--target` ECC's installer would reject.
 */
export const ECC_INSTALL_TARGETS: readonly Cli[] = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "opencode",
  "zed",
];

export function isEccInstallTarget(cli: Cli): boolean {
  return ECC_INSTALL_TARGETS.includes(cli);
}

export interface EccInstallInputs {
  /** ECC install profile: minimal | core | full. */
  profile: string;
  /** Short human stack summary for the advisor / summary docs. */
  stackSummary: string;
}

/** The `npx ecc-install` argv for a target CLI — latest from npm, scoped by profile. */
export function eccInstallerArgv(cli: Cli, profile: string): string[] {
  return ["npx", "--yes", "ecc-install", "--target", cli, "--profile", profile];
}

/** Run ECC's real installer (latest from npm) for a supported CLI, under --apply. */
function installerExec(cli: Cli, profile: string): Action {
  return exec(
    `Install ECC for ${cli} — npx ecc-install --target ${cli} --profile ${profile} (latest from npm, under --apply)`,
    eccInstallerArgv(cli, profile),
  );
}

/** Claude: the shell installer runs above; the marketplace plugin is the in-Claude alternative. */
function claudePluginDoc(): Action {
  return doc(
    "ECC for Claude Code — marketplace plugin (optional alternative)",
    lines(
      "The shell install above (`npx ecc-install --target claude`) is the reliable path and",
      "runs under `--apply`. If you prefer the marketplace plugin instead, run these INSIDE",
      "Claude Code — do NOT combine the two (that double-installs the same content):",
      "",
      "  /plugin marketplace add https://github.com/affaan-m/ECC",
      "  /plugin install ecc@ecc",
    ),
  );
}

/** CLIs ECC has no direct installer target for: route through the advisor. */
function consultDoc(cli: Cli, inputs: EccInstallInputs): Action {
  return doc(
    `Install ECC for ${cli} (via the consult advisor)`,
    lines(
      `${cli} is not a direct ECC installer target. Ask ECC's advisor (latest, from npm) for`,
      "the components + exact commands tailored to this stack, then apply them:",
      "",
      `  npx ecc consult "${inputs.stackSummary}" --target ${cli}`,
      "",
      `ECC installs directly for: ${ECC_INSTALL_TARGETS.join(", ")}. Kiro fetches ECC's repo`,
      "(latest) and runs its native `.kiro/install.sh`.",
    ),
  );
}

/** Build the ECC install action(s) for one CLI (Kiro is handled in index.ts). */
export function eccActionsForCli(cli: Cli, inputs: EccInstallInputs): Action[] {
  if (isEccInstallTarget(cli)) {
    const actions: Action[] = [installerExec(cli, inputs.profile)];
    if (cli === "claude") actions.push(claudePluginDoc());
    return actions;
  }
  return [consultDoc(cli, inputs)];
}

/** The ECC ecosystem tools doc (advisor + security scanner), emitted once. */
export function eccToolsDoc(): Action {
  return doc(
    "ECC ecosystem tools (run as needed)",
    lines(
      "ECC ships tools you run on demand (all `npx`, latest from npm):",
      "",
      '  npx ecc consult "<question>" --target <cli>   # advisor: which components to add',
      "  npx ecc-agentshield scan                       # scan your agent setup for risks",
      "  npx ecc-agentshield scan --fix                 # apply the safe fixes it finds",
      "",
      "`consult` recommends components for a task; `agentshield` audits your installed agent",
      "configuration (prompt-injection surface, over-broad permissions, leaked secrets).",
    ),
  );
}
