import type { Cli } from "../internals/clis.js";

/**
 * The harness targets supported by ECC's installer.
 *
 * This intentionally tiny module is safe to use from static preflight code: it
 * carries a hand-maintained contract only, never an installer implementation.
 */
export const ECC_INSTALL_TARGETS = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "opencode",
  "zed",
] as const satisfies readonly Cli[];
