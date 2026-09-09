/** Shared presentation controls; these never change policy or approval state. */
export function mountWorkspaceInteractions(): void {
  document.querySelectorAll<HTMLElement>("[data-groupcard]").forEach((group, index) => {
    const button = group.querySelector<HTMLButtonElement>("[data-group]");
    if (button === null) return;
    if (!button.id) button.id = `workbench-group-toggle-${index}`;
    const bodies = [...group.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== button,
    );
    bodies.forEach((body, bodyIndex) => {
      if (!body.id) body.id = `workbench-group-body-${index}-${bodyIndex}`;
    });
    button.setAttribute("aria-controls", bodies.map((body) => body.id).join(" "));
    const setOpen = (open: boolean) => {
      group.dataset.open = open ? "1" : "0";
      button.setAttribute("aria-expanded", String(open));
    };
    setOpen(group.dataset.open === "1");
    button.addEventListener("click", () => setOpen(group.dataset.open !== "1"));
  });

  let drawerOpener: HTMLElement | undefined;
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const opener = event.target.closest<HTMLElement>(
      "[data-detail],[data-open-authoring],#open-ecc-mcp,[data-ecc-mcp-approval],#export",
    );
    if (opener !== null) drawerOpener = opener;
    if (
      event.target.closest(
        "[data-drawer-close],#authoring-close,#ecc-mcp-close,#sheet-close,.scrim",
      ) &&
      drawerOpener?.isConnected
    ) {
      drawerOpener.focus({ preventScroll: true });
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const sheetClose = document.querySelector<HTMLButtonElement>(".sheet.open #sheet-close");
    const drawerClose = document.querySelector<HTMLButtonElement>(
      ".drawer:not([hidden]) [data-drawer-close],.drawer:not([hidden]) #authoring-close,.drawer:not([hidden]) #ecc-mcp-close",
    );
    const close = sheetClose ?? drawerClose;
    if (close !== null) {
      event.preventDefault();
      close.click();
    }
  });
  const trigger = document.getElementById("adoption-recipe-toggle");
  const panel = document.getElementById("adoption-recipe-panel");
  const close = document.getElementById("adoption-recipe-close");
  if (trigger === null || panel === null || close === null) return;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelLeave = () => clearTimeout(leaveTimer);
  const setOpen = (open: boolean, restoreFocus = false) => {
    cancelLeave();
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (!open && restoreFocus) trigger.focus({ preventScroll: true });
  };
  const leave = () => {
    cancelLeave();
    leaveTimer = setTimeout(() => {
      if (
        !panel.matches(":hover") &&
        !trigger.matches(":hover") &&
        !panel.contains(document.activeElement)
      )
        setOpen(false);
    }, 220);
  };
  trigger.addEventListener("click", (event) => {
    const opening = panel.hidden !== false;
    setOpen(opening);
    if (opening && event.detail === 0) close.focus({ preventScroll: true });
  });
  close.addEventListener("click", () => setOpen(false, true));
  for (const element of [trigger, panel]) {
    element.addEventListener("pointerenter", cancelLeave);
    element.addEventListener("pointerleave", leave);
  }
  panel.addEventListener("focusout", (event) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      (!panel.contains(event.relatedTarget) && event.relatedTarget !== trigger)
    )
      setOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (
      event.target instanceof Node &&
      !panel.contains(event.target) &&
      !trigger.contains(event.target)
    )
      setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-view-tab]")) setOpen(false);
  });
}
