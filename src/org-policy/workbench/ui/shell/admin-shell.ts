import { catalogKindIcon, type KindLedgerViewModel } from "../kind-ledger.js";
import { mountUserDoorTheme } from "../user-door.js";
import { button, el, icon, withId } from "./dom.js";
import { mountScreenRouter, type ScreenRouter } from "./screen-router.js";
import type { WorkbenchScreen } from "./screens.js";

/**
 * The new admin shell frame (NEW-SHELL-PLAN.md §1, slice S1): the 44 px
 * header, the sub-header strip, the nav rail, the kind ledger, the main
 * screen area and the inspector rail of `prototype/policy-workbench/screens/
 * admin-sources.html`. It owns the theme toggle and the `#announcement` /
 * `#status` live text. Screens fill their own `[data-wb-screen-body]`.
 */

interface ScreenDefinition {
  readonly screen: WorkbenchScreen;
  readonly title: string;
  readonly icon: string;
  /** Reached from the nav rail; `item` opens from a catalog card instead. */
  readonly nav: boolean;
}

const SCREENS: readonly ScreenDefinition[] = [
  { screen: "sources", title: "Sources & Catalogs", icon: "inventory_2", nav: true },
  { screen: "item", title: "Item", icon: "info", nav: false },
  { screen: "scan", title: "Scan Review", icon: "security_update_good", nav: true },
  { screen: "changes", title: "Policies & Publish", icon: "policy", nav: true },
  { screen: "org", title: "Organization", icon: "domain", nav: true },
  { screen: "acme", title: "Additions & Approvals", icon: "add", nav: true },
];

const INSPECTOR_TABS = [
  ["details", "Details"],
  ["security", "Security"],
  ["json", "Policy JSON"],
] as const;

const HEADER_BUTTON =
  "flex items-center gap-1.5 h-7 px-2 rounded bg-surface-container-low hover:bg-surface-container border border-solid border-outline-variant text-on-surface-variant hover:text-on-surface text-[12px] font-medium transition-colors shrink-0";
const ICON_BUTTON =
  "w-7 h-7 grid place-items-center rounded bg-surface-container-low hover:bg-surface-container border border-solid border-outline-variant text-on-surface-variant hover:text-on-surface transition-colors shrink-0";
const RAIL_LABEL =
  "px-2 py-0.5 text-[10px] font-mono tracking-wider text-on-surface-variant uppercase font-semibold";

export interface AdminShell {
  readonly root: HTMLElement;
  readonly router: ScreenRouter;
  /** Header slot for the policy actions (S2: Check Policy, Publish, the file menu). */
  readonly headerActions: HTMLElement;
  /** The body of one screen, where that screen's module mounts. */
  screenBody(screen: WorkbenchScreen): HTMLElement;
  /** Live status text: `#announcement` (polite live region) and `#status`. */
  announce(message: string, error?: boolean): void;
  renderLedger(view: KindLedgerViewModel): void;
}

function header(): { element: HTMLElement; actions: HTMLElement } {
  const element = el(
    "header",
    "h-11 w-full bg-surface-container-lowest border-0 border-b border-solid border-outline-variant px-3 flex items-center gap-2 shrink-0 min-w-0",
  );
  element.dataset.wbHeader = "";
  element.setAttribute("aria-label", "Policy workbench toolbar");

  const identity = el("div", "flex items-center gap-2 min-w-0 shrink-0");
  const mark = el(
    "span",
    "w-5 h-5 rounded bg-primary text-on-primary grid place-items-center shrink-0",
  );
  mark.append(icon("shield_with_house", "w-3.5 h-3.5"));
  identity.append(
    mark,
    el(
      "h1",
      "m-0 font-semibold text-[13px] tracking-tight text-on-surface whitespace-nowrap",
      "aih Policy",
    ),
    el(
      "span",
      "text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium",
      "Admin",
    ),
  );

  const actions = el("div", "flex items-center gap-1.5 min-w-0 shrink-0");
  actions.dataset.wbHeaderActions = "";

  const review = button(HEADER_BUTTON, "");
  review.dataset.wbNav = "changes";
  review.title = "Review changes";
  review.setAttribute("aria-label", "Review changes");
  review.append(icon("edit_document"), el("span", "max-sm:hidden", "Review Changes"));

  const theme = button(ICON_BUTTON, "", "theme-toggle");
  theme.append(icon("dark_mode", "wb-theme-icon-dark"), icon("light_mode", "wb-theme-icon-light"));

  element.append(identity, el("span", "flex-1 min-w-0"), review, actions, theme);
  mountUserDoorTheme(theme);
  return { element, actions };
}

