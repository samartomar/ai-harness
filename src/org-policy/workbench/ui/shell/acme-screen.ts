import { mountProtectedPolicyWorkbench } from "../../../studio-protected-authority-runtime.js";
import { policySchemaErrors } from "../../schema-validation.js";
import { button, el, withId } from "./dom.js";
import { infoTip } from "./org-screen.js";
import { governanceOrDefault } from "./policy-grammar.js";
import type { PolicySession } from "./policy-session.js";

/**
 * The additions screen (NEW-SHELL-PLAN.md S7, prototype
 * `screens/admin-acme.html`): organization artifact intake, framework
 * curation, pending custom and remote MCP, and the protected Enterprise
 * policy file. The curation and custom MCP rules are the legacy runtime's
 * (`legacy-runtime.js` `Es`, `Cy`, `oy`, `m`, `$f`, the add-curation,
 * custom-form, remote-custom-form and row handlers), copied without change.
 * The protected form and the pending custom MCP forms are the same constant
 * markup the legacy page carries, cloned from the page's inert `<template>`
 * elements; the protected runtime and the artifact intake runtime mount on
 * them unchanged. Model and policy strings reach the page through
 * `textContent`.
 */

// biome-ignore lint/suspicious/noExplicitAny: policy JSON is validated by the grammar, not by TypeScript
type Loose = any;

export interface AcmeScreenOptions {
  readonly model: { readonly catalog: unknown };
  readonly session: () => PolicySession | undefined;
  announce(message: string, error?: boolean): void;
}

export interface AcmeScreen {
  render(): void;
  /** Mount the protected policy runtime once the policy session exists. */
  mountProtected(model: unknown): void;
  /** The catalog's "Prepare approval": fill the protected form for an asset. */
  prepareApproval(asset: { readonly id: string; readonly kind: string }): void;
  /** Leave curation edit mode (Clear policy and a restored policy, as the legacy `r.editing = null`). */
  resetCurationEdit(): void;
}

const CARD =
  "flex flex-col gap-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-lowest min-w-0";
const HEADING = "m-0 text-[13px] font-semibold text-on-surface";
const HELP = "help m-0 text-[12px] text-on-surface-variant";
const TOOL_BUTTON =
  "btn sm inline-flex items-center gap-1 h-7 px-2.5 rounded border border-solid border-outline-variant bg-surface-container-low hover:bg-surface-container text-on-surface text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const PRIMARY_BUTTON =
  "btn sm primary inline-flex items-center h-7 px-2.5 rounded bg-primary-container text-white text-[11px] font-medium";
const FIELD =
  "h-7 w-full min-w-0 px-1.5 rounded border border-solid border-outline-variant bg-surface-container-lowest text-[12px] text-on-surface";

const POP_ROW =
  "pop-row flex items-center w-full min-h-8 px-2 rounded text-left text-[12px] font-medium text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors";

/** The legacy `iy`: why custom hooks are not authorable here. */
const HOOK_INFO_NOTE =
  "Only AIH-owned governance and telemetry identities are authorable here. Custom hooks are not supported. AIH records the supported hook policy fields; each named owner remains the executor. This Workbench does not install, run, inspect, or register custom hooks.";
const HOOK_INFO_HELP =
  "Hook entry, overlap, and process-spawn inventories are intentionally not embedded in the portable form model. Core preparation is required to evaluate an exact target repository.";

const CURATION_PURPOSE =
  "Add audited ECC or Superpowers guidance. This is framework curation, not an organization-owned source and not MCP. AIH records report-only policy intent and does not install, run, or enforce the source.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The legacy `x`: a field's inline error, `aria-invalid` and `aria-describedby`. */
export function fieldError(id: string, message: string): void {
  const field = document.getElementById(id);
  if (!field) return;
  const errorId = `${id}-error`;
  let error = document.getElementById(errorId);
  if (!error) {
    error = document.createElement("span");
    error.id = errorId;
    error.className = "field-error text-[11px] text-error";
    const host = field.closest("label") || field.parentElement;
    if (host) host.append(error);
    else return;
  }
  error.textContent = message;
  if (message) field.setAttribute("aria-invalid", "true");
  else field.removeAttribute("aria-invalid");
  if (message) field.setAttribute("aria-describedby", errorId);
  else field.removeAttribute("aria-describedby");
}

function writableGovernance(policy: Loose): Loose {
  policy.governance = governanceOrDefault(policy.governance);
  return policy.governance;
}

function value(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
}

function setField(id: string, text: string): void {
  const field = document.getElementById(id) as HTMLInputElement | null;
  if (field) field.value = text;
}

/** The legacy `m`: a custom candidate's state label and badge tone. */
function candidateState(governance: Loose, candidate: Loose): [string, string] {
  if (candidate.kind === "mcp" && candidate.source && candidate.source.type === "stdio")
    return ["Blocked - evidence owed at this pin", "blocked"];
  const activation = governance.activations.find(
    (entry: Loose) => entry.candidate === candidate.id,
  );
  return activation && activation.state === "active"
    ? ["Requested intent - runtime evaluation required", "requested"]
    : ["Disabled", "pending"];
}

/** The legacy `I`: the short row-state label next to the badge. */
function rowStateLabel(tone: string, label: string): string {
  return tone === "requested"
    ? "Selected"
    : tone === "blocked"
      ? "Blocked"
      : tone === "approval"
        ? "Approval"
        : tone === "pending"
          ? label.indexOf("Disabled") === 0
            ? "Disabled"
            : "Awaiting"
          : tone === "external" && label.indexOf("Selectable") === 0
            ? "Selectable"
            : "External";
}

