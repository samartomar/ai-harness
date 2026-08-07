import { uninstallEccMaterialization } from "../ecc/materialization.js";
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
 * through the engine's own `uninstallEccMaterialization`, which is where the
 * per-file digest match, the operator-content guarantee and the rollback live —
 * a second copy of that transaction here is exactly the drift a receipt exists
 * to prevent.
 *
 * ORDERING (issue #567). The ownership receipt lives under `.aih`, while the
 * bytes it claims live on the client surfaces (`.claude/`, `.agents/`). Uninstall
 * may remove `.aih` wholesale, so this member never skips itself for a receipt
 * inside a removed tree the way the hook-registrar member does for its
 * destination: skipping would strand every materialized byte with nothing left
 * on disk to attribute it. Owned content goes first, always.
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

export interface EccMaterializationRemovalOutcome {
  removed: string[];
  advisories: Array<{ path: string; reason: string; detail: string }>;
}

/**
 * Subtract every receipt-proven owned byte. Called ONLY under `--apply`: the
 * engine has no dry-run removal, and {@link eccMaterializationUninstallState} is
 * what a preview reports from.
 */
export function removeEccMaterialization(root: string): EccMaterializationRemovalOutcome {
  const result = uninstallEccMaterialization(root);
  return {
    removed: result.removed.map((file) => file.path),
    advisories: result.advisories.map((advisory) => ({
      path: advisory.path,
      reason: advisory.reason,
      detail: advisory.detail,
    })),
  };
}

export { ECC_MATERIALIZATION_RECEIPT_PATH };
