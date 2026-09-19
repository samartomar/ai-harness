import { el, icon } from "./dom.js";

/**
 * The prototype's per-screen frame (`screens/admin-org.html`,
 * `screens/admin-acme.html`): a header with a mono kicker over the 22 px
 * title, the centre on the cards background, and the screen's own inspector
 * content. The shell's inspector rail shows that content, in place of the item
 * inspector, while the screen is active (`[data-wb-screen-aside]` in
 * `wb-tokens.css`). The screen panel, its title (id, text, focus target) and
 * `[data-wb-screen-body]` stay the shell's; only their classes change.
 */
export interface ScreenFrame {
  /** The screen's own inspector content (`#inspector-rail` in the prototype). */
  readonly aside: HTMLElement;
}

export interface ScreenFrameOptions {
  readonly kicker: string;
  /** The title's icon; none when the prototype's title has none. */
  readonly glyph?: string;
  /** The line under the title. */
  readonly lede?: string;
}

export function mountScreenFrame(body: HTMLElement, options: ScreenFrameOptions): ScreenFrame {
  const panel = body.closest<HTMLElement>("[data-wb-screen-panel]");
  const title = panel?.querySelector<HTMLElement>(":scope > h2");
  if (panel !== null && panel !== undefined && title !== null && title !== undefined) {
    panel.className = "flex flex-col min-w-0 min-h-full bg-wb-cards";
    title.className =
      "m-0 text-[22px] font-bold text-wb-heading tracking-tight flex items-center gap-2 font-mono";
    const glyph = title.firstElementChild;
    if (options.glyph === undefined) glyph?.remove();
    else glyph?.replaceWith(icon(options.glyph, "w-[22px] h-[22px] text-primary"));
    const head = el(
      "div",
      "px-5 pt-4 pb-2.5 bg-wb-subhead border-0 border-b border-solid border-hairline shrink-0",
    );
    head.append(
      el(
        "div",
        "text-[10px] font-mono tracking-wider uppercase text-outline font-semibold mb-0.5",
        options.kicker,
      ),
      title,
    );
    if (options.lede !== undefined)
      head.append(
        el(
          "p",
          "m-0 mt-1 text-[11.5px] text-on-surface-variant leading-relaxed max-w-2xl",
          options.lede,
        ),
      );
    panel.prepend(head);
  }
  body.className = "flex flex-col gap-3 flex-1 min-w-0 px-5 pt-3 pb-5";
  const aside = el("div", "flex-col flex-1 min-h-0 overflow-y-auto p-3 gap-3 text-[11.5px]");
  aside.dataset.wbScreenAside = panel?.dataset.wbScreenPanel ?? "";
  body.closest("#wb-root")?.querySelector("#inspector-rail")?.append(aside);
  return { aside };
}

/** A rail section: the mono label over its content (admin-org.html `#inspector-rail`). */
export function asideSection(label: string, ...content: HTMLElement[]): HTMLElement {
  const section = el("div", "flex flex-col gap-1.5");
  section.append(
    el("div", "text-[10px] font-mono uppercase tracking-wider text-outline font-semibold", label),
    ...content,
  );
  return section;
}

/** A rail divide list of label / value rows. */
export function asideRows(rows: readonly (readonly [string, string, string?])[]): HTMLElement {
  const list = el(
    "div",
    "rounded bg-surface-container-low border border-solid border-hairline divide-y divide-x-0 divide-solid divide-hairline",
  );
  for (const [label, value, tone] of rows) {
    const row = el("div", "flex justify-between gap-3 px-2.5 py-1.5");
    row.append(
      el("span", tone ?? "text-on-surface-variant", label),
      el("span", "text-on-surface text-right [overflow-wrap:anywhere]", value),
    );
    list.append(row);
  }
  return list;
}

/**
 * JSON as the prototype's policy-file excerpt: keys in primary, string values
 * in secondary. Every piece is a text node, so policy strings stay text.
 */
export function jsonLines(value: unknown): Node[] {
  const nodes: Node[] = [];
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?/gu;
  const text = JSON.stringify(value, null, 2);
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(document.createTextNode(text.slice(last, index)));
    nodes.push(el("span", match[2] === undefined ? "text-secondary" : "text-primary", match[1]));
    if (match[2] !== undefined) nodes.push(document.createTextNode(match[2]));
    last = index + match[0].length;
  }
  nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

/** The rail's closing note (admin-org.html `mt-auto` info box). */
export function asideNote(glyph: string, text: string): HTMLElement {
  const note = el(
    "div",
    "mt-auto p-2 rounded bg-surface-container-low border border-solid border-hairline text-[10px] text-outline flex gap-1.5",
  );
  note.append(icon(glyph, "w-[13px] h-[13px] text-primary"), el("span", "", text));
  return note;
}
