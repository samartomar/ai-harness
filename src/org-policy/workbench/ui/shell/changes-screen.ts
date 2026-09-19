import { button, el, icon, withId } from "./dom.js";
import { changeHunks, type DiffLine, policyLineDiff } from "./policy-diff.js";

/**
 * The changes screen (NEW-SHELL-PLAN.md S5, prototype `screens/admin-changes.html`):
 * what this draft changed against the policy the page opened with, the whole
 * file (`#config-preview`, the readonly textarea every journey reads), Copy
 * JSON, and the draft review and exposure views of the inspector rail. Model
 * text reaches the page only through `textContent` and `value`.
 *
 * Layout and classes are admin-changes.html's `#inspector-rail`: a head with
 * the change count chip, the selection counts, the tool row and the Changes /
 * Whole file segmented control; the "Staged policy delta" editor with line
 * numbers, green added and amber removed lines and painted JSON keys and
 * strings; the Publish footer. The prototype's "Reset to template" and
 * "Ready to publish" have no product data and are not built; the footer's
 * Publish runs the header's Publish (`#download`).
 */

export type ChangesView = "changes" | "whole";

export interface ChangesScreenOptions {
  /** The policy text the page opened with; the diff baseline. */
  readonly baseline: string;
  announce(message: string, error?: boolean): void;
  /** Opens a catalog inspector view; absent when the catalog is invalid. */
  openInspectorView?(view: "draft" | "exposure"): void;
  /** The clipboard; tests inject it. */
  writeClipboard?(text: string): Promise<void>;
}

export interface ChangesScreen {
  render(policy: unknown, text: string): void;
  setView(view: ChangesView): void;
}

const LABEL = "text-[10px] font-mono uppercase tracking-wider text-outline font-semibold";
/** The editor surface: admin-changes.html `#json-editor`. */
const EDITOR =
  "rounded bg-surface-container-lowest border border-solid border-hairline font-mono text-[10.5px] leading-relaxed text-on-surface min-w-0";
const PREVIEW = `${EDITOR} block w-full min-h-[320px] px-3 py-2 resize-y focus:border-primary focus:outline-none`;
/** Head tool buttons: "Reset to template" (quiet) and "Copy JSON" (mono, primary). */
const QUIET_BUTTON =
  "px-2 py-1 rounded bg-surface-container-low hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] transition-colors";
const COPY_BUTTON =
  "px-2 py-1 rounded bg-surface-container hover:bg-surface-container-high text-primary transition-colors font-mono text-[10.5px]";
const SEGMENT =
  "wb-changes-segment px-2 py-0.5 rounded text-[11px] text-on-surface-variant hover:text-on-surface aria-pressed:bg-surface-container aria-pressed:text-primary aria-pressed:font-semibold aria-pressed:shadow-xs transition-colors";
const LINE_CLASS: Record<DiffLine["kind"], string> = {
  " ": "px-3",
  "+": "px-3 bg-wb-pass-bg border-0 border-l-2 border-solid border-secondary",
  "-": "px-3 bg-wb-review-bg border-0 border-l-2 border-solid border-tertiary",
};

function counts(policy: unknown): Record<string, number> {
  const selection =
    policy !== null && typeof policy === "object"
      ? (policy as { authoringSelections?: unknown }).authoringSelections
      : undefined;
  const record =
    selection !== null && typeof selection === "object"
      ? (selection as Record<string, unknown>)
      : {};
  const count = (key: string) => {
    const value = record[key];
    return Array.isArray(value) ? value.length : 0;
  };
  return {
    roots: count("roots"),
    requests: count("requests"),
    exclusions: count("exclusions"),
    drafts: count("drafts"),
  };
}

/**
 * The prototype's JSON paint: keys in primary, string values in secondary.
 * Pieces are text nodes and spans; the policy text is never parsed as markup.
 */
