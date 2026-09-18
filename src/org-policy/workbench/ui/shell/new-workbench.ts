import { buildKindLedgerViewModel } from "../kind-ledger.js";
import { type AdminShell, mountAdminShell } from "./admin-shell.js";
import { withId } from "./dom.js";

/**
 * Mounts the new admin shell (NEW-SHELL-PLAN.md S1) in place of the legacy
 * markup. The emitted new-shell page already holds `#wb-root`; a legacy page
 * opened with `?shell=new` has its legacy markup and inline styles removed
 * first, so both routes render the same frame from the same compiled CSS.
 */
export interface NewWorkbenchOptions {
  /** The catalog the admin browses, as `{ id, kind }`; empty when the catalog is invalid. */
  readonly ledgerAssets: readonly { readonly id: string; readonly kind: string }[];
  /** Asset ids the current policy selects. */
  selectedAssetIds(): readonly string[];
}

export interface NewWorkbench {
  readonly shell: AdminShell;
  refreshLedger(): void;
}

function shellHost(): HTMLElement {
  const existing = document.getElementById("wb-root");
  if (existing !== null) return existing;
  for (const style of document.head.querySelectorAll("style:not(#wb-styles)")) style.remove();
  document.body.removeAttribute("class");
  const host = document.createElement("div");
  withId(host, "wb-root");
  document.body.replaceChildren(host);
  return host;
}

export function mountNewWorkbench(options: NewWorkbenchOptions): NewWorkbench {
  const shell = mountAdminShell(shellHost());
  const refreshLedger = () =>
    shell.renderLedger(buildKindLedgerViewModel(options.ledgerAssets, options.selectedAssetIds()));
  refreshLedger();
  return { shell, refreshLedger };
}
