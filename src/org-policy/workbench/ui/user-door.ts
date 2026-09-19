import { workbenchIcon } from "./icons.js";
import { catalogKindIcon, KIND_LEDGER_KINDS } from "./kind-ledger.js";
import {
  buildProjectPolicyV1,
  type TrimUseV1,
  type UserDoorTrimItemV1,
  type UserDoorViewModelV1,
  userDoorViewModelV1,
} from "./user-door-model.js";

/**
 * The user door (P5b): trim the org policy's allowed items into an
 * `aih-project-policy.json` download (D5, D7). Every model-derived string is
 * written with `textContent`/attributes; only constant icon markup uses
 * `innerHTML`. No token or context cost is shown (D6).
 *
 * Markup and class strings are ported from
 * prototype/policy-workbench/screens/user-trim.html and user-shell.js (the
 * provenance strip, the trimming strip, the sources rail, the kind ledger,
 * the item cards and the "What your AI carries" panel); the invalid and
 * unbound states take user-start.html's "No organization policy found" block.
 * Literal dark hexes map to theme tokens (tools/workbench-tailwind.config.cjs).
 */

export const PROJECT_POLICY_FILENAME = "aih-project-policy.json";

const USES: readonly { use: TrimUseV1; label: string }[] = [
  { use: "required", label: "Required" },
  { use: "optional", label: "Optional" },
  { use: "skip", label: "Skip" },
];

const KIND_LABELS: Record<string, string> = {
  skill: "Skills",
  command: "Commands",
  agent: "Agents",
  mcp: "MCP Servers",
  hook: "Hook Events",
};

const KIND_CHIPS: Record<string, string> = {
  skill: "Skill",
  command: "Command",
  agent: "Agent",
  mcp: "MCP",
  hook: "Hook",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string, className: string): HTMLSpanElement {
  const node = el(
    "span",
    `inline-flex shrink-0 w-4 h-4 [&>svg]:w-full [&>svg]:h-full ${className}`,
  );
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = workbenchIcon(name);
  return node;
}

const LABEL = "text-[10px] font-mono uppercase tracking-wider text-outline font-semibold";
const SEP = "text-outline/40";
const STRIP =
  "min-h-8 bg-surface-container-lowest border-0 border-b border-solid border-hairline px-3 py-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] shrink-0 min-w-0";
const RAIL_BOX =
  "rounded bg-surface-container-low border border-solid border-surface-container-high divide-y divide-x-0 divide-solid divide-surface-container-high";
const SEGMENT =
  "flex items-center bg-surface-container-lowest p-0.5 rounded border border-solid border-surface-container-high shrink-0";

function segmentClass(use: TrimUseV1 | undefined, on: boolean, small: boolean): string {
  const pad = small ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11px]";
  const tone = !on
    ? "text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
    : use === "required"
      ? "bg-secondary-container/20 text-secondary font-semibold"
      : use === "optional"
        ? "bg-surface-container text-primary font-semibold shadow-xs"
        : "bg-surface-container-highest text-on-surface font-semibold";
  return `${pad} rounded transition-colors ${tone}`;
}

function sourceChipNode(view: UserDoorViewModelV1): HTMLElement {
  // user-shell.js: the strip's "policy" entry — which policy, from where.
  const chip = el("div", "flex flex-wrap items-center gap-1 min-w-0 font-mono text-[11px]");
  chip.id = "user-policy-source";
  const source = view.source;
  const ok = source?.valid === true;
  chip.append(
    el("span", "text-outline", "policy"),
    icon(ok ? "policy" : "info", `w-[13px] h-[13px] ${ok ? "text-secondary" : "text-error"}`),
  );
  if (source?.name !== undefined) {
    const name = el("span", "text-on-surface font-medium break-all", source.name);
    name.title = source.name;
    chip.append(name);
  }
  chip.append(
    el(
      "span",
      `px-1.5 py-0.5 rounded bg-surface-container-high text-[10px] ${ok ? "text-secondary" : "text-error"}`,
      source?.kind ?? "none",
    ),
    el("span", ok ? "text-on-surface-variant" : "text-error", ok ? "valid" : "invalid"),
  );
  if (ok) chip.append(icon("verified_user", "w-[13px] h-[13px] text-secondary"));
  chip.dataset.valid = ok ? "true" : "false";
  return chip;
}

