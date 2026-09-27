import { AihError } from "../errors.js";
import type { PlanContext } from "../internals/plan.js";
import { defaultNativeRuntimeLayout } from "../mcp/default-native-runtime.js";
import { resolveDeveloperToolSelectionForOrgPolicyV1 } from "../org-policy/developer-tool-policy.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import {
  isPrimaryCodeGraphId,
  type ResolvedDefaultToolSelection,
} from "./default-tool-selection.js";
import {
  type PrimaryCodeGraphRecord,
  readDeveloperToolPrimaryCodeGraph,
} from "./developer-tools-runtime.js";

export type PrimaryCodeGraphChoice = PrimaryCodeGraphRecord;

/**
 * The rule: a policy `developerTools.primaryCodeGraph` binds and a different
 * `--primary-code-graph` is refused; a policy that omits the field leaves the
 * choice to the user, whose flag (or earlier recorded choice) applies. With no
 * choice at all there is no primary and routing stays task-based. The primary
 * must be a tool the effective policy selects.
 */
export function resolvePrimaryCodeGraphChoice(
  selection: ResolvedDefaultToolSelection,
  requested: unknown,
  recorded: PrimaryCodeGraphRecord | undefined,
): PrimaryCodeGraphChoice | undefined {
  if (requested !== undefined && !isPrimaryCodeGraphId(requested)) {
    throw new AihError(
      "--primary-code-graph must be code-review-graph or codebase-memory-mcp",
      "AIH_CONFIG",
    );
  }
  const enterprise = selection.primaryCodeGraph;
  if (enterprise !== undefined) {
    if (requested !== undefined && requested !== enterprise) {
      throw new AihError(
        `the organization policy sets developerTools.primaryCodeGraph to ${enterprise}; --primary-code-graph ${requested} is not allowed (a policy that omits the field leaves this choice to the user)`,
        "AIH_ORG_POLICY",
      );
    }
    return { id: enterprise, source: "policy" };
  }
  if (requested !== undefined) {
    if (!selection.selected.includes(requested)) {
      throw new AihError(
        `${requested} cannot be the primary code graph: it is excluded by the effective developer-tool policy`,
        "AIH_ORG_POLICY",
      );
    }
    return { id: requested, source: "user" };
  }
  if (recorded?.source === "user" && selection.selected.includes(recorded.id)) return recorded;
  return undefined;
}

/** Policy, then this invocation's flag, then the recorded user choice. */
export function effectivePrimaryCodeGraph(ctx: PlanContext): PrimaryCodeGraphChoice | undefined {
  return effectivePrimaryCodeGraphFor(ctx, readOrgPolicy(ctx.root, ctx.env));
}

/** As {@link effectivePrimaryCodeGraph}, for a caller that already verified the policy. */
export function effectivePrimaryCodeGraphFor(
  ctx: PlanContext,
  policy: unknown,
): PrimaryCodeGraphChoice | undefined {
  const selection = resolveDeveloperToolSelectionForOrgPolicyV1(policy);
  if (!selection.accepted) {
    throw new AihError(
      `Developer tool selection is invalid: ${selection.diagnostics.map((item) => item.message).join(" ")}`,
      "AIH_ORG_POLICY",
    );
  }
  return resolvePrimaryCodeGraphChoice(
    selection,
    ctx.options.primaryCodeGraph,
    readDeveloperToolPrimaryCodeGraph(defaultNativeRuntimeLayout(ctx)),
  );
}