function panelToggle(
  id: string,
  label: string,
  glyph: string,
  controls: string,
): HTMLButtonElement {
  const toggle = button(
    "w-6 h-6 grid place-items-center rounded hover:bg-surface-container text-primary transition-colors",
    "",
    id,
  );
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  toggle.setAttribute("aria-controls", controls);
  toggle.append(icon(glyph));
  return toggle;
}

function subHeader(): { element: HTMLElement; status: HTMLElement } {
  const element = el(
    "div",
    "h-8 bg-surface-container-lowest border-0 border-b border-solid border-outline-variant px-3 flex items-center justify-between gap-2 text-[11px] shrink-0 min-w-0",
  );
  element.dataset.wbSubheader = "";
  const status = el(
    "span",
    "font-mono text-[11px] text-on-surface-variant truncate min-w-0",
    "Ready - no repository is required.",
  );
  withId(status, "status");
  const toggles = el(
    "div",
    "flex items-center rounded bg-surface-container-low border border-solid border-outline-variant p-0.5 gap-0.5 shrink-0",
  );
  toggles.append(
    panelToggle("toggle-nav-btn", "Toggle navigation", "left_panel", "nav-rail"),
    panelToggle("btn-toggle-inspector", "Toggle inspector", "right_panel", "inspector-rail"),
  );
  element.append(status, toggles);
  return { element, status };
}

function navRail(): HTMLElement {
  const rail = el(
    "aside",
    "wb-rail shrink-0 w-60 bg-surface-container-lowest border-0 border-r border-solid border-outline-variant flex-col overflow-y-auto max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
  );
  withId(rail, "nav-rail");
  rail.dataset.wbRailState = "auto";
  rail.setAttribute("aria-label", "Workbench navigation");
  const group = el("div", "p-2 flex flex-col gap-1");
  const nav = el("nav", "flex flex-col gap-0.5 text-[11px]");
  nav.setAttribute("aria-label", "Workbench screens");
  for (const definition of SCREENS) {
    if (!definition.nav) continue;
    const link = button(
      "wb-nav-link flex items-center gap-1.5 w-full px-2 py-1 rounded text-left text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors",
      "",
    );
    link.dataset.wbNav = definition.screen;
    link.append(icon(definition.icon), el("span", "truncate", definition.title));
    nav.append(link);
  }
  group.append(el("div", RAIL_LABEL, "Workbench"), nav);
  rail.append(group);
  return rail;
}

function screenPanel(definition: ScreenDefinition): { panel: HTMLElement; body: HTMLElement } {
  const panel = el("section", "flex flex-col gap-3 px-5 py-4 min-w-0");
  panel.dataset.wbScreenPanel = definition.screen;
  const titleId = `wb-screen-title-${definition.screen}`;
  panel.setAttribute("aria-labelledby", titleId);
  const title = el(
    "h2",
    "m-0 text-[18px] font-bold tracking-tight font-mono text-on-surface flex items-center gap-2",
  );
  title.id = titleId;
  title.append(icon(definition.icon, "w-4 h-4 text-primary"), el("span", "", definition.title));
  const body = el("div", "flex flex-col gap-3 min-w-0");
  body.dataset.wbScreenBody = definition.screen;
  body.append(
    el(
      "p",
      "m-0 text-[12px] text-on-surface-variant",
      "This screen has not moved to the new shell yet; the legacy shell still provides it.",
    ),
  );
  body.firstElementChild?.setAttribute("data-wb-pending-screen", definition.screen);
  panel.append(title, body);
  return { panel, body };
}

