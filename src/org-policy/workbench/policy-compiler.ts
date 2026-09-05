import { MAX_ORG_POLICY_BYTES, OrgPolicySchema } from "../schema.js";
import {
  type CompiledWorkbenchPolicyV1,
  projectWorkbenchPolicy,
  type WorkbenchPolicyBindingsV1,
} from "./compile-policy.js";
import type {
  AuthoringCatalogBundleV1,
  WorkbenchSourceInputsV1,
  WorkbenchStateV1,
} from "./contracts.js";
import {
  workbenchAuthoringSourcesBudgetIssueV1,
  workbenchPolicyFitsByteLimitV1,
  workbenchStateBudgetIssueV1,
} from "./contracts.js";
import {
  verifyWorkbenchAuthoringSourceBytesV1,
  verifyWorkbenchDraftBytesV1,
} from "./core/verification.js";

/** Internal Core oracle; no public CLI surface until a scripted author journey needs it. */
export function compilePolicy(
  input: Record<string, unknown>,
  state: WorkbenchStateV1,
  bundle: AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  mode: "author" | "consume" = "author",
  sourceInputs: WorkbenchSourceInputsV1 = {},
): CompiledWorkbenchPolicyV1 {
  const budgetIssue =
    workbenchAuthoringSourcesBudgetIssueV1(input.authoringSources) ??
    workbenchStateBudgetIssueV1(state) ??
    (input.schemaVersion === 3
      ? workbenchStateBudgetIssueV1(input.authoringSelections)
      : undefined);
  if (budgetIssue) return { accepted: false, policy: input, diagnostics: [budgetIssue] };
  const initial = OrgPolicySchema.safeParse(input);
  if (!initial.success)
    return {
      accepted: false,
      policy: input,
      diagnostics: initial.error.issues.map((issue) => issue.message),
    };
  try {
    for (const draft of state.drafts) verifyWorkbenchDraftBytesV1(draft);
  } catch (error) {
    return {
      accepted: false,
      policy: input,
      diagnostics: [error instanceof Error ? error.message : "Draft verification failed."],
    };
  }
  const projected = projectWorkbenchPolicy(
    initial.data,
    state,
    bundle,
    bindings,
    mode,
    sourceInputs,
  );
  if (!projected.accepted) return { ...projected, policy: input };
  try {
    for (const source of Array.isArray(projected.policy.authoringSources)
      ? projected.policy.authoringSources
      : [])
      verifyWorkbenchAuthoringSourceBytesV1(source);
  } catch (error) {
    return {
      accepted: false,
      policy: input,
      diagnostics: [
        error instanceof Error ? error.message : "Authoring source verification failed",
      ],
    };
  }
  const result = OrgPolicySchema.safeParse(projected.policy);
  if (!result.success)
    return {
      accepted: false,
      policy: input,
      diagnostics: result.error.issues.map((issue) => issue.message),
    };
  if (!workbenchPolicyFitsByteLimitV1(result.data))
    return {
      accepted: false,
      policy: input,
      diagnostics: [`Compiled policy exceeds the ${MAX_ORG_POLICY_BYTES}-byte Core reader limit`],
    };
  return { accepted: true, policy: result.data, diagnostics: [] };
}
