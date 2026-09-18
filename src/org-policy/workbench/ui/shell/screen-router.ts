/**
 * The new shell's one screen state (NEW-SHELL-PLAN.md §1). `data-wb-screen`
 * on the shell root names the visible screen; it replaces the legacy
 * `data-view-tab` buttons and `body.dataset.view`. Every screen panel carries
 * `data-wb-screen-panel`, every navigation control `data-wb-nav`.
 */

import { isWorkbenchScreen, SCREEN_CHANGE_EVENT, type WorkbenchScreen } from "./screens.js";

export interface ScreenRouter {
  readonly screen: WorkbenchScreen;
  /** Show one screen. Returns false, and changes nothing, for an unknown name. */
  setScreen(screen: string): boolean;
  destroy(): void;
}

export function mountScreenRouter(root: HTMLElement, initial: WorkbenchScreen): ScreenRouter {
  const teardown = new AbortController();
  let current: WorkbenchScreen = initial;

  const apply = (): void => {
    root.dataset.wbScreen = current;
    for (const panel of root.querySelectorAll<HTMLElement>("[data-wb-screen-panel]")) {
      panel.hidden = panel.dataset.wbScreenPanel !== current;
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-wb-nav]")) {
      if (control.dataset.wbNav === current) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    }
  };

  const setScreen = (screen: string): boolean => {
    if (!isWorkbenchScreen(screen)) return false;
    const changed = screen !== current;
    current = screen;
    apply();
    if (changed)
      root.dispatchEvent(
        new CustomEvent(SCREEN_CHANGE_EVENT, { bubbles: true, detail: { screen } }),
      );
    return true;
  };

  root.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest<HTMLElement>("[data-wb-nav]");
      if (control === null || !root.contains(control)) return;
      const screen = control.dataset.wbNav;
      if (screen === undefined) return;
      event.preventDefault();
      setScreen(screen);
    },
    { signal: teardown.signal },
  );

  apply();
  return {
    get screen() {
      return current;
    },
    setScreen,
    destroy() {
      teardown.abort();
    },
  };
}
