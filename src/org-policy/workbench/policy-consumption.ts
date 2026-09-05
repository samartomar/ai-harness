import { type OrgPolicy, OrgPolicySchema } from "../schema.js";
import {
  type WorkbenchStateV1,
  WorkbenchStateV1Schema,
  workbenchStateBudgetIssueV1,
} from "./contracts.js";
import { prepareAuthoringSourcesForConsumptionV1 } from "./core/authoring-sources.js";
import { compilePolicy } from "./policy-compiler.js";
import {
  defaultPreparedWorkbenchCatalog,
  type PreparedWorkbenchCatalogV1,
} from "./prepared-catalog.js";
import { resolveWorkbenchSelection } from "./selection-engine.js";

export interface WorkbenchPolicyConsumptionV1 {
  accepted: boolean;
  policy?: OrgPolicy;
  diagnostics: string[];
  requestedIntent: string[];
  selectedControls: string[];
}

/** Core reconstructs bindings from its prepared catalog; policy bytes supply no authority. */
export function consumeWorkbenchPolicy(
  input: Record<string, unknown>,
  state: WorkbenchStateV1,
  prepared: PreparedWorkbenchCatalogV1 = defaultPreparedWorkbenchCatalog(),
): WorkbenchPolicyConsumptionV1 {
  // Schema-v3 policy bytes are the selection authority. Callers cannot
  // substitute a separate state object after the policy has been imported.
  const transportedState = input.schemaVersion === 3 ? input.authoringSelections : state;
  if (
    transportedState === null ||
    typeof transportedState !== "object" ||
    Array.isArray(transportedState)
  )
    return {
      accepted: false,
      diagnostics: ["Workbench selection must be an object."],
      requestedIntent: [],
      selectedControls: [],
    };
  const { selectionVersion: _selectionVersion, ...selectionState } =
    transportedState as WorkbenchStateV1 & {
      selectionVersion?: string;
    };
  const budgetIssue = workbenchStateBudgetIssueV1(selectionState);
  if (budgetIssue !== undefined)
    return {
      accepted: false,
      diagnostics: [budgetIssue],
      requestedIntent: [],
      selectedControls: [],
    };
  const parsedState = WorkbenchStateV1Schema.safeParse(selectionState);
  if (!parsedState.success)
    return {
      accepted: false,
      diagnostics: parsedState.error.issues.map((issue) => issue.message),
      requestedIntent: [],
      selectedControls: [],
    };
  const sourcePreparation = prepareAuthoringSourcesForConsumptionV1(
    parsedState.data,
    input.schemaVersion === 3 ? input.authoringSources : undefined,
    prepared,
  );
  if (!sourcePreparation.accepted || sourcePreparation.prepared === undefined)
    return {
      accepted: false,
      diagnostics: sourcePreparation.diagnostics,
      requestedIntent: [],
      selectedControls: [],
    };
  const reconstructed = sourcePreparation.prepared;
  const compiled = compilePolicy(
    input,
    parsedState.data,
    reconstructed.bundle,
    reconstructed.bindings,
    "consume",
    reconstructed.sourceInputs,
  );
  if (!compiled.accepted)
    return {
      accepted: false,
      diagnostics: compiled.diagnostics,
      requestedIntent: [],
      selectedControls: [],
    };
  const parsed = OrgPolicySchema.safeParse(compiled.policy);
  if (!parsed.success)
    return {
      accepted: false,
      diagnostics: parsed.error.issues.map((issue) => issue.message),
      requestedIntent: [],
      selectedControls: [],
    };
  const resolved = resolveWorkbenchSelection(reconstructed.bundle, parsedState.data);
  const requestedIntent = [
    ...new Set([
      ...parsedState.data.requests.map((request) => request.assetId),
      ...resolved.assetIds.filter(
        (id) => reconstructed.bundle.assets[id]?.authoring.action === "record-selection",
      ),
    ]),
  ].sort();
  const selectedControls = [
    ...new Set(
      resolved.assetIds.filter(
        (id) => reconstructed.bundle.assets[id]?.authoring.action === "select-control",
      ),
    ),
  ].sort();
  return {
    accepted: true,
    policy: parsed.data as OrgPolicy,
    diagnostics: [],
    requestedIntent,
    selectedControls,
  };
}
