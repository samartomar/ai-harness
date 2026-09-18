import { button, el, icon, withId } from "./dom.js";
import { changeHunks, type DiffLine, policyLineDiff } from "./policy-diff.js";

/**
 * The changes screen (NEW-SHELL-PLAN.md S5, prototype `screens/admin-changes.html`):
 * what this draft changed against the policy the page opened with, the whole
 * file (`#config-preview`, the readonly textarea every journey reads), Copy
 * JSON, and the draft review and exposure views of the inspector rail. Model
 * text reaches the page only through `textContent` and `value`.
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

const PREVIEW =
  "w-full min-h-[240px] p-2.5 rounded border border-solid border-outline-variant bg-surface-container-lowest text-on-surface font-mono text-[12px] leading-relaxed resize-y";
const PREVIEW_LABEL = "text-[11px] font-medium text-on-surface-variant";
const TOOL_BUTTON =
  "inline-flex items-center gap-1 h-7 px-2.5 rounded border border-solid border-outline-variant bg-surface-container-low hover:bg-surface-container text-on-surface text-[11px] font-medium transition-colors";
const SEGMENT =
  "wb-changes-segment px-2.5 py-1 rounded text-[11px] font-medium text-on-surface-variant hover:text-on-surface transition-colors";
const LINE_CLASS: Record<DiffLine["kind"], string> = {
  " ": "px-3 text-on-surface-variant",
  "+": "px-3 bg-surface-container-low border-0 border-l-2 border-solid border-secondary text-on-surface",
  "-": "px-3 bg-surface-container border-0 border-l-2 border-solid border-tertiary text-on-surface",
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

function diffRow(entry: DiffLine | { kind: "gap"; skipped: number }): HTMLElement {
  if (entry.kind === "gap") {
    const gap = el(
      "div",
      "px-3 py-0.5 text-[10px] text-on-surface-variant bg-surface-container-low select-none",
      `⋯ ${entry.skipped} unchanged ${entry.skipped === 1 ? "line" : "lines"}`,
    );
    gap.dataset.wbDiffGap = String(entry.skipped);
    return gap;
  }
  const row = el("div", `flex gap-2 whitespace-pre-wrap break-all ${LINE_CLASS[entry.kind]}`);
  row.dataset.wbDiffLine = entry.kind === " " ? "same" : entry.kind === "+" ? "added" : "removed";
  const number = el(
    "span",
    "w-10 shrink-0 text-right text-on-surface-variant select-none tabular-nums",
    entry.line === undefined ? "" : String(entry.line),
  );
  number.setAttribute("aria-hidden", "true");
  const mark = el("span", "w-3 shrink-0 select-none", entry.kind === " " ? "" : entry.kind);
  mark.setAttribute("aria-hidden", "true");
  const text = el("span", "min-w-0", entry.text);
  row.append(number, mark, text);
  if (entry.kind !== " ")
    row.setAttribute("aria-label", `${entry.kind === "+" ? "Added" : "Removed"}: ${entry.text}`);
  return row;
}

export function mountChangesScreen(
  body: HTMLElement,
  options: ChangesScreenOptions,
): ChangesScreen {
  const screen = el("div", "flex flex-col gap-3 min-w-0");
  screen.dataset.wbChanges = "";

  const summary = el(
    "div",
    "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded border border-solid border-outline-variant bg-surface-container-lowest text-[12px] min-w-0",
  );
  const changeCount = el("span", "font-mono font-semibold text-on-surface", "");
  changeCount.dataset.wbChangesCount = "";
  changeCount.setAttribute("aria-live", "polite");
  const selectionCounts = el("span", "font-mono text-[11px] text-on-surface-variant", "");
  selectionCounts.dataset.wbChangesSelections = "";
  summary.append(changeCount, selectionCounts);

  const toolbar = el("div", "flex flex-wrap items-center gap-1.5 min-w-0");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Policy changes");
  const copy = button(TOOL_BUTTON, "");
  copy.dataset.wbChangesCopy = "";
  copy.title = "Copy the whole policy JSON";
  copy.append(icon("code"), el("span", "", "Copy JSON"));
  toolbar.append(copy);
  if (options.openInspectorView !== undefined) {
    for (const [view, label] of [
      ["draft", "Review draft"],
      ["exposure", "Policy exposure"],
    ] as const) {
      const open = button(TOOL_BUTTON, label);
      open.dataset.wbChangesOpen = view;
      open.setAttribute("aria-controls", "workbench-detail-panel");
      open.addEventListener("click", () => options.openInspectorView?.(view));
      toolbar.append(open);
    }
  }
  const segments = el(
    "div",
    "ml-auto flex items-center p-0.5 gap-0.5 rounded border border-solid border-outline-variant bg-surface-container-low",
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

  const diff = el(
    "div",
    "rounded border border-solid border-outline-variant bg-surface-container-lowest font-mono text-[11.5px] leading-relaxed py-1 overflow-x-auto min-w-0",
  );
  diff.dataset.wbChangesDiff = "";
  diff.setAttribute("role", "region");
  diff.setAttribute("aria-label", "Changes from the starting policy");

  const region = withId(el("section", "flex flex-col gap-2 min-w-0"), "json-editor");
  region.setAttribute("aria-label", "Authored policy and evaluated report");
  const configLabel = el("label", PREVIEW_LABEL, "Authored policy — actual schema fields");
  configLabel.htmlFor = "config-preview";
  const config = withId(el("textarea", PREVIEW), "config-preview");
  config.readOnly = true;
  config.spellcheck = false;
  config.setAttribute("aria-label", "Authored policy actual schema fields");
  const reportLabel = el(
    "label",
    PREVIEW_LABEL,
    "Evaluated report — unavailable without target evaluation",
  );
  reportLabel.htmlFor = "report-preview";
  const report = withId(el("textarea", `${PREVIEW} min-h-[160px]`), "report-preview");
  report.readOnly = true;
  report.setAttribute("aria-label", "Evaluated report unavailable without target evaluation");
  region.append(
    configLabel,
    config,
    reportLabel,
    report,
    el(
      "p",
      "m-0 text-[11px] text-on-surface-variant",
      "Author portable intent without repository access. Imported audit and authority data is preserved/preflight-only here; AIH engine evaluation in a target repository is the only source of effective state.",
    ),
  );

  screen.append(summary, toolbar, diff, region);
  body.replaceChildren(screen);

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
        ? [el("p", "m-0 px-3 py-1 text-on-surface-variant", "No changes from the starting policy.")]
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
      renderDiff();
    },
    setView,
  };
}
