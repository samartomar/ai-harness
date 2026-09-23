import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { type CommandSpec, digest, type PlanContext, plan } from "../internals/plan.js";
import { VerificationReport } from "../internals/verify.js";
import { command as mcpCommand } from "../mcp/index.js";
import { resolveDeveloperToolSelectionForOrgPolicyV1 } from "../org-policy/developer-tool-policy.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import { combineProjectResults } from "../org-policy/validate.js";
import {
  DEFAULT_DEVELOPER_TOOL_IDS,
  type DeveloperToolId,
  type ResolvedDefaultToolSelection,
} from "./default-tool-selection.js";
import {
  createDeveloperToolReconciler,
  type DeveloperToolRuntimeDeps,
} from "./developer-tools-runtime.js";

export type DeveloperToolLifecycleState =
  | "selected-pending"
  | "installed"
  | "configured"
  | "verified"
  | "policy-excluded"
  | "blocked";

export interface DeveloperToolLifecycleResult {
  readonly id: DeveloperToolId;
  readonly state: DeveloperToolLifecycleState;
  readonly detail: string;
  readonly changed: boolean;
}

export type TokenOptimizerProfile = "quiet" | "balanced";

export interface DeveloperToolReconcileInput {
  readonly id: DeveloperToolId;
  readonly ctx: PlanContext;
  /** False asks the production reconciler to cease only unchanged receipt-owned integration. */
  readonly selected: boolean;
  readonly acceptTokenOptimizerLicense: boolean;
  readonly tokenOptimizerProfile: TokenOptimizerProfile;
}

export interface DeveloperToolsCommandDeps {
  /** Runtime/acquisition boundary. Tests replace this one function; production supplies each default. */
  readonly reconcileTool?: (
    input: DeveloperToolReconcileInput,
  ) => Promise<DeveloperToolLifecycleResult>;
  /** Keep production receipt/policy reconciliation while replacing low-level operations. */
  readonly runtime?: DeveloperToolRuntimeDeps;
  /** Set false when `aih init` already composed the root-aware MCP projection phase. */
  readonly projectMcp?: false | ((ctx: PlanContext) => Promise<PlanResult>);
}

export interface DeveloperToolsPlanResult extends PlanResult {
  readonly accepted: boolean;
  readonly selection: ResolvedDefaultToolSelection;
  readonly tools: DeveloperToolLifecycleResult[];
  readonly changed: boolean;
}

function profile(value: unknown): TokenOptimizerProfile {
  if (value === undefined || value === "quiet") return "quiet";
  if (value === "balanced") return value;
  throw new AihError("--token-optimizer-profile must be quiet or balanced", "AIH_CONFIG");
}

function selectionFor(ctx: PlanContext): ResolvedDefaultToolSelection {
  const selection = resolveDeveloperToolSelectionForOrgPolicyV1(readOrgPolicy(ctx.root, ctx.env));
  if (!selection.accepted) {
    throw new AihError(
      `Developer tool selection is invalid: ${selection.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join(" ")}`,
      "AIH_ORG_POLICY",
    );
  }
  return selection;
}

function previewTools(selection: ResolvedDefaultToolSelection): DeveloperToolLifecycleResult[] {
  const selected = new Set(selection.selected);
  return DEFAULT_DEVELOPER_TOOL_IDS.map((id) => ({
    id,
    state: selected.has(id) ? "selected-pending" : "policy-excluded",
    detail: selected.has(id)
      ? id === "headroom"
        ? "selected intent only; Headroom activation unavailable in this Core release"
        : "selected for ordinary setup; run with --apply to reconcile and verify"
      : "not selected by the effective developer-tool policy",
    changed: false,
  }));
}

function resultPlan(
  selection: ResolvedDefaultToolSelection,
  tools: readonly DeveloperToolLifecycleResult[],
) {
  return plan(
    "developer-tools",
    digest(
      "Developer tool lifecycle",
      tools.map((tool) => `${tool.id}: ${tool.state} — ${tool.detail}`).join("\n"),
      { accepted: true, selection, tools },
    ),
  );
}

