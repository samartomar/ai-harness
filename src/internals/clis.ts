import { SettingsError } from "../errors.js";

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
 * Claude Code (the harness's primary target).
 *
 * `strict` (used for the non-interactive `--cli` FLAG) fails closed on any
 * unknown name, so a typo like `--cli codx` errors instead of silently writing
 * Claude config. The interactive confirm path stays lenient (drops unknowns) —
 * the operator is in a loop and can see/retype the list.
 */
export function resolveClis(
  options: Record<string, unknown>,
  opts: { strict?: boolean } = {},
): Cli[] {
  if (options.allTools === true) return [...SUPPORTED_CLIS];
  const raw = options.cli;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const tokens = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    const unknown = tokens.filter((s) => !VALID.has(s));
    if (opts.strict && unknown.length > 0) {
      throw new SettingsError(
        `unknown --cli target(s): ${unknown.join(", ")}. Supported: ${SUPPORTED_CLIS.join(", ")}`,
      );
    }
    // In strict mode any unknown token already threw above, so reaching here means
    // every token was valid (picked is non-empty). Non-strict: keep the valid subset.
    const picked = tokens.filter((s): s is Cli => VALID.has(s));
    if (picked.length > 0) return [...new Set(picked)];
  }
  return ["claude"];
}
