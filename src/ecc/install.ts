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
  /**
   * Optional pin for `npx ecc-install@<version>` (enterprise supply-chain control,
   * from `AIH_ECC_INSTALL_VERSION`). Unset → latest from npm.
   */
  installVersion?: string;
}

/** The npm spec for the ECC installer — pinned `ecc-install@<ver>` or bare (latest). */
function installerSpec(version?: string): string {
  return version && version.length > 0 ? `ecc-install@${version}` : "ecc-install";
}

/** The `npx ecc-install` argv for a target CLI — version-pinnable, scoped by profile. */
export function eccInstallerArgv(cli: Cli, profile: string, version?: string): string[] {
  return ["npx", "--yes", installerSpec(version), "--target", cli, "--profile", profile];
}

/** Run ECC's real installer for a supported CLI, under --apply (pinned if requested). */
function installerExec(cli: Cli, profile: string, version?: string): Action {
  const spec = installerSpec(version);
  const tag = version ? `pinned ${spec}` : "latest from npm";
  return exec(
    `Install ECC for ${cli} — npx ${spec} --target ${cli} --profile ${profile} (${tag}, under --apply)`,
    eccInstallerArgv(cli, profile, version),
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
    const actions: Action[] = [installerExec(cli, inputs.profile, inputs.installVersion)];
    if (cli === "claude") actions.push(claudePluginDoc());
    return actions;
  }
  return [consultDoc(cli, inputs)];
}

/**
 * A supply-chain advisory emitted whenever ECC runs UNPINNED (the default `latest`
 * surfaces). Names the mutable-upstream execution explicitly and how to pin/mirror
 * it for an enterprise rollout — the "explicit acknowledgement" the review asked for.
 */
export function eccSupplyChainDoc(): Action {
  return doc(
    "⚠ supply chain — ECC runs LATEST upstream unless you pin it",
    lines(
      "By design aih runs ECC's own installer at its LATEST published version, so what",
      "executes can change after review. For a governed/enterprise rollout, pin it:",
      "",
      "  AIH_ECC_INSTALL_VERSION=<x.y.z>   # pins `npx ecc-install@<x.y.z>` (npm targets)",
      "  AIH_ECC_REF=<tag|sha>             # pins the Kiro git checkout to a tag/commit",
      "  AIH_MCP_FS_VERSION=<x.y.z>        # pins the workspace filesystem MCP server",
      "",
      "Or mirror `ecc-install` / `@modelcontextprotocol/server-filesystem` into your",
      "internal registry and point npm/uv at it. Unpinned `npx`/`git pull` execution is",
      "the residual supply-chain risk — pin or mirror before an air-gapped/audited deploy.",
    ),
  );
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
