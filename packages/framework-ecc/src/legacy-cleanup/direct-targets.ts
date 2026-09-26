import type { Cli } from "@aihq/core/framework-host";

/** Historical aih-owned direct ECC installer targets recorded in old ledgers. */
const DIRECT_TARGETS: readonly Cli[] = [
  "claude",
  "cursor",
  "antigravity",
  "gemini",
  "opencode",
  "zed",
];

export function isAihDirectEccInstallTarget(target: Cli): boolean {
  return DIRECT_TARGETS.includes(target);
}