function provenanceStrip(view: UserDoorViewModelV1): HTMLElement {
  const strip = el("div", STRIP);
  strip.dataset.userStrip = "provenance";
  const line = el(
    "div",
    "flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 font-mono text-[11px] text-on-surface-variant",
  );
  const saves = el("span", "flex items-center gap-1");
  saves.append(
    el("span", "text-outline", "saves to"),
    el("span", "text-on-surface font-medium", PROJECT_POLICY_FILENAME),
  );
  line.append(
    icon("account_tree", "w-[14px] h-[14px] text-primary"),
    sourceChipNode(view),
    el("span", SEP, "•"),
    saves,
    el(
      "span",
      "px-1.5 py-0.5 rounded bg-surface-container text-outline text-[10px]",
      "download only",
    ),
  );
  strip.append(line);
  return strip;
}

function emptyState(id: string, title: string, tone: string): HTMLElement {
  // user-start.html: "No organization policy found on this machine".
  const box = el(
    "div",
    "rounded border border-dashed border-surface-container-high bg-surface-container-low/40 p-3.5 flex flex-col gap-2.5 text-[11.5px] text-on-surface-variant",
  );
  box.id = id;
  const head = el("div", "flex items-center gap-2");
  head.append(
    icon(tone === "text-error" ? "link_off" : "link", `w-[18px] h-[18px] ${tone}`),
    el("span", "font-semibold text-on-surface text-[13px]", title),
  );
  box.append(head);
  return box;
}

function lookupNote(): HTMLElement {
  // user-start.html's "Set it up for good" card: where the org policy comes from.
  const card = el(
    "div",
    "rounded bg-wb-card border border-solid border-surface-container-high p-2.5 flex flex-col gap-1.5",
  );
  const text = el("p", "text-[11px] text-on-surface-variant leading-relaxed");
  text.append(
    "This page opens for a project bound to an organization policy (",
    el("span", "font-mono text-on-surface", ".aih-config.json"),
    ") or holding ",
    el("span", "font-mono text-on-surface", PROJECT_POLICY_FILENAME),
    ". Fix the binding, then open the page again.",
  );
  card.append(el("div", LABEL, "Where the organization policy comes from"), text);
  return card;
}

