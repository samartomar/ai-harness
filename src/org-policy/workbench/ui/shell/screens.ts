/**
 * DOM-free names for the new shell (NEW-SHELL-PLAN.md §1): the six screens,
 * and which admin shell renders the page during the migration.
 */

export const WORKBENCH_SCREENS = ["sources", "item", "changes", "scan", "org", "acme"] as const;
export type WorkbenchScreen = (typeof WORKBENCH_SCREENS)[number];

export const SCREEN_CHANGE_EVENT = "aih-workbench-screen-change";

export function isWorkbenchScreen(value: unknown): value is WorkbenchScreen {
  return typeof value === "string" && (WORKBENCH_SCREENS as readonly string[]).includes(value);
}

export type WorkbenchShellMode = "legacy" | "new";

/**
 * Which shell renders the admin page. `?shell=` (local runs) wins over the
 * model field (`AIH_WORKBENCH_SHELL`, fixture-only); anything unrecognised
 * falls back to the legacy shell, which stays the default.
 */
export function resolveWorkbenchShell(modelShell: unknown, search: string): WorkbenchShellMode {
  const requested = new URLSearchParams(search).get("shell");
  if (requested === "new" || requested === "legacy") return requested;
  return modelShell === "new" ? "new" : "legacy";
}
