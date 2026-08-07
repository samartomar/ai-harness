import { uninstallEccMaterialization } from "../ecc/materialization.js";
import {
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
  /** Owned destination paths the receipt claims; empty unless `owned`. */
  paths: string[];
  detail: string;
}

/** What the receipt proves right now, with no side effect of any kind. */
export function eccMaterializationUninstallState(root: string): EccMaterializationUninstallState {
  const read = readEccMaterializationReceipt(root);
  if (read.state === "absent") {
    return { state: "absent", paths: [], detail: "no ECC materialization receipt" };
  }
  if (read.state === "malformed") {
    return { state: "unprovable", paths: [], detail: read.detail };
  }
  const paths = read.receipt.components.flatMap((component) =>
    component.files.map((file) => file.path),
  );
  if (paths.length === 0) {
    // A receipt claiming nothing still records ownership of itself; removing it
    // is the whole subtraction, and saying "0 files" is the honest description.
    return {
      state: "owned",
      paths: [],
      detail: "receipt-proven ECC materialization claiming no destination",
    };
  }
  return {
    state: "owned",
    paths,
    detail: `receipt-proven ECC materialization of ${paths.length} owned file(s) across ${read.receipt.components.length} component(s)`,
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
