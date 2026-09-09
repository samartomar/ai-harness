import { catalogSourceDisplayName } from "../catalog-browse.js";
import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
  WorkbenchActionV1,
  WorkbenchStateV1,
} from "../contracts.js";
import {
  createWorkbenchState,
  previewWorkbenchTransactionV1,
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
  type WorkbenchTransactionPreviewV1,
} from "../selection-engine.js";
import { humanizedAssetLabel } from "./catalog-presentation.js";

export interface SelectionComparisonPresentation {
  kind: "none" | "already-in-draft" | "conflict";
  candidates: { assetId: string; label: string; sourceLabel: string }[];
  steps: WorkbenchActionV1[];
  preview: WorkbenchTransactionPreviewV1;
  explanation: string;
}

export interface McpRuntimeOverlapPresentation {
  kind: "none" | "potential-overlap";
  runtimeIdentity?: string;
  candidates: { assetId: string; label: string; sourceLabel: string }[];
  explanation: string;
}

/** Exact provider-declared registration names are advisory only; pins and writer collisions remain separate. */
export function mcpRuntimeOverlapPresentation(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
  state: WorkbenchStateV1,
): McpRuntimeOverlapPresentation {
  if (asset.kind !== "mcp" || asset.runtimeIdentity === undefined)
    return {
      kind: "none",
      candidates: [],
      explanation: "No declared runtime identity is available.",
    };
  const selected = resolveWorkbenchSelection(bundle, state);
  const currentIds = new Set([
    ...selected.assetIds,
    ...state.requests
      .filter((request) => {
        const candidate = bundle.assets[request.assetId];
        return (
          candidate !== undefined &&
          candidate.sourceId === request.sourceId &&
          candidate.sourceRevisionId === request.sourceRevisionId &&
          candidate.contentDigest === request.contentDigest
        );
      })
      .map((request) => request.assetId),
  ]);
  const matches = [...currentIds]
    .filter((id) => id !== asset.id && bundle.assets[id]?.runtimeIdentity === asset.runtimeIdentity)
    .sort()
    .flatMap((id) => {
      const candidate = bundle.assets[id];
      return candidate === undefined
        ? []
        : [
            {
              assetId: id,
              label: humanizedAssetLabel(candidate),
              sourceLabel: catalogSourceDisplayName(bundle, candidate.sourceId),
            },
          ];
    });
  return matches.length === 0
    ? {
        kind: "none",
        candidates: [],
        explanation: "No selected MCP declares this runtime identity.",
      }
    : {
        kind: "potential-overlap",
        runtimeIdentity: asset.runtimeIdentity,
        candidates: matches,
        explanation:
          "These MCP choices declare the same registration name and may overlap. Keep one, or explicitly retain both; this advisory does not prove they use the same endpoint, establish a destination collision, or alter source approval.",
      };
}

/** Only catalog-declared conflicts establish a replacement; similar names establish nothing. */
export function selectionComparisonPresentation(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
  state: WorkbenchStateV1,
): SelectionComparisonPresentation {
  const canonical = bundle.assets[asset.id];
  if (
    canonical === undefined ||
    canonical.sourceId !== asset.sourceId ||
    canonical.sourceRevisionId !== asset.sourceRevisionId ||
    canonical.contentDigest !== asset.contentDigest ||
    canonical.authoring.action !== asset.authoring.action
  )
    return {
      kind: "none",
      candidates: [],
      steps: [],
      preview: previewWorkbenchTransactionV1(bundle, state, []),
      explanation:
        "This item's catalog identity changed. Review the current version before adding it.",
    };
  const add: WorkbenchActionV1 =
    asset.authoring.action === "record-request"
      ? { type: "record-request", assetId: asset.id, origin: { kind: "administrator" } }
      : { type: "select-root", assetId: asset.id, origin: { kind: "administrator" } };
  const selected = resolveWorkbenchSelection(bundle, state);
  const present =
    state.requests.some(
      (request) =>
        request.assetId === asset.id &&
        request.sourceId === asset.sourceId &&
        request.sourceRevisionId === asset.sourceRevisionId &&
        request.contentDigest === asset.contentDigest,
    ) || selected.assetIds.includes(asset.id);
  const trial = reduceWorkbenchAction(bundle, createWorkbenchState(), add);
  const incomingIds = trial.accepted ? resolveWorkbenchSelection(bundle, trial.state).assetIds : [];
  const incomingSet = new Set(incomingIds);
  const current = new Set(selected.assetIds);
  const incomingMethodologies = new Set(
    incomingIds.flatMap((id) => {
      const incoming = bundle.assets[id];
      return incoming?.exclusiveSlot === "methodology" ? [incoming.methodologyKey] : [];
    }),
  );
  const conflicts = new Set<string>();
  for (const existingId of current) {
    const existing = bundle.assets[existingId];
    if (
      existing?.exclusiveSlot === "methodology" &&
      [...incomingMethodologies].some((key) => key !== existing.methodologyKey)
    )
      conflicts.add(existingId);
  }
  for (const relation of bundle.relations) {
    if (relation.kind !== "conflicts") continue;
    if (incomingSet.has(relation.fromAssetId) && current.has(relation.toAssetId))
      conflicts.add(relation.toAssetId);
    if (incomingSet.has(relation.toAssetId) && current.has(relation.fromAssetId))
      conflicts.add(relation.fromAssetId);
  }
  const removals: WorkbenchActionV1[] = [];
  for (const root of state.roots) {
    if (
      !conflicts.has(root.assetId) &&
      !root.resolvedItems.some((pin) => conflicts.has(pin.assetId))
    )
      continue;
    const closure = resolveWorkbenchSelection(bundle, { ...state, roots: [root] });
    if (![...closure.assetIds, ...closure.staleAssetIds].some((id) => conflicts.has(id))) continue;
    removals.push(
      root.origin.kind === "template"
        ? { type: "remove-template", templateId: root.origin.id, digest: root.origin.digest }
        : { type: "remove-root", assetId: root.assetId, origin: root.origin },
    );
  }
  const unique = [...new Map(removals.map((step) => [JSON.stringify(step), step])).values()];
  const steps = [...unique, add];
  return {
    kind: conflicts.size > 0 ? "conflict" : present ? "already-in-draft" : "none",
    candidates: [...conflicts].sort().flatMap((id) => {
      const candidate = bundle.assets[id];
      return candidate === undefined
        ? []
        : [
            {
              assetId: id,
              label: humanizedAssetLabel(candidate),
              sourceLabel: catalogSourceDisplayName(bundle, candidate.sourceId),
            },
          ];
    }),
    steps,
    preview: previewWorkbenchTransactionV1(bundle, state, steps),
    explanation:
      conflicts.size > 0
        ? "These choices conflict according to the catalog. Replacing them removes the selecting roots, including an entire starting point when it owns a conflicting choice. Review every change below."
        : present
          ? "This exact version is already in your draft. Keeping it as your own choice adds an origin; it does not add another installed copy."
          : "No conflict is declared for this addition. The catalog does not establish whether differently named or sourced items provide overlapping capabilities.",
  };
}
