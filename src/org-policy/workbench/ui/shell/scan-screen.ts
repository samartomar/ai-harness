import {
  type ScanGlance,
  scanDecisionExportV1,
  scanDecisionLinesV1,
  scanReceiptRowsV1,
} from "../../engine/scan-presentation.js";
import { button, el, icon, withId } from "./dom.js";

/**
 * The scan screen (NEW-SHELL-PLAN.md admin-scan, prototype
 * `screens/admin-scan.html`): imported authority receipts and evidence, the
 * imported governance decision, and the finding model. Everything here is
 * preserved/preflight-only; the browser verifies nothing and creates no
 * effective approval. Model and imported text reach the page only through
 * `textContent`. Hooks keep the legacy ids (`#approval-rows`,
 * `#receipt-state`, `#copy-approvals`, `#decision-state`, `#decision-rows`,
 * `#decision-export`, `#dispositionable-findings`, `#hard-blockers`).
 *
 * Layout and classes are admin-scan.html's: the masthead ("Scan Review — n
 * need review"), column 1 "The scan at a glance" (the catalog's report
 * tiles and the explanation cards, with the evidence and decision imports),
 * column 2 "Needs review, grouped by what it means" (the finding model's two
 * groups, then the imported receipt and decision as cards). Column 3, the
 * short item report, is the shared inspector rail. Not built (no product
 * data or behaviour): Group by, the scanner version / pin line, the
 * per-group "Keep held back / Review one by one" controls and examples.
 */

/** Report totals across the prepared catalog (sourceEvidenceSummary per source). */
export type { ScanGlance };

export interface ScanScreenOptions {
  readonly findings: {
    readonly dispositionable: readonly string[];
    readonly fenced: readonly string[];
  };
  announce(message: string, error?: boolean): void;
  /** The catalog's report totals; absent when the prepared catalog is invalid. */
  glance?(): ScanGlance;
}

export interface ScanScreen {
  render(receipt: unknown, decision: unknown): void;
}

type Loose = Record<string, unknown>;

/** admin-scan.html's cards: `rounded border … bg-[#141822] p-3`. */
const CARD =
  "rounded border border-solid border-hairline bg-wb-card p-3 flex flex-col gap-1.5 text-[11.5px] text-on-surface-variant leading-relaxed min-w-0";
const LABEL = "m-0 text-[10px] font-mono tracking-wider text-outline uppercase font-semibold";
/** A group card's row label (`w-[104px]` in the prototype). */
const ROW_LABEL =
  "text-[10px] font-mono uppercase tracking-wider text-outline font-semibold w-[104px] shrink-0 pt-px";
const HELP = "m-0 text-[11.5px] text-on-surface-variant leading-relaxed";
const MONO =
  "m-0 p-2 rounded bg-surface-container-lowest border border-solid border-hairline font-mono text-[10.5px] leading-relaxed text-on-surface whitespace-pre-wrap break-all empty:hidden";
const TOOL_BUTTON =
  "self-start inline-flex items-center gap-1 px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const PILL_REVIEW =
  "self-start px-1.5 py-0.5 rounded bg-wb-review-bg text-wb-review font-mono text-[10px] font-medium flex items-center gap-1";
const PILL_QUIET =
  "self-start px-1.5 py-0.5 rounded bg-surface-container-low border border-solid border-hairline text-outline font-mono text-[10px]";

function object(value: unknown): Loose | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : undefined;
}

