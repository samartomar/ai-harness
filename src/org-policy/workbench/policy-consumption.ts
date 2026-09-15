import {
  hasExpandedMcpControlTargetsV1,
  isExactLegacyMcpControlV1,
  LEGACY_GOVERNED_MCP_TARGETS_V1,
} from "../mcp-target-compatibility.js";
import { type OrgPolicy, OrgPolicySchema } from "../schema.js";
import {
  type WorkbenchStateV1,
  WorkbenchStateV1Schema,
  workbenchAuthoringSourcesBudgetIssueV1,
  workbenchStateBudgetIssueV1,
} from "./contracts.js";
import { prepareAuthoringSourcesForConsumptionV1 } from "./core/authoring-sources.js";
import { compilePolicy } from "./policy-compiler.js";
import {
  type PreparedWorkbenchCatalogV1,
  packagedPreparedWorkbenchCatalogV1,
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
  prepared: PreparedWorkbenchCatalogV1 = packagedPreparedWorkbenchCatalogV1(),
): WorkbenchPolicyConsumptionV1 {
  return consumeCompatibleWorkbenchPolicy(input, state, prepared).consumption;
}

/** Reopening selects historical authoring data only after complete consumption succeeds. */
export function historicalWorkbenchCatalogForPolicyV1(
  input: Record<string, unknown>,
  state: WorkbenchStateV1,
  prepared: PreparedWorkbenchCatalogV1,
): PolicyAuthoringCatalog | undefined {
  // Most saved policies cannot need this compatibility path. Do not reconstruct
  // their sources or selections just to decide which catalog Studio should use.
  if (!hasExactLegacyMcpCandidateV1(input, prepared)) return undefined;
  return consumeCompatibleWorkbenchPolicy(input, state, prepared).historicalCatalog;
}

function hasExactLegacyMcpCandidateV1(
  input: Record<string, unknown>,
  prepared: PreparedWorkbenchCatalogV1,
): boolean {
  if (
    input.schemaVersion !== 3 ||
    workbenchStateBudgetIssueV1(input.authoringSelections) !== undefined ||
    workbenchAuthoringSourcesBudgetIssueV1(input.authoringSources) !== undefined
  )
    return false;
  const parsed = OrgPolicySchema.safeParse(input);
  return (
    parsed.success &&
    parsed.data.schemaVersion === 3 &&
    parsed.data.governance !== undefined &&
    "catalog" in parsed.data.governance &&
    parsed.data.governance.catalog.reviewed.some((candidate) =>
      prepared.catalog.mcp.some(({ control }) => isExactLegacyMcpControlV1(candidate, control)),
    )
  );
}

function consumeCompatibleWorkbenchPolicy(
  input: Record<string, unknown>,
  state: WorkbenchStateV1,
  prepared: PreparedWorkbenchCatalogV1,
): { consumption: WorkbenchPolicyConsumptionV1; historicalCatalog?: PolicyAuthoringCatalog } {
  const current = consumePreparedWorkbenchPolicy(input, state, prepared);
  if (current.accepted) return { consumption: current };
  // Preserve the normal reader's cheap rejection before considering fallback.
  if (!hasExactLegacyMcpCandidateV1(input, prepared)) return { consumption: current };

  // A single exact historical catalog can reconstruct old declaration pins.
  // Full source/pin and consume-mode projection validation still runs; no
  // imported pin, activation, approval, or source identity is rewritten.
  const historicalCatalog = structuredClone(prepared.catalog);
  for (const item of historicalCatalog.mcp) {
    if (hasExpandedMcpControlTargetsV1(item.control))
      item.control.targets = [...LEGACY_GOVERNED_MCP_TARGETS_V1];
  }
  const historical = consumePreparedWorkbenchPolicy(input, state, {
    ...prepared,
    catalog: historicalCatalog,
  });
  return historical.accepted
    ? { consumption: historical, historicalCatalog }
    : { consumption: current };
}

function consumePreparedWorkbenchPolicy(
  input: Record<string, unknown>,
  state: WorkbenchStateV1,
  prepared: PreparedWorkbenchCatalogV1,
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

import type { PolicyAuthoringCatalog } from "../catalog.js";
