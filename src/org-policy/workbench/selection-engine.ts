import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
  WorkbenchActionV1,
  WorkbenchRequestV1,
  WorkbenchRootV1,
  WorkbenchStateV1,
} from "./contracts.js";
import {
  WorkbenchActionV1Schema,
  type WorkbenchOriginV1,
  WorkbenchStateV1Schema,
  workbenchOriginKey,
  workbenchStateBudgetIssueV1,
} from "./contracts.js";

export type {
  AuthoringCatalogBundleV1,
  WorkbenchActionV1,
  WorkbenchDraftV1,
  WorkbenchRequestV1,
  WorkbenchRootV1,
  WorkbenchStateV1,
} from "./contracts.js";

export interface WorkbenchDiagnosticV1 {
  code:
    | "unknown-asset"
    | "unsupported-action"
    | "excluded-required-asset"
    | "methodology-conflict"
    | "conflicting-assets"
    | "invalid-action";
  assetId?: string;
  message: string;
}

export interface WorkbenchReductionV1 {
  accepted: boolean;
  state: WorkbenchStateV1;
  diagnostics?: WorkbenchDiagnosticV1[];
}

export interface WorkbenchSelectionCountsV1 {
  requestCount: number;
  selectedControlCount: number;
  rootCount: number;
  effectiveStatus: "not-evaluated";
}

export interface WorkbenchResolvedSelectionV1 {
  assetIds: string[];
  missingAssetIds: string[];
  staleAssetIds: string[];
}

export function createWorkbenchState(): WorkbenchStateV1 {
  return { roots: [], exclusions: [], requests: [], drafts: [] };
}

function compareAssetAndOrigin(
  left: { assetId: string; origin: WorkbenchOriginV1 },
  right: { assetId: string; origin: WorkbenchOriginV1 },
): number {
  if (left.assetId !== right.assetId) return left.assetId < right.assetId ? -1 : 1;
  const leftKey = workbenchOriginKey(left.origin);
  const rightKey = workbenchOriginKey(right.origin);
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
}

function stableByAssetAndOrigin<T extends { assetId: string; origin: WorkbenchOriginV1 }>(
  items: readonly T[],
): T[] {
  return [...items].sort(compareAssetAndOrigin);
}

function assetFor(bundle: AuthoringCatalogBundleV1, assetId: string): AuthoringAssetV1 | undefined {
  return bundle.assets[assetId];
}

function rejected(
  state: WorkbenchStateV1,
  diagnostic: WorkbenchDiagnosticV1,
): WorkbenchReductionV1 {
  return { accepted: false, state, diagnostics: [diagnostic] };
}