function inspectorRail(): HTMLElement {
  const rail = el(
    "aside",
    "wb-rail shrink-0 w-80 bg-surface-container-lowest border-0 border-l border-solid border-outline-variant flex-col min-h-0 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-40",
  );
  withId(rail, "inspector-rail");
  rail.dataset.wbInspector = "";
  rail.dataset.wbRailState = "auto";
  rail.setAttribute("aria-label", "Inspector");
  const head = el(
    "div",
    "flex items-center gap-1 px-2 h-9 border-0 border-b border-solid border-outline-variant shrink-0",
  );
  const tabs = el("div", "flex items-center gap-0.5 flex-1 min-w-0");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Inspector views");
  const panel = el("div", "flex-1 overflow-y-auto p-3 text-[12px] text-on-surface-variant");
  withId(panel, "wb-inspector-panel");
  panel.setAttribute("role", "tabpanel");
  panel.append(el("p", "m-0", "Select an item to inspect it."));
  panel.dataset.wbInspectorPanel = "details";
  for (const [key, label] of INSPECTOR_TABS) {
    const tab = button(
      "wb-inspector-tab px-2 py-1 rounded text-[11px] font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-colors",
      label,
    );
    tab.id = `wb-inspector-tab-${key}`;
    tab.dataset.wbInspectorTab = key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);
    tab.setAttribute("aria-selected", key === "details" ? "true" : "false");
    tabs.append(tab);
  }
  panel.setAttribute("aria-labelledby", "wb-inspector-tab-details");
  const close = button(ICON_BUTTON, "");
  close.dataset.closeInspector = "";
  close.setAttribute("aria-label", "Close inspector");
  close.title = "Close inspector";
  close.append(icon("close"));
  head.append(tabs, close);
  rail.append(head, panel);
  tabs.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLElement>("[data-wb-inspector-tab]");
    const key = tab?.dataset.wbInspectorTab;
    if (tab === null || tab === undefined || key === undefined) return;
    for (const other of tabs.querySelectorAll<HTMLElement>("[data-wb-inspector-tab]"))
      other.setAttribute("aria-selected", other === tab ? "true" : "false");
    panel.dataset.wbInspectorPanel = key;
    panel.setAttribute("aria-labelledby", tab.id);
  });
  return rail;
}

function railVisible(rail: HTMLElement): boolean {
  return getComputedStyle(rail).display !== "none";
}

function wireRailToggle(toggle: HTMLButtonElement, rail: HTMLElement): () => void {
  const sync = () => toggle.setAttribute("aria-expanded", railVisible(rail) ? "true" : "false");
  toggle.addEventListener("click", () => {
    rail.dataset.wbRailState = railVisible(rail) ? "closed" : "open";
    sync();
  });
  return sync;
}

