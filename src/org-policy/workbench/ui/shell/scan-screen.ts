import { stableDecisionJson } from "../decision-json.js";
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
 */

export interface ScanScreenOptions {
  readonly findings: {
    readonly dispositionable: readonly string[];
    readonly fenced: readonly string[];
  };
  announce(message: string, error?: boolean): void;
}

export interface ScanScreen {
  render(receipt: unknown, decision: unknown): void;
}

type Loose = Record<string, unknown>;

const CARD =
  "flex flex-col gap-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-lowest min-w-0";
const HEADING =
  "m-0 text-[10px] font-mono uppercase tracking-wider font-semibold text-on-surface-variant";
const HELP = "m-0 text-[12px] text-on-surface-variant";
const MONO =
  "m-0 p-2 rounded bg-surface-container-low font-mono text-[11px] leading-relaxed text-on-surface whitespace-pre-wrap break-all empty:hidden";
const TOOL_BUTTON =
  "inline-flex items-center gap-1 h-7 px-2.5 rounded border border-solid border-outline-variant bg-surface-container-low hover:bg-surface-container text-on-surface text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

function object(value: unknown): Loose | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : undefined;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

/** One preserved receipt subject, as the legacy row: id, state, source note, badge. */
function receiptRow(id: string, note: string): HTMLElement {
  const row = el(
    "div",
    "row flex flex-wrap items-center gap-2 px-3 py-2 rounded border border-solid border-outline-variant bg-surface-container-low text-[12px] min-w-0",
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
      "badge pending px-1.5 py-0.5 rounded border border-solid border-tertiary font-mono text-[10px] text-on-surface",
      "Not verified / not effective",
    ),
    el("span", "basis-full text-[11px] text-on-surface-variant", note),
  );
  row.lastElementChild?.setAttribute("title", "Not verified / not effective");
  return row;
}

function receiptRows(receipt: unknown): HTMLElement[] {
  const record = object(receipt);
  const rows: HTMLElement[] = [];
  if (record === undefined) return rows;
  if (Array.isArray(record.approvals))
    for (const approval of record.approvals) {
      const entry = object(approval) ?? {};
      rows.push(
        receiptRow(
          text(entry.id, "approval"),
          `${text(entry.issuer, "unknown issuer")} — preserved/preflight-only`,
        ),
      );
    }
  if (Array.isArray(record.evidence))
    for (const evidence of record.evidence) {
      const entry = object(evidence) ?? {};
      rows.push(
        receiptRow(
          text(entry.id, "evidence"),
          `${text(entry.state, "unknown")} evidence — preserved/preflight-only`,
        ),
      );
    }
  return rows;
}

function decisionLines(decision: Loose): string {
  return [
    `id: ${decision.id}`,
    `candidate: ${decision.candidate}`,
    `kind: ${decision.kind}`,
    `disposition: ${decision.disposition}`,
    `targets: ${list(decision.targets)}`,
    `effects: ${list(decision.effects)}`,
    `issuer: ${decision.issuer}`,
    `actor: ${decision.actor}`,
    `policyVersion: ${decision.policyVersion}`,
    `issuedAt: ${decision.issuedAt}`,
    `notBefore: ${decision.notBefore}`,
    `expiresAt: ${decision.expiresAt}`,
    `reviewBy: ${decision.reviewBy || "none"}`,
    `acceptedFindings: ${list(decision.acceptedFindings)}`,
    `acceptedGaps: ${list(decision.acceptedGaps)}`,
    `conditions: ${Array.isArray(decision.conditions) ? decision.conditions.join(" | ") : String(decision.conditions)}`,
    `reason: ${decision.reason}`,
  ].join("\n");
}

export function mountScanScreen(body: HTMLElement, options: ScanScreenOptions): ScanScreen {
  const screen = el("div", "flex flex-col gap-3 min-w-0");
  screen.dataset.wbScan = "";

  const imports = el("section", CARD);
  imports.setAttribute("aria-labelledby", "wb-scan-imports-title");
  const importsTitle = withId(el("h3", HEADING, "Scan results"), "wb-scan-imports-title");
  const importsActions = el("div", "flex flex-wrap items-center gap-1.5");
  for (const [kind, label, input] of [
    ["evidence", "Import evidence", "evidence-file"],
    ["decision", "Import decision", "decision-file"],
  ] as const) {
    const control = button(TOOL_BUTTON, "");
    control.dataset.wbScanImport = kind;
    control.setAttribute("aria-controls", input);
    control.append(icon("upload_file"), el("span", "", label));
    control.addEventListener("click", () => document.getElementById(input)?.click());
    importsActions.append(control);
  }
  imports.append(
    importsTitle,
    el(
      "p",
      HELP,
      "Scans run in a target repository with the AIH engine. Import their evidence or a governance decision here to inspect it; nothing imported is verified or becomes effective in this browser.",
    ),
    importsActions,
  );

  const approvals = el("section", CARD);
  approvals.setAttribute("aria-labelledby", "wb-scan-approvals-title");
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
  const copyRow = el("div", "flex");
  copyRow.append(copyApprovals);
  approvals.append(
    withId(el("h3", HEADING, "Approval / evidence"), "wb-scan-approvals-title"),
    approvalRows,
    receiptState,
    copyRow,
  );

  const decisions = el("section", CARD);
  decisions.setAttribute("aria-labelledby", "wb-scan-decision-title");
  const decisionState = withId(el("p", HELP, "No standalone decision imported."), "decision-state");
  const decisionRows = withId(el("pre", `${MONO} mono`), "decision-rows");
  const decisionExport = withId(el("pre", `${MONO} mono`), "decision-export");
  decisionExport.setAttribute("aria-label", "Canonical decision JSON");
  decisions.append(
    withId(el("h3", HEADING, "Imported governance decision"), "wb-scan-decision-title"),
    decisionState,
    decisionRows,
    decisionExport,
  );

  const model = el("details", CARD);
  model.dataset.wbScanFindingModel = "";
  const dispositionable = options.findings.dispositionable;
  const fenced = options.findings.fenced;
  const summary = el(
    "summary",
    "cursor-pointer text-[12px] font-medium text-on-surface",
    `Finding model: ${dispositionable.length} administrator-dispositionable, ${fenced.length} hard blockers`,
  );
  model.append(
    summary,
    el(
      "p",
      HELP,
      `A completed scan reports these ${dispositionable.length}. The accountable administrator decides each one, because a detector label is evidence and not a verdict. They stay visible and authorable; this workbench does not dispose of them.`,
    ),
    withId(el("p", `${MONO} mono`, dispositionable.join(" | ")), "dispositionable-findings"),
    el(
      "p",
      HELP,
      `These ${fenced.length} are missing or untrustworthy prerequisites rather than detector findings. No approval substitutes for one, and this workbench cannot waive, approve or downgrade them.`,
    ),
    withId(el("p", `${MONO} mono`, fenced.join(" | ")), "hard-blockers"),
  );

  screen.append(imports, approvals, decisions, model);
  body.replaceChildren(screen);

  return {
    render(receipt, decision) {
      const rows = receiptRows(receipt);
      if (rows.length > 0) {
        const details = el("details", "receipt-details text-[12px] min-w-0");
        details.append(
          el("summary", "cursor-pointer text-on-surface", "Preserved receipt details"),
          el("p", HELP, "preserved/preflight-only; not verified or effective."),
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
      decisionRows.textContent = decisionLines(record);
      decisionExport.textContent = stableDecisionJson(record);
    },
  };
}
