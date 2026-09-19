import { buildKindLedgerViewModel } from "../kind-ledger.js";
import { type AcmeScreen, mountAcmeScreen } from "./acme-screen.js";
import { type AdminShell, mountAdminShell } from "./admin-shell.js";
import { type ChangesScreen, mountChangesScreen } from "./changes-screen.js";
import { el, withId } from "./dom.js";
import { mountFileTransfer } from "./file-transfer.js";
import { mountOrgScreen, type OrgScreen, type OrgScreenModel } from "./org-screen.js";
import { serializePolicy } from "./policy-grammar.js";
import {
  createPolicySession,
  type PolicySession,
  type PolicySessionModel,
} from "./policy-session.js";
import { mountScanScreen } from "./scan-screen.js";

/**
 * Mounts the admin shell (NEW-SHELL-PLAN.md S1, S2) on the page's `#wb-root`.
 */
export interface NewWorkbenchOptions {
  readonly model: PolicySessionModel &
    OrgScreenModel & {
      readonly decisionSchema: unknown;
      readonly findings: {
        readonly dispositionable: readonly string[];
        readonly fenced: readonly string[];
      };
    };
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
  /** S6: the organization screen (deployment setup, developer tools, ECC hooks). */
  readonly org: OrgScreen;
  /** S7: the additions screen (artifact intake, curation, custom MCP, protected file). */
  readonly acme: AcmeScreen;
  /** Remove the file transfer controls and their document listener. */
  destroy(): void;
}

export const POLICY_CHANGE_EVENT = "aih-workbench-policy-change";

function shellHost(): HTMLElement {
  const host = document.getElementById("wb-root");
  if (host === null) throw new Error("Policy Workbench root is unavailable.");
  return host;
}

/**
 * The catalog and baseline evidence provenance lines (plan §2, sub-header
 * strip): the page's inert, server-escaped `<template id="wb-provenance">`
 * cloned as-is; absent when the model has no provenance.
 */
function mountProvenance(root: HTMLElement): void {
  const template = document.getElementById("wb-provenance");
  if (!(template instanceof HTMLTemplateElement)) return;
  const strip = el(
    "div",
    "flex flex-col gap-0.5 px-3 py-1 text-[11px] text-on-surface-variant border-0 border-b border-solid border-outline-variant bg-surface-container-lowest shrink-0 break-all [&_p]:m-0",
  );
  strip.dataset.wbProvenance = "";
  strip.append(template.content.cloneNode(true));
  root.querySelector("#announcement")?.before(strip);
}

export function mountNewWorkbench(options: NewWorkbenchOptions): NewWorkbench {
  const shell = mountAdminShell(shellHost());
  mountProvenance(shell.root);
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

  const scan = mountScanScreen(shell.screenBody("scan"), {
    findings: options.model.findings,
    announce: shell.announce,
  });
  let session: PolicySession | undefined;
  const org = mountOrgScreen(shell.screenBody("org"), {
    model: options.model,
    session: () => session,
    announce: shell.announce,
    render: () => render(),
  });
  const acme = mountAcmeScreen(shell.screenBody("acme"), {
    model: options.model,
    session: () => session,
    announce: shell.announce,
  });
  const renderPreview = () => {
    if (session !== undefined) changes.render(session.snapshotPolicy(), session.serialize());
  };
  const render = () => {
    if (session === undefined) return;
    renderPreview();
    scan.render(session.receipt(), session.decision());
    org.render();
    acme.render();
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
    resetEditing: () => acme.resetCurationEdit(),
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
  acme.mountProtected(options.model);
  return { shell, session, changes, org, acme, destroy: () => transfer.destroy() };
}
