/**
 * The AI coding CLIs the harness can target. Capabilities that install agent
 * tooling (ECC, Superpowers) and write IDE adapters use the user's selection
 * (`--cli claude,codex` or `--all-tools`) so the harness only touches the tools
 * the user actually runs. Names match each tool's own CLI / config conventions.
 */
export const SUPPORTED_CLIS = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "copilot",
  "windsurf",
  "opencode",
  "zed",
  "kimi",
  "kiro",
] as const;

export type Cli = (typeof SUPPORTED_CLIS)[number];

const VALID = new Set<string>(SUPPORTED_CLIS);

/**
 * Resolve the target CLIs from command options. `--all-tools` selects every
 * supported CLI; `--cli a,b,c` selects a validated subset; otherwise default to
 * Claude Code (the harness's primary target). Unknown names are dropped.
 */
export function resolveClis(options: Record<string, unknown>): Cli[] {
  if (options.allTools === true) return [...SUPPORTED_CLIS];
  const raw = options.cli;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const picked = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is Cli => VALID.has(s));
    if (picked.length > 0) return [...new Set(picked)];
  }
  return ["claude"];
}
