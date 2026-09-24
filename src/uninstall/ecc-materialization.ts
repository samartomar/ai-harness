import {
  displaySafe,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  readEccMaterializationReceipt,
} from "../ecc/materialization-receipt.js";

/**
 * F6: the governed ECC materialization's removal member of `aih uninstall`.
 *
 * The hook-registrar precedent, applied to bytes instead of JSON keys: read the
 * destination-root receipt, subtract exactly what it proves AIH wrote, and where
 * it cannot prove clean ownership report why and remove nothing. Removal runs
 * through the ECC engine's own `uninstallEccMaterialization` (in the plugin), which is where the
 * per-file digest match, the operator-content guarantee and the rollback live —
 * a second copy of that transaction here is exactly the drift a receipt exists
 * to prevent.
 *
 * ORDERING (issue #567). The ownership receipt lives under `.aih`, while the
 * bytes it claims live on the client surfaces (`.claude/`, `.agents/`). Uninstall
 * preserves `.aih` while this receipt exists. After the ordinary cleanup phase
 * succeeds, this member removes proven content before its ownership receipt.
 * A partial cleanup retains the receipt and reports the remaining destinations
 * for a supported retry.
 */

export interface EccMaterializationUninstallState {
  state: "absent" | "owned" | "unprovable";
  detail: string;
}

/** What the receipt proves right now, with no side effect of any kind. */
export function eccMaterializationUninstallState(root: string): EccMaterializationUninstallState {
  const read = readEccMaterializationReceipt(root);
  if (read.state === "absent") {
    return { state: "absent", detail: "no ECC materialization receipt" };
  }
  if (read.state === "malformed") {
    // The receipt is third-party text and its parse error carries that text
    // through: zod renders a rejected multi-megabyte document as megabytes of
    // INDENTED JSON, so pasting it verbatim would not merely be long — its
    // newlines would forge extra rows inside AIH's own refusal.
    return { state: "unprovable", detail: displaySafe(read.detail) };
  }
  // A valid receipt always claims at least one file: `components` is `.min(1)`
  // (`materialization-receipt.ts:296`) and every component's `files` is `.min(1)`
  // (`:277`), so there is no "owned but claiming nothing" state to describe.
  const owned = read.receipt.components.reduce(
    (total, component) => total + component.files.length,
    0,
  );
  return {
    state: "owned",
    detail: `receipt-proven ECC materialization of ${owned} owned file(s) across ${read.receipt.components.length} component(s)`,
  };
}

/**
 * What the receipt-proven removal did. The removal itself runs in
 * `@aihq/framework-ecc` (`src/framework-plugin/ecc-lifecycle.ts`), called only
 * under `--apply`; {@link eccMaterializationUninstallState} is what a preview
 * reports from.
 */
export interface EccMaterializationRemovalOutcome {
  readonly removed: readonly string[];
  readonly advisories: readonly { path: string; reason: string; detail: string }[];
}

export { ECC_MATERIALIZATION_RECEIPT_PATH };
