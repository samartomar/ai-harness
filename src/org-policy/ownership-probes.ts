import { readAihConfig } from "../config/marker.js";
import { readEccMaterializationReceipt } from "../ecc/materialization-receipt.js";
import { hasCommandPermissionOwnership } from "./command-permissions.js";
import { inspectPolicyRequiredGuidance } from "./required-guidance.js";

/** One kind of governed state aih writes at a project root, and whether it is present. */
export interface GovernedOwnershipProbe {
  readonly id: string;
  owned(root: string): boolean;
}

/**
 * Every kind of governed state aih can own at a project root. Each probe reads
 * only state aih itself writes; a present-but-unreadable record still counts
 * as owned, so a caller that requires a binding while ownership remains fails
 * closed instead of treating damaged state as absent.
 */
export const GOVERNED_OWNERSHIP_PROBES: readonly GovernedOwnershipProbe[] = Object.freeze([
  {
    id: "framework-materialization-receipt",
    owned: (root: string) => readEccMaterializationReceipt(root).state !== "absent",
  },
  {
    id: "policy-required-guidance",
    owned: (root: string) =>
      inspectPolicyRequiredGuidance(root, readAihConfig(root)?.contextDir ?? "ai-coding").state !==
      "absent",
  },
  { id: "command-permissions", owned: hasCommandPermissionOwnership },
]);

/** The ids of the governed state present at `root`, in probe order. */
export function governedOwnershipAt(
  root: string,
  probes: readonly GovernedOwnershipProbe[] = GOVERNED_OWNERSHIP_PROBES,
): string[] {
  return probes.filter((probe) => probe.owned(root)).map((probe) => probe.id);
}
