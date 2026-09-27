import { readAihConfig, readPolicyBinding } from "../config/marker.js";
import type {
  FrameworkGovernedSelectionV1,
  FrameworkPolicyDeliveryInspectorV1,
} from "../framework-plugin/contract-v1.js";
import {
  type EccReadOutcomeV1,
  eccPolicyDeliveryInspectorV1,
} from "../framework-plugin/ecc-read.js";
import type { Cli } from "../internals/clis.js";
import type { PlanContext } from "../internals/plan.js";
import { applyPolicyBindingDefaults, assertPolicyBindingCurrent } from "./binding.js";
import {
  type CommandPermissionInspection,
  hasCommandPermissionOwnership,
  inspectCommandPermissions,
} from "./command-permissions.js";
import {
  inspectPolicyRequiredGuidance,
  type PolicyRequiredGuidanceInspection,
} from "./required-guidance.js";
import { resolveRuntimeOrgPolicy } from "./runtime.js";
import { governanceOwnsAihSurfaces, type OrgPolicy, readOrgPolicy } from "./schema.js";

export interface PolicyDeliveryComponent {
  id: string;
  source: { repository: string; commit: string; path: string };
  state: "developer-managed";
  files: Array<{ path: string; state: "current" | "missing" | "drifted" | "unreadable" }>;
  nativeLoading: "unverified";
  practiceEffect: "guidance" | "component-specific";
  authorization?: "recorded-unverified" | "not-recorded";
  targetCoverage?: {
    state: "matches" | "mismatch" | "unverified";
    recordedTargets: string[];
    missingTargets: string[];
    unselectedTargets: string[];
  };
}

/** Owned bytes are evidence of installation only, never of native loading or enforcement. */
export interface PolicyDeliveryReport {
  policyVersion?: string;
  blocking: boolean;
  policyBlocked: boolean;
  targets: string[];
  unsupportedTargets: string[];
  receipt: "absent" | "malformed" | "valid" | "unverified";
  components: PolicyDeliveryComponent[];
  excludedOptionalAssets: string[];
  unrequestedOwnedComponents: string[];
  nativeLoading: "unverified" | "not-requested";
  detail: string;
  nextStep: string;
  binding?: { state: "unbound" | "current" | "blocked"; projectId?: string; detail: string };
  startupGuidance?: Pick<PolicyRequiredGuidanceInspection, "state" | "path" | "detail">;
  commandPermissions?: CommandPermissionInspection;
  selection?: FrameworkGovernedSelectionV1;
  /** Present when the delivery needed ECC's knowledge and the ECC plugin could not supply it. */
  eccChecks?: { state: "not-run"; detail: string };
}

/** ECC's inspector for one report, or why it is unavailable; `undefined` means it was not consulted. */
export type PolicyDeliveryEccV1 = EccReadOutcomeV1<FrameworkPolicyDeliveryInspectorV1>;

function hasEccSelection(policy: OrgPolicy | undefined): boolean {
  return (
    policy !== undefined &&
    governanceOwnsAihSurfaces(policy) &&
    policy.governance.externalSelections.some((selection) => selection.framework === "ecc")
  );
}

/**
 * Whether the delivery report needs ECC's knowledge: the policy selects ECC
 * content from the current Catalog.
 */
export function policyDeliveryConsultsEcc(
  _root: string,
  _targets: readonly string[],
  policy: OrgPolicy | undefined,
): boolean {
  return hasEccSelection(policy);
}

/** Load ECC's inspector through the plugin when the report needs it. */
export async function loadPolicyDeliveryEccV1(
  ctx: PlanContext,
  targets: readonly string[],
  policy: OrgPolicy | undefined,
): Promise<PolicyDeliveryEccV1 | undefined> {
  if (!policyDeliveryConsultsEcc(ctx.root, targets, policy)) return undefined;
  return eccPolicyDeliveryInspectorV1(ctx);
}

