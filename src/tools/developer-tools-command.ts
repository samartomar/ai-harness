import { AihError } from "../errors.js";
import { resolveTargets } from "../internals/cli-detect.js";
import { entry } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { type CommandSpec, digest, type PlanContext, plan } from "../internals/plan.js";
import { VerificationReport } from "../internals/verify.js";
import { defaultNativeRuntimeLayout } from "../mcp/default-native-runtime.js";
import {
  command as mcpCommand,
  recordedRetirementActions,
  retainedRecordedMcpEntries,
} from "../mcp/index.js";
import { resolveDeveloperToolSelectionForOrgPolicyV1 } from "../org-policy/developer-tool-policy.js";
import { governanceOwnsAihSurfaces, type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import { combineProjectResults } from "../org-policy/validate.js";
import {
  DEFAULT_DEVELOPER_TOOL_IDS,
  type DeveloperToolId,
  type ResolvedDefaultToolSelection,
} from "./default-tool-selection.js";
import {
  createDeveloperToolReconciler,
  type DeveloperToolRuntimeDeps,
  readDeveloperToolPrimaryCodeGraph,
  recordDeveloperToolPrimaryCodeGraph,
} from "./developer-tools-runtime.js";
import { headroomLayout } from "./headroom.js";
import {
  activateHeadroom,
  type HeadroomLifecycleDeps,
  type HeadroomRequest,
  headroomRequestFrom,
  recordIncompleteHeadroomRemoval,
  removeHeadroomState,
  verifyActiveHeadroom,
} from "./headroom-lifecycle.js";
import { readHeadroomReceipt } from "./headroom-receipt.js";
import {
  type PrimaryCodeGraphChoice,
  resolvePrimaryCodeGraphChoice,
} from "./primary-code-graph.js";

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
  /** Headroom activation, health and acquisition seams. */
  readonly headroom?: HeadroomLifecycleDeps;
}

export interface DeveloperToolsPlanResult extends PlanResult {
  readonly accepted: boolean;
  readonly selection: ResolvedDefaultToolSelection;
  readonly tools: DeveloperToolLifecycleResult[];
  readonly changed: boolean;
  /** The effective primary code graph and who chose it; absent when none is chosen. */
  readonly primaryCodeGraph?: PrimaryCodeGraphChoice;
}

/** Validated invocation: flags, policy, Headroom request and primary code graph. */
export interface DeveloperToolRequest {
  readonly policy: OrgPolicy | undefined;
  readonly selection: ResolvedDefaultToolSelection;
  readonly headroom: HeadroomRequest;
  readonly primaryCodeGraph: PrimaryCodeGraphChoice | undefined;
}

function profile(value: unknown): TokenOptimizerProfile {
  if (value === undefined || value === "quiet") return "quiet";
  if (value === "balanced") return value;
  throw new AihError("--token-optimizer-profile must be quiet or balanced", "AIH_CONFIG");
}