function ledgerTile(entry: KindLedgerViewModel["entries"][number]): HTMLElement {
  const percent = entry.total === 0 ? 0 : Math.round((entry.selected / entry.total) * 100);
  const kindIcon = catalogKindIcon(entry.kind);
  const tile = el("div", "px-4 py-2.5 flex flex-col gap-1.5 min-w-0");
  tile.dataset.kindLedgerTile = entry.kind;
  const top = el("div", "flex items-center justify-between gap-2 min-w-0");
  const name = el("span", "flex items-center gap-1.5 min-w-0");
  name.append(
    icon(kindIcon.name, kindIcon.colorClass ?? ""),
    el(
      "span",
      "text-[10px] uppercase font-semibold tracking-[0.08em] truncate text-on-surface-variant",
      entry.label,
    ),
  );
  top.append(
    name,
    el(
      "span",
      "text-[10px] font-mono tabular-nums shrink-0 text-on-surface-variant",
      `${percent}%`,
    ),
  );
  const count = el("div", "flex items-baseline gap-1");
  count.append(
    el(
      "span",
      "text-[20px] leading-none font-semibold font-mono tabular-nums tracking-tight text-on-surface",
      String(entry.selected),
    ),
    el("span", "text-[11px] font-mono tabular-nums text-on-surface-variant", `/${entry.total}`),
    el("span", "text-[10px] font-mono text-on-surface-variant ml-auto", "selected"),
  );
  const track = el("div", "h-[3px] rounded-full bg-surface-container-highest overflow-hidden");
  const bar = el("div", `h-full rounded-full ${kindIcon.colorClass ?? ""}`.trim());
  bar.dataset.kindLedgerBar = entry.kind;
  bar.style.width = `${percent}%`;
  bar.style.background = "currentColor";
  track.append(bar);
  tile.append(top, count, track);
  return tile;
}

export function mountAdminShell(
  host: HTMLElement,
  initial: WorkbenchScreen = "sources",
): AdminShell {
  document.documentElement.dataset.wbShell = "new";
  const root = host;
  root.className =
    "wb-shell flex flex-col h-screen min-h-0 overflow-hidden bg-background text-on-surface";
  withId(root, "wb-root");
  root.dataset.wbShell = "new";

  const top = header();
  const sub = subHeader();
  const announcement = el(
    "p",
    "wb-announcement m-0 px-3 py-1 text-[12px] text-on-surface empty:hidden",
  );
  withId(announcement, "announcement");
  announcement.setAttribute("aria-live", "polite");

  const frame = el("div", "relative flex flex-1 min-h-0 min-w-0");
  const rail = navRail();
  const column = el("div", "flex flex-col flex-1 min-w-0 min-h-0");
  const ledger = el(
    "div",
    "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 border-0 border-b border-solid border-outline-variant bg-surface-container-lowest shrink-0 select-none w-full",
  );
  ledger.dataset.wbLedger = "";
  ledger.setAttribute("role", "group");
  ledger.setAttribute("aria-label", "Catalog kinds");
  const work = el("div", "flex flex-1 min-h-0 min-w-0");
  const main = el("main", "flex-1 min-w-0 overflow-y-auto bg-surface");
  withId(main, "wb-main");
  main.dataset.wbMain = "";
  main.tabIndex = -1;
  const bodies = new Map<WorkbenchScreen, HTMLElement>();
  for (const definition of SCREENS) {
    const { panel, body } = screenPanel(definition);
    bodies.set(definition.screen, body);
    main.append(panel);
  }
  const inspector = inspectorRail();
  work.append(main, inspector);
  column.append(ledger, work);
  frame.append(rail, column);
  root.replaceChildren(top.element, sub.element, announcement, frame);

  const syncNav = wireRailToggle(
    sub.element.querySelector<HTMLButtonElement>("#toggle-nav-btn") as HTMLButtonElement,
    rail,
  );
  const syncInspector = wireRailToggle(
    sub.element.querySelector<HTMLButtonElement>("#btn-toggle-inspector") as HTMLButtonElement,
    inspector,
  );
  inspector.querySelector("[data-close-inspector]")?.addEventListener("click", () => {
    inspector.dataset.wbRailState = "closed";
    syncInspector();
  });
  syncNav();
  syncInspector();

  const router = mountScreenRouter(root, initial);
  return {
    root,
    router,
    headerActions: top.actions,
    screenBody(screen) {
      const body = bodies.get(screen);
      if (body === undefined) throw new Error(`Unknown Workbench screen: ${screen}`);
      return body;
    },
    announce(message, error = false) {
      announcement.textContent = message;
      announcement.dataset.wbTone = error ? "error" : "info";
      sub.status.textContent = message;
    },
    renderLedger(view) {
      ledger.replaceChildren(...view.entries.map(ledgerTile));
    },
  };
}