/** The legacy `$f`: the pending custom MCP's scan instruction. */
function customNextStep(candidate: Loose): string {
  const source = candidate.source || {};
  return `Next: save this policy as aih-org-policy.json in the target repository, then run aih trust scan ${source.package}@${source.version}. Integrity: ${source.integrity}. AIH fetches and scans that pinned npm tarball and emits preflight evidence record ${candidate.evidence.record} bound to candidate ${candidate.id}. The current fence is mandatory-detector-failed; it remains blocked until an independently attested authority receipt carries that exact record.`;
}

interface RowAction {
  readonly action: string;
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly framework?: string;
  readonly curationKind?: string;
}

/** One authored row, as the legacy `ft`: label, state, badge, detail, actions. */
function authoredRow(
  label: string,
  detail: string,
  badge: string,
  tone: string,
  actions: readonly RowAction[],
  visibleDetail?: string,
): HTMLElement {
  const row = el(
    "div",
    "row flex flex-wrap items-center gap-2 px-3 py-2 rounded border border-solid border-outline-variant bg-surface-container-low text-[12px] min-w-0",
  );
  row.dataset.state = tone;
  row.dataset.row = label;
  const name = el("strong", "font-mono text-on-surface break-all");
  const colon = label.indexOf(":");
  if (colon === -1) name.textContent = label;
  else name.append(el("u", "", label.slice(0, colon + 1)), label.slice(colon + 1));
  row.append(name);
  const state = rowStateLabel(tone, badge);
  if (["Selected", "Selectable", "Disabled", "Available"].indexOf(state) === -1) {
    const chip = el(
      "span",
      "row-state px-1.5 py-0.5 rounded bg-surface-container-highest font-mono text-[10px] uppercase text-on-surface-variant",
      state,
    );
    chip.title = badge;
    row.append(chip);
  }
  row.append(
    el(
      "span",
      `badge ${tone} px-1.5 py-0.5 rounded border border-solid border-outline-variant font-mono text-[10px] text-on-surface`,
      badge,
    ),
  );
  if (visibleDetail)
    row.append(el("p", "mono m-0 basis-full text-[11px] font-mono", visibleDetail));
  row.append(el("span", "basis-full text-[11px] text-on-surface-variant", detail));
  const controls = el("span", "row-actions flex gap-1.5");
  for (const entry of actions) {
    const control = button(TOOL_BUTTON, entry.label);
    control.dataset.workbenchAction = entry.action;
    control.dataset.workbenchKind = entry.kind;
    control.dataset.workbenchId = entry.id;
    if (entry.framework !== undefined) control.dataset.workbenchFramework = entry.framework;
    if (entry.curationKind !== undefined)
      control.dataset.workbenchCurationKind = entry.curationKind;
    controls.append(control);
  }
  row.append(controls);
  return row;
}

function labelled(text: string, field: HTMLElement, labelId?: string): HTMLLabelElement {
  const label = el("label", "flex flex-col gap-1 min-w-0 text-[11px] text-on-surface-variant");
  const caption = el("span", "", text);
  if (labelId !== undefined) caption.id = labelId;
  label.append(caption, document.createTextNode(" "), field);
  return label;
}

function input(id: string, attributes: Record<string, string> = {}): HTMLInputElement {
  const field = withId(el("input", FIELD), id);
  for (const [name, entry] of Object.entries(attributes)) field.setAttribute(name, entry);
  return field;
}

function select(id: string, options: readonly (readonly [string, string])[]): HTMLSelectElement {
  const field = withId(el("select", FIELD), id);
  for (const [entry, text] of options) {
    const option = el("option", "", text);
    option.value = entry;
    field.append(option);
  }
  return field;
}

/** Clone a page `<template>` of constant markup; empty when the page has none. */
function cloneTemplate(id: string): DocumentFragment {
  const template = document.getElementById(id);
  return template instanceof HTMLTemplateElement
    ? (template.content.cloneNode(true) as DocumentFragment)
    : document.createDocumentFragment();
}

/** The legacy `[data-groupcard]` disclosures (`workspace-interactions.ts`). */
function wireGroupCards(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-groupcard]").forEach((group, index) => {
    const toggle = group.querySelector<HTMLButtonElement>("[data-group]");
    if (toggle === null) return;
    if (!toggle.id) toggle.id = `wb-acme-group-toggle-${index}`;
    const bodies = [...group.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== toggle,
    );
    bodies.forEach((body, bodyIndex) => {
      if (!body.id) body.id = `wb-acme-group-body-${index}-${bodyIndex}`;
    });
    toggle.setAttribute("aria-controls", bodies.map((body) => body.id).join(" "));
    const setOpen = (open: boolean) => {
      group.dataset.open = open ? "1" : "0";
      toggle.setAttribute("aria-expanded", String(open));
    };
    setOpen(group.dataset.open === "1");
    toggle.addEventListener("click", () => setOpen(group.dataset.open !== "1"));
  });
}