function dot(color: string): HTMLElement {
  const node = el("span", `w-1 h-1 rounded-full ${color}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}

function paragraph(lead: string, rest: string): HTMLElement {
  const node = el("p", HELP);
  node.append(el("strong", "text-on-surface", lead), ` ${rest}`);
  return node;
}

/** One preserved receipt subject, as the legacy row: id, state, source note, badge. */
function receiptRow(id: string, note: string): HTMLElement {
  const row = el(
    "div",
    "row flex flex-wrap items-center gap-2 px-2.5 py-2 rounded border border-solid border-hairline bg-surface-container-low text-[11.5px] min-w-0",
  );
  row.dataset.state = "pending";
  row.dataset.row = id;
  row.append(
    el("strong", "font-mono text-on-surface break-all", id),
    el(
      "span",
      "row-state px-1.5 py-0.5 rounded bg-surface-container-highest font-mono text-[10px] uppercase text-on-surface-variant",
      "Awaiting",
    ),
    el(
      "span",
      "badge pending px-1.5 py-0.5 rounded bg-wb-review-bg text-wb-review font-mono text-[10px]",
      "Not verified / not effective",
    ),
    el("span", "basis-full text-[11px] text-outline", note),
  );
  row.lastElementChild?.setAttribute("title", "Not verified / not effective");
  return row;
}

function receiptRows(receipt: unknown): HTMLElement[] {
  return scanReceiptRowsV1(receipt).map((row) => receiptRow(row.id, row.note));
}

/** One "The scan at a glance" tile: the figure, its pill and its caption. */
function glanceTile(figure: HTMLElement, pill: HTMLElement, caption: string): HTMLElement {
  const tile = el("div", "p-2.5 flex flex-col gap-1 min-w-0");
  tile.append(figure, pill, el("span", "text-[10px] text-outline leading-tight", caption));
  return tile;
}

/** A group card row: mono label, then the text (admin-scan.html `#groups`). */
function groupRow(label: string, value: Node | string): HTMLElement {
  const row = el("div", "flex text-[11.5px] text-on-surface-variant min-w-0 max-sm:flex-col");
  const content = el("span", "min-w-0");
  content.append(value);
  row.append(el("span", ROW_LABEL, label), content);
  return row;
}

export function mountScanScreen(body: HTMLElement, options: ScanScreenOptions): ScanScreen {
  const screen = el("div", "flex flex-col flex-1 min-w-0");
  screen.dataset.wbScan = "";
  const dispositionable = options.findings.dispositionable;
  const fenced = options.findings.fenced;

  // Masthead: admin-scan.html's kicker, "Scan Review — n need review", meta.
  const masthead = el(
    "header",
    "px-5 pb-3 border-0 border-b border-solid border-hairline bg-wb-subhead flex flex-col gap-2 shrink-0 min-w-0",
  );
  const title = el(
    "h3",
    "m-0 text-[22px] font-bold text-wb-heading tracking-tight flex flex-wrap items-center gap-x-2 font-mono min-w-0",
  );
  const titleCount = el("span", "text-tertiary", "");
  const titleDash = el("span", "text-outline font-light", "—");
  titleDash.setAttribute("aria-hidden", "true");
  title.append(el("span", "", "Scan Review"), titleDash, titleCount);
  const meta = el(
    "div",
    "flex flex-wrap items-center gap-2 text-[11px] font-mono text-outline pt-0.5 min-w-0",
  );
  masthead.append(title, meta);

  const columns = el("div", "flex flex-1 min-w-0 max-lg:flex-col");

  // Column 1: the scan at a glance.
  const glance = el(
    "div",
    "w-[300px] shrink-0 p-4 bg-wb-cards border-0 border-r border-solid border-hairline flex flex-col gap-3 min-w-0 max-lg:w-full max-lg:border-r-0 max-lg:border-b",
  );
  glance.dataset.wbScanGlance = "";
  const tiles = el(
    "div",
    "grid grid-cols-3 divide-x divide-y-0 divide-solid divide-hairline rounded border border-solid border-hairline bg-wb-card",
  );
  const passed = el("span", "text-lg font-bold text-wb-heading font-mono", "");
  const review = el("span", "text-lg font-bold text-wb-heading font-mono", "");
  const notScanned = el("span", "text-lg font-bold text-wb-heading font-mono", "");
  const passedPill = el(
    "span",
    "self-start px-1.5 py-0.5 rounded bg-wb-pass-bg text-wb-pass font-mono text-[10px] font-medium flex items-center gap-1",
  );
  passedPill.append(dot("bg-secondary"), "Passed");
  const reviewPill = el("span", PILL_REVIEW);
  reviewPill.append(dot("bg-tertiary"), "Review");
  tiles.append(
    glanceTile(passed, passedPill, "a current, verified, clean report"),
    glanceTile(review, reviewPill, "a person should read the report"),
    glanceTile(notScanned, el("span", PILL_QUIET, "Not scanned"), "no report attached"),
  );
  const meaning = el("div", CARD);
  meaning.append(
    el("p", LABEL, "What each result means"),
    paragraph(
      "Passed.",
      "A current, verified report at this exact version: pass, complete coverage, no findings. Lower risk, not a guarantee.",
    ),
    paragraph(
      "Needs review.",
      "A report is attached, but it lists findings, covers part of the item, or is stale or unverified. Not proof of harm.",
    ),
    paragraph("Not scanned.", "No report is attached. Unknown, so treated like needs review."),
  );
  const glanceBlocks: HTMLElement[] = [];
  if (options.glance !== undefined) glanceBlocks.push(tiles, meaning);

  const imports = el("section", CARD);
  imports.setAttribute("aria-labelledby", "wb-scan-imports-title");
  const importsActions = el("div", "flex flex-wrap items-center gap-1.5");
  for (const [kind, label, input] of [
    ["evidence", "Import evidence", "evidence-file"],
    ["decision", "Import decision", "decision-file"],
  ] as const) {
    const control = button(TOOL_BUTTON, "");
    control.dataset.wbScanImport = kind;
    control.setAttribute("aria-controls", input);
    control.append(icon("upload_file", "w-[13px] h-[13px]"), el("span", "", label));
    control.addEventListener("click", () => document.getElementById(input)?.click());
    importsActions.append(control);
  }
  imports.append(
    withId(el("h3", LABEL, "Do I need to run a scan?"), "wb-scan-imports-title"),
    paragraph(
      "In this browser: no.",
      "Scans run in a target repository with the AIH engine. Import their evidence or a governance decision here to inspect it; nothing imported is verified or becomes effective in this browser.",
    ),
    importsActions,
  );
  const updates = el("div", CARD);
  updates.append(
    el("p", LABEL, "When a source updates"),
    el(
      "p",
      HELP,
      "A report belongs to one exact version: the source revision and the content digest. A new version needs a new report.",
    ),
  );
  glance.append(
    el("div", `${LABEL} tracking-wider`, "1 · The scan at a glance"),
    ...glanceBlocks,
    imports,
    updates,
  );

  // Column 2: needs review, grouped by what it means.
  const groups = el("div", "flex-1 p-4 bg-wb-cards flex flex-col gap-3 min-w-0");
  groups.dataset.wbScanGroups = "";
  const groupsHead = el(
    "div",
    "flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-outline pb-1",
  );
  const groupsTitle = el("div", "");
  groupsTitle.append(el("strong", "text-wb-heading font-bold", "2 ·"), " Needs review, grouped");
  const groupsCount = el("div", "");
  groupsCount.append(
    el("strong", "text-wb-heading font-bold", String(dispositionable.length + fenced.length)),
    " finding kinds in 2 groups",
  );
  groupsHead.append(groupsTitle, groupsCount);

  // The finding model's first group: what an administrator decides.
  const decide = el(
    "div",
    "rounded border border-solid border-hairline bg-wb-card p-3 flex flex-col gap-2 hover:border-primary transition-all shadow-xs min-w-0",
  );
  const decideHead = el("div", "flex items-center gap-2 flex-wrap");
  const decideCount = el("span", PILL_REVIEW);
  decideCount.append(dot("bg-tertiary"), `${dispositionable.length} kinds`);
  decideHead.append(
    icon("flag", "w-4 h-4 text-tertiary"),
    el(
      "span",
      "font-bold text-wb-heading text-[13.5px] tracking-tight",
      "Findings an administrator decides",
    ),
    decideCount,
  );
  const dispositionableList = withId(
    el("p", "m-0 font-mono text-[10.5px] text-on-surface-variant break-words"),
    "dispositionable-findings",
  );
  dispositionableList.textContent = dispositionable.join(" | ");
  const decideExample = el(
    "div",
    "pt-2 mt-0.5 border-0 border-t border-solid border-hairline flex items-start gap-2 min-w-0 max-sm:flex-col",
  );
  decideExample.append(el("span", ROW_LABEL, "Kinds"), dispositionableList);
  decide.append(
    decideHead,
    groupRow(
      "Means",
      "A completed scan reports these. A detector label is evidence, not a verdict.",
    ),
    groupRow(
      "Who decides",
      "The accountable administrator, one by one. They stay visible and authorable; this workbench does not dispose of them.",
    ),
    decideExample,
  );

  // The second group: prerequisites nobody can decide (the dashed card).
  const blocked = el(
    "div",
    "rounded border border-dashed border-surface-container-high bg-surface-container-low p-3 flex flex-col gap-1.5 min-w-0",
  );
  const blockedHead = el("div", "flex items-center gap-2 flex-wrap");
  blockedHead.append(
    el("span", "font-semibold text-on-surface text-[12.5px]", "Nobody can decide these"),
    el("span", PILL_QUIET, `${fenced.length} hard blockers`),
  );
  const blockers = withId(
    el("p", "m-0 font-mono text-[10.5px] text-on-surface-variant break-words"),
    "hard-blockers",
  );
  blockers.textContent = fenced.join(" | ");
  blocked.append(
    blockedHead,
    el(
      "p",
      HELP,
      `These ${fenced.length} are missing or untrustworthy prerequisites rather than detector findings. No approval substitutes for one, and this workbench cannot waive, approve or downgrade them.`,
    ),
    blockers,
  );

  // The finding model's own summary line, as a quiet disclosure.
  const model = el(
    "details",
    "rounded border border-solid border-hairline bg-wb-card px-3 py-2 text-[11.5px] min-w-0",
  );
  model.dataset.wbScanFindingModel = "";
  model.append(
    el(
      "summary",
      "cursor-pointer text-[10.5px] font-mono text-on-surface-variant",
      `Finding model: ${dispositionable.length} administrator-dispositionable, ${fenced.length} hard blockers`,
    ),
    el(
      "p",
      `${HELP} pt-1.5`,
      `A completed scan reports the ${dispositionable.length}. The accountable administrator decides each one, because a detector label is evidence and not a verdict. The ${fenced.length} are prerequisites; no approval substitutes for one.`,
    ),
  );

  // Imported authority receipt: the prototype's group card shape.
  const approvals = el(
    "section",
    "rounded border border-solid border-hairline bg-wb-card p-3 flex flex-col gap-2 min-w-0",
  );
  approvals.setAttribute("aria-labelledby", "wb-scan-approvals-title");
  const approvalsHead = el("div", "flex items-center gap-2 flex-wrap");
  approvalsHead.append(
    icon("verified_user", "w-4 h-4 text-primary"),
    withId(
      el("h3", "m-0 font-bold text-wb-heading text-[13.5px] tracking-tight", "Approval / evidence"),
      "wb-scan-approvals-title",
    ),
    el("span", PILL_QUIET, "preflight only"),
  );
  const approvalRows = withId(el("div", "flex flex-col gap-1.5 min-w-0"), "approval-rows");
  const receiptState = withId(el("p", HELP, "No authority receipt imported."), "receipt-state");
  const copyApprovals = button(
    TOOL_BUTTON,
    "Preserve approval subjects in policy (not effective)",
    "copy-approvals",
  );
  copyApprovals.disabled = true;
  copyApprovals.addEventListener("click", () =>
    options.announce(
      "Raw imported authority data remains an inert draft until Core prepares and verifies it; it cannot populate governance approvals.",
      true,
    ),
  );
  approvals.append(approvalsHead, approvalRows, receiptState, copyApprovals);

  const decisions = el(
    "section",
    "rounded border border-solid border-hairline bg-wb-card p-3 flex flex-col gap-2 min-w-0",
  );
  decisions.setAttribute("aria-labelledby", "wb-scan-decision-title");
  const decisionsHead = el("div", "flex items-center gap-2 flex-wrap");
  decisionsHead.append(
    icon("policy", "w-4 h-4 text-primary"),
    withId(
      el(
        "h3",
        "m-0 font-bold text-wb-heading text-[13.5px] tracking-tight",
        "Imported governance decision",
      ),
      "wb-scan-decision-title",
    ),
    el("span", PILL_QUIET, "inspection only"),
  );
  const decisionState = withId(el("p", HELP, "No standalone decision imported."), "decision-state");
  const decisionRows = withId(el("pre", `${MONO} mono`), "decision-rows");
  const decisionExport = withId(el("pre", `${MONO} mono`), "decision-export");
  decisionExport.setAttribute("aria-label", "Canonical decision JSON");
  decisions.append(decisionsHead, decisionState, decisionRows, decisionExport);

  groups.append(groupsHead, decide, blocked, model, approvals, decisions);
  columns.append(glance, groups);
  screen.append(masthead, columns);
  body.replaceChildren(screen);

  const renderGlance = (): void => {
    const totals = options.glance?.();
    if (totals === undefined) {
      titleDash.hidden = true;
      titleCount.textContent = "";
      meta.replaceChildren(el("span", "", "Prepared catalog unavailable: no report totals."));
      return;
    }
    const needReview = totals.review + totals.notScanned;
    titleDash.hidden = false;
    titleCount.textContent = `${needReview} need review`;
    passed.textContent = String(totals.passed);
    review.textContent = String(totals.review);
    notScanned.textContent = String(totals.notScanned);
    const separator = () => {
      const node = el("span", "text-outline", "•");
      node.setAttribute("aria-hidden", "true");
      return node;
    };
    const fact = (value: number, label: string) => {
      const node = el("span", "");
      node.append(el("strong", "text-on-surface font-semibold", String(value)), ` ${label}`);
      return node;
    };
    meta.replaceChildren(
      fact(totals.total, "catalog items"),
      separator(),
      fact(totals.reportsIncluded, "reports included"),
      separator(),
      fact(totals.currentlyVerified, "currently verified"),
    );
  };

  return {
    render(receipt, decision) {
      renderGlance();
      const rows = receiptRows(receipt);
      if (rows.length > 0) {
        const details = el("details", "receipt-details text-[11.5px] min-w-0");
        details.append(
          el(
            "summary",
            "cursor-pointer text-[10.5px] font-mono text-on-surface-variant",
            "Preserved receipt details",
          ),
          el("p", `${HELP} pt-1`, "preserved/preflight-only; not verified or effective."),
          el("pre", `${MONO} mono`, JSON.stringify(receipt, null, 2)),
        );
        approvalRows.replaceChildren(...rows, details);
      } else
        approvalRows.replaceChildren(
          el(
            "p",
            HELP,
            "Import an authority receipt to preserve and inspect its subjects; target-repository verification decides authority.",
          ),
        );
      receiptState.textContent = receipt
        ? "Receipt preserved for preflight only; this browser does not verify it or create effective approval."
        : "No authority receipt imported.";
      copyApprovals.disabled = true;

      const record = object(decision);
      if (record === undefined) {
        decisionState.textContent = "No standalone decision imported.";
        decisionRows.textContent = "";
        decisionExport.textContent = "";
        return;
      }
      decisionState.textContent =
        "Decision imported for inspection only: unverified and not effective. It does not change policy, receipt, or authority state.";
      decisionRows.textContent = scanDecisionLinesV1(record);
      decisionExport.textContent = scanDecisionExportV1(record);
    },
  };
}
