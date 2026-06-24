import type { Cli } from "../internals/clis.js";
import { type Action, doc, exec } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { EccLanguagePack } from "./select.js";

/**
 * How affaan-m/ECC is installed for a given CLI:
 *  - `plugin`    — Claude Code's plugin marketplace (slash commands, can't be
 *                  shell-run, so emitted as a doc to run inside Claude Code);
 *  - `installer` — the `ecc-install` CLI targets it directly (shell-runnable,
 *                  emitted as an `exec` that runs under --apply);
 *  - `consult`   — not a first-class installer target; emitted as a doc that
 *                  routes the user through ECC's `consult` advisor.
 * Codex and Kiro are NOT `ecc-install` targets — ECC ships native scripts for
 * them (`scripts/sync-ecc-to-codex.sh`, `.kiro/install.sh`) that need a local
 * checkout, so they're handled in `index.ts` via clone discovery. OpenCode needs
 * no installer — it auto-detects the root `AGENTS.md` the canon writes.
 * Source: affaan-m/ECC README — `ecc-install --target` accepts claude|cursor|zed.
 */
export type EccMethod = "plugin" | "installer" | "consult";

/**
 * CLIs the `ecc-install` CLI targets directly (besides Claude's plugin path).
 * Verified against the affaan-m/ECC README, which documents `--target` only for
 * cursor and zed (claude defaults). Codex/Kiro use native scripts and OpenCode
 * auto-detects AGENTS.md — all three are intercepted in `eccPlan`, not here.
 */
const INSTALLER_TARGETS: readonly Cli[] = ["cursor", "zed"];

export function eccMethod(cli: Cli): EccMethod {
  if (cli === "claude") return "plugin";
  if (INSTALLER_TARGETS.includes(cli)) return "installer";
  return "consult";
}

export interface EccInstallInputs {
  profile: string;
  packs: EccLanguagePack[];
  installEverything: boolean;
  /** Short human stack summary for the `consult` advisor prompt. */
  stackSummary: string;
}

/** The `ecc-install` argv for a shell-runnable target, customized to the stack. */
export function eccInstallerArgv(
  cli: Cli,
  { profile, packs, installEverything }: EccInstallInputs,
): string[] {
  const base = ["npx", "--yes", "ecc-install", "--target", cli];
  if (installEverything) return [...base, "--profile", "full"];
  return [...base, "--profile", profile, ...packs];
}

function packsLabel(packs: EccLanguagePack[], installEverything: boolean): string {
  if (installEverything) return "full profile (no stack detected yet)";
  return packs.length > 0 ? `packs: ${packs.join(", ")}` : "baseline only";
}

/** Claude Code: the plugin marketplace path (recommended by ECC). */
function pluginDoc(cli: Cli, inputs: EccInstallInputs): Action {
  const altArgv = eccInstallerArgv(cli, inputs).join(" ");
  return doc(
    `Install ECC for Claude Code (plugin — ${packsLabel(inputs.packs, inputs.installEverything)})`,
    lines(
      "Install the ECC plugin (recommended). Run these inside Claude Code:",
      "",
      "  /plugin marketplace add https://github.com/affaan-m/ECC",
      "  /plugin install ecc@ecc",
      "",
      "This adds the ECC marketplace and installs the `ecc` plugin — 67 agents,",
      "skills, instincts, persistent memory, security, and research-first defaults.",
      "",
      "Non-plugin alternative (shell, no Claude restart):",
      `  ${altArgv}`,
      "",
      "Do NOT combine the plugin with `ecc-install --profile full` — that double-",
      "installs the same content. Pick one path (the plugin is recommended).",
    ),
  );
}

/** codex/cursor/zed/opencode: the shell installer (runs under --apply). */
function installerExec(cli: Cli, inputs: EccInstallInputs): Action {
  const argv = eccInstallerArgv(cli, inputs);
  return exec(
    `Install ECC for ${cli} (${packsLabel(inputs.packs, inputs.installEverything)}) — runs under --apply`,
    argv,
  );
}

/** Targets ECC doesn't install directly: route through the consult advisor. */
function consultDoc(cli: Cli, inputs: EccInstallInputs): Action {
  return doc(
    `Install ECC for ${cli} (via consult advisor)`,
    lines(
      `${cli} is not a first-class ECC installer target. Use the advisor to get`,
      "components + exact commands tailored to this stack, then apply them:",
      "",
      `  npx ecc consult "${inputs.stackSummary}" --target ${cli}`,
      "",
      "ECC installs directly for: claude (plugin), cursor, zed. Codex and Kiro use",
      "ECC's native sync/install scripts; OpenCode auto-detects the root `AGENTS.md`.",
      "For Gemini/Antigravity-style tools, ECC content is wired via the canonical",
      "context dir + thin adapters (see `aih scaffold`).",
    ),
  );
}

/** OpenCode: no installer — ECC loads via the root AGENTS.md the canon writes. */
export function opencodeEccDoc(): Action {
  return doc(
    "Install ECC for OpenCode (no installer needed)",
    lines(
      "OpenCode auto-detects the root `AGENTS.md`, so ECC's guidance loads from the",
      "canon's bootloader — run `aih bootstrap-ai --cli opencode` to write it. ECC has",
      "no `ecc-install` target for OpenCode. For extra agents/skills/MCP, use the advisor:",
      "",
      '  npx ecc consult "<your stack>" --target opencode',
    ),
  );
}

/** Build the ECC install action(s) for one CLI per its supported method. */
export function eccActionsForCli(cli: Cli, inputs: EccInstallInputs): Action[] {
  switch (eccMethod(cli)) {
    case "plugin":
      return [pluginDoc(cli, inputs)];
    case "installer":
      return [installerExec(cli, inputs)];
    default:
      return [consultDoc(cli, inputs)];
  }
}

/** The ECC ecosystem tools doc (advisor + security scanner), emitted once. */
export function eccToolsDoc(): Action {
  return doc(
    "ECC ecosystem tools (run as needed)",
    lines(
      "ECC ships two tools you run on demand:",
      "",
      '  npx ecc consult "<question>" --target <cli>   # advisor: which agents/skills/MCP to add',
      "  npx ecc-agentshield scan                       # scan your agent setup for risks",
      "  npx ecc-agentshield scan --fix                 # apply the safe fixes it finds",
      "",
      "`consult` recommends components for a task; `agentshield` audits your installed",
      "agent configuration (prompt-injection surface, over-broad permissions, leaked",
      "secrets) and can auto-remediate the safe findings.",
    ),
  );
}
