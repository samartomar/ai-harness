import type { WorkbenchPolicyBindingsV1 } from "../compile-policy.js";
import {
  type AuthoringCatalogBundleV1,
  type WorkbenchStateV1,
  WorkbenchStateV1Schema,
  workbenchStateBudgetIssueV1,
} from "../contracts.js";
import { resolveWorkbenchSelection } from "../selection-engine.js";

export type WorkbenchAdoptionStateV1 =
  | "pending-selection"
  | "pending-evidence"
  | "pending-approval"
  | "pending-route"
  | "ready-to-preview";

export interface WorkbenchAdoptionPlanItemV1 {
  readonly assetId: string;
  readonly state: WorkbenchAdoptionStateV1;
  readonly reason: string;
  readonly nextAction: string;
  readonly command?: string;
}

export interface WorkbenchAdoptionPlanV1 {
  readonly accepted: boolean;
  readonly diagnostics: readonly string[];
  readonly items: readonly WorkbenchAdoptionPlanItemV1[];
}

function githubRepository(locator: string): string | undefined {
  return /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(locator)?.[1];
}

function skillVetCommand(bundle: AuthoringCatalogBundleV1, assetId: string): string | undefined {
  const asset = bundle.assets[assetId];
  const source = asset === undefined ? undefined : bundle.sources[asset.sourceId];
  const repository =
    source?.upstreamOrigin.kind === "git" ||
    source?.inputFormat === "organization-authoring-manifest/v1"
      ? githubRepository(source.upstreamOrigin.locator)
      : undefined;
  const match = /(?:^|\/)skills\/([a-zA-Z0-9._-]+)\/SKILL\.md$/.exec(asset?.originalPath ?? "");
  if (
    asset?.kind !== "skill" ||
    source === undefined ||
    asset.sourceRevisionId !== source.revision.id ||
    repository === undefined ||
    !/^[a-f0-9]{40}$/.test(source.revision.id) ||
    match?.[1] === undefined
  )
    return undefined;
  return `aih skill vet ${repository} --pin ${source.revision.id} --name ${match[1]} --apply`;
}

function itemFor(
  bundle: AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  assetId: string,
  unusableAssetIds: ReadonlySet<string>,
): WorkbenchAdoptionPlanItemV1 {
  const asset = bundle.assets[assetId];
  const binding = bindings[assetId];
  if (unusableAssetIds.has(assetId))
    return {
      assetId,
      state: "pending-selection",
      reason: "The saved selection no longer matches the prepared catalog content.",
      nextAction:
        "Refresh the selection from the prepared catalog before choosing an adoption route.",
    };
  if (binding?.kind === "external-selection" && binding.external?.owner === "ecc") {
    if (binding.external.item.kind === "mcp")
      return {
        assetId,
        state: "pending-route",
        reason: "AIH can save this choice, but cannot configure this MCP yet.",
        nextAction: "Choose a supported AIH control if one meets your need.",
      };
    return {
      assetId,
      state: "pending-evidence",
      reason:
        "This selected ECC item can be evaluated only by the governed lifecycle at a concrete project after it rechecks policy and evidence.",
      nextAction:
        "Use the ECC lifecycle preview in your target project. It checks selected versions and required reports before any apply.",
    };
  }
  if (binding?.kind === "package-root" && binding.packageRoot)
    return {
      assetId,
      state: "ready-to-preview",
      reason:
        "This selected package root is already projected into the governed capability-package intent.",
      nextAction: "Inspect its local governed package status before any explicit apply.",
      command: `aih capability package status ${binding.packageRoot.root}`,
    };
  if (binding?.kind === "control")
    return {
      assetId,
      state: "pending-approval",
      reason:
        "The selected Core control is a policy intent; this plan cannot create a review approval or activate it.",
      nextAction:
        "Check this policy against your intended project before applying it. Core checks any required approvals there.",
    };
  const vet = skillVetCommand(bundle, assetId);
  if (vet !== undefined)
    return {
      assetId,
      state: "pending-evidence",
      reason:
        "No authenticated Core preparation result is supplied to this offline adoption plan for the exact Skill source.",
      nextAction:
        "Run the exact vet command to write a local vet record, then separately review and approve its result.",
      command: vet,
    };
  return {
    assetId,
    state: "pending-selection",
    reason:
      asset === undefined
        ? "The saved selection no longer names a prepared catalog asset."
        : "This selection has no existing governed adoption route.",
    nextAction: "Keep it as a request until Core adds an explicit, reviewed adoption route.",
  };
}

/**
 * Pure offline handoff. It never calls a lifecycle, treats intake JSON as
 * evidence, creates approval, or mutates the authored selection.
 */
export function planWorkbenchAdoptionV1(
  bundle: AuthoringCatalogBundleV1,
  rawState: unknown,
  bindings: WorkbenchPolicyBindingsV1,
): WorkbenchAdoptionPlanV1 {
  const budgetIssue = workbenchStateBudgetIssueV1(rawState);
  const parsed = budgetIssue === undefined ? WorkbenchStateV1Schema.safeParse(rawState) : undefined;
  if (budgetIssue !== undefined || parsed === undefined || !parsed.success)
    return {
      accepted: false,
      diagnostics:
        budgetIssue === undefined ? ["Malformed Workbench selection state."] : [budgetIssue],
      items: [],
    };
  const state: WorkbenchStateV1 = parsed.data;
  const resolved = resolveWorkbenchSelection(bundle, state);
  const staleRequests = state.requests
    .filter((request) => {
      const asset = bundle.assets[request.assetId];
      return (
        asset === undefined ||
        asset.sourceId !== request.sourceId ||
        asset.sourceRevisionId !== request.sourceRevisionId ||
        asset.contentDigest !== request.contentDigest
      );
    })
    .map((request) => request.assetId);
  const diagnostics = [
    ...resolved.missingAssetIds.map((id) => `Missing catalog asset: ${id}`),
    ...resolved.staleAssetIds.map((id) => `Stale selected content: ${id}`),
    ...staleRequests.map((id) => `Stale requested content: ${id}`),
  ];
  const assetIds = [
    ...new Set([...resolved.assetIds, ...state.requests.map((request) => request.assetId)]),
  ].sort();
  const unusableAssetIds = new Set([
    ...resolved.missingAssetIds,
    ...resolved.staleAssetIds,
    ...staleRequests,
  ]);
  const items = assetIds.map((assetId) => itemFor(bundle, bindings, assetId, unusableAssetIds));
  return {
    accepted: diagnostics.length === 0,
    diagnostics,
    items: diagnostics.length === 0 ? items : items.map(({ command: _command, ...item }) => item),
  };
}
