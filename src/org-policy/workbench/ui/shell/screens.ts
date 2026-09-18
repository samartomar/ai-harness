/**
 * DOM-free names for the new shell (NEW-SHELL-PLAN.md §1): the six screens.
 */

export const WORKBENCH_SCREENS = ["sources", "item", "changes", "scan", "org", "acme"] as const;
export type WorkbenchScreen = (typeof WORKBENCH_SCREENS)[number];

export const SCREEN_CHANGE_EVENT = "aih-workbench-screen-change";

export function isWorkbenchScreen(value: unknown): value is WorkbenchScreen {
  return typeof value === "string" && (WORKBENCH_SCREENS as readonly string[]).includes(value);
}