function closureFor(
  bundle: AuthoringCatalogBundleV1,
  state: WorkbenchStateV1,
): WorkbenchResolvedSelectionV1 {
  const selected = new Set<string>();
  const missing = new Set<string>();
  const stale = new Set<string>();
  const pending = state.roots.map((root) => ({
    assetId: root.assetId,
    sourceId: root.sourceId,
    sourceRevisionId: root.sourceRevisionId,
    contentDigest: root.contentDigest,
    includeOptionalMembers: root.mode === "select" && root.includeOptionalMembers,
    required: true,
    selectItem: root.mode === "select",
    context: `${workbenchOriginKey(root.origin)}\u0000${root.resolvedItems.map((pin) => `${pin.assetId}\u0000${pin.sourceId}\u0000${pin.sourceRevisionId}\u0000${pin.contentDigest}`).join("\u0001")}`,
    pins: root.resolvedItems,
  }));
  const expanded = new Set<string>();
  for (const root of state.roots) {
    const expected = capturedPins(
      bundle,
      root.assetId,
      root.mode === "select" && root.includeOptionalMembers,
    );
    const actual = root.resolvedItems;
    if (
      expected.length !== actual.length ||
      expected.some((pin, index) => {
        const saved = actual[index];
        return (
          saved === undefined ||
          pin.assetId !== saved.assetId ||
          pin.sourceId !== saved.sourceId ||
          pin.sourceRevisionId !== saved.sourceRevisionId ||
          pin.contentDigest !== saved.contentDigest
        );
      })
    )
      stale.add(root.assetId);
  }

  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) continue;
    const key = `${next.assetId}\u0000${next.sourceId}\u0000${next.sourceRevisionId}\u0000${next.contentDigest}\u0000${next.includeOptionalMembers ? "optional" : "required"}\u0000${next.required ? "required" : "optional"}\u0000${next.context}`;
    if (expanded.has(key)) continue;
    expanded.add(key);
    const resolvedAsset = assetFor(bundle, next.assetId);
    if (resolvedAsset === undefined) {
      missing.add(next.assetId);
      continue;
    }
    if (
      next.sourceId !== undefined &&
      (resolvedAsset.sourceId !== next.sourceId ||
        resolvedAsset.sourceRevisionId !== next.sourceRevisionId ||
        resolvedAsset.contentDigest !== next.contentDigest)
    ) {
      stale.add(next.assetId);
      continue;
    }
    const excluded = state.exclusions.some((exclusion) => exclusion.assetId === next.assetId);
    if (excluded && !next.required) continue;
    if (next.selectItem) selected.add(next.assetId);
    for (const relation of bundle.relations) {
      if (relation.fromAssetId !== next.assetId || relation.kind === "conflicts") continue;
      const include =
        relation.kind === "requires" ||
        relation.membership === "required" ||
        (relation.membership === "optional" && next.includeOptionalMembers);
      if (include) {
        const pin = next.pins.find((candidate) => candidate.assetId === relation.toAssetId);
        if (pin === undefined) {
          missing.add(relation.toAssetId);
          continue;
        }
        pending.push({
          ...pin,
          includeOptionalMembers: false,
          required: relation.kind === "requires" || relation.membership === "required",
          selectItem: true,
          context: next.context,
          pins: next.pins,
        });
      }
    }
  }
  return {
    assetIds: [...selected].sort(),
    missingAssetIds: [...missing].sort(),
    staleAssetIds: [...stale].sort(),
  };
}
function selectionDiagnostic(
  bundle: AuthoringCatalogBundleV1,
  state: WorkbenchStateV1,
): WorkbenchDiagnosticV1 | undefined {
  const selection = closureFor(bundle, state);
  for (const request of state.requests) {
    const asset = assetFor(bundle, request.assetId);
    if (asset === undefined)
      return {
        code: "unknown-asset",
        assetId: request.assetId,
        message: `Saved request ${request.assetId} is missing.`,
      };
    if (
      asset.sourceId !== request.sourceId ||
      asset.sourceRevisionId !== request.sourceRevisionId ||
      asset.contentDigest !== request.contentDigest
    )
      return {
        code: "unknown-asset",
        assetId: request.assetId,
        message: `Saved request ${request.assetId} has a stale pin.`,
      };
    if (asset.authoring.action !== "record-request")
      return {
        code: "unsupported-action",
        assetId: request.assetId,
        message: `Saved request ${request.assetId} is no longer request-only.`,
      };
  }
  for (const exclusion of state.exclusions) {
    const asset = assetFor(bundle, exclusion.assetId);
    if (
      asset === undefined ||
      asset.sourceId !== exclusion.sourceId ||
      asset.sourceRevisionId !== exclusion.sourceRevisionId ||
      asset.contentDigest !== exclusion.contentDigest
    )
      return {
        code: "unknown-asset",
        assetId: exclusion.assetId,
        message: `Saved exclusion ${exclusion.assetId} has an unresolved or stale pin.`,
      };
  }
  for (const root of state.roots) {
    const asset = assetFor(bundle, root.assetId);
    if (
      asset !== undefined &&
      asset.authoring.action !== "select-control" &&
      asset.authoring.action !== "record-selection"
    )
      return {
        code: "unsupported-action",
        assetId: root.assetId,
        message: `Saved root ${root.assetId} is no longer selectable.`,
      };
  }
  if (selection.missingAssetIds.length || selection.staleAssetIds.length)
    return {
      code: "unknown-asset",
      assetId: selection.missingAssetIds[0] ?? selection.staleAssetIds[0],
      message: "Saved selection has an unresolved or stale pin.",
    };
  for (const assetId of selection.assetIds) {
    if (state.exclusions.some((exclusion) => exclusion.assetId === assetId)) {
      return {
        code: "excluded-required-asset",
        assetId,
        message: `Selection requires excluded asset ${assetId}.`,
      };
    }
  }
  const methodologyKeys = new Set(
    selection.assetIds
      .map((assetId) => assetFor(bundle, assetId))
      .filter((asset): asset is AuthoringAssetV1 => asset?.exclusiveSlot === "methodology")
      .map((asset) => asset.methodologyKey),
  );
  if (methodologyKeys.size > 1) {
    return {
      code: "methodology-conflict",
      message: `Selection contains incompatible methodologies: ${[...methodologyKeys].sort().join(", ")}.`,
    };
  }
  for (const relation of bundle.relations) {
    if (
      relation.kind === "conflicts" &&
      selection.assetIds.includes(relation.fromAssetId) &&
      selection.assetIds.includes(relation.toAssetId)
    ) {
      return {
        code: "conflicting-assets",
        assetId: relation.fromAssetId,
        message: `Selection contains conflicting assets ${relation.fromAssetId} and ${relation.toAssetId}.`,
      };
    }
  }
  return undefined;
}