function withLifecycle(
  result: PlanResult,
  selection: ResolvedDefaultToolSelection,
  tools: DeveloperToolLifecycleResult[],
): DeveloperToolsPlanResult {
  const changed =
    tools.some((tool) => tool.changed) ||
    result.writes.some((write) => write.effect === "create" || write.effect === "overwrite");
  return {
    ...result,
    capability: "developer-tools",
    accepted: true,
    selection,
    tools,
    changed,
  };
}

function lifecycleReport(tools: readonly DeveloperToolLifecycleResult[]): VerificationReport {
  const report = new VerificationReport();
  for (const tool of tools) {
    if (tool.state === "policy-excluded") continue;
    if (tool.id === "headroom" && tool.state === "selected-pending")
      report.skip("headroom developer tool", tool.detail);
    else if (tool.state === "verified") report.pass(`${tool.id} developer tool`, tool.detail);
    else
      report.add({
        name: `${tool.id} developer tool`,
        verdict: "fail",
        code: "developer-tools.runtime-verification",
        detail: tool.detail,
      });
  }
  return report;
}

async function reconcileSelected(
  ctx: PlanContext,
  selection: ResolvedDefaultToolSelection,
  deps: DeveloperToolsCommandDeps,
): Promise<DeveloperToolLifecycleResult[]> {
  const selected = new Set(selection.selected);
  const reconcile = deps.reconcileTool ?? createDeveloperToolReconciler(ctx, deps.runtime);
  const tokenOptimizerProfile = profile(ctx.options.tokenOptimizerProfile);
  const acceptTokenOptimizerLicense = ctx.options.acceptTokenOptimizerLicense === true;
  const tools: DeveloperToolLifecycleResult[] = [];
  for (const id of DEFAULT_DEVELOPER_TOOL_IDS) {
    if (id === "headroom") {
      tools.push({
        id,
        state: selected.has(id) ? "selected-pending" : "policy-excluded",
        detail: selected.has(id)
          ? "selected intent only; Headroom activation unavailable in this Core release"
          : "not selected by the effective developer-tool policy",
        changed: false,
      });
      continue;
    }
    try {
      const result = await reconcile({
        id,
        ctx,
        selected: selected.has(id),
        acceptTokenOptimizerLicense,
        tokenOptimizerProfile,
      });
      if (result.id !== id) throw new Error("developer-tool reconciler returned a different id");
      tools.push(result);
    } catch (error) {
      tools.push({
        id,
        state: "blocked",
        detail: error instanceof Error ? error.message : String(error),
        changed: false,
      });
    }
  }
  return tools;
}

export async function developerToolsPlan(ctx: PlanContext) {
  profile(ctx.options.tokenOptimizerProfile);
  const selection = selectionFor(ctx);
  return resultPlan(selection, previewTools(selection));
}

/**
 * Reconcile every selected default independently. One missing prerequisite is
 * reported for that tool and never prevents the remaining tools from running.
 */
export async function executeDeveloperToolsCommand(
  ctx: PlanContext,
  deps: DeveloperToolsCommandDeps = {},
): Promise<DeveloperToolsPlanResult> {
  profile(ctx.options.tokenOptimizerProfile);
  const selection = selectionFor(ctx);
  if (!ctx.apply) {
    const tools = previewTools(selection);
    return withLifecycle(await executePlan(resultPlan(selection, tools), ctx), selection, tools);
  }

  const tools = await reconcileSelected(ctx, selection, deps);
  let result = await executePlan(resultPlan(selection, tools), ctx);
  if (deps.projectMcp !== false) {
    const projected = deps.projectMcp
      ? await deps.projectMcp(ctx)
      : await executePlan(await mcpCommand.plan(ctx), ctx);
    result = combineProjectResults(result, projected);
  }
  result.report = lifecycleReport(tools);
  return withLifecycle(result, selection, tools);
}

export const developerToolsCommand: CommandSpec = {
  name: "developer-tools",
  summary: "Select, provision, configure, and verify the policy-allowed default developer tools",
  options: [
    {
      flags: "--accept-token-optimizer-license",
      description: "accept Token Optimizer's license before acquiring its selected runtime",
    },
    {
      flags: "--token-optimizer-profile <profile>",
      description: "Token Optimizer setup profile: quiet | balanced",
      default: "quiet",
    },
  ],
  plan: developerToolsPlan,
};
