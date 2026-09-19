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
  ["security", "Security Scan"],
  ["json", "Policy JSON"],
] as const;

/*
 * Class strings copied from prototype/policy-workbench/screens/admin-sources.html
 * (header, sub-header, nav rail). Literal dark hexes map to theme tokens
 * (tools/workbench-tailwind.config.cjs); `border-hairline` is the prototype's
 * harmonised border colour. The header carries no opacity modifiers.
 */
const HEADER_BUTTON =
  "flex items-center gap-1.5 px-2 py-1 rounded bg-surface-container-low hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[12px] transition-colors shrink-0";
const ICON_BUTTON =
  "p-1 rounded bg-surface-container-low hover:bg-surface-container border border-solid border-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors flex items-center justify-center shadow-xs shrink-0";
const RAIL_LABEL =
  "px-2 py-0.5 text-[10px] font-mono tracking-wider text-outline uppercase font-semibold flex items-center justify-between";
const DIVIDER = "h-3.5 w-px bg-surface-container-high mx-0.5 shrink-0";

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
  /** S4: the inspector rail's panel, where the catalog's item inspector mounts. */
  readonly inspectorPanel: HTMLElement;
  /** S4: reopen the inspector rail when the user closed it. */
  revealInspector(): void;
  /** The catalog's source list, shown in the nav rail's "Catalog scopes" section. */
  mountCatalogScopes(node: HTMLElement): void;
  /** The draft's entry count on the header's Review Changes badge (hidden at 0). */
  setReviewCount(count: number): void;
  /**
   * Hand the inspector's tabs and collapse chevron to the catalog's item
   * inspector, which shows them in its own head under the item's name
   * (admin-item.html). The rail's own head is hidden from then on.
   */
  adoptInspectorChrome(): { tabs: HTMLElement; close: HTMLElement };
}

/**
 * The rail's Details / Security Scan / Policy JSON tabs (admin-item.html).
 * Details shows the whole item; Security Scan and Policy JSON narrow the item
 * inspector to its evidence sheet or its technical JSON record
 * (`[data-wb-inspector-panel]` in wb-tokens.css), opening that record.
 */
const INSPECTOR_SECTIONS: Record<string, string> = {
  security: ".workbench-evidence-sheet",
  json: ".workbench-detail-advanced, .workbench-item-technical",
};

function revealInspectorSection(panel: HTMLElement, key: string): void {
  const selector = INSPECTOR_SECTIONS[key];
  if (selector === undefined) {
    panel.scrollTop = 0;
    return;
  }
  panel.scrollTop = 0;
  const section = panel.querySelector<HTMLElement>(selector);
  if (section === null) return;
  for (
    let node: HTMLElement | null = section;
    node !== null && node !== panel;
    node = node.parentElement
  )
    if (node instanceof HTMLDetailsElement) node.open = true;
}