function committed(
  bundle: AuthoringCatalogBundleV1,
  prior: WorkbenchStateV1,
  next: WorkbenchStateV1,
): WorkbenchReductionV1 {
  const budgetIssue = workbenchStateBudgetIssueV1(next);
  if (budgetIssue) return rejected(prior, { code: "invalid-action", message: budgetIssue });
  const diagnostic = selectionDiagnostic(bundle, next);
  return diagnostic === undefined ? { accepted: true, state: next } : rejected(prior, diagnostic);
}
function replaceRoot(state: WorkbenchStateV1, root: WorkbenchRootV1): WorkbenchRootV1[] {
  return stableByAssetAndOrigin([
    ...state.roots.filter(
      (candidate) =>
        candidate.assetId !== root.assetId ||
        workbenchOriginKey(candidate.origin) !== workbenchOriginKey(root.origin),
    ),
    root,
  ]);
}

function addRequest(state: WorkbenchStateV1, request: WorkbenchRequestV1): WorkbenchRequestV1[] {
  return stableByAssetAndOrigin([
    ...state.requests.filter(
      (candidate) =>
        candidate.assetId !== request.assetId ||
        workbenchOriginKey(candidate.origin) !== workbenchOriginKey(request.origin),
    ),
    request,
  ]);
}
function capturedPins(
  bundle: AuthoringCatalogBundleV1,
  assetId: string,
  includeOptionalMembers: boolean,
): WorkbenchRootV1["resolvedItems"] {
  const pending = [{ assetId, includeOptionalMembers }];
  const seen = new Set<string>();
  const pins: WorkbenchRootV1["resolvedItems"] = [];
  while (pending.length > 0) {
    const next = pending.shift()!;
    const currentId = next.assetId;
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const asset = assetFor(bundle, currentId);
    if (asset === undefined) continue;
    pins.push({
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
    });
    for (const relation of bundle.relations)
      if (
        relation.fromAssetId === currentId &&
        relation.kind !== "conflicts" &&
        (relation.kind === "requires" ||
          relation.membership === "required" ||
          (relation.membership === "optional" && next.includeOptionalMembers))
      )
        pending.push({ assetId: relation.toAssetId, includeOptionalMembers: false });
  }
  return pins.sort((left, right) =>
    left.assetId === right.assetId ? 0 : left.assetId < right.assetId ? -1 : 1,
  );
}

