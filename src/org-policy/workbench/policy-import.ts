import {
  inspectSavedWorkbenchSourcesV1,
  referencedWorkbenchSourcePinsV1,
} from "./authoring-sources.js";
import type { WorkbenchPolicyBindingsV1 } from "./compile-policy.js";
import {
  type AuthoringCatalogBundleV1,
  WORKBENCH_MINIMUM_CORE_VERSION,
  type WorkbenchActionV1,
  WorkbenchActionV1Schema,
  WorkbenchSelectionExportV1Schema,
  type WorkbenchSourceInputsV1,
  type WorkbenchStateV1,
  WorkbenchStateV1Schema,
  workbenchAuthoringSourcesBudgetIssueV1,
  workbenchPolicyFitsByteLimitV1,
  workbenchStateBudgetIssueV1,
} from "./contracts.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
} from "./selection-engine.js";

export interface WorkbenchPolicyImportV1 {
  accepted: boolean;
  state: WorkbenchStateV1;
  diagnostics: string[];
}
export interface WorkbenchPolicyRepairV1 {
  accepted: boolean;
  inert: true;
  policy?: Record<string, unknown>;
  state: WorkbenchStateV1;
  diagnostics: string[];
}

function rejectedRepair(diagnostics: string[]): WorkbenchPolicyRepairV1 {
  return { accepted: false, inert: true, state: createWorkbenchState(), diagnostics };
}

