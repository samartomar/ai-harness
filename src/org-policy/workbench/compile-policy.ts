import {
  inspectSavedWorkbenchSourcesV1,
  selectWorkbenchAuthoringSourcesV1,
} from "./authoring-sources.js";
import type { AuthoringCatalogBundleV1, WorkbenchStateV1 } from "./contracts.js";
import {
  WORKBENCH_MAX_POLICY_BYTES,
  WORKBENCH_MINIMUM_CORE_VERSION,
  type WorkbenchSourceInputsV1,
  WorkbenchStateV1Schema,
  workbenchAuthoringSourcesBudgetIssueV1,
  workbenchPolicyFitsByteLimitV1,
  workbenchStateBudgetIssueV1,
} from "./contracts.js";
import { resolveWorkbenchSelection } from "./selection-engine.js";

export interface WorkbenchPolicyBindingV1 {
  legacyRequestId?: string;
  legacyRequestOrder?: number;
  kind: "control" | "external-selection" | "package-root" | "intent";
  candidate?: Record<string, unknown> & { id: string; targets: string[] };
  external?: {
    owner: string;
    item: {
      id: string;
      kind: string;
      source: {
        repository: string;
        commit: string;
        path: string;
      };
    };
  };
  packageRoot?: { catalogRepository: string; root: string };
}
export type WorkbenchPolicyBindingsV1 = Record<string, WorkbenchPolicyBindingV1>;
export interface CompiledWorkbenchPolicyV1 {
  accepted: boolean;
  policy: Record<string, unknown>;
  diagnostics: string[];
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Authoring transforms intent using Core-prepared data. At evaluation Core
 * reconstructs these bindings from its own pinned catalog; policy JSON cannot
 * supply a binding or add projection authority.
 */
export function projectWorkbenchPolicy(
  input: Record<string, unknown>,
  rawState: WorkbenchStateV1,
  bundle: AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  mode: "author" | "consume" = "author",
  sourceInputs: WorkbenchSourceInputsV1 = {},
): CompiledWorkbenchPolicyV1 {
  const budgetIssue =
    workbenchStateBudgetIssueV1(rawState) ??
    workbenchAuthoringSourcesBudgetIssueV1(input.authoringSources);
  if (budgetIssue) return { accepted: false, policy: input, diagnostics: [budgetIssue] };
  const parsed = WorkbenchStateV1Schema.safeParse(rawState);
  if (!parsed.success)
    return {
      accepted: false,
      policy: input,
      diagnostics: parsed.error.issues.map((issue) => issue.message),
    };
  const state = parsed.data;
  const sourceProjection = selectWorkbenchAuthoringSourcesV1(state, bundle, sourceInputs);
  if (sourceProjection.errors.length)
    return { accepted: false, policy: input, diagnostics: sourceProjection.errors };
  if (mode === "consume") {
    const savedSources = inspectSavedWorkbenchSourcesV1(
      input.authoringSources,
      state,
      bundle,
      sourceInputs,
    );
    const sourceErrors = [...savedSources.errors, ...savedSources.stale];
    if (canonical(savedSources.sources) !== canonical(sourceProjection.sources))
      sourceErrors.push("Authoring sources disagree with exact prepared inputs");
    if (sourceErrors.length) return { accepted: false, policy: input, diagnostics: sourceErrors };
  }
  const resolved = resolveWorkbenchSelection(bundle, state);
  const diagnostics = [
    ...resolved.missingAssetIds.map((id) => `Missing catalog asset: ${id}`),
    ...resolved.staleAssetIds.map((id) => `Stale selected content: ${id}`),
  ];
  const selected = new Set(resolved.assetIds);
  const methodologies = new Set<string>();
  for (const id of selected) {
    const asset = bundle.assets[id];
    if (state.exclusions.some((exclusion) => exclusion.assetId === id))
      diagnostics.push(`Selected asset is excluded: ${id}`);
    if (asset?.exclusiveSlot === "methodology" && asset.methodologyKey)
      methodologies.add(asset.methodologyKey);
    if (
      asset?.authoring.action !== "select-control" &&
      asset?.authoring.action !== "record-selection"
    )
      diagnostics.push(`Asset has no selection action: ${id}`);
  }
  if (methodologies.size > 1)
    diagnostics.push(`Multiple methodology profiles: ${[...methodologies].sort().join(", ")}`);
  for (const relation of bundle.relations) {
    if (
      relation.kind === "conflicts" &&
      selected.has(relation.fromAssetId) &&
      selected.has(relation.toAssetId)
    )
      diagnostics.push(`Conflicting selections: ${relation.fromAssetId}, ${relation.toAssetId}`);
  }
  for (const request of state.requests) {
    const asset = bundle.assets[request.assetId];
    if (
      !asset ||
      asset.sourceId !== request.sourceId ||
      asset.sourceRevisionId !== request.sourceRevisionId ||
      asset.contentDigest !== request.contentDigest
    )
      diagnostics.push(`Stale or missing request identity: ${request.assetId}`);
    else if (asset.authoring.action !== "record-request")
      diagnostics.push(`Asset has no request action: ${request.assetId}`);
  }
  for (const exclusion of state.exclusions) {
    const asset = bundle.assets[exclusion.assetId];
    if (
      !asset ||
      asset.sourceId !== exclusion.sourceId ||
      asset.sourceRevisionId !== exclusion.sourceRevisionId ||
      asset.contentDigest !== exclusion.contentDigest
    )
      diagnostics.push("Stale or missing exclusion identity: " + exclusion.assetId);
  }
  if (diagnostics.length)
    return { accepted: false, policy: input, diagnostics: [...new Set(diagnostics)].sort() };

  const policy = structuredClone(input);
  const previousGovernance = object(policy.governance);
  const governance: Record<string, unknown> = {
    policyVersion: "1",
    catalog: { reviewed: [], custom: [] },
    activations: [],
    authority: { approvals: [] },
    externalCuration: [],
    externalSelections: [],
    ...previousGovernance,
  };
  const previousCatalog = object(governance.catalog);
  const managedControlIds = new Set(
    Object.values(bindings).flatMap((binding) =>
      binding.kind === "control" && binding.candidate ? [binding.candidate.id] : [],
    ),
  );
  const reviewed = records(previousCatalog.reviewed).filter(
    (candidate) => !managedControlIds.has(String(candidate.id)),
  );
  const activations = records(governance.activations).filter(
    (activation) => !managedControlIds.has(String(activation.candidate)),
  );
  const external = new Map<
    string,
    { framework: string; items: unknown[]; roots: string[]; unattributedItems: string[] }
  >();
  const managedOwners = new Set(
    Object.values(bindings).flatMap((binding) =>
      binding.external ? [binding.external.owner] : [],
    ),
  );
  const packageRoots: string[] = [];
  let packageRepository: string | undefined;
  const supported = Array.isArray(governance.supportedClis) ? governance.supportedClis : undefined;
  const controlClarification = (id: string): string | undefined => {
    const origins = new Set<string>();
    for (const root of state.roots) {
      const reaches = root.assetId === id || root.resolvedItems.some((pin) => pin.assetId === id);
      if (!reaches) continue;
      if (root.origin.kind === "administrator") origins.add("administrator");
      if (root.origin.kind === "template") origins.add("enterprise profile");
    }
    const values = ["enterprise profile", "administrator"].filter((origin) => origins.has(origin));
    return values.length ? "Requested by: " + values.join(", ") : undefined;
  };
  for (const id of [...selected].sort()) {
    const binding = bindings[id];
    if (!binding) {
      // Unknown source intent remains explicit and cannot nominate a projector.
      if (bundle.assets[id]?.authoring.action === "select-control")
        diagnostics.push(`Core control binding is missing: ${id}`);
      continue;
    }
    if (binding.kind === "control" && binding.candidate) {
      const candidate = structuredClone(binding.candidate);
      const targets = candidate.targets.filter(
        (target) => !supported || supported.includes(target),
      );
      if (!targets.length) {
        diagnostics.push(`No organization-sanctioned target for: ${id}`);
        continue;
      }
      reviewed.push(candidate);
      const clarification = controlClarification(id);
      activations.push({
        candidate: candidate.id,
        state: "active",
        targets,
        ...(clarification ? { clarification } : {}),
      });
    } else if (binding.kind === "external-selection" && binding.external) {
      const { owner, item } = binding.external;
      const group = external.get(owner) ?? {
        framework: owner,
        items: [],
        roots: [],
        unattributedItems: [],
      };
      group.items.push(structuredClone(item));
      const roots = state.roots.filter((root) => root.assetId === id);
      const derivedFromStructuralExternalRoot = state.roots.some((root) => {
        const structuralBinding = bindings[root.assetId];
        return (
          root.mode === "structural" &&
          structuralBinding?.kind === "external-selection" &&
          structuralBinding.external?.owner === owner &&
          root.resolvedItems.some((pin) => pin.assetId === id)
        );
      });
      if (roots.some((root) => root.origin.kind !== "legacy-unattributed"))
        group.roots.push(item.id);
      else if (roots.length || derivedFromStructuralExternalRoot)
        group.unattributedItems.push(item.id);
      external.set(owner, group);
    } else if (binding.kind === "package-root" && binding.packageRoot) {
      if (packageRepository && packageRepository !== binding.packageRoot.catalogRepository)
        diagnostics.push("Selected package roots require different catalogs");
      packageRepository = binding.packageRoot.catalogRepository;
      packageRoots.push(binding.packageRoot.root);
    }
  }
  if (diagnostics.length)
    return { accepted: false, policy: input, diagnostics: [...new Set(diagnostics)].sort() };
  const sortIds = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(left.id ?? left.candidate) < String(right.id ?? right.candidate)
      ? -1
      : String(left.id ?? left.candidate) > String(right.id ?? right.candidate)
        ? 1
        : 0;
  const nextCatalog = { ...previousCatalog, reviewed: reviewed.sort(sortIds) };
  const nextActivations = activations.sort(sortIds);
  const nextExternal = [
    ...records(governance.externalSelections).filter(
      (group) => !managedOwners.has(String(group.framework)),
    ),
    ...[...external.values()].sort((a, b) =>
      a.framework < b.framework ? -1 : a.framework > b.framework ? 1 : 0,
    ),
  ];
  const nextRequests = state.requests
    .flatMap((request) => {
      const id = bindings[request.assetId]?.legacyRequestId;
      return request.origin.kind === "administrator" && id
        ? [{ id, clarification: "Requested by: administrator" }]
        : [];
    })
    .sort((left, right) => {
      const order = (id: string) =>
        Object.values(bindings).find((binding) => binding.legacyRequestId === id)
          ?.legacyRequestOrder ?? Number.MAX_SAFE_INTEGER;
      return order(left.id) - order(right.id);
    });
  const nextPackages = packageRepository
    ? {
        catalog: { provider: "github", repository: packageRepository },
        roots: [...new Set(packageRoots)].sort(),
      }
    : undefined;
  if (mode === "consume") {
    if (
      policy.capabilityPackages !== undefined &&
      canonical(policy.capabilityPackages) !== canonical(nextPackages)
    )
      diagnostics.push("Legacy package roots disagree with pinned authoring selections");
    for (const [label, previous, next] of [
      ["reviewed controls", previousCatalog.reviewed ?? [], nextCatalog.reviewed],
      ["activations", governance.activations ?? [], nextActivations],
      ["external selections", governance.externalSelections ?? [], nextExternal],
      ["requests", governance.aihMcpRequests ?? [], nextRequests],
    ] as const) {
      // Empty compatibility fields are omitted projections. Nonempty competing
      // fields must agree; a second legacy representation never wins by order.
      if (Array.isArray(previous) && previous.length && canonical(previous) !== canonical(next))
        diagnostics.push(`Legacy ${label} disagree with pinned authoring selections`);
    }
  }
  if (diagnostics.length) return { accepted: false, policy: input, diagnostics };
  policy.governance = {
    ...governance,
    catalog: nextCatalog,
    activations: nextActivations,
    externalSelections: nextExternal,
  };
  if (nextRequests.length)
    (policy.governance as Record<string, unknown>).aihMcpRequests = nextRequests;
  else delete (policy.governance as Record<string, unknown>).aihMcpRequests;
  if (nextPackages) policy.capabilityPackages = nextPackages;
  else delete policy.capabilityPackages;
  policy.schemaVersion = 3;
  policy.minimumCoreVersion = WORKBENCH_MINIMUM_CORE_VERSION;
  policy.authoringSelections = { selectionVersion: "workbench-selection/v1", ...state };
  if (sourceProjection.sources.length) policy.authoringSources = sourceProjection.sources;
  else delete policy.authoringSources;
  if (!workbenchPolicyFitsByteLimitV1(policy))
    return {
      accepted: false,
      policy: input,
      diagnostics: [
        `Compiled policy exceeds the ${WORKBENCH_MAX_POLICY_BYTES}-byte Core reader limit`,
      ],
    };
  return { accepted: true, policy, diagnostics: [] };
}