export function reduceWorkbenchAction(
  bundle: AuthoringCatalogBundleV1,
  state: WorkbenchStateV1,
  input: WorkbenchActionV1 | unknown,
): WorkbenchReductionV1 {
  const budgetIssue = workbenchStateBudgetIssueV1(state);
  if (budgetIssue) return rejected(state, { code: "invalid-action", message: budgetIssue });
  const parsedState = WorkbenchStateV1Schema.safeParse(state);
  if (!parsedState.success)
    return rejected(state, { code: "invalid-action", message: "Workbench state is malformed." });
  if (input && typeof input === "object" && "type" in input && input.type === "restore-state") {
    const issue = workbenchStateBudgetIssueV1("state" in input ? input.state : undefined);
    if (issue) return rejected(state, { code: "invalid-action", message: issue });
  }
  const parsedAction = WorkbenchActionV1Schema.safeParse(input);
  if (!parsedAction.success)
    return rejected(state, { code: "invalid-action", message: "Workbench action is malformed." });
  const action = parsedAction.data;
  if (action.type === "restore-state") return committed(bundle, state, action.state);
  if (action.type === "add-exclusion") {
    const asset = assetFor(bundle, action.assetId);
    if (asset === undefined)
      return rejected(state, {
        code: "unknown-asset",
        assetId: action.assetId,
        message: `Unknown asset ${action.assetId}.`,
      });
    const exclusion = {
      assetId: asset.id,
      origin: action.origin,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
    };
    return committed(bundle, state, {
      ...state,
      exclusions: stableByAssetAndOrigin([
        ...state.exclusions.filter(
          (item) =>
            item.assetId !== exclusion.assetId ||
            workbenchOriginKey(item.origin) !== workbenchOriginKey(exclusion.origin),
        ),
        exclusion,
      ]),
    });
  }
  if (action.type === "remove-exclusion")
    return {
      accepted: true,
      state: {
        ...state,
        exclusions: state.exclusions.filter(
          (item) =>
            item.assetId !== action.assetId ||
            workbenchOriginKey(item.origin) !== workbenchOriginKey(action.origin),
        ),
      },
    };
  if (action.type === "remove-template") {
    const origin = { kind: "template" as const, id: action.templateId, digest: action.digest };
    return {
      accepted: true,
      state: {
        ...state,
        roots: state.roots.filter(
          (root) => workbenchOriginKey(root.origin) !== workbenchOriginKey(origin),
        ),
        exclusions: state.exclusions.filter(
          (item) => workbenchOriginKey(item.origin) !== workbenchOriginKey(origin),
        ),
      },
    };
  }
  if (action.type === "add-draft") {
    const next = {
      ...state,
      drafts: [...state.drafts.filter((draft) => draft.id !== action.draft.id), action.draft].sort(
        (left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1),
      ),
    };
    const issue = workbenchStateBudgetIssueV1(next);
    return issue
      ? rejected(state, { code: "invalid-action", message: issue })
      : { accepted: true, state: next };
  }
  if (action.type === "remove-draft")
    return {
      accepted: true,
      state: { ...state, drafts: state.drafts.filter((draft) => draft.id !== action.id) },
    };
  if (action.type === "apply-template") {
    const template = bundle.templates[action.templateId];
    if (template === undefined)
      return rejected(state, {
        code: "unknown-asset",
        assetId: action.templateId,
        message: `Unknown template ${action.templateId}.`,
      });
    let roots = state.roots;
    for (const templateRoot of template.roots) {
      const asset = assetFor(bundle, templateRoot.assetId);
      if (
        asset === undefined ||
        (asset.authoring.action !== "select-control" &&
          asset.authoring.action !== "record-selection")
      )
        return rejected(state, {
          code: "unsupported-action",
          assetId: templateRoot.assetId,
          message: `Template root ${templateRoot.assetId} cannot be selected.`,
        });
      const origin = { kind: "template" as const, id: template.id, digest: template.digest };
      roots = replaceRoot(
        { ...state, roots },
        {
          assetId: asset.id,
          origin,
          mode: templateRoot.mode,
          includeOptionalMembers: templateRoot.includeOptionalMembers,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
          resolvedItems: capturedPins(
            bundle,
            asset.id,
            templateRoot.mode === "select" && templateRoot.includeOptionalMembers,
          ),
        },
      );
    }
    const origin = { kind: "template" as const, id: template.id, digest: template.digest };
    const exclusions = stableByAssetAndOrigin([
      ...state.exclusions.filter(
        (item) => workbenchOriginKey(item.origin) !== workbenchOriginKey(origin),
      ),
      ...template.exclusions.map((assetId) => {
        const asset = assetFor(bundle, assetId)!;
        return {
          assetId,
          origin,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        };
      }),
    ]);
    return committed(bundle, state, { ...state, roots, exclusions });
  }
  if (action.type === "remove-request") {
    const next = {
      ...state,
      requests: state.requests.filter(
        (request) =>
          request.assetId !== action.assetId ||
          workbenchOriginKey(request.origin) !== workbenchOriginKey(action.origin),
      ),
    };
    return { accepted: true, state: next };
  }
  if (action.type === "remove-root") {
    const next = {
      ...state,
      roots: state.roots.filter(
        (root) =>
          root.assetId !== action.assetId ||
          workbenchOriginKey(root.origin) !== workbenchOriginKey(action.origin),
      ),
    };
    return { accepted: true, state: next };
  }

  const asset = assetFor(bundle, action.assetId);
  if (asset === undefined) {
    return rejected(state, {
      code: "unknown-asset",
      assetId: action.assetId,
      message: `Unknown asset ${action.assetId}.`,
    });
  }
  if (action.type === "record-request") {
    if (asset.authoring.action !== "record-request") {
      return rejected(state, {
        code: "unsupported-action",
        assetId: action.assetId,
        message: `Asset ${action.assetId} cannot record a request.`,
      });
    }
    return committed(bundle, state, {
      ...state,
      requests: addRequest(state, {
        assetId: action.assetId,
        origin: action.origin,
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
      }),
    });
  }

  if (
    asset.authoring.action !== "select-control" &&
    asset.authoring.action !== "record-selection"
  ) {
    return rejected(state, {
      code: "unsupported-action",
      assetId: action.assetId,
      message: `Asset ${action.assetId} cannot be selected as a root.`,
    });
  }
  const mode = action.mode ?? "select";
  return committed(bundle, state, {
    ...state,
    roots: replaceRoot(state, {
      assetId: action.assetId,
      origin: action.origin,
      mode,
      includeOptionalMembers: mode === "select" && (action.includeOptionalMembers ?? false),
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
      resolvedItems: capturedPins(
        bundle,
        action.assetId,
        mode === "select" && (action.includeOptionalMembers ?? false),
      ),
    }),
  });
}