function selectionExport(state: WorkbenchStateV1) {
  return { selectionVersion: "workbench-selection/v1" as const, ...state };
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function withLegacyPolicyCandidateDefaultsV1(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    ...(!Object.hasOwn(value, "findings") ? { findings: [] } : {}),
    ...(!Object.hasOwn(value, "autoExecute") ? { autoExecute: false } : {}),
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

function duplicateString(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}
function legacyExternalMatches(
  item: Record<string, unknown>,
  owner: string,
  entries: readonly [string, WorkbenchPolicyBindingsV1[string]][],
) {
  return entries.filter(
    ([, binding]) =>
      binding.external !== undefined &&
      binding.external.owner === owner &&
      canonical(binding.external.item) === canonical(item),
  );
}

/** Import records saved facts; only an explicit new selection captures new pins. */
export function importWorkbenchPolicySelections(
  input: unknown,
  bundle: AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  sourceInputs: WorkbenchSourceInputsV1 = {},
): WorkbenchPolicyImportV1 {
  const policy = object(input);
  const empty = createWorkbenchState();
  if (policy.schemaVersion === 3) {
    if (policy.minimumCoreVersion !== WORKBENCH_MINIMUM_CORE_VERSION)
      return {
        accepted: false,
        state: empty,
        diagnostics: ["Unsupported or missing minimum compatible Core version"],
      };
    const budgetIssue =
      workbenchAuthoringSourcesBudgetIssueV1(policy.authoringSources) ??
      workbenchStateBudgetIssueV1(policy.authoringSelections);
    if (budgetIssue) return { accepted: false, state: empty, diagnostics: [budgetIssue] };
    const parsed = WorkbenchSelectionExportV1Schema.safeParse(policy.authoringSelections);
    if (!parsed.success)
      return {
        accepted: false,
        state: empty,
        diagnostics: parsed.error.issues.map((issue) => issue.message),
      };
    const { selectionVersion: _version, ...state } = parsed.data;
    const savedSources = inspectSavedWorkbenchSourcesV1(
      policy.authoringSources,
      state,
      bundle,
      sourceInputs,
    );
    if (savedSources.errors.length)
      return { accepted: false, state: empty, diagnostics: savedSources.errors };
    const resolved = resolveWorkbenchSelection(bundle, state);
    // Missing or changed pins remain importable only to offer exact subtraction
    // through the repair flow. Every live catalog semantic must still be valid
    // before the UI applies this saved state.
    const repairDiagnostics = [
      ...savedSources.stale,
      ...resolved.missingAssetIds.map((id) => `Missing saved asset: ${id}`),
      ...resolved.staleAssetIds.map((id) => `Stale saved asset: ${id}`),
    ];
    const semanticDiagnostics: string[] = [];
    // Structural roots intentionally do not become effective leaves, so inspect
    // their current action separately from the resolved closure.
    for (const root of state.roots) {
      if (root.mode !== "structural") continue;
      const asset = bundle.assets[root.assetId];
      if (
        asset !== undefined &&
        asset.authoring.action !== "select-control" &&
        asset.authoring.action !== "record-selection"
      )
        semanticDiagnostics.push(
          `Saved structural root no longer supports selection: ${root.assetId}`,
        );
    }
    const selected = new Set(resolved.assetIds);
    const methodologies = new Set<string>();
    for (const id of selected) {
      const asset = bundle.assets[id];
      if (!["select-control", "record-selection"].includes(asset?.authoring.action ?? ""))
        semanticDiagnostics.push(`Saved asset no longer supports selection: ${id}`);
      if (asset?.exclusiveSlot === "methodology" && asset.methodologyKey)
        methodologies.add(asset.methodologyKey);
      if (state.exclusions.some((exclusion) => exclusion.assetId === id))
        semanticDiagnostics.push(`Selected asset is excluded: ${id}`);
    }
    if (methodologies.size > 1)
      semanticDiagnostics.push(
        `Multiple methodology profiles: ${[...methodologies].sort().join(", ")}`,
      );
    for (const relation of bundle.relations)
      if (
        relation.kind === "conflicts" &&
        selected.has(relation.fromAssetId) &&
        selected.has(relation.toAssetId)
      )
        semanticDiagnostics.push(
          `Conflicting selections: ${relation.fromAssetId}, ${relation.toAssetId}`,
        );
    for (const request of state.requests) {
      const asset = bundle.assets[request.assetId];
      if (
        !asset ||
        asset.sourceId !== request.sourceId ||
        asset.sourceRevisionId !== request.sourceRevisionId ||
        asset.contentDigest !== request.contentDigest
      ) {
        repairDiagnostics.push(`Stale or unavailable saved request: ${request.assetId}`);
      } else if (asset.authoring.action !== "record-request") {
        semanticDiagnostics.push(`Saved request no longer supports requests: ${request.assetId}`);
      }
    }
    for (const exclusion of state.exclusions) {
      const asset = bundle.assets[exclusion.assetId];
      if (!asset) repairDiagnostics.push("Missing saved exclusion: " + exclusion.assetId);
      else if (
        asset.sourceId !== exclusion.sourceId ||
        asset.sourceRevisionId !== exclusion.sourceRevisionId ||
        asset.contentDigest !== exclusion.contentDigest
      )
        repairDiagnostics.push("Stale saved exclusion: " + exclusion.assetId);
    }
    const diagnostics = [...new Set([...repairDiagnostics, ...semanticDiagnostics])].sort();
    return semanticDiagnostics.length
      ? { accepted: false, state: empty, diagnostics }
      : { accepted: true, state, diagnostics };
  }
  if (policy.schemaVersion !== 2)
    return { accepted: false, state: empty, diagnostics: ["Unsupported policy version"] };
  const governance = object(policy.governance);
  let state = empty;
  const diagnostics: string[] = [];
  const add = (id: string, action: "select-root" | "record-request", attributed: boolean) => {
    const result = reduceWorkbenchAction(bundle, state, {
      type: action,
      assetId: id,
      origin: attributed ? { kind: "administrator" } : { kind: "legacy-unattributed" },
    });
    if (result.accepted) state = result.state;
    else diagnostics.push(...(result.diagnostics ?? []).map((item) => item.message));
  };
  const entries = Object.entries(bindings);
  const reviewed = rows(object(governance.catalog).reviewed);
  for (const activation of rows(governance.activations)) {
    const match = entries.find(
      ([, binding]) => binding.kind === "control" && binding.candidate?.id === activation.candidate,
    );
    if (!match) continue;
    const [id, binding] = match;
    const candidate = reviewed.find((item) => item.id === activation.candidate);
    const supported = governance.supportedClis;
    const targets = binding.candidate!.targets.filter(
      (target) => !Array.isArray(supported) || supported.includes(target),
    );
    const clarification = activation.clarification;
    const attributed = clarification === "Requested by: administrator";
    if (
      activation.state !== "active" ||
      canonical(withLegacyPolicyCandidateDefaultsV1(candidate)) !==
        canonical(withLegacyPolicyCandidateDefaultsV1(binding.candidate)) ||
      canonical(activation.targets) !== canonical(targets) ||
      (clarification !== undefined &&
        clarification !== "Requested by: administrator" &&
        clarification !== "Requested by: enterprise profile")
    ) {
      diagnostics.push("Legacy control needs explicit review before migration: " + id);
      continue;
    }
    // Only the exact administrator clarification is attributable. Profile
    // wording is retained as a historical, unattributed selection because a
    // V2 record has no stable template identity to pin safely.
    add(id, "select-root", attributed);
  }
  const externalGroups = rows(governance.externalSelections);
  const externalOwners = new Set<string>();
  for (const [groupIndex, group] of externalGroups.entries()) {
    const owner = typeof group.framework === "string" ? group.framework : undefined;
    if (!owner) {
      diagnostics.push("Legacy source group has no exact owner: " + groupIndex);
      continue;
    }
    if (externalOwners.has(owner)) {
      diagnostics.push("Legacy source group is duplicated: " + owner);
      continue;
    }
    externalOwners.add(owner);
    if (externalOwners.size > 1) {
      diagnostics.push("Legacy policy permits only one external source owner");
      continue;
    }
    if (group.items !== undefined && !Array.isArray(group.items)) {
      diagnostics.push("Legacy source items are malformed: " + owner);
      continue;
    }
    const originals = rows(group.items);
    const itemIds = originals.map((item) => (typeof item.id === "string" ? item.id : ""));
    const duplicateItem = duplicateString(itemIds);
    if (duplicateItem !== undefined) {
      diagnostics.push("Legacy source item is duplicated: " + duplicateItem);
      continue;
    }
    const explicit = group.roots === undefined ? undefined : stringList(group.roots);
    const unattributed =
      group.unattributedItems === undefined ? [] : stringList(group.unattributedItems);
    if (explicit === undefined && group.roots !== undefined) {
      diagnostics.push("Legacy source roots are malformed: " + owner);
      continue;
    }
    if (unattributed === undefined) {
      diagnostics.push("Legacy unattributed source items are malformed: " + owner);
      continue;
    }
    const duplicateRoot = duplicateString(explicit ?? []);
    const duplicateUnattributed = duplicateString(unattributed);
    if (duplicateRoot !== undefined) {
      diagnostics.push("Legacy source root is duplicated: " + duplicateRoot);
      continue;
    }
    if (duplicateUnattributed !== undefined) {
      diagnostics.push("Legacy unattributed source item is duplicated: " + duplicateUnattributed);
      continue;
    }
    const itemIdSet = new Set(itemIds);
    const invalidRoot = (explicit ?? []).find((id) => !itemIdSet.has(id));
    const invalidUnattributed = unattributed.find((id) => !itemIdSet.has(id));
    const overlapping = (explicit ?? []).find((id) => unattributed.includes(id));
    if (invalidRoot !== undefined) {
      diagnostics.push("Legacy source root is not an item: " + invalidRoot);
      continue;
    }
    if (invalidUnattributed !== undefined) {
      diagnostics.push("Legacy unattributed source item is not an item: " + invalidUnattributed);
      continue;
    }
    if (overlapping !== undefined) {
      diagnostics.push("Legacy source item is both root and unattributed: " + overlapping);
      continue;
    }
    const curated = new Set(
      rows(governance.externalCuration)
        .filter((curation) => curation.framework === owner)
        .flatMap((curation) => rows(curation.items))
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string"),
    );
    const curatedSelection = itemIds.find((id) => curated.has(id));
    if (curatedSelection !== undefined) {
      diagnostics.push("Legacy source item is both selected and curated: " + curatedSelection);
      continue;
    }
    const mapped = originals.map((item) => legacyExternalMatches(item, owner, entries));
    const unmapped = mapped.find((matches) => matches.length !== 1);
    if (unmapped !== undefined) {
      diagnostics.push("Legacy source items do not match the prepared catalog: " + owner);
      continue;
    }
    const exact = mapped.map((matches) => matches[0]!);
    for (const [id, binding] of exact) {
      const rawId = binding.external!.item.id;
      if (explicit === undefined || explicit.includes(rawId) || unattributed.includes(rawId))
        add(id, "select-root", explicit?.includes(rawId) ?? false);
    }
    const allowed = new Set(exact.map(([id]) => id));
    const selected = new Set(resolveWorkbenchSelection(bundle, state).assetIds);
    const missing = exact.find(([id]) => !selected.has(id));
    if (missing !== undefined) {
      diagnostics.push(
        "Legacy source item is not reachable from a root or preserved item: " +
          missing[1].external!.item.id,
      );
      continue;
    }
    for (const id of selected) {
      if (bindings[id]?.external?.owner === owner && !allowed.has(id))
        diagnostics.push("Legacy dependency set differs from prepared catalog: " + id);
    }
  }
  const packages = object(policy.capabilityPackages);
  const repository = object(packages.catalog).repository;
  for (const root of Array.isArray(packages.roots) ? packages.roots : []) {
    const match = entries.find(
      ([, binding]) =>
        binding.packageRoot !== undefined &&
        binding.packageRoot.root === root &&
        binding.packageRoot.catalogRepository === repository,
    );
    if (!match)
      diagnostics.push("Legacy package root is absent from prepared catalog: " + String(root));
    else add(match[0], "select-root", false);
  }
  const requests = rows(governance.aihMcpRequests);
  const requestIds = requests
    .map((request) => request.id)
    .filter((id): id is string => typeof id === "string");
  const duplicateRequest = duplicateString(requestIds);
  if (duplicateRequest !== undefined)
    diagnostics.push("Legacy request is duplicated: " + duplicateRequest);
  const policyCandidates = new Set(
    [...rows(object(governance.catalog).reviewed), ...rows(object(governance.catalog).custom)]
      .map((candidate) => candidate.id)
      .filter((id): id is string => typeof id === "string"),
  );
  if (duplicateRequest === undefined) {
    const mappedRequests: Array<[string, WorkbenchPolicyBindingsV1[string]]> = [];
    let previousRequestOrder = -1;
    for (const request of requests) {
      const requestId = typeof request.id === "string" ? request.id : undefined;
      if (!requestId) {
        diagnostics.push("Legacy request has no exact identity");
        continue;
      }
      const matches = entries.filter(([, binding]) => binding.legacyRequestId === requestId);
      if (matches.length !== 1) {
        diagnostics.push("Legacy request is absent from prepared catalog: " + requestId);
        continue;
      }
      const [id, binding] = matches[0]!;
      if (
        policyCandidates.has(requestId) ||
        entries.some(
          ([, candidateBinding]) =>
            candidateBinding.kind === "control" && candidateBinding.candidate?.id === requestId,
        )
      ) {
        diagnostics.push("Legacy request collides with a selectable candidate: " + requestId);
        continue;
      }
      if (
        binding.kind !== "intent" ||
        binding.legacyRequestOrder === undefined ||
        !Number.isInteger(binding.legacyRequestOrder) ||
        binding.legacyRequestOrder <= previousRequestOrder
      ) {
        diagnostics.push("Legacy requests do not follow the pinned declaration order");
        continue;
      }
      previousRequestOrder = binding.legacyRequestOrder;
      mappedRequests.push([id, binding]);
    }
    if (!diagnostics.some((diagnostic) => diagnostic.startsWith("Legacy request")))
      for (const [id] of mappedRequests) add(id, "record-request", false);
  }
  return diagnostics.length
    ? { accepted: false, state: empty, diagnostics: [...new Set(diagnostics)].sort() }
    : { accepted: true, state, diagnostics: [] };
}

/**
 * Serializes one exact removal from an otherwise stale V3 selection. This is
 * intentionally separate from normal projection: it never adds pins, never
 * derives legacy effects, and only returns a policy while another diagnosis
 * remains for the administrator to repair.
 */
export function serializeWorkbenchRepairV1(
  input: unknown,
  currentState: WorkbenchStateV1,
  action: WorkbenchActionV1,
  bundle: AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  sourceInputs: WorkbenchSourceInputsV1 = {},
): WorkbenchPolicyRepairV1 {
  const policy = object(input);
  if (policy.schemaVersion !== 3 || policy.minimumCoreVersion !== WORKBENCH_MINIMUM_CORE_VERSION)
    return rejectedRepair(["Repair requires an exact V3 Workbench policy"]);

  const budgetIssue =
    workbenchStateBudgetIssueV1(policy.authoringSelections) ??
    workbenchStateBudgetIssueV1(currentState);
  if (budgetIssue) return rejectedRepair([budgetIssue]);
  const saved = WorkbenchSelectionExportV1Schema.safeParse(policy.authoringSelections);
  const current = WorkbenchStateV1Schema.safeParse(currentState);
  if (!saved.success || !current.success)
    return rejectedRepair(["Repair requires a valid saved and current selection state"]);
  const { selectionVersion: _version, ...savedState } = saved.data;
  if (canonical(savedState) !== canonical(current.data))
    return rejectedRepair(["Repair state does not match the saved selection"]);

  const imported = importWorkbenchPolicySelections(policy, bundle, bindings, sourceInputs);
  if (!imported.accepted || imported.diagnostics.length === 0)
    return rejectedRepair(["Repair is only available while saved selections need review"]);

  const parsedAction = WorkbenchActionV1Schema.safeParse(action);
  if (
    !parsedAction.success ||
    !["remove-root", "remove-request", "remove-exclusion", "remove-template"].includes(
      parsedAction.data.type,
    )
  )
    return rejectedRepair(["Repair permits only one exact saved-item removal"]);

  const reduced = reduceWorkbenchAction(bundle, current.data, parsedAction.data);
  if (!reduced.accepted)
    return rejectedRepair(
      reduced.diagnostics?.map((diagnostic) => diagnostic.message) ?? ["Repair was rejected"],
    );
  if (canonical(reduced.state) === canonical(current.data))
    return rejectedRepair(["Repair removal did not change the saved selection"]);

  const candidate = structuredClone(policy);
  candidate.authoringSelections = selectionExport(reduced.state);
  if (Array.isArray(candidate.authoringSources)) {
    const ids = new Set(referencedWorkbenchSourcePinsV1(reduced.state).map((pin) => pin.sourceId));
    const remaining = candidate.authoringSources.filter((source) =>
      ids.has(object(source).sourceId as string),
    );
    if (remaining.length) candidate.authoringSources = remaining;
    else delete candidate.authoringSources;
  }
  if (!workbenchPolicyFitsByteLimitV1(candidate))
    return rejectedRepair(["Repair exceeds the Core policy byte limit"]);
  const verified = importWorkbenchPolicySelections(candidate, bundle, bindings, sourceInputs);
  if (!verified.accepted) return rejectedRepair(["Repair result could not be re-imported"]);
  if (verified.diagnostics.length === 0)
    return rejectedRepair(["Repair is complete; regenerate the policy through normal projection"]);
  return {
    accepted: true,
    inert: true,
    policy: candidate,
    state: reduced.state,
    diagnostics: verified.diagnostics,
  };
}
