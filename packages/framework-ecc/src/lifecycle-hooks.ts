import type { FrameworkPruneHookV1, FrameworkUninstallHookV1 } from "@aihq/core/framework-host";

/** ECC is developer-managed; generic lifecycle dispatch has no ECC-owned work. */
export const uninstall: FrameworkUninstallHookV1 = Object.freeze({
  remove: async () => ({ removed: [], advisories: [] }),
});

export const prune: FrameworkPruneHookV1 = Object.freeze({
  plan: async () => ({ actions: [], subtracted: 0 }),
});
