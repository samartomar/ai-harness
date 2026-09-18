import { buildKindLedgerViewModel } from "../kind-ledger.js";
import { type AdminShell, mountAdminShell } from "./admin-shell.js";
import { el, withId } from "./dom.js";
import { mountFileTransfer } from "./file-transfer.js";
import {
  createPolicySession,
  type PolicySession,
  type PolicySessionModel,
} from "./policy-session.js";

/**
 * Mounts the new admin shell (NEW-SHELL-PLAN.md S1, S2) in place of the
 * legacy markup. The emitted new-shell page already holds `#wb-root`; a
 * legacy page opened with `?shell=new` has its legacy markup and inline
 * styles removed first, so both routes render the same frame from the same
 * compiled CSS.
 */
export interface NewWorkbenchOptions {
  readonly model: PolicySessionModel & { readonly decisionSchema: unknown };
  /** False when the prepared catalog is invalid: Check Policy and Publish stay disabled. */
  readonly catalogValid: boolean;
  /** The catalog the admin browses, as `{ id, kind }`; empty when the catalog is invalid. */
  readonly ledgerAssets: readonly { readonly id: string; readonly kind: string }[];
  /** Asset ids a policy selects. */
  selectedAssetIds(policy: unknown): readonly string[];
  /** The selection validator the policy grammar consults. */
  selectionValidator(): unknown;
}

export interface NewWorkbench {
  readonly shell: AdminShell;
  readonly session: PolicySession;
}

export const POLICY_CHANGE_EVENT = "aih-workbench-policy-change";

function shellHost(): HTMLElement {
  const existing = document.getElementById("wb-root");
  if (existing !== null) return existing;
  for (const style of document.head.querySelectorAll("style:not(#wb-styles)")) style.remove();
  document.body.removeAttribute("class");
  const host = withId(document.createElement("div"), "wb-root");
  document.body.replaceChildren(host);
  return host;
}

const PREVIEW =
  "w-full min-h-[240px] p-2.5 rounded border border-solid border-outline-variant bg-surface-container-lowest text-on-surface font-mono text-[12px] leading-relaxed resize-y";
const PREVIEW_LABEL = "text-[11px] font-medium text-on-surface-variant";

/**
 * The changes screen's JSON region: `#config-preview` stays the readonly
 * textarea every journey reads the canonical policy from.
 */
function mountPolicyPreview(body: HTMLElement): (policy: unknown, text: string) => void {
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
  body.replaceChildren(region);
  return (policy, text) => {
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
    config.value = text;
    report.value = [
      "Policy Workbench preview",
      "",
      "Generic authoring state is represented by prepared catalog identities.",
      `Direct roots: ${count("roots")}`,
      `Requests: ${count("requests")}`,
      `Exclusions: ${count("exclusions")}`,
      `Local drafts: ${count("drafts")}`,
      "",
      "Effective: not evaluated - choose a target repository for Core evaluation.",
    ].join("\n");
  };
}

export function mountNewWorkbench(options: NewWorkbenchOptions): NewWorkbench {
  const shell = mountAdminShell(shellHost());
  const renderPreviewText = mountPolicyPreview(shell.screenBody("changes"));
  if (!options.catalogValid) {
    const note = el(
      "p",
      "m-0 text-[12px] text-error",
      "Prepared catalog is invalid. Catalog selection and policy download are disabled.",
    );
    note.setAttribute("role", "alert");
    shell.screenBody("sources").replaceChildren(note);
  }

  let session: PolicySession | undefined;
  const renderPreview = () => {
    if (session !== undefined) renderPreviewText(session.snapshotPolicy(), session.serialize());
  };
  const render = () => {
    if (session === undefined) return;
    renderPreview();
    shell.renderLedger(
      buildKindLedgerViewModel(
        options.ledgerAssets,
        options.selectedAssetIds(session.snapshotPolicy()),
      ),
    );
  };
  session = createPolicySession(options.model, {
    announce: shell.announce,
    render,
    changed: () => window.dispatchEvent(new Event(POLICY_CHANGE_EVENT)),
    selectionValidator: options.selectionValidator,
  });
  mountFileTransfer({
    shell,
    session,
    decisionSchema: options.model.decisionSchema,
    catalogValid: options.catalogValid,
    renderPreview,
  });
  render();
  return { shell, session };
}
