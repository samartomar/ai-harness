import { compileOrganizationManifestV1 } from "../compilers/organization-manifest.js";
import {
  WorkbenchAuthoringSourcesV1Schema,
  type WorkbenchStateV1,
  WorkbenchStateV1Schema,
  workbenchAuthoringSourcesBudgetIssueV1,
  workbenchStateBudgetIssueV1,
} from "../contracts.js";
import { type PreparedWorkbenchCatalogV1, prepareWorkbenchCatalog } from "../prepared-catalog.js";
import { verifyWorkbenchAuthoringSourceBytesV1 } from "./verification.js";

export interface WorkbenchSourcePinV1 {
  assetId: string;
  sourceId: string;
  sourceRevisionId: string;
  contentDigest: string;
}

export interface PreparedAuthoringSourcesV1 {
  accepted: boolean;
  diagnostics: string[];
  prepared?: PreparedWorkbenchCatalogV1;
}

function sourcePins(state: WorkbenchStateV1): WorkbenchSourcePinV1[] {
  return [
    ...state.roots.flatMap((root) => [
      {
        assetId: root.assetId,
        sourceId: root.sourceId,
        sourceRevisionId: root.sourceRevisionId,
        contentDigest: root.contentDigest,
      },
      ...root.resolvedItems,
    ]),
    ...state.requests,
    ...state.exclusions,
  ];
}

/** Exposes all saved state pins without trusting policy-authored catalog metadata. */
export function referencedWorkbenchSourcePinsV1(state: WorkbenchStateV1): WorkbenchSourcePinV1[] {
  return sourcePins(state).map((pin) => ({ ...pin }));
}

function failures(message: string): PreparedAuthoringSourcesV1 {
  return { accepted: false, diagnostics: [message] };
}

/**
 * Rebuilds portable organization declarations from their exact V3 transport
 * inputs. The envelope cannot provide evidence, authoring actions, or Core
 * bindings: those remain properties of the reconstructed prepared catalog.
 */
export function prepareAuthoringSourcesForConsumptionV1(
  state: WorkbenchStateV1,
  authoringSources: unknown,
  baseline: PreparedWorkbenchCatalogV1,
): PreparedAuthoringSourcesV1 {
  const budgetIssue = workbenchStateBudgetIssueV1(state);
  if (budgetIssue !== undefined) return failures(budgetIssue);
  const parsedState = WorkbenchStateV1Schema.safeParse(state);
  if (!parsedState.success)
    return failures(parsedState.error.issues.map((issue) => issue.message).join("; "));
  const savedState = parsedState.data;
  let canonicalBaseline: PreparedWorkbenchCatalogV1;
  try {
    canonicalBaseline = prepareWorkbenchCatalog(baseline.catalog);
  } catch (error) {
    return failures(error instanceof Error ? error.message : "unable to prepare Core catalog");
  }
  if (authoringSources === undefined) {
    const baselinePins = sourcePins(savedState);
    for (const pin of baselinePins)
      if (canonicalBaseline.bundle.sources[pin.sourceId] === undefined)
        return failures(`missing authoring source input for ${pin.sourceId}`);
    return { accepted: true, diagnostics: [], prepared: canonicalBaseline };
  }
  const sourceBudgetIssue = workbenchAuthoringSourcesBudgetIssueV1(authoringSources);
  if (sourceBudgetIssue !== undefined) return failures(sourceBudgetIssue);
  const parsed = WorkbenchAuthoringSourcesV1Schema.safeParse(authoringSources);
  if (!parsed.success)
    return failures(parsed.error.issues.map((issue) => issue.message).join("; "));

  const manifests: string[] = [];
  const sourceIds = new Set<string>();
  try {
    for (const source of parsed.data) {
      const verified = verifyWorkbenchAuthoringSourceBytesV1(source);
      const compiled = compileOrganizationManifestV1(verified.text);
      if (
        compiled.source.id !== verified.source.sourceId ||
        compiled.source.revisionId !== verified.source.sourceRevisionId ||
        compiled.source.contentDigest !== verified.source.digest
      )
        return failures(
          `authoring source ${verified.source.sourceId} identity does not match its manifest`,
        );
      if (canonicalBaseline.bundle.sources[verified.source.sourceId] !== undefined)
        return failures(
          `authoring source ${verified.source.sourceId} collides with a Core catalog source`,
        );
      if (sourceIds.has(verified.source.sourceId))
        return failures(`duplicate authoring source ${verified.source.sourceId}`);
      sourceIds.add(verified.source.sourceId);
      manifests.push(verified.text);
    }
  } catch (error) {
    return failures(error instanceof Error ? error.message : "invalid authoring source");
  }

  let prepared: PreparedWorkbenchCatalogV1;
  try {
    prepared = prepareWorkbenchCatalog(canonicalBaseline.catalog, {
      organizationManifestBytes: manifests,
    });
  } catch (error) {
    return failures(error instanceof Error ? error.message : "unable to prepare authoring sources");
  }

  const referencedInputs = new Set<string>();
  for (const pin of sourcePins(savedState)) {
    const asset = prepared.bundle.assets[pin.assetId];
    if (asset === undefined) {
      const missingInput = canonicalBaseline.bundle.sources[pin.sourceId] === undefined;
      return failures(
        missingInput
          ? `missing authoring source input for ${pin.sourceId}`
          : `missing catalog asset: ${pin.assetId}`,
      );
    }
    if (
      asset.sourceId !== pin.sourceId ||
      asset.sourceRevisionId !== pin.sourceRevisionId ||
      asset.contentDigest !== pin.contentDigest
    )
      return failures(`stale authoring source pin: ${pin.assetId}`);
    if (sourceIds.has(pin.sourceId)) referencedInputs.add(pin.sourceId);
  }
  for (const sourceId of sourceIds)
    if (!referencedInputs.has(sourceId))
      return failures(`unreferenced authoring source input: ${sourceId}`);

  return { accepted: true, diagnostics: [], prepared };
}
