import type { PlanContext } from "../internals/plan.js";
import { type Action, doc, exec } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";

/**
 * `aih tools` — install the agent shell tools the harness leans on. Mirrors the
 * harness posture used for certs/npm: pick the right command for the detected
 * package manager, EMIT it (dry-run shows exactly what will run), execute it as a
 * LOCAL exec under `--apply`, and when an install fails (blocked registry, no
 * admin) escalate it as a support ticket rather than pretending it worked.
 *
 * Pure data + Runner-seam probes, so tests stay hermetic (no real install).
 */

export type Tier = "core" | "optional";

/**
 * winget's first run pops an interactive source/package agreement prompt and can
 * stall a hidden child on a slow corporate-proxy download. These flags make every
 * winget install non-interactive: auto-accept both agreements, disable the
 * interactivity prompts, and install to `--scope user` (the scope these four tools
 * ship user-mode installers for, which also sidesteps the non-admin elevation
 * failure). Appended to every `winget install` argv below. Validated against an
 * enterprise Windows field report where a first-run `aih tools`/`aih ready --apply`
 * hung on the agreement prompt.
 */
const WINGET_NONINTERACTIVE_FLAGS = [
  "--accept-source-agreements",
  "--accept-package-agreements",
  "--disable-interactivity",
  "--scope",
  "user",
];

/**
 * Generous ceiling for a single tool install (5 min). A winget download behind a
 * corporate proxy routinely exceeds the runner's 30s DEFAULT_TIMEOUT_MS, and a
 * timed-out child maps to exit 1 — which reproduced the field report "every
 * install exits 1". This bounds the wait without inheriting that default.
 */
const INSTALL_TIMEOUT_MS = 300_000;

/** One package-manager install option: the PM that must be present, and its argv. */
export interface PmOption {
  pm: string;
  argv: string[];
}

export interface ToolSpec {
  /** Display name. */
  tool: string;
  /** The binary probed on PATH to decide "installed". */
  bin: string;
  /** `core` (rg/fd/jq — absence is a real gap) vs `optional` (nice-to-have). */
  tier: Tier;
  /** Ordered install options — the first whose PM is available wins. */
  options: PmOption[];
  /** Human fallback shown when no supported package manager is available. */
  manual: string;
}

/**
 * The install matrix. Each tool lists package-manager options in preference order
 * (native PM first, then the cross-platform language toolchains). Only SAFE,
 * non-interactive commands — no piped `curl | bash`.
 */
