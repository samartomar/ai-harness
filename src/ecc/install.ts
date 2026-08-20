import { AihError } from "../errors.js";
import type { Cli } from "../internals/clis.js";
import { type Action, doc, exec } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Platform } from "../platform/base.js";
import { execArgv } from "../tools/install.js";
import type { EccInstallMechanism } from "./install-manifest.js";
import { ECC_INSTALL_TARGETS as ECC_INSTALL_TARGET_TUPLE } from "./install-targets.js";
import type { EccLanguagePack } from "./select.js";

/**
 * ECC is installed by running ECC's OWN published installer — aih assembles no ECC
 * content itself. `npx --yes --package ecc-universal ecc-install` fetches the
 * LATEST `ecc-universal` from npm and runs its `ecc-install` bin for the target
 * CLI, so a fresh machine with no ECC checkout and no user setup still gets the
 * current version. aih only passes the target + profile (the selection); ECC's
 * installer does the rest.
 *
 * Source of truth: ECC's `SUPPORTED_INSTALL_TARGETS` in `scripts/install-apply.js`
 * (v2) — claude, claude-project, cursor, antigravity, codex, gemini, opencode,
 * qwen, zed. Intersected with the harness's own CLIs, the supported upstream
 * targets are the seven below. Codex is special-cased in index.ts because the
 * upstream target copies shared `~/.codex` files; aih routes it through ECC's
 * add-only merge helpers instead. Kiro is NOT an `ecc-install` target (it ships
 * only in the git repo's `.kiro/`) — index.ts fetches the repo and runs ECC's
 * `.kiro/install.sh`.
 * copilot / windsurf / kimi are NOT ECC targets — they route through the `consult`
 * advisor rather than fabricating a `--target` ECC's installer would reject.
 */
export const ECC_INSTALL_TARGETS: readonly Cli[] = ECC_INSTALL_TARGET_TUPLE;

export const AIH_DIRECT_ECC_INSTALL_TARGETS: readonly Cli[] = ECC_INSTALL_TARGETS.filter(
  (cli) => cli !== "codex",
);

export function isEccInstallTarget(cli: Cli): boolean {
  return ECC_INSTALL_TARGETS.includes(cli);
}

export function isAihDirectEccInstallTarget(cli: Cli): boolean {
  return AIH_DIRECT_ECC_INSTALL_TARGETS.includes(cli);
}

/** A mechanism that writes files, or `consult` — the advisor path, which installs nothing. */
export type EccMechanism = EccInstallMechanism | "consult";

/**
 * How each registered CLI actually gets ECC installed — the SINGLE source of truth for
 * both routing and the user-facing per-mechanism claim.
 *
 * The four mechanisms have genuinely different rerun semantics (#555), so one blanket
 * promise is false for at least one of them. The mapping is EXPLICIT and the default is
 * `consult`: a newly registered tool installs nothing until someone deliberately maps
 * it, so it can never INHERIT a claim that is untrue for it. That is the hand-kept-list
 * failure #553 hit and #559 fixed structurally for directory loading.
 */
const ECC_INSTALL_MECHANISMS_BY_CLI: Partial<Record<Cli, EccInstallMechanism>> = {
  ...Object.fromEntries(AIH_DIRECT_ECC_INSTALL_TARGETS.map((cli) => [cli, "npm" as const])),
  codex: "checkout-merge",
  kiro: "native-script",
};

export function eccInstallMechanism(cli: Cli): EccMechanism {
  return ECC_INSTALL_MECHANISMS_BY_CLI[cli] ?? "consult";
}

/**
 * Repo-relative directory an install writes into, for targets whose written surface aih
 * can bound. Declared, never derived — and deliberately REPO-LOCAL only.
 *
 * Codex and the npm targets install into HOME-scoped dirs (`~/.codex`, `~/.claude`)
 * shared by every repo on the machine, so a repo-local manifest could not honestly claim
 * ownership of what it finds there — another repo's install may have written it. Those
 * targets therefore declare no managed root and receive no ownership claim at all, which
 * is the fail-closed answer rather than a false one. Kiro installs into the repo's own
 * `.kiro/`, is absence-guarded, and is the target this drift detection exists for (#555).
 */
const ECC_MANAGED_ROOTS: Partial<Record<Cli, string>> = { kiro: ".kiro" };

/** The repo-relative root aih can prove ownership within, when there is one. */
export function eccManagedRoot(cli: Cli): string | undefined {
  return ECC_MANAGED_ROOTS[cli];
}

/** Short human label per mechanism (reports and the coverage test key off this). */
export const ECC_INSTALL_MECHANISM_LABELS: Record<EccMechanism, string> = {
  npm: "ECC's npm installer",
  "checkout-merge": "cached ECC checkout + add-only merge helpers",
  "native-script": "cached ECC checkout + ECC's native .kiro/install.sh",
  consult: "consult advisor — installs nothing",
};

/** The mechanisms a CLI selection actually uses, in canonical order. */
export function eccMechanismsFor(clis: readonly Cli[]): EccMechanism[] {
  const order: EccMechanism[] = ["npm", "checkout-merge", "native-script", "consult"];
  const used = new Set(clis.map(eccInstallMechanism));
  return order.filter((mechanism) => used.has(mechanism));
}

