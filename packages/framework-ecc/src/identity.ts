import { type Cli, type FrameworkUpstreamV1, SUPPORTED_CLIS } from "@aihq/core/framework-host";

/** Must equal this package's own package.json name and version (Core checks both). */
export const PACKAGE_NAME = "@aihq/framework-ecc";
export const PACKAGE_VERSION = "0.1.0";

/**
 * The contract and host API versions this plugin was BUILT against. Literals on
 * purpose: reading them from the installed Core at run time would make every
 * Core look compatible.
 */
export const CONTRACT_VERSION = 1;
export const HOST_API_VERSION = 1;

/**
 * The one affaan-m/ECC revision this plugin version supports (C3: Core checks it
 * against Catalog's plugins record, and the plugin requires Catalog's
 * `vendorLock.pinnedSha` to equal it). This is the plugin's only revision
 * datum: hook ids, profiles, eligibility and provenance all come from the
 * descriptor bytes, so moving revisions is this line plus Catalog's
 * regenerated descriptor.
 */
export const UPSTREAM: FrameworkUpstreamV1 = Object.freeze({
  repository: "affaan-m/ECC",
  commit: "5caf398a91599029a176ca6d806409b00d1052c4",
});

/**
 * `aih ecc` has a route for every host Core targets: an evidence-gated install
 * for ECC's installer targets and Codex, a consult-only route for the rest.
 */
export const SUPPORTED_HOSTS: readonly Cli[] = Object.freeze([...SUPPORTED_CLIS]);

/** Environment variables the plugin reads through its operation context. */
export const ENVIRONMENT_VARIABLES = Object.freeze([
  "AIH_ECC_REF",
  "AIH_ECC_INSTALL_VERSION",
  "AIH_ECC_STATE_ROOT",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "XDG_STATE_HOME",
] as const);

/** ECC's own hook switches, read by its hook runtime from the Claude settings environment. */
export const ECC_HOOK_PROFILE_KEY = "ECC_HOOK_PROFILE";
export const ECC_DISABLED_HOOKS_KEY = "ECC_DISABLED_HOOKS";
