import type { Cli, FrameworkUpstreamV1 } from "@aihq/core/framework-host";

/** Must equal this package's own package.json name and version (Core checks both). */
export const PACKAGE_NAME = "@aihq/framework-superpowers";
export const PACKAGE_VERSION = "0.1.0";

/**
 * The contract and host API versions this plugin was BUILT against. Literals on
 * purpose: reading them from the installed Core at run time would make every
 * Core look compatible.
 */
export const CONTRACT_VERSION = 1;
export const HOST_API_VERSION = 1;

/** obra/Superpowers v6.4.1: the upstream this plugin's guidance and hook inventory were verified against. */
export const UPSTREAM: FrameworkUpstreamV1 = Object.freeze({
  repository: "obra/Superpowers",
  commit: "5bf4e78011075bcfc0dc295f0724994cd123ee71",
});

/** Every host this plugin emits a delivery route for (guidance, or the Kiro steering bridge). */
export const SUPPORTED_HOSTS: readonly Cli[] = Object.freeze([
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
]);

export const KIRO_STEERING_PATH = ".kiro/steering/superpowers-methodology.md";

/** The one environment variable this plugin reads: an exact commit override for the pinned source. */
export const REF_ENVIRONMENT_VARIABLE = "AIH_SUPERPOWERS_REF";
