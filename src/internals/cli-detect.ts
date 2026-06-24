import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Cli, resolveClis, SUPPORTED_CLIS } from "./clis.js";
import type { PlanContext } from "./plan.js";

/**
 * Best-effort presence detection for each AI CLI: a home-relative config dir, or
 * a binary on PATH (probed through the Runner seam, so tests stay hermetic).
 * Signals are conservative — present is high-signal, absent just means "not found
 * here", never an error. Paths/binaries follow each tool's common conventions.
 */
interface DetectSignal {
  /** Home-relative config dirs that imply the tool is installed/configured. */
  configDirs: string[];
  /** Executable names to look for on PATH. */
  binaries: string[];
}

const SIGNALS: Record<Cli, DetectSignal> = {
  claude: { configDirs: [".claude"], binaries: ["claude"] },
  codex: { configDirs: [".codex"], binaries: ["codex"] },
  cursor: { configDirs: [".cursor"], binaries: ["cursor"] },
  antigravity: {
    configDirs: [".gemini/antigravity", ".antigravity", ".config/antigravity"],
    binaries: ["agy", "antigravity"],
  },
  gemini: { configDirs: [".gemini"], binaries: ["gemini"] },
  copilot: { configDirs: [".config/github-copilot", ".copilot"], binaries: ["copilot"] },
  windsurf: { configDirs: [".codeium/windsurf", ".windsurf"], binaries: ["windsurf"] },
  opencode: { configDirs: [".config/opencode", ".opencode"], binaries: ["opencode"] },
  zed: { configDirs: [".config/zed", ".zed"], binaries: ["zed"] },
  kimi: { configDirs: [".kimi", ".config/kimi"], binaries: ["kimi"] },
};

export interface CliPresence {
  cli: Cli;
  present: boolean;
  /** How it was detected, when present. */
  via?: "config" | "binary";
  /** The matching config dir or binary name. */
  detail?: string;
}

/** The user's home directory — from the injected env first (testable), then the OS. */
function homeDir(ctx: PlanContext): string {
  return ctx.env.USERPROFILE || ctx.env.HOME || homedir();
}

/** Is `name` resolvable on PATH? Uses `where` (Windows) / `which` (POSIX) via the Runner. */
async function binaryOnPath(ctx: PlanContext, name: string): Promise<boolean> {
  const argv = ctx.host.platform === "windows" ? ["where", name] : ["which", name];
  const res = await ctx.run(argv);
  return !res.spawnError && res.code === 0 && res.stdout.trim().length > 0;
}

/** Detect one CLI: config dir wins (cheap, deterministic), else a PATH probe. */
export async function detectOne(ctx: PlanContext, cli: Cli): Promise<CliPresence> {
  const sig = SIGNALS[cli];
  const home = homeDir(ctx);
  for (const rel of sig.configDirs) {
    if (existsSync(join(home, rel)))
      return { cli, present: true, via: "config", detail: `~/${rel}` };
  }
  for (const bin of sig.binaries) {
    if (await binaryOnPath(ctx, bin)) return { cli, present: true, via: "binary", detail: bin };
  }
  return { cli, present: false };
}

/** Detect every supported CLI (presence + how), in canonical order. */
export async function detectClis(ctx: PlanContext): Promise<CliPresence[]> {
  return Promise.all(SUPPORTED_CLIS.map((cli) => detectOne(ctx, cli)));
}

/** The CLIs detected as present, in canonical order. */
export function presentClis(presences: CliPresence[]): Cli[] {
  return presences.filter((p) => p.present).map((p) => p.cli);
}

/**
 * Resolve the target CLIs, honoring `--detect`. Precedence: `--all-tools` >
 * explicit `--cli <list>` > `--detect` (the CLIs found on this machine) > the
 * default (`claude`). When `--detect` finds nothing, fall back to `claude` so the
 * harness still produces a usable result rather than nothing.
 */
export async function resolveTargetClis(ctx: PlanContext): Promise<Cli[]> {
  const opts = ctx.options;
  const explicit = typeof opts.cli === "string" && opts.cli.trim().length > 0;
  if (opts.detect === true && opts.allTools !== true && !explicit) {
    const present = presentClis(await detectClis(ctx));
    return present.length > 0 ? present : ["claude"];
  }
  return resolveClis(opts);
}
