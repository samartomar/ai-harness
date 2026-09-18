import { buildKindLedgerViewModel } from "../kind-ledger.js";
import { type AdminShell, mountAdminShell } from "./admin-shell.js";
import { type ChangesScreen, mountChangesScreen } from "./changes-screen.js";
import { el, withId } from "./dom.js";
import { mountFileTransfer } from "./file-transfer.js";
import { serializePolicy } from "./policy-grammar.js";
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
  /** S5: opens the catalog inspector's draft or exposure view from the changes screen. */
  openInspectorView?(view: "draft" | "exposure"): void;
}

export interface NewWorkbench {
  readonly shell: AdminShell;
  readonly session: PolicySession;
  /** S5: the changes screen (diff, whole file, Copy JSON). */
  readonly changes: ChangesScreen;
  /** Remove the file transfer controls and their document listener. */
  destroy(): void;
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

export function mountNewWorkbench(options: NewWorkbenchOptions): NewWorkbench {
  const shell = mountAdminShell(shellHost());
  const changes = mountChangesScreen(shell.screenBody("changes"), {
    baseline: serializePolicy(options.model.initialPolicy),
    announce: shell.announce,
    ...(options.catalogValid
      ? { openInspectorView: (view: "draft" | "exposure") => options.openInspectorView?.(view) }
      : {}),
  });
  if (!options.catalogValid) {
    // S3: the note sits in the catalog root, as the legacy `#framework-rows .error`.
    const note = el(
      "p",
      "help error m-0 text-[12px] text-error",
      "Prepared catalog is invalid. Catalog selection and policy download are disabled.",
    );
    note.setAttribute("role", "alert");
    const catalog = withId(el("div", "min-w-0"), "framework-rows");
    catalog.append(note);
    shell.screenBody("sources").replaceChildren(catalog);
  }

  let session: PolicySession | undefined;
  const renderPreview = () => {
    if (session !== undefined) changes.render(session.snapshotPolicy(), session.serialize());
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
  const transfer = mountFileTransfer({
    shell,
    session,
    decisionSchema: options.model.decisionSchema,
    catalogValid: options.catalogValid,
    renderPreview,
  });
  render();
  return { shell, session, changes, destroy: () => transfer.destroy() };
}