function selectionFor(policy: OrgPolicy | undefined): ResolvedDefaultToolSelection {
  const selection = resolveDeveloperToolSelectionForOrgPolicyV1(policy);
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

/** Legacy MCP controls still bind Headroom's server name. */
function headroomMcpPolicyRefusal(policy: OrgPolicy | undefined): string | undefined {
  if (policy?.mcp?.disabledServers?.includes("headroom")) {
    return "headroom is disabled by org policy (mcp.disabledServers)";
  }
  if (
    policy?.mcp?.allowManagedOnly === true &&
    !(policy.mcp.allowedServers ?? []).includes("headroom")
  ) {
    return "headroom is outside the org-managed MCP allowlist (mcp.allowedServers)";
  }
  return undefined;
}

function headroomExclusion(
  selection: ResolvedDefaultToolSelection,
  policy: OrgPolicy | undefined,
): string | undefined {
  return selection.selected.includes("headroom")
    ? headroomMcpPolicyRefusal(policy)
    : "not selected by the effective developer-tool policy";
}

/**
 * Validate everything a run depends on before any work: lifecycle flags, the
 * policy selection, the primary code-graph rule, and whether Headroom may be
 * activated at all. A policy can exclude Headroom but never activate it.
 */
export function prepareDeveloperToolRequest(ctx: PlanContext): DeveloperToolRequest {
  profile(ctx.options.tokenOptimizerProfile);
  const headroom = headroomRequestFrom(ctx.options);
  const policy = readOrgPolicy(ctx.root, ctx.env);
  const selection = selectionFor(policy);
  const primaryCodeGraph = resolvePrimaryCodeGraphChoice(
    selection,
    ctx.options.primaryCodeGraph,
    readDeveloperToolPrimaryCodeGraph(defaultNativeRuntimeLayout(ctx)),
  );
  if (headroom.activate) {
    const exclusion = headroomExclusion(selection, policy);
    if (exclusion !== undefined) {
      throw new AihError(`Headroom activation refused: ${exclusion}`, "AIH_ORG_POLICY");
    }
    if (governanceOwnsAihSurfaces(policy)) {
      throw new AihError(
        "Headroom activation refused: governance exclusively owns AIH MCP projection for this project",
        "AIH_ORG_POLICY",
      );
    }
  }
  return { policy, selection, headroom, primaryCodeGraph };
}

function previewHeadroom(
  ctx: PlanContext,
  request: DeveloperToolRequest,
): DeveloperToolLifecycleResult {
  const receipt = readHeadroomReceipt(headroomLayout(ctx));
  const recorded = receipt.state !== "absent";
  const exclusion = headroomExclusion(request.selection, request.policy);
  const pending = (detail: string): DeveloperToolLifecycleResult => ({
    id: "headroom",
    state: "selected-pending",
    detail,
    changed: false,
  });
  if (exclusion !== undefined) {
    return {
      id: "headroom",
      state: "policy-excluded",
      detail: recorded
        ? `${exclusion}; --apply removes the AIH-owned Headroom activation`
        : exclusion,
      changed: false,
    };
  }
  if (request.headroom.deactivate) {
    return pending(
      recorded
        ? "deactivation requested; --apply removes AIH-owned Headroom MCP entries, runtime state and the activation receipt"
        : "not activated; nothing to deactivate",
    );
  }
  if (request.headroom.activate) {
    return pending(
      "activation requested with egress consent; re-run with --apply to install the pinned runtime, register the MCP server and verify it",
    );
  }
  if (receipt.state === "valid") {
    return pending(
      `activated (consent recorded ${receipt.receipt.consent.acceptedAt}); run with --apply to verify it`,
    );
  }
  if (receipt.state === "stale" || receipt.state === "invalid") {
    return pending(
      `activation needs attention (${receipt.reason}); re-run with --activate-headroom --accept-headroom-egress --apply or --deactivate-headroom --apply`,
    );
  }
  return pending(
    "selected; not activated. Activation is explicit: pass --activate-headroom --accept-headroom-egress with --apply",
  );
}

function previewTools(
  ctx: PlanContext,
  request: DeveloperToolRequest,
): DeveloperToolLifecycleResult[] {
  const selected = new Set(request.selection.selected);
  return DEFAULT_DEVELOPER_TOOL_IDS.map((id) =>
    id === "headroom"
      ? previewHeadroom(ctx, request)
      : {
          id,
          state: selected.has(id) ? "selected-pending" : "policy-excluded",
          detail: selected.has(id)
            ? "selected for ordinary setup; run with --apply to reconcile and verify"
            : "not selected by the effective developer-tool policy",
          changed: false,
        },
  );
}

function resultPlan(
  selection: ResolvedDefaultToolSelection,
  tools: readonly DeveloperToolLifecycleResult[],
  primaryCodeGraph: PrimaryCodeGraphChoice | undefined,
) {
  const primary =
    primaryCodeGraph === undefined
      ? "primary code graph: none (task-based routing)"
      : `primary code graph: ${primaryCodeGraph.id} (${primaryCodeGraph.source})`;
  return plan(
    "developer-tools",
    digest(
      "Developer tool lifecycle",
      [...tools.map((tool) => `${tool.id}: ${tool.state} — ${tool.detail}`), primary].join("\n"),
      {
        accepted: true,
        selection,
        tools,
        ...(primaryCodeGraph === undefined ? {} : { primaryCodeGraph }),
      },
    ),
  );
}

function withLifecycle(
  result: PlanResult,
  selection: ResolvedDefaultToolSelection,
  tools: DeveloperToolLifecycleResult[],
  primaryCodeGraph: PrimaryCodeGraphChoice | undefined,
  primaryChanged = false,
): DeveloperToolsPlanResult {
  const changed =
    primaryChanged ||
    tools.some((tool) => tool.changed) ||
    result.writes.some((write) => write.effect === "create" || write.effect === "overwrite");
  return {
    ...result,
    capability: "developer-tools",
    accepted: true,
    selection,
    tools,
    changed,
    ...(primaryCodeGraph === undefined ? {} : { primaryCodeGraph }),
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
    // Headroom has its own activation receipt and lifecycle.
    if (id === "headroom") continue;
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

interface HeadroomPhase {
  readonly result: DeveloperToolLifecycleResult;
  /** Removal runs after the MCP projection has removed AIH-owned host entries. */
  readonly remove: boolean;
}

async function reconcileHeadroom(
  ctx: PlanContext,
  request: DeveloperToolRequest,
  deps: DeveloperToolsCommandDeps,
): Promise<HeadroomPhase> {
  const exclusion = headroomExclusion(request.selection, request.policy);
  if (exclusion !== undefined) {
    return {
      result: { id: "headroom", state: "policy-excluded", detail: exclusion, changed: false },
      remove: true,
    };
  }
  if (request.headroom.deactivate) {
    return {
      result: {
        id: "headroom",
        state: "selected-pending",
        detail: "deactivation requested",
        changed: false,
      },
      remove: true,
    };
  }
  const outcome = request.headroom.activate
    ? await activateHeadroom(
        ctx,
        (ctx.targets ?? []).filter((cli) => entry(cli).mcp.support === "native"),
        deps.headroom,
      )
    : await verifyActiveHeadroom(ctx, deps.headroom);
  return { result: { id: "headroom", ...outcome }, remove: false };
}

/** The hosts and exact launcher the activation receipt recorded, when it is readable. */
function recordedHeadroomHosts(ctx: PlanContext) {
  const receipt = readHeadroomReceipt(headroomLayout(ctx));
  if (receipt.state !== "valid" && receipt.state !== "stale") return undefined;
  return { hosts: receipt.receipt.hosts as Cli[], server: receipt.receipt.launcher.server };
}

interface HeadroomRemovalOutcome {
  readonly result: DeveloperToolLifecycleResult;
  /** Writes that removed AIH's unchanged entry from recorded hosts outside this run's targets. */
  readonly retirement?: PlanResult;
}

/**
 * Remove Headroom from every host the activation receipt recorded, not only this
 * run's targets. The runtime and receipt are deleted only when no recorded host
 * still registers Headroom (AIH's unchanged entry, or an edited Codex table AIH
 * will not discard); otherwise the receipt records which hosts and why.
 */
async function finishHeadroomRemoval(
  ctx: PlanContext,
  phase: HeadroomPhase,
): Promise<HeadroomRemovalOutcome> {
  let retirement: PlanResult | undefined;
  try {
    const recorded = recordedHeadroomHosts(ctx);
    if (recorded !== undefined) {
      const actions = recordedRetirementActions(ctx, recorded.hosts, "headroom", recorded.server);
      if (actions.length > 0) {
        retirement = await executePlan(plan("developer-tools", ...actions), ctx);
      }
      const retained = retainedRecordedMcpEntries(ctx, recorded.hosts, "headroom", recorded.server);
      if (retained.length > 0) {
        return {
          result: {
            id: "headroom",
            state: "blocked",
            detail: recordIncompleteHeadroomRemoval(ctx, retained),
            changed: false,
          },
          retirement,
        };
      }
    }
    const removal = removeHeadroomState(ctx);
    if (phase.result.state === "policy-excluded") {
      return {
        result: removal.changed
          ? { ...phase.result, detail: `${phase.result.detail}; ${removal.detail}`, changed: true }
          : phase.result,
        retirement,
      };
    }
    return {
      result: {
        id: "headroom",
        state: "selected-pending",
        detail: removal.changed
          ? `deactivated: ${removal.detail}; AIH-owned MCP entries were removed from every recorded host where unchanged. Selection remains; re-activate with --activate-headroom --accept-headroom-egress`
          : "not activated; no AIH-owned Headroom state was present",
        changed: removal.changed,
      },
      retirement,
    };
  } catch (error) {
    return {
      result: {
        id: "headroom",
        state: "blocked",
        detail: error instanceof Error ? error.message : String(error),
        changed: false,
      },
      retirement,
    };
  }
}

/** Resolve CLI targets once so the activation receipt and the projection agree. */
async function withResolvedTargets(ctx: PlanContext, policy: OrgPolicy | undefined) {
  if (ctx.targets !== undefined) return ctx;
  const resolution = await resolveTargets(ctx, policy);
  return { ...ctx, targets: resolution.clis };
}

export async function developerToolsPlan(ctx: PlanContext) {
  const request = prepareDeveloperToolRequest(ctx);
  return resultPlan(request.selection, previewTools(ctx, request), request.primaryCodeGraph);
}

/**
 * Reconcile every selected default independently. One missing prerequisite is
 * reported for that tool and never prevents the remaining tools from running.
 * Headroom runs only after explicit, consented activation; its host entries are
 * projected after the activation receipt exists and removed before its state.
 */
export async function executeDeveloperToolsCommand(
  ctx: PlanContext,
  deps: DeveloperToolsCommandDeps = {},
): Promise<DeveloperToolsPlanResult> {
  const request = prepareDeveloperToolRequest(ctx);
  const { selection, primaryCodeGraph } = request;
  if (!ctx.apply) {
    const tools = previewTools(ctx, request);
    return withLifecycle(
      await executePlan(resultPlan(selection, tools, primaryCodeGraph), ctx),
      selection,
      tools,
      primaryCodeGraph,
    );
  }

  const runCtx = request.headroom.activate ? await withResolvedTargets(ctx, request.policy) : ctx;
  const tools = await reconcileSelected(runCtx, selection, deps);
  const primaryChanged = recordDeveloperToolPrimaryCodeGraph(
    defaultNativeRuntimeLayout(runCtx),
    primaryCodeGraph,
  );
  const headroom = await reconcileHeadroom(runCtx, request, deps);
  let projected: PlanResult | undefined;
  if (deps.projectMcp !== false) {
    projected = deps.projectMcp
      ? await deps.projectMcp(runCtx)
      : await executePlan(await mcpCommand.plan(runCtx), runCtx);
  }
  const removal = headroom.remove ? await finishHeadroomRemoval(runCtx, headroom) : undefined;
  tools.push(removal?.result ?? headroom.result);
  let result = await executePlan(resultPlan(selection, tools, primaryCodeGraph), runCtx);
  if (projected !== undefined) result = combineProjectResults(result, projected);
  if (removal?.retirement !== undefined) {
    result = combineProjectResults(result, removal.retirement);
  }
  result.report = lifecycleReport(tools);
  return withLifecycle(result, selection, tools, primaryCodeGraph, primaryChanged);
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
    {
      flags: "--activate-headroom",
      description:
        "install, register and verify the selected Headroom MCP server (requires --accept-headroom-egress)",
    },
    {
      flags: "--accept-headroom-egress",
      description:
        "consent to Headroom activation egress: PyPI wheels and two tokenizer vocabularies (see docs/commands.md)",
    },
    {
      flags: "--deactivate-headroom",
      description:
        "remove AIH-owned Headroom MCP entries, runtime state and its activation receipt",
    },
    {
      flags: "--primary-code-graph <id>",
      description:
        "primary code graph: code-review-graph | codebase-memory-mcp (a policy value binds)",
    },
  ],
  plan: developerToolsPlan,
};