export function mountAcmeScreen(body: HTMLElement, options: AcmeScreenOptions): AcmeScreen {
  const catalog = options.model.catalog as Loose;
  const session = () => options.session();
  const governance = (): Loose =>
    governanceOrDefault((session()?.snapshotPolicy() as Loose)?.governance);
  const screen = el("div", "flex flex-col gap-3 min-w-0");
  screen.dataset.wbAcme = "";

  // Bring Your Own (legacy `#byo-actions`): organization intake and the
  // custom-hook note, kept apart from framework curation.
  const byo = el("section", CARD);
  byo.setAttribute("aria-labelledby", "wb-acme-byo-title");
  const openArtifacts = button(POP_ROW, "Organization artifacts", "open-artifacts");
  const openHookInfo = button(POP_ROW, "Why custom Hooks are unavailable", "open-custom-hook-info");
  const byoActions = withId(el("div", "flex flex-col min-w-0"), "byo-actions");
  byoActions.append(openArtifacts, openHookInfo);
  const hookInfo = withId(
    el(
      "div",
      "flex flex-col gap-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-low min-w-0",
    ),
    "wb-acme-hook-info",
  );
  hookInfo.setAttribute("role", "region");
  hookInfo.setAttribute("aria-labelledby", "wb-acme-hook-info-title");
  hookInfo.hidden = true;
  const closeHookInfo = button(TOOL_BUTTON, "Close", "wb-acme-hook-info-close");
  closeHookInfo.setAttribute("aria-label", "Close details");
  const hookInfoHead = el("div", "flex items-center justify-between gap-2");
  hookInfoHead.append(
    withId(el("h4", HEADING, "AIH Governance & Telemetry Hooks"), "wb-acme-hook-info-title"),
    closeHookInfo,
  );
  const hookBadges = el("div", "flex flex-wrap gap-1.5");
  for (const text of ["AIH registers", "Owners vary"])
    hookBadges.append(
      el(
        "span",
        "px-1.5 py-0.5 rounded border border-solid border-outline-variant font-mono text-[10px] text-on-surface",
        text,
      ),
    );
  hookInfo.append(
    hookInfoHead,
    hookBadges,
    el(
      "p",
      "m-0 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant",
      "Hook registration information",
    ),
    el("p", "m-0 text-[12px] text-on-surface", HOOK_INFO_NOTE),
    el("p", HELP, HOOK_INFO_HELP),
  );
  openHookInfo.setAttribute("aria-controls", "wb-acme-hook-info");
  openHookInfo.setAttribute("aria-expanded", "false");
  byo.append(
    withId(el("h3", HEADING, "Bring Your Own"), "wb-acme-byo-title"),
    byoActions,
    hookInfo,
  );

  // ECC MCP approval (legacy `#ecc-mcp-actions` and the `#ecc-mcp-sidebar` drawer).
  const ecc = el("section", CARD);
  ecc.setAttribute("aria-labelledby", "wb-acme-ecc-mcp-title");
  const openEcc = button(POP_ROW, "Approve ECC MCP", "open-ecc-mcp");
  const eccActions = withId(el("div", "flex flex-col min-w-0"), "ecc-mcp-actions");
  eccActions.append(openEcc);
  const eccPanel = withId(
    el(
      "div",
      "flex flex-col gap-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-low min-w-0",
    ),
    "ecc-mcp-sidebar",
  );
  eccPanel.setAttribute("role", "region");
  eccPanel.setAttribute("aria-label", "ECC MCP approval authoring");
  eccPanel.hidden = true;
  const closeEcc = button(TOOL_BUTTON, "Close", "ecc-mcp-close");
  closeEcc.setAttribute("aria-label", "Close Add MCP");
  const eccHead = el("div", "flex items-center justify-between gap-2");
  eccHead.append(el("h4", HEADING, "Add MCP"), closeEcc);
  const eccHelp = el("p", HELP);
  eccHelp.append(
    "Approval records permission for this pinned ECC MCP. Enter the approving person's email so the policy identifies the human decision-maker; it is an audit identity, not a credential. Only ",
    el("code", "font-mono", "https-configurable"),
    " entries can use later explicit Add; manual entries remain approval-only/manual. For an eligible entry, the seat operator explicitly chooses one client with ",
    el("code", "font-mono", "aih ecc mcp add <id> --cli <client>"),
    "; no policy field chooses it. This panel does not install, contact, scan, attest, or claim reachability or a tool surface.",
  );
  const eccId = select("ecc-mcp-id", []);
  const eccGrid = el("div", "form-grid grid grid-cols-1 md:grid-cols-3 gap-2 min-w-0");
  eccGrid.append(
    labelled("ECC MCP", eccId),
    labelled(
      "Administrative status",
      select("ecc-mcp-state", [
        ["approved", "approved"],
        ["revoked", "revoked"],
      ]),
    ),
    labelled(
      "Approver email",
      input("ecc-mcp-approved-by", {
        type: "email",
        autocomplete: "email",
        placeholder: "name@company.example",
        required: "",
      }),
    ),
    labelled(
      "Authentication mode",
      input("ecc-mcp-authentication-mode", { placeholder: "oauth", required: "" }),
    ),
    labelled(
      "Allowed data classes",
      input("ecc-mcp-data-classes", {
        placeholder: "issue-metadata, design-metadata",
        required: "",
      }),
    ),
  );
  const eccSaveRow = el("div", "brow flex flex-wrap gap-1.5");
  eccSaveRow.append(button(PRIMARY_BUTTON, "Save MCP approval", "save-ecc-mcp-approval"));
  const eccRows = withId(el("div", "flex flex-col gap-1.5 min-w-0"), "ecc-mcp-approval-rows");
  const eccEditor = withId(el("section", "dform flex flex-col gap-2 min-w-0"), "ecc-mcp-editor");
  eccEditor.append(eccHelp, eccGrid, eccSaveRow, eccRows);
  eccPanel.append(eccHead, eccEditor);
  openEcc.setAttribute("aria-controls", "ecc-mcp-sidebar");
  openEcc.setAttribute("aria-expanded", "false");
  ecc.append(
    withId(el("h3", HEADING, "ECC MCP approval"), "wb-acme-ecc-mcp-title"),
    eccActions,
    eccPanel,
  );

  // Organization artifact intake (the artifact intake runtime fills #panel-artifacts).
  const artifacts = el("section", CARD);
  artifacts.setAttribute("aria-labelledby", "wb-acme-artifacts-title");
  artifacts.append(
    withId(el("h3", HEADING, "Organization artifacts"), "wb-acme-artifacts-title"),
    el(
      "p",
      HELP,
      "Say what the MCP, Skill or Agent is and where its exact source lives, then scan it in a target repository. Candidates here are non-authoritative until Core verifies them.",
    ),
    withId(el("div", "flex flex-col gap-3 min-w-0"), "panel-artifacts"),
  );

  // Framework curation (legacy `#curation-editor`, `#curation-rows`).
  const curation = el("section", CARD);
  curation.setAttribute("aria-labelledby", "wb-acme-curation-title");
  const editor = withId(el("details", "flex flex-col gap-2 min-w-0"), "curation-editor");
  const editorSummary = el(
    "summary",
    "cursor-pointer text-[12px] font-medium text-on-surface",
    "Add framework curation",
  );
  const purpose = withId(el("p", HELP, CURATION_PURPOSE), "curation-purpose");
  const frameworkField = select("curation-framework", []);
  const assetField = select("curation-asset", [["", "Manual item"]]);
  const kindField = select("curation-kind", [
    ["agent", "Agent"],
    ["skill", "Skill"],
    ["command", "Command"],
  ]);
  const grid = el("div", "form-grid grid grid-cols-1 md:grid-cols-3 gap-2 min-w-0");
  grid.append(
    labelled("External framework owner", frameworkField, "curation-framework-label"),
    labelled("Catalog prefill (optional)", assetField),
    labelled("Item kind", kindField),
    labelled("Item identifier", input("curation-id", { required: "" })),
    labelled(
      "Accountable owner email",
      input("curation-owner", {
        type: "email",
        autocomplete: "email",
        placeholder: "name@company.example",
        required: "",
      }),
    ),
    labelled(
      "Source repository",
      input("curation-repository", { placeholder: "owner/repository", required: "" }),
    ),
    labelled(
      "Source commit",
      input("curation-commit", { placeholder: "40-character commit", required: "" }),
    ),
    labelled("Source path", input("curation-path", { placeholder: "relative/path", required: "" })),
    labelled("Audit record", input("audit-record", { value: "external-audit", required: "" })),
    labelled(
      "Audit digest",
      input("audit-digest", {
        value: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        required: "",
      }),
    ),
    labelled("Admin clarification", input("curation-note")),
  );
  const addCuration = button(PRIMARY_BUTTON, "Add framework curation", "add-curation");
  const cancelCuration = button(TOOL_BUTTON, "Cancel curation edit", "cancel-curation-edit");
  cancelCuration.hidden = true;
  const curationActions = el("div", "brow flex flex-wrap gap-1.5");
  curationActions.append(addCuration, cancelCuration);
  const form = el("div", "dform flex flex-col gap-2 mt-2");
  form.append(purpose, grid, curationActions);
  editor.append(
    editorSummary,
    infoTip(
      "curation-editor-info",
      "curation-editor-help",
      "About external curation",
      "AIH preserves audited curation intent for agents, skills and commands with a pin and an audit record. It never installs, projects or enforces them - ECC and Superpowers do.",
    ),
    form,
  );
  const curationRows = withId(el("div", "flex flex-col gap-1.5 min-w-0"), "curation-rows");
  curation.append(
    withId(el("h3", HEADING, "ECC / Superpowers curation"), "wb-acme-curation-title"),
    editor,
    curationRows,
    el(
      "p",
      HELP,
      "AIH preserves audited curation intent for agents, skills and commands. It does not install, project or enforce those external assets.",
    ),
  );

  // Pending custom and remote MCP (constant legacy markup) and their rows.
  const custom = el("section", `${CARD} [&_.form-grid]:grid [&_.form-grid]:gap-2`);
  custom.setAttribute("aria-labelledby", "wb-acme-custom-title");
  const customRows = withId(el("div", "flex flex-col gap-1.5 min-w-0"), "custom-rows");
  custom.append(
    withId(el("h3", HEADING, "Your sources"), "wb-acme-custom-title"),
    cloneTemplate("wb-custom-mcp"),
    customRows,
    el(
      "p",
      HELP,
      "Custom MCP can only be authored as a fully pinned pending candidate. It has no activation affordance until supported scanning, evidence and projection exist.",
    ),
  );

  custom
    .querySelector("#custom-editor > summary")
    ?.after(
      infoTip(
        "custom-editor-info",
        "custom-editor-help",
        "About custom sources",
        "A custom MCP is recorded immediately as a fully pinned candidate and stays blocked until a completed scan binds to that exact pin.",
      ),
    );

  // Protected Enterprise policy file (constant legacy markup; its runtime mounts below).
  const protectedHost = el("div", "flex flex-col gap-3 min-w-0");
  protectedHost.dataset.wbAcmeProtected = "";
  protectedHost.append(cloneTemplate("wb-protected-policy"));

  screen.append(byo, artifacts, protectedHost, curation, custom, ecc);
  body.replaceChildren(screen);
  wireGroupCards(screen);

  /** The legacy `Ds`/`Nr` for the custom-hook note, and `Rf`/`dn` for ECC MCP. */
  const showHookInfo = (open: boolean) => {
    hookInfo.hidden = !open;
    openHookInfo.setAttribute("aria-expanded", String(open));
  };
  const showEcc = (open: boolean) => {
    eccPanel.hidden = !open;
    openEcc.setAttribute("aria-expanded", String(open));
  };
  openHookInfo.addEventListener("click", () => {
    showEcc(false);
    showHookInfo(true);
  });
  closeHookInfo.addEventListener("click", () => {
    showHookInfo(false);
    openHookInfo.focus({ preventScroll: true });
  });
  const openEccPanel = () => {
    showHookInfo(false);
    showEcc(true);
    eccId.focus();
  };
  openEcc.addEventListener("click", openEccPanel);
  closeEcc.addEventListener("click", () => {
    showEcc(false);
    openEcc.focus({ preventScroll: true });
  });
  /** The legacy drawer Escape (`workspace-interactions.ts`): from anywhere while open, back to the opener. */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = !eccPanel.hidden ? closeEcc : !hookInfo.hidden ? closeHookInfo : null;
    if (open === null) return;
    event.preventDefault();
    open.click();
  });
  /** The legacy `Py`: an adoption route's `[data-ecc-mcp-approval]` preselects a pinned entry. */
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const route = target?.closest<HTMLElement>("[data-ecc-mcp-approval]");
    if (!route) return;
    const id = route.getAttribute("data-ecc-mcp-approval") ?? "";
    const pinned: Loose[] = Array.isArray(catalog.externalMcp) ? catalog.externalMcp : [];
    if (!pinned.some((entry) => entry.id === id)) return;
    openEccPanel();
    eccId.value = id;
    options.announce(
      `ECC MCP ${id} selected for approval authoring only; it is not installed or contacted.`,
    );
  });
  eccRows.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const remove = target?.closest<HTMLElement>("[data-ecc-mcp-approval-remove]");
    const current = session();
    if (!remove || current === undefined) return;
    const id = remove.getAttribute("data-ecc-mcp-approval-remove");
    current.edit((draft) => {
      const writable = writableGovernance(draft);
      writable.eccMcpApprovals = (
        Array.isArray(writable.eccMcpApprovals) ? writable.eccMcpApprovals : []
      ).filter((entry: Loose) => entry.id !== id);
      return undefined;
    }, `ECC MCP approval removed for ${id}.`);
  });

  /** The legacy `sy`: pinned ECC MCP options and recorded approvals. */
  const renderEcc = () => {
    const pinned: Loose[] = Array.isArray(catalog.externalMcp) ? catalog.externalMcp : [];
    const recorded = governance();
    const approvals: Loose[] = Array.isArray(recorded.eccMcpApprovals)
      ? recorded.eccMcpApprovals
      : [];
    const chosen = eccId.value;
    const placeholder = el("option", "", "Choose pinned ECC MCP");
    placeholder.value = "";
    eccId.replaceChildren(
      placeholder,
      ...pinned.map((entry) => {
        const option = el("option", "", `${entry.id} — ${entry.addability}`);
        option.value = entry.id;
        return option;
      }),
    );
    eccId.value = pinned.some((entry) => entry.id === chosen) ? chosen : "";
    eccRows.replaceChildren(
      ...(approvals.length
        ? approvals.map((approval) => {
            const row = el("p", HELP);
            const remove = button(TOOL_BUTTON, "Remove approval");
            remove.dataset.eccMcpApprovalRemove = approval.id;
            row.append(
              el("code", "font-mono", approval.id),
              ` — ${approval.state}; ${approval.authenticationMode}. `,
              remove,
            );
            return row;
          })
        : [el("p", HELP, "No ECC MCP approvals recorded.")]),
    );
  };

  let editing: { framework: string; kind: string; id: string } | null = null;

  /** The legacy `Cy`: the curation editor's add state. */
  const resetCurationEditor = () => {
    kindField.disabled = false;
    editorSummary.textContent = "Add framework curation";
    purpose.textContent = CURATION_PURPOSE;
    (document.getElementById("curation-framework-label") as HTMLElement).textContent =
      "External framework owner";
    addCuration.textContent = "Add framework curation";
  };

  /** The legacy `Es`: framework options, keeping the chosen framework. */
  const renderFrameworks = () => {
    const chosen = frameworkField.value;
    const frameworks: Loose[] = Array.isArray(catalog.frameworks) ? catalog.frameworks : [];
    frameworkField.replaceChildren(
      ...frameworks.map((framework) => {
        const option = el("option", "", `${framework.id.toUpperCase()} - external guidance`);
        option.value = framework.id;
        return option;
      }),
    );
    frameworkField.value = chosen || (frameworks[0] ? frameworks[0].id : "");
    const manual = el("option", "", "Manual item");
    manual.value = "";
    assetField.replaceChildren(manual);
  };

  frameworkField.addEventListener("change", renderFrameworks);
  for (const id of ["curation-id", "curation-owner"])
    document.getElementById(id)?.addEventListener("input", () => {
      if (value("curation-id").trim() && value("curation-owner").trim())
        fieldError("curation-id", "");
    });
  const leaveCurationEdit = () => {
    editing = null;
    frameworkField.disabled = false;
    cancelCuration.hidden = true;
    resetCurationEditor();
  };
  cancelCuration.addEventListener("click", leaveCurationEdit);

  addCuration.addEventListener("click", () => {
    const current = session();
    if (current === undefined) return;
    const framework = frameworkField.value;
    const kind = kindField.value;
    const id = value("curation-id").trim();
    const repository = value("curation-repository").trim();
    const commit = value("curation-commit").trim();
    const path = value("curation-path").trim();
    const record = value("audit-record").trim();
    const digest = value("audit-digest").trim();
    const owner = value("curation-owner").trim();
    const unsafePath =
      !path ||
      path.startsWith("/") ||
      path.startsWith("./") ||
      path.includes("\\") ||
      path.includes("//") ||
      path.split("/").some((part) => !part || part === "." || part === "..");
    if (
      !/^(agent|skill|command)$/.test(kind) ||
      !id ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !/^[0-9a-f]{40}$/.test(commit) ||
      unsafePath ||
      !record ||
      !/^sha256:[0-9a-f]{64}$/.test(digest) ||
      !EMAIL.test(owner)
    ) {
      fieldError(
        "curation-id",
        id ? "Correct the curation fields before adding." : "Use an external item identifier.",
      );
      document.getElementById("curation-id")?.focus();
      options.announce(
        "Use a kind, identifier, pinned repository/40-character commit/safe path, audit record, and sha256 digest.",
        true,
      );
      return;
    }
    fieldError("curation-id", "");
    const wasEditing = editing;
    const note = value("curation-note").trim();
    current.edit(
      (draft) => {
        const writable = writableGovernance(draft);
        if (wasEditing) {
          const previous = writable.externalCuration.find(
            (group: Loose) => group.framework === wasEditing.framework,
          );
          if (!previous) return "Curation edit could not find its original item.";
          previous.items = previous.items.filter(
            (item: Loose) => item.kind !== wasEditing.kind || item.id !== wasEditing.id,
          );
          writable.externalCuration = writable.externalCuration.filter(
            (group: Loose) => group.items.length > 0,
          );
        }
        let group = writable.externalCuration.find((entry: Loose) => entry.framework === framework);
        if (!group) {
          group = { framework, items: [] };
          writable.externalCuration.push(group);
        }
        if (group.items.some((item: Loose) => item.kind === kind && item.id === id))
          return "That external curation item is already present.";
        group.items.push({
          kind,
          id,
          accountableOwner: owner,
          source: { repository, commit, path },
          audit: { record, digest },
          ...(note ? { clarification: note } : {}),
        });
        editing = null;
        frameworkField.disabled = false;
        cancelCuration.hidden = true;
        resetCurationEditor();
        return undefined;
      },
      wasEditing
        ? "External curation intent updated; it is report-only and not enforced by AIH."
        : "External curation intent added; it is report-only and not enforced by AIH.",
    );
  });

  const customForm = document.getElementById("custom-form") as HTMLFormElement | null;
  customForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = session();
    if (current === undefined) return;
    const id = value("custom-id").trim();
    const packageName = value("custom-package").trim();
    const version = value("custom-version").trim();
    const integrity = value("custom-integrity").trim();
    const evidence = value("custom-evidence").trim();
    const note = value("custom-note").trim();
    const owner = value("custom-owner").trim();
    if (!EMAIL.test(owner)) {
      fieldError("custom-owner", "Use an accountable owner email address.");
      document.getElementById("custom-owner")?.focus();
      options.announce("Use an accountable owner email address for the pending custom MCP.", true);
      return;
    }
    fieldError("custom-owner", "");
    if (governance().catalog.custom.some((candidate: Loose) => candidate.id === id)) {
      options.announce("Custom candidate identifier already exists.", true);
      return;
    }
    const committed = current.edit((draft) => {
      writableGovernance(draft).catalog.custom.push({
        id,
        kind: "mcp",
        accountableOwner: owner,
        description: "Pending custom MCP",
        capabilities: [],
        risks: ["custom source"],
        source: {
          type: "stdio",
          resolver: "npx",
          registry: "https://registry.npmjs.org",
          package: packageName,
          version,
          integrity,
        },
        targets: ["claude"],
        projector: "mcp-managed-settings",
        lifecycle: "supported",
        evidence: { record: evidence },
        findings: [],
        autoExecute: false,
        ...(note ? { clarification: note } : {}),
      });
      return undefined;
    }, "Pending custom MCP added. It cannot be activated.");
    if (committed) customForm.reset();
    else if (/[\p{C}]/u.test(note)) {
      fieldError("custom-note", "Use visible text without hidden Unicode.");
      document.getElementById("custom-note")?.focus();
    }
  });

  const remoteForm = document.getElementById("remote-custom-form");
  remoteForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = session();
    if (current === undefined) return;
    const id = value("remote-custom-id").trim();
    const origin = value("remote-custom-origin").trim();
    const approvedBy = value("remote-custom-approved-by").trim();
    const authenticationMode = value("remote-custom-authentication-mode").trim();
    const dataClasses = value("remote-custom-data-classes")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const administrativeStatus = value("remote-custom-administrative-status");
    const evidence = value("remote-custom-evidence").trim();
    const clarification = value("remote-custom-note").trim();
    let originUrl: URL | null;
    try {
      originUrl = new URL(origin);
    } catch {
      originUrl = null;
    }
    const validOrigin =
      originUrl !== null &&
      originUrl.protocol === "https:" &&
      originUrl.username === "" &&
      originUrl.password === "" &&
      originUrl.pathname === "/" &&
      originUrl.search === "" &&
      originUrl.hash === "";
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
      !validOrigin ||
      !EMAIL.test(approvedBy) ||
      !authenticationMode ||
      !dataClasses.length ||
      !/^(approved|revoked)$/.test(administrativeStatus) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(evidence) ||
      (clarification && /[\p{C}]/u.test(clarification))
    ) {
      fieldError(
        "remote-custom-origin",
        validOrigin
          ? ""
          : "Use an exact HTTPS origin without a path, credentials, query, or fragment.",
      );
      options.announce("Correct the highlighted remote-endpoint fields.", true);
      document.getElementById("remote-custom-origin")?.focus();
      return;
    }
    for (const field of [
      "remote-custom-id",
      "remote-custom-origin",
      "remote-custom-approved-by",
      "remote-custom-authentication-mode",
      "remote-custom-data-classes",
      "remote-custom-evidence",
      "remote-custom-note",
    ])
      fieldError(field, "");
    const existing = governance().catalog.custom.findIndex((entry: Loose) => entry.id === id);
    if (existing !== -1 && governance().catalog.custom[existing].source.type !== "remote") {
      options.announce("Custom candidate identifier already exists.", true);
      return;
    }
    const candidate = {
      id,
      kind: "mcp",
      description: "Pending remote custom MCP",
      capabilities: [],
      risks: ["hosted endpoint"],
      source: {
        type: "remote",
        origin: (originUrl as URL).origin,
        approval: { approvedBy, authenticationMode, allowedDataClasses: dataClasses },
        administrativeStatus,
        contentScanned: false,
      },
      targets: ["claude"],
      projector: "mcp-managed-settings",
      lifecycle: "supported",
      evidence: { record: evidence },
      findings: [],
      autoExecute: false,
      ...(clarification ? { clarification } : {}),
    };
    current.edit((draft) => {
      const writable = writableGovernance(draft);
      if (existing === -1) writable.catalog.custom.push(candidate);
      else writable.catalog.custom[existing] = candidate;
      return undefined;
    }, "Pending remote MCP recorded. It remains fenced and does not activate or contact the endpoint.");
  });

  /** The legacy row action handler for curation, custom and remote rows. */
  const onRowAction = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    const action = target?.closest<HTMLElement>(
      "[data-workbench-action][data-workbench-kind][data-workbench-id]",
    );
    const current = session();
    if (!action || current === undefined) return;
    const id = action.getAttribute("data-workbench-id") as string;
    const kind = action.getAttribute("data-workbench-kind");
    const operation = action.getAttribute("data-workbench-action");
    const recorded = governance();
    if (kind === "curation") {
      const framework = action.getAttribute("data-workbench-framework");
      const curationKind = action.getAttribute("data-workbench-curation-kind");
      const group = recorded.externalCuration.find((entry: Loose) => entry.framework === framework);
      const item =
        group && group.items.find((entry: Loose) => entry.id === id && entry.kind === curationKind);
      if (!group || !item || !framework || !curationKind) return;
      if (operation === "remove") {
        current.edit((draft) => {
          const writable = writableGovernance(draft);
          const writableGroup = writable.externalCuration.find(
            (entry: Loose) => entry.framework === framework,
          );
          if (!writableGroup) return undefined;
          writableGroup.items = writableGroup.items.filter(
            (entry: Loose) => entry.id !== id || entry.kind !== curationKind,
          );
          writable.externalCuration = writable.externalCuration.filter(
            (entry: Loose) => entry.items.length > 0,
          );
          return undefined;
        }, "External curation intent removed.");
        return;
      }
      if (operation !== "edit") return;
      frameworkField.value = framework;
      kindField.value = curationKind;
      setField("curation-id", item.id);
      setField("curation-owner", item.accountableOwner || "");
      setField("curation-repository", item.source.repository);
      setField("curation-commit", item.source.commit);
      setField("curation-path", item.source.path);
      setField("audit-record", item.audit.record);
      setField("audit-digest", item.audit.digest);
      setField("curation-note", item.clarification || "");
      editing = { framework, kind: curationKind, id: item.id };
      resetCurationEditor();
      frameworkField.disabled = true;
      (document.getElementById("curation-framework-label") as HTMLElement).textContent =
        "External framework owner (locked while editing)";
      addCuration.textContent = "Save framework curation";
      cancelCuration.hidden = false;
      editor.open = true;
      document.getElementById("curation-id")?.focus();
      return;
    }
    const index = recorded.catalog.custom.findIndex(
      (candidate: Loose) =>
        candidate.id === id &&
        (kind === "remote") === (candidate.source && candidate.source.type === "remote"),
    );
    if (index === -1) return;
    const candidate = recorded.catalog.custom[index];
    if (operation === "readonly") {
      options.announce(
        "This remote declaration is preserved read-only; record a new administrative declaration to change it.",
      );
      return;
    }
    if (operation === "remove") {
      current.edit((draft) => {
        writableGovernance(draft).catalog.custom.splice(index, 1);
        return undefined;
      }, "Custom candidate removed.");
      return;
    }
    if (operation !== "edit") return;
    if (kind === "remote") {
      const source = candidate.source;
      setField("remote-custom-id", candidate.id);
      setField("remote-custom-origin", source.origin);
      setField("remote-custom-approved-by", source.approval.approvedBy);
      setField("remote-custom-authentication-mode", source.approval.authenticationMode);
      setField("remote-custom-data-classes", source.approval.allowedDataClasses.join(", "));
      setField("remote-custom-administrative-status", source.administrativeStatus);
      setField("remote-custom-evidence", candidate.evidence.record);
      setField("remote-custom-note", candidate.clarification || "");
      const remote = document.getElementById("remote-custom-editor") as HTMLDetailsElement | null;
      if (remote) remote.open = true;
      document.getElementById("remote-custom-id")?.focus();
      return;
    }
    setField("custom-id", candidate.id);
    setField("custom-owner", candidate.accountableOwner || "");
    setField("custom-package", candidate.source.package || "");
    setField("custom-version", candidate.source.version || "");
    setField("custom-integrity", candidate.source.integrity || "");
    setField("custom-evidence", candidate.evidence.record || "");
    setField("custom-note", candidate.clarification || "");
    const customEditor = document.getElementById("custom-editor") as HTMLDetailsElement | null;
    if (customEditor) customEditor.open = true;
    document.getElementById("custom-id")?.focus();
  };
  curationRows.addEventListener("click", onRowAction);
  customRows.addEventListener("click", onRowAction);

  /** The legacy `oy`: pending custom candidates and external curation rows. */
  const renderRows = () => {
    const recorded = governance();
    customRows.replaceChildren(
      ...(recorded.catalog.custom.length
        ? recorded.catalog.custom.map((candidate: Loose) => {
            const [label, tone] = candidateState(recorded, candidate);
            const kind =
              candidate.source && candidate.source.type === "remote" ? "remote" : "custom";
            const preserved =
              kind === "remote" && !Object.hasOwn(candidate.source, "administrativeStatus");
            const actions: RowAction[] = preserved
              ? [
                  {
                    action: "readonly",
                    kind: "remote",
                    id: candidate.id,
                    label: "View preserved remote",
                  },
                ]
              : [
                  { action: "edit", kind, id: candidate.id, label: "Edit" },
                  { action: "remove", kind, id: candidate.id, label: "Remove" },
                ];
            const detail =
              kind === "remote"
                ? preserved
                  ? `Remote origin: ${candidate.source.origin} · Preserved remote declaration, read-only · Content scan: none`
                  : `Remote origin: ${candidate.source.origin} · Administrative status: ${candidate.source.administrativeStatus} · Content scan: none · Accountable owner: ${candidate.source.approval && candidate.source.approval.approvedBy ? candidate.source.approval.approvedBy : "unrecorded"}`
                : `${customNextStep(candidate)} Accountable owner: ${candidate.accountableOwner}`;
            return authoredRow(
              candidate.id,
              "Pinned custom source - no activation affordance",
              label,
              tone,
              actions,
              detail,
            );
          })
        : [el("p", HELP, "No custom candidates.")]),
    );
    curationRows.replaceChildren(
      ...(recorded.externalCuration.length
        ? recorded.externalCuration.flatMap((group: Loose) =>
            group.items.map((item: Loose) =>
              authoredRow(
                `${group.framework}: ${item.kind} / ${item.id}`,
                `Repository: ${item.source.repository} · Commit: ${item.source.commit} · Path: ${item.source.path} · Audit record: ${item.audit.record} · Audit digest: ${item.audit.digest} · Clarification: ${item.clarification || "none"} · report-only`,
                "External guidance - not enforced",
                "external",
                ["edit", "remove"].map((action) => ({
                  action,
                  kind: "curation",
                  id: item.id,
                  label: action === "edit" ? "Edit" : "Remove",
                  framework: group.framework,
                  curationKind: item.kind,
                })),
              ),
            ),
          )
        : [el("p", HELP, "No external curation intent.")]),
    );
  };

  let protectedMounted = false;
  return {
    resetCurationEdit: leaveCurationEdit,
    render() {
      renderFrameworks();
      renderRows();
      renderEcc();
    },
    mountProtected(model) {
      if (protectedMounted || document.getElementById("protected-form") === null) return;
      protectedMounted = true;
      mountProtectedPolicyWorkbench({
        model,
        byId: (id) => document.getElementById(id),
        announce: options.announce,
        schemaErrors: policySchemaErrors,
        fieldError,
        state: {
          get policy() {
            return session()?.snapshotPolicy();
          },
        },
      });
    },
    prepareApproval(asset) {
      const form = document.getElementById("protected-form");
      const subject = document.getElementById("protected-subject-id") as HTMLInputElement | null;
      const kind = document.getElementById("protected-kind") as HTMLSelectElement | null;
      const section = form?.closest<HTMLElement>("[data-groupcard]");
      if (section !== null && section !== undefined) {
        section.dataset.open = "1";
        section.querySelector<HTMLElement>("[data-group]")?.setAttribute("aria-expanded", "true");
      }
      if (subject !== null) subject.value = asset.id;
      if (kind !== null && [...kind.options].some((option) => option.value === asset.kind))
        kind.value = asset.kind;
      form?.scrollIntoView?.({ block: "start" });
      subject?.focus({ preventScroll: true });
    },
  };
}