function paintJson(text: string): Node[] {
  const nodes: Node[] = [];
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(document.createTextNode(text.slice(last, index)));
    nodes.push(el("span", match[2] === undefined ? "text-secondary" : "text-primary", match[1]));
    if (match[2] !== undefined) nodes.push(document.createTextNode(match[2]));
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function diffRow(entry: DiffLine | { kind: "gap"; skipped: number }): HTMLElement {
  if (entry.kind === "gap") {
    const gap = el(
      "div",
      "px-3 py-0.5 text-[10px] text-outline bg-surface-container-low select-none",
      `⋯ ${entry.skipped} unchanged ${entry.skipped === 1 ? "line" : "lines"}`,
    );
    gap.dataset.wbDiffGap = String(entry.skipped);
    return gap;
  }
  const row = el("div", `flex whitespace-pre-wrap break-all ${LINE_CLASS[entry.kind]}`);
  row.dataset.wbDiffLine = entry.kind === " " ? "same" : entry.kind === "+" ? "added" : "removed";
  const number = el(
    "span",
    "inline-block w-8 shrink-0 text-outline select-none tabular-nums",
    entry.line === undefined ? "" : String(entry.line),
  );
  number.setAttribute("aria-hidden", "true");
  const mark = el(
    "span",
    `inline-block w-3 shrink-0 select-none ${entry.kind === "+" ? "text-secondary" : "text-tertiary"}`,
    entry.kind === " " ? "" : entry.kind,
  );
  mark.setAttribute("aria-hidden", "true");
  const text = el("span", "min-w-0");
  text.append(...paintJson(entry.text));
  row.append(number, mark, text);
  if (entry.kind !== " ")
    row.setAttribute("aria-label", `${entry.kind === "+" ? "Added" : "Removed"}: ${entry.text}`);
  return row;
}

/** The download filename the file menu holds (`#policy-download-name`). */
function downloadName(): string {
  // Duck-typed: the screen also mounts in DOM stand-ins without HTMLInputElement.
  const input = document.getElementById("policy-download-name") as { value?: unknown } | null;
  const value = typeof input?.value === "string" ? input.value.trim() : "";
  return value === "" ? "aih-org-policy.json" : value;
}

export function mountChangesScreen(
  body: HTMLElement,
  options: ChangesScreenOptions,
): ChangesScreen {
  const screen = el("div", "flex flex-col flex-1 min-w-0 bg-wb-inspector");
  screen.dataset.wbChanges = "";

  // Head: admin-changes.html `p-2.5 bg-surface-container-lowest … space-y-2`.
  const head = el(
    "div",
    "px-5 py-2.5 bg-surface-container-lowest border-0 border-b border-solid border-hairline flex flex-col gap-2 shrink-0 min-w-0",
  );
  const titleRow = el("div", "flex items-center justify-between gap-2 min-w-0");
  titleRow.append(
    el("span", "font-semibold text-on-surface text-[13px]", "Changes from the starting policy"),
  );
  const summary = el(
    "div",
    "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] min-w-0",
  );
  const chips = el("div", "flex items-center gap-1.5 min-w-0");
  const changeCount = el(
    "span",
    "px-1.5 py-0.5 rounded bg-surface-container text-primary font-mono text-[10px] font-semibold",
    "",
  );
  changeCount.dataset.wbChangesCount = "";
  changeCount.setAttribute("aria-live", "polite");
  chips.append(changeCount);
  const selectionCounts = el("span", "text-outline font-mono text-[10.5px]", "");
  selectionCounts.dataset.wbChangesSelections = "";
  summary.append(chips, selectionCounts);

  const toolbar = el("div", "flex flex-wrap items-center gap-1.5 text-[11px] min-w-0");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Policy changes");
  const copy = button(COPY_BUTTON, "Copy JSON");
  copy.dataset.wbChangesCopy = "";
  copy.title = "Copy the whole policy JSON";
  toolbar.append(copy);
  if (options.openInspectorView !== undefined) {
    for (const [view, label] of [
      ["draft", "Review draft"],
      ["exposure", "Policy exposure"],
    ] as const) {
      const open = button(QUIET_BUTTON, label);
      open.dataset.wbChangesOpen = view;
      open.setAttribute("aria-controls", "workbench-detail-panel");
      open.addEventListener("click", () => options.openInspectorView?.(view));
      toolbar.append(open);
    }
  }
  toolbar.append(el("span", "flex-1"));
  const segments = el(
    "div",
    "flex items-center p-0.5 rounded bg-surface-container-low border border-solid border-hairline gap-0.5",
  );
  segments.setAttribute("role", "group");
  segments.setAttribute("aria-label", "Show");
  const viewButtons = new Map<ChangesView, HTMLButtonElement>();
  for (const [view, label] of [
    ["changes", "Changes"],
    ["whole", "Whole file"],
  ] as const) {
    const segment = button(SEGMENT, label);
    segment.dataset.wbChangesView = view;
    segment.addEventListener("click", () => setView(view));
    viewButtons.set(view, segment);
    segments.append(segment);
  }
  toolbar.append(segments);
  head.append(titleRow, summary, toolbar);

  // Body: the "Staged policy delta" label row, then the editor.
  const content = el("div", "flex-1 px-5 py-3 flex flex-col gap-2 min-w-0");
  const labelRow = el("div", "flex items-center justify-between gap-2 min-w-0");
  const fileName = el("span", "font-mono text-[10px] text-outline truncate min-w-0", "");
  labelRow.append(el("span", LABEL, "Staged policy delta"), fileName);

  const diff = el("div", `${EDITOR} py-2 overflow-x-auto`);
  diff.dataset.wbChangesDiff = "";
  diff.setAttribute("role", "region");
  diff.setAttribute("aria-label", "Changes from the starting policy");

  const region = withId(el("section", "flex flex-col gap-2 min-w-0"), "json-editor");
  region.setAttribute("aria-label", "Authored policy and evaluated report");
  // The label row above names the editor; the field keeps its own label.
  const configLabel = el("label", "sr-only", "Authored policy — actual schema fields");
  configLabel.htmlFor = "config-preview";
  const config = withId(el("textarea", PREVIEW), "config-preview");
  config.readOnly = true;
  config.spellcheck = false;
  config.setAttribute("aria-label", "Authored policy actual schema fields");
  const reportLabel = el(
    "label",
    `${LABEL} pt-1`,
    "Evaluated report — unavailable without target evaluation",
  );
  reportLabel.htmlFor = "report-preview";
  const report = withId(
    el("textarea", `${PREVIEW} min-h-[180px] text-on-surface-variant`),
    "report-preview",
  );
  report.readOnly = true;
  report.setAttribute("aria-label", "Evaluated report unavailable without target evaluation");
  region.append(configLabel, config, reportLabel, report);
  const note = el(
    "p",
    "m-0 text-[10.5px] text-outline leading-snug",
    "Green lines are yours; amber is what the starting policy had. Author portable intent without repository access. Imported audit and authority data is preserved/preflight-only here; AIH engine evaluation in a target repository is the only source of effective state.",
  );
  content.append(labelRow, diff, region, note);

  // Footer: admin-changes.html's Publish bar. Publish runs the header's
  // Publish, which downloads the policy file (decision D7).
  const footer = el(
    "div",
    "sticky bottom-0 px-5 py-2 bg-surface-container-lowest border-0 border-t border-solid border-hairline flex items-center gap-2 shrink-0 min-w-0",
  );
  const footerNote = el("span", "flex-1 text-[10.5px] text-outline min-w-0");
  const footerName = el("span", "font-mono text-on-surface-variant", "");
  footerNote.append(
    "Publish downloads ",
    footerName,
    ". Move it into your policy folder and commit it.",
  );
  const publish = button(
    "flex items-center gap-1 px-3 py-1.5 rounded bg-primary hover:bg-primary-bright text-on-primary text-[12px] font-medium transition-colors shadow-xs shrink-0",
    "",
  );
  publish.dataset.wbChangesPublish = "";
  publish.setAttribute("aria-label", "Publish from the changes screen (download the policy file)");
  publish.append(el("span", "", "Publish"), icon("arrow_forward", "w-[13px] h-[13px]"));
  publish.addEventListener("click", () => {
    document.getElementById("download")?.click();
  });
  footer.append(footerNote, publish);

  screen.append(head, content, footer);
  body.replaceChildren(screen);

  const syncName = () => {
    const name = downloadName();
    fileName.textContent = name;
    footerName.textContent = name;
    const download = document.getElementById("download") as { disabled?: unknown } | null;
    publish.disabled = download?.disabled === true;
  };
  document.addEventListener("input", (event) => {
    if ((event.target as { id?: unknown } | null)?.id === "policy-download-name") syncName();
  });

  let view: ChangesView = "whole";
  let text = "";
  const renderDiff = () => {
    const lines = policyLineDiff(options.baseline, text);
    const changed = lines.filter((line) => line.kind !== " ").length;
    changeCount.textContent =
      changed === 0
        ? "No changes from the starting policy"
        : `${changed} changed ${changed === 1 ? "line" : "lines"}`;
    if (view !== "changes") return;
    diff.replaceChildren(
      ...(changed === 0
        ? [el("p", "m-0 px-3 py-1 text-outline", "No changes from the starting policy.")]
        : changeHunks(lines).map(diffRow)),
    );
  };
  const setView = (next: ChangesView): void => {
    view = next;
    for (const [key, segment] of viewButtons)
      segment.setAttribute("aria-pressed", key === view ? "true" : "false");
    diff.hidden = view !== "changes";
    region.hidden = view !== "whole";
    renderDiff();
  };

  copy.addEventListener("click", () => {
    const write =
      options.writeClipboard ??
      ((value: string) =>
        navigator.clipboard === undefined
          ? Promise.reject(new Error("clipboard unavailable"))
          : navigator.clipboard.writeText(value));
    write(config.value).then(
      () => options.announce("Policy JSON copied to the clipboard."),
      () => options.announce("Copy failed: the clipboard is unavailable here.", true),
    );
  });

  setView("whole");
  return {
    render(policy, nextText) {
      text = nextText;
      config.value = nextText;
      const value = counts(policy);
      selectionCounts.textContent = `Direct roots ${value.roots} · Requests ${value.requests} · Exclusions ${value.exclusions} · Local drafts ${value.drafts}`;
      report.value = [
        "Policy Workbench preview",
        "",
        "Generic authoring state is represented by prepared catalog identities.",
        `Direct roots: ${value.roots}`,
        `Requests: ${value.requests}`,
        `Exclusions: ${value.exclusions}`,
        `Local drafts: ${value.drafts}`,
        "",
        "Effective: not evaluated - choose a target repository for Core evaluation.",
      ].join("\n");
      syncName();
      renderDiff();
    },
    setView,
  };
}