function inspectBinding(
  root: string,
  targets: readonly string[],
  env: NodeJS.ProcessEnv,
): NonNullable<PolicyDeliveryReport["binding"]> {
  try {
    const binding = readPolicyBinding(root);
    if (!binding)
      return {
        state: "unbound",
        detail: "No durable project assignment is recorded; this invocation selects the policy.",
      };
    assertPolicyBindingCurrent(
      root,
      applyPolicyBindingDefaults(root, env, {}).env,
      targets as Cli[],
    );
    return {
      state: "current",
      projectId: binding.projectId,
      detail:
        "Canonical root, exact policy bytes and selected targets match the durable assignment.",
    };
  } catch {
    return {
      state: "blocked",
      detail:
        "Project binding is revoked, missing its source, altered, copied or conflicts with the selected targets. Review the assignment and use policy rebind for the same project.",
    };
  }
}

/** Shared source/receipt comparison; the caller supplies the already-resolved policy blocker. */
export function summarizePolicyDelivery(
  root: string,
  targets: readonly string[],
  policy: OrgPolicy | undefined,
  policyBlocked: boolean,
  env: NodeJS.ProcessEnv = {},
  contextDir = "ai-coding",
  ecc?: PolicyDeliveryEccV1,
): PolicyDeliveryReport {
  const binding = inspectBinding(root, targets, env);
  const eccRead: PolicyDeliveryEccV1 | undefined = policyDeliveryConsultsEcc(root, targets, policy)
    ? (ecc ?? { state: "not-run", detail: "the ECC plugin was not consulted", broken: false })
    : undefined;
  const inspector = eccRead?.state === "ran" ? eccRead.value : undefined;
  const eccNotRun = eccRead?.state === "not-run" ? eccRead.detail : undefined;
  const governance = policy && governanceOwnsAihSurfaces(policy) ? policy.governance : undefined;
  const requested =
    governance?.externalSelections.find((selection) => selection.framework === "ecc")?.items ?? [];
  const components = requested
    .map<PolicyDeliveryComponent>((item) => {
      return {
        id: item.id,
        source: item.source,
        state: "developer-managed",
        files: [],
        nativeLoading: "unverified",
        practiceEffect: item.kind === "skill" ? "guidance" : "component-specific",
        authorization: "not-recorded",
        targetCoverage: {
          state: "unverified",
          recordedTargets: [],
          missingTargets: [],
          unselectedTargets: [],
        },
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const governedTargets: readonly string[] = inspector?.governedTargets ?? [];
  const unsupportedTargets =
    requested.length === 0 || inspector === undefined
      ? []
      : targets.filter((target) => !governedTargets.includes(target)).sort();
  const startupGuidance = inspectPolicyRequiredGuidance(root, contextDir);
  const commandPermissions = inspectCommandPermissions(root, policy, targets);
  const blocking =
    policyBlocked ||
    binding.state === "blocked" ||
    !["not-requested", "current"].includes(commandPermissions.state);
  return {
    ...(governance?.policyVersion === undefined ? {} : { policyVersion: governance.policyVersion }),
    blocking,
    policyBlocked,
    binding,
    startupGuidance,
    commandPermissions,
    ...(eccNotRun === undefined
      ? {}
      : { eccChecks: { state: "not-run" as const, detail: eccNotRun } }),
    targets: [...targets].sort(),
    unsupportedTargets,
    receipt: "absent",
    components,
    ...(policy && inspector && hasEccSelection(policy)
      ? {
          selection: inspector.describeSelection({
            policy,
            targets: targets as Cli[],
            components: components.map((component) => ({
              id: component.id,
              provenance: {
                repository: component.source.repository,
                commit: component.source.commit,
                componentPath: component.source.path,
              },
              ownership: "planned",
              files: [],
            })),
          }),
        }
      : {}),
    excludedOptionalAssets:
      policy?.schemaVersion === 3
        ? [...new Set(policy.authoringSelections.exclusions.map((item) => item.assetId))].sort()
        : [],
    unrequestedOwnedComponents: [],
    nativeLoading:
      components.length > 0 || commandPermissions.state !== "not-requested"
        ? "unverified"
        : "not-requested",
    detail:
      "ECC Catalog selections are developer-managed. aih does not install or verify ECC files.",
    nextStep: "run aih ecc for the exact ECC commands",
  };
}

/** Fresh read for each readiness computation; no cached canary can clear a policy blocker. */
export async function inspectPolicyDelivery(
  ctx: PlanContext,
): Promise<PolicyDeliveryReport | undefined> {
  try {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    const contextDir = readAihConfig(ctx.root)?.contextDir ?? ctx.contextDir;
    const guidance = inspectPolicyRequiredGuidance(ctx.root, contextDir);
    if (
      !policy &&
      guidance.state === "absent" &&
      !readPolicyBinding(ctx.root) &&
      !hasCommandPermissionOwnership(ctx.root)
    )
      return undefined;
    const effective = policy ? (await resolveRuntimeOrgPolicy(ctx, policy)).effective : undefined;
    const targets = ctx.targets ?? ["claude"];
    return summarizePolicyDelivery(
      ctx.root,
      targets,
      policy,
      effective?.blocking ?? false,
      ctx.env,
      contextDir,
      await loadPolicyDeliveryEccV1(ctx, targets, policy),
    );
  } catch {
    return {
      blocking: true,
      policyBlocked: true,
      targets: [...(ctx.targets ?? ["claude"])],
      unsupportedTargets: [],
      receipt: "unverified",
      components: [],
      excludedOptionalAssets: [],
      unrequestedOwnedComponents: [],
      nativeLoading: "unverified",
      detail:
        "Policy delivery could not be verified. Inspect the selected policy and project binding before applying changes.",
      nextStep: "aih policy evaluate --json",
    };
  }
}

export function renderPolicyDelivery(report: PolicyDeliveryReport): string {
  return [
    `Policy delivery: ${report.blocking ? "blocked" : "no delivery blocker observed"}; policy=${report.policyVersion ?? "unspecified"}; receipt=${report.receipt}; native loading=${report.nativeLoading}`,
    report.detail,
    ...(report.startupGuidance
      ? [
          `  Startup guidance: ${report.startupGuidance.state}; ${report.startupGuidance.path}${report.startupGuidance.detail ? `; ${report.startupGuidance.detail}` : ""}`,
        ]
      : []),
    ...(report.commandPermissions
      ? [
          `  Command permissions: ${report.commandPermissions.state}; native enforcement=${report.commandPermissions.nativeEnforcement}; advisory targets=${report.commandPermissions.advisoryTargets.join(", ") || "none"}. ${report.commandPermissions.detail}`,
        ]
      : []),
    ...(report.binding
      ? [
          `  Project binding: ${report.binding.state}${report.binding.projectId ? ` (${report.binding.projectId})` : ""}. ${report.binding.detail}`,
        ]
      : []),
    ...(report.eccChecks ? [`  ECC checks were not run: ${report.eccChecks.detail}`] : []),
    ...report.components.map(
      (component) =>
        `  ${component.id}@${component.source.commit}: ${component.state}; target coverage=${component.targetCoverage?.state ?? "unverified"}; recorded targets=${component.targetCoverage?.recordedTargets.join(", ") || "unverified"}; native loading=${component.nativeLoading}; effect=${component.practiceEffect}`,
    ),
    ...(report.selection
      ? [
          `  Governed ECC selection; dependency provenance=${report.selection.dependencyAuthority}; native discovery and complete loading remain unverified.`,
          ...report.selection.components.map(
            (component) =>
              `  ${component.id}: ${component.requirement}/${component.selectionReason}; owner=${component.owner}/${component.ownership}; source=${component.source.repository}@${component.source.commit}:${component.source.componentPath}; destinations=${component.destinations.map((destination) => `${destination.path} (${destination.discovery})`).join(", ") || "none observed"}`,
          ),
          ...report.selection.otherOwners.map(
            (owner) => `  Other owner ${owner.owner}: ${owner.state}. ${owner.detail}`,
          ),
        ]
      : []),
    `  Optional exclusions: ${report.excludedOptionalAssets.join(", ") || "none"}`,
    `  Unrequested owned components requiring reconciliation: ${report.unrequestedOwnedComponents.join(", ") || "none"}`,
    `  Unsupported ECC targets: ${report.unsupportedTargets.join(", ") || "none"}`,
    `  Next: ${report.nextStep}`,
  ].join("\n");
}