export const TOOLS: ToolSpec[] = [
  {
    tool: "ripgrep (rg)",
    bin: "rg",
    tier: "core",
    options: [
      {
        pm: "winget",
        argv: [
          "winget",
          "install",
          "-e",
          "--id",
          "BurntSushi.ripgrep.MSVC",
          ...WINGET_NONINTERACTIVE_FLAGS,
        ],
      },
      { pm: "scoop", argv: ["scoop", "install", "ripgrep"] },
      { pm: "brew", argv: ["brew", "install", "ripgrep"] },
      { pm: "apt", argv: ["sudo", "apt-get", "install", "-y", "ripgrep"] },
      { pm: "cargo", argv: ["cargo", "install", "ripgrep"] },
    ],
    manual: "https://github.com/BurntSushi/ripgrep#installation",
  },
  {
    tool: "fd",
    bin: "fd",
    tier: "core",
    options: [
      {
        pm: "winget",
        argv: ["winget", "install", "-e", "--id", "sharkdp.fd", ...WINGET_NONINTERACTIVE_FLAGS],
      },
      { pm: "scoop", argv: ["scoop", "install", "fd"] },
      { pm: "brew", argv: ["brew", "install", "fd"] },
      { pm: "apt", argv: ["sudo", "apt-get", "install", "-y", "fd-find"] },
      { pm: "cargo", argv: ["cargo", "install", "fd-find"] },
    ],
    manual: "https://github.com/sharkdp/fd#installation",
  },
  {
    tool: "jq",
    bin: "jq",
    tier: "core",
    options: [
      {
        pm: "winget",
        argv: ["winget", "install", "-e", "--id", "jqlang.jq", ...WINGET_NONINTERACTIVE_FLAGS],
      },
      { pm: "scoop", argv: ["scoop", "install", "jq"] },
      { pm: "brew", argv: ["brew", "install", "jq"] },
      { pm: "apt", argv: ["sudo", "apt-get", "install", "-y", "jq"] },
    ],
    manual: "https://jqlang.github.io/jq/download/",
  },
  {
    tool: "ast-grep (sg)",
    bin: "sg",
    tier: "optional",
    options: [
      { pm: "brew", argv: ["brew", "install", "ast-grep"] },
      { pm: "cargo", argv: ["cargo", "install", "ast-grep", "--locked"] },
      { pm: "npm", argv: ["npm", "install", "-g", "@ast-grep/cli"] },
    ],
    manual: "https://ast-grep.github.io/guide/quick-start.html",
  },
  {
    tool: "comby",
    bin: "comby",
    tier: "optional",
    options: [{ pm: "brew", argv: ["brew", "install", "comby"] }],
    manual: "https://comby.dev/docs/get-started",
  },
  {
    tool: "tree",
    bin: "tree",
    tier: "optional",
    options: [
      { pm: "scoop", argv: ["scoop", "install", "tree"] },
      { pm: "brew", argv: ["brew", "install", "tree"] },
      { pm: "apt", argv: ["sudo", "apt-get", "install", "-y", "tree"] },
    ],
    manual: "install `tree` from your OS package manager",
  },
  {
    tool: "GitHub CLI (gh)",
    bin: "gh",
    tier: "optional",
    options: [
      {
        pm: "winget",
        argv: ["winget", "install", "-e", "--id", "GitHub.cli", ...WINGET_NONINTERACTIVE_FLAGS],
      },
      { pm: "scoop", argv: ["scoop", "install", "gh"] },
      { pm: "brew", argv: ["brew", "install", "gh"] },
      { pm: "apt", argv: ["sudo", "apt-get", "install", "-y", "gh"] },
    ],
    manual: "https://cli.github.com",
  },
  {
    tool: "code-review-graph",
    bin: "code-review-graph",
    tier: "optional",
    // Pinned to match the uvx MCP runners (src/mcp/servers.ts + src/workspace/templates.ts);
    // bump in lockstep. PEP 508 `==` form — pip/uv reject the uvx `@2.3.6` shorthand.
    options: [
      { pm: "uv", argv: ["uv", "tool", "install", "code-review-graph==2.3.6"] },
      { pm: "pip", argv: ["pip", "install", "code-review-graph==2.3.6"] },
    ],
    manual: "pip install code-review-graph==2.3.6",
  },
];

/** Package managers we know how to drive (binary name → canonical key). */
const PM_BINARIES: Array<[bin: string, key: string]> = [
  ["winget", "winget"],
  ["scoop", "scoop"],
  ["brew", "brew"],
  ["apt-get", "apt"],
  ["cargo", "cargo"],
  ["npm", "npm"],
  ["uv", "uv"],
  ["pip", "pip"],
];

/** Probe a binary on PATH through the Runner seam (`where`/`which`). */
export async function onPath(ctx: PlanContext, bin: string): Promise<boolean> {
  const argv = ctx.host.platform === "windows" ? ["where", bin] : ["which", bin];
  const res = await ctx.run(argv);
  return !res.spawnError && res.code === 0 && res.stdout.trim().length > 0;
}

/** The package managers available on this machine (canonical keys). */
export async function detectPms(ctx: PlanContext): Promise<Set<string>> {
  const found = new Set<string>();
  await Promise.all(
    PM_BINARIES.map(async ([bin, key]) => {
      if (await onPath(ctx, bin)) found.add(key);
    }),
  );
  return found;
}