export function mountUserDoor(root: HTMLElement, model: unknown): void {
  const view = userDoorViewModelV1(model);
  const choices = new Map<string, TrimUseV1>();
  const useOf = (item: UserDoorTrimItemV1): TrimUseV1 => choices.get(item.assetId) ?? "optional";
  const listeners: (() => void)[] = [];
  const refresh = () => {
    for (const listener of listeners) listener();
  };
  root.replaceChildren();
  root.className =
    "user-door flex-1 min-h-0 flex flex-col bg-background text-on-surface text-[13px] leading-normal";

  // ---- the trimming strip: what is trimmed, and for whom (user-trim.html sub-header)
  const trimStrip = el("div", STRIP);
  trimStrip.dataset.userStrip = "trim";
  const trimming = el("span", "flex items-center gap-2 min-w-0");
  trimming.append(
    el(
      "span",
      "font-mono uppercase tracking-wider text-[10px] text-outline font-semibold",
      "Trimming",
    ),
    el("span", "font-semibold text-on-surface", "Organization policy"),
  );
  const lock = el(
    "span",
    "px-1.5 py-0.5 rounded bg-surface-container text-outline font-mono text-[10px] flex items-center gap-1",
  );
  lock.append(icon("lock", "w-[11px] h-[11px]"), el("span", "", "locked"));
  trimming.append(lock);
  if (view.source?.valid === true && view.saveBlocked === undefined) {
    const allowed = el(
      "span",
      "px-1.5 py-0.5 rounded bg-secondary-container/20 text-secondary font-mono text-[10px] flex items-center gap-1",
    );
    allowed.append(
      icon("verified_user", "w-[11px] h-[11px]"),
      el("span", "", "everything here is allowed by your organization"),
    );
    trimming.append(allowed);
  }
  const forGroup = el("span", "flex items-center gap-2 min-w-0");
  const forLabel = el(
    "label",
    "font-mono uppercase tracking-wider text-[10px] text-outline font-semibold",
    "For",
  );
  forLabel.htmlFor = "user-for-type";
  const forType = el(
    "select",
    "h-6 px-2 py-0 rounded bg-surface-container-lowest border border-solid border-surface-container-high text-[11px] text-primary font-semibold focus:border-primary focus:outline-none",
  );
  forType.id = "user-for-type";
  for (const value of ["project", "persona", "agent"]) {
    const option = el("option", "", value[0]?.toUpperCase() + value.slice(1));
    option.value = value;
    forType.append(option);
  }
  const forName = el(
    "input",
    "w-40 h-6 px-2 py-0 leading-6 rounded bg-wb-card border border-solid border-surface-container-high font-mono text-on-surface text-[11px] placeholder:text-outline focus:border-primary focus:outline-none",
  );
  forName.id = "user-for-name";
  forName.type = "text";
  forName.autocomplete = "off";
  forName.required = true;
  forName.placeholder = "Project name";
  forName.setAttribute("aria-label", "Project name");
  forName.setAttribute("aria-required", "true");
  forGroup.append(
    el("span", "h-3.5 w-px bg-surface-container-high mx-0.5 max-sm:hidden"),
    forLabel,
    forType,
    forName,
  );
  trimStrip.append(trimming, forGroup);

  // ---- LEFT: sources in this policy, kept / offered
  const nav = el(
    "aside",
    "shrink-0 w-60 bg-wb-nav border-0 border-r border-solid border-surface-container-high flex flex-col overflow-hidden max-md:hidden",
  );
  nav.setAttribute("aria-label", "Sources in this policy");
  const navBody = el("div", "p-2 flex flex-col gap-1 flex-1 overflow-y-auto");
  const navHead = el(
    "div",
    "px-2 py-0.5 text-[10px] font-mono tracking-wider text-outline uppercase font-semibold flex items-center justify-between",
  );
  navHead.append(
    el("span", "", "Sources in this policy"),
    el("span", "normal-case tracking-normal font-normal", "kept / offered"),
  );
  const sourceList = el("div", "flex flex-col gap-0.5 text-[11px]");
  const sources = new Map<string, UserDoorTrimItemV1[]>();
  for (const item of view.items) {
    const key = item.sourceId ?? "other";
    sources.set(key, [...(sources.get(key) ?? []), item]);
  }
  for (const [sourceId, items] of sources) {
    const box = el(
      "div",
      "rounded bg-surface-container-low/80 p-1 border border-solid border-surface-container-high",
    );
    const head = el("div", "flex items-center justify-between px-1.5 py-1");
    const name = el("span", "flex items-center gap-2 min-w-0");
    name.append(
      icon("folder_open", "w-[15px] h-[15px] text-primary"),
      el("span", "truncate font-semibold text-[11.5px] text-on-surface", sourceId),
    );
    const count = el(
      "span",
      "font-mono text-[10px] px-1 rounded bg-surface-container-highest text-secondary font-bold",
    );
    listeners.push(() => {
      count.textContent = `${items.filter((item) => useOf(item) !== "skip").length} / ${items.length}`;
    });
    head.append(name, count);
    const kinds = el("div", "pl-2 flex flex-col gap-0.5 text-[10.5px] pb-0.5");
    for (const kind of new Set(items.map((item) => item.kind ?? "other"))) {
      const ofKind = items.filter((item) => (item.kind ?? "other") === kind);
      const row = el(
        "div",
        "flex items-center justify-between px-1.5 py-0.5 rounded text-on-surface-variant",
      );
      const dot = el("span", "w-1.5 h-1.5 rounded-full shrink-0");
      const label = el("span", "flex items-center gap-1.5 truncate");
      label.append(dot, el("span", "truncate", KIND_LABELS[kind] ?? kind));
      const kindCount = el("span", "font-mono text-outline text-[10px]");
      listeners.push(() => {
        const uses = new Set(ofKind.map(useOf));
        const only = uses.size === 1 ? [...uses][0] : undefined;
        dot.className = `w-1.5 h-1.5 rounded-full shrink-0 ${
          only === undefined
            ? "bg-tertiary"
            : only === "skip"
              ? "bg-surface-container-highest"
              : only === "required"
                ? "bg-secondary"
                : "bg-primary"
        }`;
        kindCount.textContent = `${ofKind.filter((item) => useOf(item) !== "skip").length} / ${ofKind.length}`;
      });
      row.append(label, kindCount);
      kinds.append(row);
    }
    box.append(head, kinds);
    sourceList.append(box);
  }
  if (sources.size === 0)
    sourceList.append(el("p", "px-2 py-1 text-[10.5px] text-outline", "No sources listed."));
  navBody.append(navHead, sourceList);
  nav.append(
    navBody,
    el(
      "p",
      "m-0 p-3 text-[10.5px] text-outline leading-snug border-0 border-t border-solid border-hairline",
      "Only what your organization allows is listed. Security was decided by your organization; here you choose what your AI carries.",
    ),
  );

  // ---- the kind ledger: what you keep, live (six tiles; the sixth is the total kept)
  const ledger = el(
    "div",
    "grid grid-cols-3 md:grid-cols-6 divide-x divide-y-0 divide-solid divide-hairline border-0 border-b border-solid border-hairline bg-wb-manifest shrink-0 select-none w-full",
  );
  ledger.dataset.userLedger = "";
  ledger.setAttribute("role", "group");
  ledger.setAttribute("aria-label", "Kept by kind");
  const tile = (
    key: string,
    label: string,
    glyph: string,
    colorClass: string,
    of: () => readonly UserDoorTrimItemV1[],
  ) => {
    const node = el("div", "px-4 pt-3 pb-3 flex flex-col gap-2 min-w-0 max-md:px-3");
    node.dataset.userLedgerTile = key;
    const top = el("div", "flex items-center justify-between gap-2 min-w-0");
    const name = el("span", "flex items-center gap-1.5 min-w-0");
    name.append(
      icon(glyph, `w-[14px] h-[14px] ${colorClass}`),
      el(
        "span",
        "text-[10px] uppercase font-semibold tracking-[0.08em] truncate text-outline",
        label,
      ),
    );
    const pct = el("span", "text-[10px] font-mono tabular-nums shrink-0 text-outline");
    top.append(name, pct);
    const figures = el("span", "flex items-baseline gap-1");
    const kept = el(
      "span",
      "text-[22px] leading-none font-semibold font-mono tabular-nums tracking-tight text-wb-heading",
    );
    const total = el("span", "text-[11px] font-mono tabular-nums text-outline");
    figures.append(kept, total);
    const count = el("div", "flex items-baseline justify-between gap-2");
    count.append(
      figures,
      el("span", "text-[10px] font-mono tabular-nums whitespace-nowrap text-outline", "kept"),
    );
    const track = el("div", "h-[3px] rounded-full bg-surface-container-highest overflow-hidden");
    const bar = el("div", `h-full rounded-full transition-all duration-300 ${colorClass}`);
    bar.style.background = "currentColor";
    track.append(bar);
    node.append(top, count, track);
    listeners.push(() => {
      const items = of();
      const keptCount = items.filter((item) => useOf(item) !== "skip").length;
      const percent = items.length === 0 ? 0 : Math.round((keptCount * 100) / items.length);
      pct.textContent = `${percent}%`;
      kept.textContent = String(keptCount);
      total.textContent = `/${items.length}`;
      bar.style.width = `${percent}%`;
    });
    ledger.append(node);
  };
  for (const kind of KIND_LEDGER_KINDS) {
    const glyph = catalogKindIcon(kind);
    tile(kind, KIND_LABELS[kind] ?? kind, glyph.name, glyph.colorClass ?? "", () =>
      view.items.filter((item) => item.kind === kind),
    );
  }
  tile("all", "All items", "done_all", "text-primary", () => view.items);

  // ---- CENTER: the policy's items as cards
  const main = el("section", "flex-1 flex flex-col min-w-0 bg-wb-center md:overflow-hidden");
  main.setAttribute("aria-labelledby", "user-trim-title");
  const mainHead = el(
    "div",
    "px-5 pt-4 pb-3 border-0 border-b border-solid border-hairline bg-wb-subhead flex flex-col gap-2 shrink-0 max-md:px-4",
  );
  const headRow = el("div", "flex items-center justify-between flex-wrap gap-2");
  const titles = el("div", "min-w-0");
  const title = el(
    "h2",
    "m-0 text-[22px] font-bold text-wb-heading tracking-tight flex flex-wrap items-center gap-2 font-mono",
  );
  title.id = "user-trim-title";
  title.append(el("span", "", "Choose what this project uses"));
  titles.append(
    el(
      "div",
      "text-[10px] font-mono tracking-wider uppercase text-outline font-semibold mb-0.5",
      "Organization policy · locked",
    ),
    title,
  );
  headRow.append(titles);
  const setAll = el("div", "flex items-center gap-2");
  if (view.items.length > 0) {
    const setAllLabel = el(
      "span",
      "text-[10.5px] font-mono text-outline uppercase tracking-wider",
      `Set all ${view.items.length}`,
    );
    const setAllGroup = el("div", SEGMENT);
    setAllGroup.setAttribute("role", "group");
    setAllGroup.setAttribute("aria-label", "Set every item");
    const setAllButtons = USES.map((option) => {
      const node = el("button", "", option.label);
      node.type = "button";
      node.dataset.userSetAll = option.use;
      node.addEventListener("click", () => {
        for (const item of view.items) choices.set(item.assetId, option.use);
        refresh();
      });
      setAllGroup.append(node);
      return node;
    });
    const mixed = el("span", "px-1.5 text-[9.5px] font-mono text-tertiary", "mixed");
    mixed.title = "The items are not all set the same way. Pick one to set them all.";
    setAllGroup.append(mixed);
    listeners.push(() => {
      const uses = new Set(view.items.map(useOf));
      const only = uses.size === 1 ? [...uses][0] : undefined;
      for (const node of setAllButtons) {
        const on = node.dataset.userSetAll === only;
        node.setAttribute("aria-pressed", on ? "true" : "false");
        node.className = segmentClass(only, on, false);
      }
      mixed.hidden = only !== undefined;
    });
    setAll.append(setAllLabel, setAllGroup);
    headRow.append(setAll);
  }
  const meta = el("div", "flex flex-wrap items-center gap-2 text-[11px] font-mono text-outline");
  const sha = view.source?.sha256;
  if (sha !== undefined) {
    const pinned = el("span", "");
    pinned.append("sha256 ", el("strong", "text-on-surface font-semibold", sha.slice(0, 8)));
    pinned.title = sha;
    meta.append(pinned, el("span", SEP, "•"));
  }
  meta.append(
    el(
      "span",
      "font-body text-on-surface-variant",
      "Only items your organization's policy allows are listed. Required and Optional items are kept; skipped items are left out of the file.",
    ),
  );
  mainHead.append(headRow, meta);

  const body = el("div", "flex-1 md:overflow-y-auto p-4 bg-wb-cards flex flex-col gap-4 min-h-0");
  if (view.source?.valid === false) {
    const box = emptyState(
      "user-trim-unavailable",
      "The organization policy could not be read",
      "text-error",
    );
    const error = el("p", "text-[11.5px] text-on-surface flex items-start gap-1.5 leading-relaxed");
    error.id = "user-source-error";
    error.append(
      icon("info", "w-[15px] h-[15px] text-error mt-px"),
      el("span", "", view.saveBlocked ?? ""),
    );
    box.append(error, lookupNote());
    body.append(box);
  } else if (view.missing.length > 0) {
    const box = emptyState(
      "user-trim-empty",
      "No organization policy to trim yet",
      "text-tertiary",
    );
    box.append(
      el(
        "p",
        "leading-relaxed",
        "This page cannot list your organization's items yet. The Workbench server does not provide:",
      ),
    );
    const missing = el("ul", "list-disc pl-5 m-0 flex flex-col gap-1 font-mono text-[10.5px]");
    for (const entry of view.missing) missing.append(el("li", "", entry));
    box.append(missing, lookupNote());
    body.append(box);
  } else if (view.items.length === 0) {
    const box = emptyState("user-trim-empty", "The org policy lists no items.", "text-tertiary");
    body.append(box);
  }

  const list = el(
    "ul",
    "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 m-0 p-0 list-none empty:hidden",
  );
  list.id = "user-trim-list";
  for (const item of view.items) {
    const name = item.label ?? item.assetId;
    const row = el(
      "li",
      "group rounded border border-solid bg-wb-card p-3 flex flex-col justify-between hover:border-primary transition-all shadow-xs min-w-0",
    );
    row.dataset.assetId = item.assetId;
    const kindIcon = catalogKindIcon(item.kind ?? "");
    const top = el("div", "min-w-0");
    const titleRow = el("div", "flex items-start justify-between gap-2");
    const nameBox = el("div", "flex items-center gap-1.5 min-w-0");
    const nameText = el(
      "span",
      "font-mono font-bold text-wb-heading text-[13px] tracking-tight truncate",
      name,
    );
    nameText.title = name;
    nameBox.append(
      icon(kindIcon.name, `w-[15px] h-[15px] ${kindIcon.colorClass ?? "text-outline"}`),
      nameText,
    );
    titleRow.append(nameBox);
    if (item.kind !== undefined)
      titleRow.append(
        el(
          "span",
          "px-1.5 py-0.5 rounded bg-surface-container-low border border-solid border-surface-container-high text-[8.5px] font-mono text-outline uppercase shrink-0",
          KIND_CHIPS[item.kind] ?? item.kind,
        ),
      );
    top.append(
      titleRow,
      el(
        "p",
        "text-[11px] text-on-surface-variant mt-2 leading-relaxed font-mono break-all line-clamp-2",
        item.assetId,
      ),
    );
    const foot = el(
      "div",
      "pt-2.5 mt-2.5 border-0 border-t border-solid border-hairline flex flex-col gap-2 text-[10px]",
    );
    const facts = el("div", "flex items-center gap-1.5 flex-wrap");
    facts.append(
      el(
        "span",
        "px-1.5 py-0.5 rounded bg-surface-container-low border border-solid border-surface-container-high text-outline font-mono shrink-0",
        item.origin.kind,
      ),
    );
    if (item.sourceId !== undefined)
      facts.append(
        el(
          "span",
          "px-1.5 py-0.5 rounded bg-surface-container-low border border-solid border-surface-container-high text-outline font-mono shrink-0",
          item.sourceId,
        ),
      );
    const group = el("div", SEGMENT);
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", `Use of ${name}`);
    const buttons: HTMLButtonElement[] = [];
    const paint = () => {
      const current = useOf(item);
      row.dataset.use = current;
      const changed = current !== "optional";
      row.classList.toggle("border-primary/60", changed);
      row.classList.toggle("border-surface-container-high", !changed);
      row.classList.toggle("opacity-55", current === "skip");
      nameText.classList.toggle("line-through", current === "skip");
      for (const button of buttons) {
        const on = button.dataset.use === current;
        button.setAttribute("aria-checked", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
        button.className = segmentClass(current, on, true);
      }
    };
    listeners.push(paint);
    const choose = (use: TrimUseV1) => {
      choices.set(item.assetId, use);
      refresh();
    };
    for (const [index, option] of USES.entries()) {
      const button = el("button", "", option.label);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.use = option.use;
      button.addEventListener("click", () => choose(option.use));
      button.addEventListener("keydown", (event) => {
        const step =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? -1
              : 0;
        if (step === 0) return;
        event.preventDefault();
        const next = USES[(index + step + USES.length) % USES.length];
        if (next === undefined) return;
        choose(next.use);
        buttons.find((candidate) => candidate.dataset.use === next.use)?.focus();
      });
      buttons.push(button);
      group.append(button);
    }
    const segRow = el("div", "flex justify-end");
    segRow.append(group);
    foot.append(facts, segRow);
    row.append(top, foot);
    list.append(row);
  }
  body.append(list);
  if (view.ambiguous.length > 0) {
    const note = el(
      "p",
      "p-2 rounded bg-tertiary-container/15 border border-solid border-tertiary/30 text-[11px] text-on-surface-variant",
      `Not offered, listed under more than one origin: ${view.ambiguous.join(", ")}`,
    );
    note.id = "user-trim-ambiguous";
    body.append(note);
  }
  main.append(mainHead, body);

  // ---- RIGHT: what your AI carries, live, and Save
  const side = el(
    "aside",
    "shrink-0 w-[330px] max-md:w-full bg-wb-inspector border-0 border-l max-md:border-l-0 max-md:border-t border-solid border-surface-container-high flex flex-col md:overflow-hidden text-[11.5px] text-on-surface-variant",
  );
  side.setAttribute("aria-label", "Save project policy");
  const sideHead = el(
    "div",
    "p-2.5 bg-surface-container-lowest border-0 border-b border-solid border-hairline flex flex-col gap-1 shrink-0",
  );
  const sideTitleRow = el("div", "flex items-center justify-between");
  const changed = el(
    "span",
    "px-1.5 py-0.5 rounded bg-primary/15 text-primary font-mono text-[10px] font-semibold",
  );
  changed.dataset.userChanges = "";
  listeners.push(() => {
    const count = view.items.filter((item) => useOf(item) !== "optional").length;
    changed.textContent = `${count} ${count === 1 ? "change" : "changes"}`;
  });
  sideTitleRow.append(
    el("h2", "m-0 font-semibold text-on-surface text-[13px]", "What your AI carries"),
    changed,
  );
  sideHead.append(
    sideTitleRow,
    el(
      "div",
      "text-[10.5px] text-outline",
      "Updates as you choose. Nothing is saved until you save.",
    ),
  );
  const sideBody = el("div", "flex-1 md:overflow-y-auto p-3 flex flex-col gap-3");

  const factsBox = el("div", RAIL_BOX);
  const factRow = (label: string, value: HTMLElement) => {
    const node = el("div", "flex justify-between gap-2 px-2.5 py-1.5");
    node.append(el("span", "", label), value);
    factsBox.append(node);
  };
  const forValue = el("span", "text-on-surface text-right break-all");
  const onValue = el("span", "text-on-surface text-right break-all");
  const required = el("span", "text-secondary font-mono");
  const optional = el("span", "text-primary font-mono");
  const skipped = el("span", "text-on-surface font-mono");
  factRow("For", forValue);
  factRow("On", onValue);
  factRow("Required", required);
  factRow("Optional", optional);
  factRow("Skipped", skipped);

  const tools = el("fieldset", "flex flex-col gap-1.5 border-0 p-0 m-0 min-w-0");
  tools.id = "user-ai-tools";
  tools.append(el("legend", `${LABEL} mb-1.5 p-0`, "Set up for"));
  const toolGrid = el(
    "div",
    "grid grid-cols-2 gap-x-2 gap-y-0.5 p-1 rounded bg-surface-container-low border border-solid border-surface-container-high text-[11.5px]",
  );
  for (const tool of view.aiTools) {
    const label = el(
      "label",
      "flex items-center gap-2 px-1.5 py-1 rounded hover:bg-surface-container cursor-pointer text-on-surface",
    );
    const box = el("input", "rounded-sm w-3.5 h-3.5 accent-primary m-0");
    box.type = "checkbox";
    box.name = "user-ai-tool";
    box.id = `user-ai-tool-${tool}`;
    box.value = tool;
    label.append(box, el("span", "font-mono", tool));
    toolGrid.append(label);
  }
  tools.append(toolGrid);
  if (view.aiTools.length > 0 && !view.aiToolsFromPolicy)
    tools.append(
      el(
        "p",
        "text-[10.5px] text-outline",
        "The org policy does not limit AI tools; every tool aih supports is listed.",
      ),
    );
  const checkedTools = () =>
    [...tools.querySelectorAll<HTMLInputElement>("input[name='user-ai-tool']:checked")].map(
      (box) => box.value,
    );

  const counts = el("p", "text-[10.5px] font-mono text-outline");
  counts.id = "user-trim-counts";
  const renderFacts = () => {
    const tally = { required: 0, optional: 0, skip: 0 };
    for (const item of view.items) tally[useOf(item)] += 1;
    counts.textContent = `${tally.required} required · ${tally.optional} optional · ${tally.skip} skipped`;
    required.textContent = String(tally.required);
    optional.textContent = String(tally.optional);
    skipped.textContent = String(tally.skip);
    const type = forType.selectedOptions[0]?.textContent ?? forType.value;
    forValue.textContent = `${type} · ${forName.value.trim() || "—"}`;
    onValue.textContent = checkedTools().join(", ") || "no AI tool";
  };
  listeners.push(renderFacts);
  forName.addEventListener("input", renderFacts);
  forType.addEventListener("change", renderFacts);
  tools.addEventListener("change", renderFacts);

  const files = el("div", `${RAIL_BOX} text-[10.5px]`);
  const fileRow = (glyph: string, tone: string, name: string, note: string) => {
    const node = el("div", "flex items-center justify-between gap-2 px-2.5 py-1.5");
    const left = el("span", "flex items-center gap-1.5 min-w-0");
    left.append(
      icon(glyph, `w-[13px] h-[13px] ${tone}`),
      el("span", "font-mono text-on-surface whitespace-nowrap", name),
    );
    node.append(left, el("span", "text-outline text-right", note));
    files.append(node);
  };
  fileRow("lock", "text-outline", view.source?.name ?? "org policy", "read only · never written");
  fileRow("edit_document", "text-primary", PROJECT_POLICY_FILENAME, "your choices · downloaded");
  const saveSection = el("div", "flex flex-col gap-1.5");
  const saveText = el("p", "m-0 leading-relaxed");
  saveText.append(
    "Save downloads ",
    el("span", "font-mono text-on-surface", PROJECT_POLICY_FILENAME),
    ", with the digest of the policy it was cut from. Nothing is written to disk by the Workbench, and the org policy is never changed. Put it in the project folder and commit it.",
  );
  saveSection.append(el("div", LABEL, "Save and use"), files, saveText);

  const message = el("p", "m-0 text-[11px] text-on-surface min-h-[1em] empty:hidden");
  message.id = "user-save-message";
  message.setAttribute("aria-live", "polite");

  const summary = el("div", "flex flex-col gap-1.5");
  summary.append(el("div", LABEL, "What you keep"), factsBox, counts);
  sideBody.append(summary, tools, saveSection, message);

  const foot = el(
    "div",
    "p-2 bg-surface-container-lowest border-0 border-t border-solid border-surface-container-high flex items-center gap-2 shrink-0",
  );
  const reset = el(
    "button",
    "px-2.5 py-1.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
    "Reset",
  );
  reset.type = "button";
  reset.id = "user-reset";
  reset.addEventListener("click", () => {
    choices.clear();
    refresh();
  });
  const save = el(
    "button",
    "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-primary hover:bg-primary-bright text-on-primary text-[12px] font-medium transition-colors shadow-xs disabled:cursor-not-allowed disabled:bg-surface-container-highest disabled:text-on-surface-variant",
  );
  save.id = "user-save";
  save.type = "button";
  save.setAttribute("aria-describedby", "user-save-message");
  save.append(icon("save", "w-[14px] h-[14px]"), el("span", "", `Save ${PROJECT_POLICY_FILENAME}`));
  if (view.saveBlocked !== undefined) {
    save.disabled = true;
    reset.disabled = true;
    message.textContent = view.saveBlocked;
  }
  save.addEventListener("click", () => {
    const result = buildProjectPolicyV1(view, {
      choices,
      forType: forType.value as "project" | "persona" | "agent",
      forName: forName.value,
      aiTools: checkedTools(),
    });
    if (!result.ok) {
      message.textContent = `Not saved: ${result.errors.join("; ")}`;
      return;
    }
    const blob = new Blob([`${JSON.stringify(result.policy, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = PROJECT_POLICY_FILENAME;
    link.click();
    URL.revokeObjectURL(url);
    message.textContent = `Download started. Put ${PROJECT_POLICY_FILENAME} in the project folder and commit it.`;
  });
  // The header's Save (user-shell.js `data-save`) runs the same save.
  const headerSave = document.querySelector<HTMLButtonElement>("[data-user-header-save]");
  if (headerSave !== null) {
    headerSave.disabled = save.disabled;
    headerSave.addEventListener("click", () => save.click());
  }
  foot.append(reset, save);
  side.append(sideHead, sideBody, foot);

  const frame = el("div", "flex flex-1 min-h-0 w-full md:overflow-hidden max-md:flex-col");
  const column = el("div", "flex-1 flex flex-col min-w-0 md:overflow-hidden");
  const work = el("div", "flex-1 flex min-h-0 md:overflow-hidden max-md:flex-col");
  work.append(main, side);
  column.append(ledger, work);
  // Nothing to trim (invalid or unbound source): the start page's frame, the
  // main column and the right panel, without the rail and the ledger.
  const unavailable = view.saveBlocked !== undefined && view.items.length === 0;
  if (unavailable) {
    nav.hidden = true;
    ledger.hidden = true;
    summary.hidden = true;
  }
  tools.hidden = view.aiTools.length === 0;
  frame.append(nav, column);
  root.append(provenanceStrip(view), trimStrip, frame);
  refresh();
}

/** Wire the user page's own theme toggle (the admin runtime is not mounted here). */
export function mountUserDoorTheme(toggle: HTMLElement | null): void {
  if (!(toggle instanceof HTMLButtonElement)) return;
  const sync = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  };
  toggle.addEventListener("click", () => {
    document.documentElement.dataset.theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    sync();
  });
  sync();
}

/**
 * Chooser door: the launch folder is neither a policy repository nor a
 * project. Say which folder opens which page; no new behaviour.
 */
export function mountChooserNote(anchor: HTMLElement | null): void {
  if (anchor === null) return;
  const note = el(
    "aside",
    "wb-door-chooser mx-3 my-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-lowest text-on-surface text-[12px] flex items-start gap-2",
  );
  note.id = "door-chooser-note";
  note.setAttribute("aria-label", "Which page opens");
  const body = el("div", "flex flex-col gap-1 min-w-0");
  body.append(el("p", "font-semibold", "This folder is not a policy repository or a project."));
  const list = el("ul", "list-disc pl-5 m-0 text-on-surface-variant");
  list.append(
    el(
      "li",
      "",
      "A folder with aih-org-policy.json (or AIH_ORG_POLICY set) opens this admin page.",
    ),
    el(
      "li",
      "",
      "A project bound to an org policy (.aih-config.json) or holding aih-project-policy.json opens the project page.",
    ),
  );
  body.append(list);
  note.append(icon("info", "text-primary"), body);
  anchor.after(note);
}