/** Detail chunks are intentionally unnecessary for closure, validation, and export. */
export function resolveWorkbenchSelection(
  bundle: AuthoringCatalogBundleV1,
  state: WorkbenchStateV1,
): WorkbenchResolvedSelectionV1 {
  const budgetIssue = workbenchStateBudgetIssueV1(state);
  if (budgetIssue) throw new Error(budgetIssue);
  return closureFor(bundle, state);
}

export function workbenchSelectionCounts(
  bundle: AuthoringCatalogBundleV1,
  state: WorkbenchStateV1,
): WorkbenchSelectionCountsV1 {
  const budgetIssue = workbenchStateBudgetIssueV1(state);
  if (budgetIssue) throw new Error(budgetIssue);
  const selection = closureFor(bundle, state);
  return {
    requestCount: new Set(
      state.requests
        .filter((request) => {
          const asset = assetFor(bundle, request.assetId);
          return (
            asset?.authoring.action === "record-request" &&
            asset.sourceId === request.sourceId &&
            asset.sourceRevisionId === request.sourceRevisionId &&
            asset.contentDigest === request.contentDigest
          );
        })
        .map((request) => request.assetId),
    ).size,
    selectedControlCount: new Set(
      selection.assetIds.filter(
        (assetId) => assetFor(bundle, assetId)?.authoring.action === "select-control",
      ),
    ).size,
    rootCount: new Set(
      state.roots.map((root) => `${root.assetId}\u0000${workbenchOriginKey(root.origin)}`),
    ).size,
    effectiveStatus: "not-evaluated",
  };
}