/** Tools (core + optional) whose binary is NOT on PATH. */
export async function missingTools(ctx: PlanContext): Promise<ToolSpec[]> {
  const checked = await Promise.all(
    TOOLS.map(async (t) => ({ t, present: await onPath(ctx, t.bin) })),
  );
  return checked.filter((c) => !c.present).map((c) => c.t);
}

/** The first install option whose package manager is available, or `undefined`. */
export function chooseOption(t: ToolSpec, pms: ReadonlySet<string>): PmOption | undefined {
  return t.options.find((o) => pms.has(o.pm));
}

/**
 * Windows can't `execFile` a `.cmd` shim directly (npm/scoop/pnpm/yarn), so route
 * those through `cmd /c` — the same fix the rest of the harness uses for npm/npx.
 */
export const WIN_CMD_SHIMS = new Set(["npm", "npx", "pnpm", "scoop", "yarn"]);
export function execArgv(platform: Platform, argv: string[]): string[] {
  return platform === "windows" && argv[0] !== undefined && WIN_CMD_SHIMS.has(argv[0])
    ? ["cmd", "/c", ...argv]
    : argv;
}

/**
 * The install actions for a set of missing tools, given the available package
 * managers: one per tool — a LOCAL `exec` when a PM matches (`allowFailure` so one
 * blocked install doesn't abort the rest), else a `doc` with the manual route. The
 * single source of truth for "how aih installs a shell tool", reused by `aih tools`
 * AND `aih ready --apply`. Callers append their own follow-on verify probes, which
 * carry the `env.tool-install-blocked` escalation when an install stays blocked.
 */
export function installActionsFor(
  ctx: PlanContext,
  tools: readonly ToolSpec[],
  pms: ReadonlySet<string>,
): Action[] {
  const actions: Action[] = [];
  for (const t of tools) {
    const opt = chooseOption(t, pms);
    if (opt) {
      actions.push(
        exec(`install ${t.tool} (${opt.pm})`, execArgv(ctx.host.platform, opt.argv), {
          allowFailure: true,
          // A winget/proxy download easily exceeds the runner's 30s default, whose
          // timeout-kill maps to exit 1 ("every install exits 1"); give installs room.
          timeoutMs: INSTALL_TIMEOUT_MS,
        }),
      );
    } else {
      actions.push(
        doc(
          `install ${t.tool} manually (no supported package manager found)`,
          `No detected package manager can install ${t.tool}. Install it manually: ${t.manual}`,
        ),
      );
    }
  }
  return actions;
}

/** How a tool would be installed, given the available package managers. */
export function howToInstall(t: ToolSpec, pms: ReadonlySet<string>): string {
  const opt = chooseOption(t, pms);
  return opt ? `\`${opt.argv.join(" ")}\`` : `manually — ${t.manual}`;
}

/**
 * Post-install verification: is the tool on PATH now? A CORE tool still missing is
 * a `fail` (real gap, drives a non-zero exit + an escalation ticket); an OPTIONAL
 * one is a `skip` (advisory improvement). Both carry `env.tool-install-blocked` so
 * the support pipeline turns a blocked install into a ready-to-send ticket. Shared
 * by `aih tools` and `aih ready --apply` so a blocked install escalates identically.
 */
export async function verifyTool(
  ctx: PlanContext,
  t: ToolSpec,
  pms: ReadonlySet<string>,
): Promise<Check> {
  if (await onPath(ctx, t.bin)) {
    return { name: t.tool, verdict: "pass", detail: `${t.bin} on PATH` };
  }
  return {
    name: t.tool,
    verdict: t.tier === "core" ? "fail" : "skip",
    detail: `${t.bin} not on PATH — install: ${howToInstall(t, pms)}`,
    code: "env.tool-install-blocked",
  };
}