function header(): { element: HTMLElement; actions: HTMLElement; reviewCount: HTMLElement } {
  const element = el(
    "header",
    "h-11 w-full bg-surface-container-lowest border-0 border-b border-solid border-surface-container-high px-3 flex items-center justify-between gap-2 z-50 shrink-0 min-w-0",
  );
  element.dataset.wbHeader = "";
  element.setAttribute("aria-label", "Policy workbench toolbar");

  // App identity. The prototype's org switcher, Vibe/Enterprise toggle,
  // AI-tools pill, user-page link and avatar have no product data here
  // (NEW-SHELL-PLAN.md §2 Omit).
  const left = el("div", "flex items-center gap-2.5 shrink-0 min-w-0");
  const identity = el("div", "flex items-center gap-2 pr-1 min-w-0");
  const mark = el(
    "span",
    "w-5 h-5 rounded bg-primary text-on-primary flex items-center justify-center shadow-sm shrink-0",
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
  left.append(identity);

  const right = el("div", "flex items-center gap-2 shrink-0 min-w-0");
  const actions = el("div", "flex items-center gap-2 min-w-0 shrink-0");
  actions.dataset.wbHeaderActions = "";

  const review = button(HEADER_BUTTON, "");
  review.dataset.wbNav = "changes";
  review.title = "Review changes";
  review.setAttribute("aria-label", "Review changes");
  // The draft's entry count, in the prototype's Review Changes badge.
  const reviewCount = el(
    "span",
    "text-[10px] font-mono px-1 rounded bg-tertiary-container text-on-tertiary font-bold",
  );
  reviewCount.dataset.wbReviewCount = "";
  reviewCount.setAttribute("aria-hidden", "true");
  reviewCount.hidden = true;
  review.append(
    icon("edit_document", "sm:hidden"),
    el("span", "max-sm:hidden", "Review Changes"),
    reviewCount,
  );

  const theme = button(ICON_BUTTON, "", "theme-toggle");
  theme.append(
    icon("dark_mode", "wb-theme-icon-dark w-[15px] h-[15px] text-primary"),
    icon("light_mode", "wb-theme-icon-light w-[15px] h-[15px] text-tertiary"),
  );

  right.append(review, actions, el("div", DIVIDER), theme);
  element.append(left, right);
  mountUserDoorTheme(theme);
  return { element, actions, reviewCount };
}

function panelToggle(
  id: string,
  label: string,
  glyph: string,
  controls: string,
): HTMLButtonElement {
  const toggle = button(
    "p-1 rounded hover:bg-surface-container transition-colors flex items-center justify-center text-primary",
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
    "h-8 bg-surface-container-lowest border-0 border-b border-solid border-hairline px-3 flex items-center justify-between gap-2 text-[11px] shrink-0 min-w-0",
  );
  element.dataset.wbSubheader = "";
  const left = el("div", "flex items-center gap-2 min-w-0");
  const line = el(
    "div",
    "flex items-center gap-2 font-mono text-[11px] text-on-surface-variant min-w-0",
  );
  const status = el(
    "span",
    "text-on-surface font-medium truncate min-w-0",
    "Ready - no repository is required.",
  );
  withId(status, "status");
  line.append(icon("account_tree", "text-primary"), status);
  // The legacy ledger's statement: effective state needs a target repository.
  const effective = el(
    "span",
    "px-1.5 py-0.5 rounded bg-surface-container text-outline font-mono text-[10px] truncate min-w-0 max-sm:hidden",
    "effective: not evaluated — needs a target repository",
  );
  effective.dataset.wbEffective = "";
  left.append(line, effective);
  const toggles = el(
    "div",
    "flex items-center rounded bg-surface-container-low border border-solid border-hairline p-0.5 gap-0.5 shrink-0",
  );
  toggles.append(
    panelToggle("toggle-nav-btn", "Toggle navigation", "left_panel", "nav-rail"),
    panelToggle("btn-toggle-inspector", "Toggle inspector", "right_panel", "inspector-rail"),
  );
  element.append(left, toggles);
  return { element, status };
}

function railSection(label: string, glyph: string): HTMLElement {
  const heading = el("div", RAIL_LABEL);
  heading.append(el("span", "", label), icon(glyph, "w-3 h-3 text-outline"));
  return heading;
}

function navRail(): { rail: HTMLElement; scopes: HTMLElement; scopesHost: HTMLElement } {
  const rail = el(
    "aside",
    "wb-rail shrink-0 w-60 bg-wb-nav border-0 border-r border-solid border-hairline flex-col justify-between overflow-hidden max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
  );
  withId(rail, "nav-rail");
  rail.dataset.wbRailState = "auto";
  rail.setAttribute("aria-label", "Workbench navigation");
  const scroll = el("div", "flex flex-col h-full justify-between overflow-y-auto");
  const sections = el("div", "p-2 flex flex-col gap-3");
  const group = el("div", "flex flex-col gap-1");
  const nav = el("nav", "flex flex-col gap-0.5 text-[11px]");
  nav.setAttribute("aria-label", "Workbench screens");
  for (const definition of SCREENS) {
    if (!definition.nav) continue;
    const link = button(
      "wb-nav-link group flex items-center justify-between w-full px-2 py-1 rounded text-left text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors",
      "",
    );
    link.dataset.wbNav = definition.screen;
    const name = el("span", "flex items-center gap-1.5 min-w-0");
    name.append(
      icon(definition.icon, "text-outline group-aria-[current=page]:text-primary"),
      el("span", "truncate", definition.title),
    );
    link.append(name);
    nav.append(link);
  }
  group.append(railSection("Workbench", "tune"), nav);
  // "Catalog scopes": the catalog's sources, which the catalog controller fills.
  const scopes = el(
    "div",
    "flex flex-col gap-1 pt-1 border-0 border-t border-solid border-hairline",
  );
  scopes.dataset.wbCatalogScopes = "";
  scopes.hidden = true;
  const scopesHost = el("div", "flex flex-col min-w-0");
  scopes.append(railSection("Catalog scopes", "account_tree"), scopesHost);
  sections.append(group, scopes);
  scroll.append(sections);
  rail.append(scroll);
  return { rail, scopes, scopesHost };
}

/** Screens that draw the prototype's full-bleed layout under a kicker title. */
const FULL_BLEED: ReadonlySet<WorkbenchScreen> = new Set(["sources", "changes"]);

function screenPanel(definition: ScreenDefinition): { panel: HTMLElement; body: HTMLElement } {
  // Ported screens are full-bleed like admin-sources.html: the title is a
  // kicker line and the screen draws its own masthead, bars and footer.
  const sources = FULL_BLEED.has(definition.screen);
  const panel = el(
    "section",
    sources
      ? "flex flex-col min-w-0 min-h-full bg-wb-center"
      : "flex flex-col gap-3 px-5 py-4 min-w-0",
  );
  panel.dataset.wbScreenPanel = definition.screen;
  const titleId = `wb-screen-title-${definition.screen}`;
  panel.setAttribute("aria-labelledby", titleId);
  const title = el(
    "h2",
    sources
      ? "m-0 px-5 pt-4 pb-0.5 bg-wb-subhead text-[10px] font-mono tracking-wider uppercase text-outline font-semibold flex items-center gap-1.5"
      : "m-0 text-[18px] font-bold tracking-tight font-mono text-on-surface flex items-center gap-2",
  );
  title.id = titleId;
  // Focus lands here after a file-menu action moves to this screen.
  title.tabIndex = -1;
  title.append(
    icon(definition.icon, sources ? "w-3 h-3" : "w-4 h-4 text-primary"),
    el("span", "", definition.title),
  );
  const body = el("div", sources ? "flex flex-col flex-1 min-w-0" : "flex flex-col gap-3 min-w-0");
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
    "wb-rail shrink-0 w-[390px] bg-wb-inspector border-0 border-l border-solid border-hairline flex-col min-h-0 shadow-2xl z-20 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-40",
  );
  withId(rail, "inspector-rail");
  rail.dataset.wbInspector = "";
  rail.dataset.wbRailState = "auto";
  rail.setAttribute("aria-label", "Inspector");
  const head = el(
    "div",
    "p-2.5 bg-surface-container-lowest border-0 border-b border-solid border-hairline flex items-center gap-2 shrink-0",
  );
  const tabs = el(
    "div",
    "flex items-center flex-1 min-w-0 p-0.5 rounded bg-surface-container-low border border-solid border-hairline text-[11px] gap-0.5",
  );
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Inspector views");
  const panel = el("div", "flex-1 overflow-y-auto p-3 text-[12px] text-on-surface-variant");
  withId(panel, "wb-inspector-panel");
  panel.setAttribute("role", "tabpanel");
  panel.append(el("p", "m-0", "Select an item to inspect it."));
  panel.dataset.wbInspectorPanel = "details";
  for (const [key, label] of INSPECTOR_TABS) {
    const tab = button(
      "wb-inspector-tab flex-1 py-1 px-1 rounded text-center text-on-surface-variant hover:text-on-surface transition-colors",
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
  const close = button(
    "p-1 rounded hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors shrink-0",
    "",
  );
  close.dataset.closeInspector = "";
  close.setAttribute("aria-label", "Close inspector");
  close.title = "Close inspector";
  close.append(icon("chevron_right", "w-4 h-4"));
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
    revealInspectorSection(panel, key);
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
  const tile = el("div", "px-4 pt-3 pb-3 flex flex-col gap-2 text-left min-w-0");
  tile.dataset.kindLedgerTile = entry.kind;
  const top = el("div", "flex items-center justify-between gap-2 min-w-0");
  const name = el("span", "flex items-center gap-1.5 min-w-0");
  name.append(
    icon(kindIcon.name, kindIcon.colorClass ?? ""),
    el(
      "span",
      "text-[10px] uppercase font-semibold tracking-[0.08em] truncate text-outline",
      entry.label,
    ),
  );
  top.append(
    name,
    el("span", "text-[10px] font-mono tabular-nums shrink-0 text-outline", `${percent}%`),
  );
  const count = el("div", "flex items-baseline justify-between gap-2");
  const figures = el("span", "flex items-baseline gap-1");
  figures.append(
    el(
      "span",
      "text-[22px] leading-none font-semibold font-mono tabular-nums tracking-tight text-wb-heading",
      String(entry.selected),
    ),
    el("span", "text-[11px] font-mono tabular-nums text-outline", `/${entry.total}`),
  );
  count.append(
    figures,
    el("span", "text-[10px] font-mono tabular-nums whitespace-nowrap text-outline", "selected"),
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
    "wb-shell flex flex-col h-screen min-h-0 overflow-hidden bg-background text-on-surface text-[13px] leading-normal antialiased";
  withId(root, "wb-root");
  root.dataset.wbShell = "new";

  const top = header();
  const sub = subHeader();
  const announcement = el(
    "p",
    "wb-announcement m-0 px-3 py-1 font-mono text-[11px] text-on-surface-variant bg-surface-container-low border-0 border-b border-solid border-hairline empty:hidden",
  );
  withId(announcement, "announcement");
  announcement.setAttribute("aria-live", "polite");

  const frame = el("div", "relative flex flex-1 min-h-0 min-w-0 w-full overflow-hidden");
  const nav = navRail();
  const rail = nav.rail;
  const column = el("div", "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden");
  // The prototype's six-tile strip; the Token Budget tile has no product data
  // (D6), so the five kind tiles share its width.
  const ledger = el(
    "div",
    "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 divide-x divide-y-0 divide-solid divide-hairline border-0 border-b border-solid border-hairline bg-wb-manifest shrink-0 select-none w-full",
  );
  ledger.dataset.wbLedger = "";
  ledger.setAttribute("role", "group");
  ledger.setAttribute("aria-label", "Catalog kinds");
  const work = el("div", "flex flex-1 min-h-0 min-w-0 w-full overflow-hidden relative");
  const main = el("main", "flex-1 min-w-0 overflow-y-auto bg-wb-center");
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
  const inspectorPanel = inspector.querySelector<HTMLElement>("#wb-inspector-panel") as HTMLElement;
  const syncInspector = wireRailToggle(
    sub.element.querySelector<HTMLButtonElement>("#btn-toggle-inspector") as HTMLButtonElement,
    inspector,
  );
  inspector.querySelector("[data-close-inspector]")?.addEventListener("click", () => {
    // Close an open catalog item through its own close path first, so its
    // open state, panel attributes and row aria-expanded are reset.
    inspectorPanel
      .querySelector<HTMLButtonElement>(
        "[data-workbench-inspector-open='true'] [data-workbench-details-close]",
      )
      ?.click();
    inspector.dataset.wbRailState = "closed";
    syncInspector();
  });
  syncNav();
  syncInspector();

  const router = mountScreenRouter(root, initial);
  // A catalog scope opens its catalog, whichever screen is showing.
  nav.scopesHost.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-workbench-source-tab]") !== null)
      router.setScreen("sources");
  });
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
    inspectorPanel,
    revealInspector() {
      if (inspector.dataset.wbRailState !== "closed") return;
      inspector.dataset.wbRailState = "auto";
      syncInspector();
    },
    mountCatalogScopes(node) {
      nav.scopesHost.replaceChildren(node);
      nav.scopes.hidden = false;
    },
    setReviewCount(count) {
      top.reviewCount.textContent = String(count);
      top.reviewCount.hidden = count === 0;
    },
    adoptInspectorChrome() {
      const head = inspectorPanel.previousElementSibling as HTMLElement;
      const tabs = head.querySelector<HTMLElement>("[role='tablist']") as HTMLElement;
      const close = head.querySelector<HTMLElement>("[data-close-inspector]") as HTMLElement;
      head.hidden = true;
      inspectorPanel.classList.remove("p-3");
      return { tabs, close };
    },
  };
}
