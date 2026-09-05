import {
  type AuthoringCatalogBundleV1,
  WorkbenchAuthoringSourcesV1Schema,
  type WorkbenchAuthoringSourceV1,
  type WorkbenchSourceInputsV1,
  type WorkbenchStateV1,
  workbenchAuthoringSourcesBudgetIssueV1,
} from "./contracts.js";

export function referencedWorkbenchSourcePinsV1(state: WorkbenchStateV1) {
  return [
    ...state.roots,
    ...state.roots.flatMap((root) => root.resolvedItems),
    ...state.requests,
    ...state.exclusions,
  ];
}

/** Pure identity comparison against prepared inputs, never cryptographic verification. */
export function inspectSavedWorkbenchSourcesV1(
  value: unknown,
  state: WorkbenchStateV1,
  bundle: AuthoringCatalogBundleV1,
  available: WorkbenchSourceInputsV1 = {},
): { sources: WorkbenchAuthoringSourceV1[]; errors: string[]; stale: string[] } {
  const budget = workbenchAuthoringSourcesBudgetIssueV1(value);
  if (budget) return { sources: [], errors: [budget], stale: [] };
  const parsed = WorkbenchAuthoringSourcesV1Schema.safeParse(
    value === undefined ? undefined : value,
  );
  if (value !== undefined && !parsed.success)
    return { sources: [], errors: parsed.error.issues.map((issue) => issue.message), stale: [] };
  const sources = parsed.success ? parsed.data : [];
  const pins = referencedWorkbenchSourcePinsV1(state);
  const referenced = new Set(pins.map((pin) => pin.sourceId));
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const errors: string[] = [],
    stale: string[] = [];
  for (const id of referenced) {
    if (bundle.sources[id]?.policyInputRequired && !byId.has(id))
      errors.push("Missing authoring source input: " + id);
  }
  for (const input of sources) {
    const id = input.sourceId;
    if (!referenced.has(id)) {
      errors.push("Unreferenced authoring source input: " + id);
      continue;
    }
    if (pins.some((pin) => pin.sourceId === id && pin.sourceRevisionId !== input.sourceRevisionId))
      errors.push("Authoring source revision disagrees with saved pins: " + id);
    const source = bundle.sources[id];
    if (!source) {
      stale.push("Missing prepared authoring source: " + id);
      continue;
    }
    if (!source.policyInputRequired) {
      errors.push("Prepared source does not accept policy input: " + id);
      continue;
    }
    if (
      source.revision.id !== input.sourceRevisionId ||
      source.revision.contentDigest !== input.digest ||
      source.inputFormat !== input.inputFormat
    ) {
      stale.push("Stale authoring source input: " + id);
      continue;
    }
    const expected = available[id];
    if (
      expected &&
      (expected.digest !== input.digest ||
        expected.bytesBase64 !== input.bytesBase64 ||
        expected.byteLength !== input.byteLength)
    )
      errors.push("Authoring source bytes disagree with prepared input: " + id);
  }
  return { sources, errors: [...new Set(errors)].sort(), stale: [...new Set(stale)].sort() };
}

/** Emit only exact prepared source inputs required by the current pinned state. */
export function selectWorkbenchAuthoringSourcesV1(
  state: WorkbenchStateV1,
  bundle: AuthoringCatalogBundleV1,
  available: WorkbenchSourceInputsV1 = {},
): { sources: WorkbenchAuthoringSourceV1[]; errors: string[] } {
  const ids = [
    ...new Set(referencedWorkbenchSourcePinsV1(state).map((pin) => pin.sourceId)),
  ].sort();
  const inputs = ids
    .filter((id) => bundle.sources[id]?.policyInputRequired)
    .flatMap((id) => (available[id] ? [available[id]!] : []));
  const checked = inspectSavedWorkbenchSourcesV1(
    inputs.length ? inputs : undefined,
    state,
    bundle,
    available,
  );
  return { sources: checked.sources, errors: [...checked.errors, ...checked.stale] };
}