/** How the install runs, per mechanism — emitted ONLY for the mechanisms in play. */
export function eccMechanismInstallLines(clis: readonly Cli[], profile: string): string[] {
  const claim: Record<EccMechanism, string> = {
    npm: `  • npm targets → npx --package ecc-universal ecc-install --target <cli> --profile ${profile}  (no clone)`,
    "checkout-merge":
      "  • Codex → cached git checkout of ECC + add-only config/MCP/AGENTS merge helpers",
    "native-script":
      "  • Kiro → cached git checkout of ECC (clone/pull to latest) + native .kiro/install.sh",
    consult: "  • consult targets → npx ecc consult — advisory only, they install nothing",
  };
  return eccMechanismsFor(clis).map((mechanism) => claim[mechanism]);
}

/**
 * What a RERUN does, per mechanism (#558's honesty half, now registry-driven). No
 * mechanism replaces already-installed content, so none can re-scope an existing
 * install — but the REASON differs per mechanism, and only the reasons true for the
 * SELECTED targets are emitted.
 */
export function eccMechanismRerunLines(clis: readonly Cli[]): string[] {
  const claim: Record<EccMechanism, string> = {
    npm: "For npm targets the update behavior is ECC's own installer's, not aih's.",
    "checkout-merge": "The Codex merge helpers are add-only.",
    "native-script": "Kiro's native installer copies only absent destinations.",
    consult: "Consult targets install nothing at all.",
  };
  const mechanisms = eccMechanismsFor(clis);
  const writes = mechanisms.filter((mechanism) => mechanism !== "consult");
  return [
    ...(writes.length > 0
      ? [
          "Re-running ADDS newly-matched content; it does not replace or remove what is",
          "already installed — so a rerun cannot re-scope an existing install.",
        ]
      : []),
    ...mechanisms.map((mechanism) => claim[mechanism]),
  ];
}

export interface EccInstallInputs {
  /** ECC install profile: minimal | core | full. */
  profile: string;
  /** Short human stack summary for the advisor / summary docs. */
  stackSummary: string;
  /**
   * Host platform — routes the `npx` installer through `cmd /c` on Windows, where
   * `execFile` cannot spawn a `.cmd` shim directly (npm/npx have no `.exe`).
   */
  platform: Platform;
  /**
   * Optional pin for `npx --package ecc-universal@<version> ecc-install`
   * (enterprise supply-chain control, from `AIH_ECC_INSTALL_VERSION`). Unset →
   * latest from npm.
   */
  installVersion?: string;
  /** Stack-specific ECC language packs appended after --profile. */
  packs?: readonly EccLanguagePack[];
}

export const ECC_NPM_PACKAGE = "ecc-universal";
export const ECC_NPM_BIN = "ecc-install";
export const ECC_NPM_CLI_BIN = "ecc";
export const ECC_NPM_BINS = [ECC_NPM_BIN, ECC_NPM_CLI_BIN] as const;

/** The npm package spec for ECC's installer package — pinned or bare latest. */
function installerPackageSpec(version?: string): string {
  return version && version.length > 0 ? `${ECC_NPM_PACKAGE}@${version}` : ECC_NPM_PACKAGE;
}

export function normalizeEccInstallVersion(raw: string | undefined): string | undefined {
  const version = (raw ?? "").trim();
  if (version.length === 0) return undefined;
  if (
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      version,
    )
  ) {
    return version;
  }
  throw new AihError(
    "AIH_ECC_INSTALL_VERSION must be an exact semver version like 1.2.3; tags and ranges such as `latest` are not accepted",
    "AIH_CONFIG",
  );
}

/** The `npx --package ecc-universal ecc-install` argv for a target CLI. */
export function eccInstallerArgv(
  cli: Cli,
  profile: string,
  version?: string,
  packs: readonly EccLanguagePack[] = [],
): string[] {
  return [
    "npx",
    "--yes",
    "--package",
    installerPackageSpec(version),
    ECC_NPM_BIN,
    "--target",
    cli,
    "--profile",
    profile,
    ...packs,
  ];
}

/** Run ECC's real installer for a supported CLI, under --apply (pinned if requested). */
function installerExec(
  cli: Cli,
  profile: string,
  platform: Platform,
  version?: string,
  packs: readonly EccLanguagePack[] = [],
): Action {
  const spec = installerPackageSpec(version);
  const tag = version ? `pinned ${spec}` : "latest from npm";
  const packSuffix = packs.length > 0 ? ` ${packs.join(" ")}` : "";
  return exec(
    `Install ECC for ${cli} — npx --package ${spec} ${ECC_NPM_BIN} --target ${cli} --profile ${profile}${packSuffix} (${tag}, under --apply)`,
    // Windows execFile can't spawn the `npx` .cmd shim directly (no .exe) — route it
    // through `cmd /c`, the same shim fix the rest of the harness uses (tools/install.ts).
    execArgv(platform, eccInstallerArgv(cli, profile, version, packs)),
  );
}

/** Claude: the shell installer runs above; the marketplace plugin is the in-Claude alternative. */
function claudePluginDoc(): Action {
  return doc(
    "ECC for Claude Code — marketplace plugin (optional alternative)",
    lines(
      "The shell install above (`npx --package ecc-universal ecc-install --target claude`) is the reliable path and",
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
  if (isAihDirectEccInstallTarget(cli)) {
    const actions: Action[] = [
      installerExec(
        cli,
        inputs.profile,
        inputs.platform,
        inputs.installVersion,
        inputs.packs ?? [],
      ),
    ];
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
      "  AIH_ECC_INSTALL_VERSION=<x.y.z>   # pins `npx --package ecc-universal@<x.y.z> ecc-install`",
      "  AIH_ECC_REF=<tag|sha>             # pins the Codex/Kiro git checkout to a tag/commit",
      "",
      "Or mirror `ecc-universal` and `code-review-graph` into your internal registries",
      "and point npm/uv at them. Unpinned `npx`/`git pull` execution is",
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
