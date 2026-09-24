import { readAihConfig, readPolicyBinding } from "../config/marker.js";
import { inspectDestination, materializationRoot } from "../ecc/materialization-fs.js";
import {
  type EccOwnedFile,
  ownedFileSha256,
  readEccMaterializationReceipt,
} from "../ecc/materialization-receipt.js";
import {
  describeEccEffectiveDiscovery,
  type EccEffectiveDiscoveryReport,
  type EccMaterializationTarget,
  GOVERNED_MATERIALIZATION_TARGETS,
  type GovernedCodexRoleRegistrationInspection,
  inspectGovernedCodexRoleRegistration,
  ownedFragmentDigest,
  parseJsonObject,
} from "../framework-plugin/ecc-facade.js";
import type { Cli } from "../internals/clis.js";
import type { PlanContext } from "../internals/plan.js";
import { applyPolicyBindingDefaults, assertPolicyBindingCurrent } from "./binding.js";
import {
  type CommandPermissionInspection,
  hasCommandPermissionOwnership,
  inspectCommandPermissions,
} from "./command-permissions.js";
import {
  expectedPolicyRequiredGuidance,
  hasRequiredGuidanceComponents,
  inspectPolicyRequiredGuidance,
  type PolicyRequiredGuidanceInspection,
} from "./required-guidance.js";
import { resolveRuntimeOrgPolicy } from "./runtime.js";
import { governanceOwnsAihSurfaces, type OrgPolicy, readOrgPolicy } from "./schema.js";

export interface PolicyDeliveryComponent {
  id: string;
  source: { repository: string; commit: string; path: string };
  state: "missing-receipt" | "source-mismatch" | "drifted" | "receipt-current";
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
  codexRoles?: GovernedCodexRoleRegistrationInspection;
  selection?: EccEffectiveDiscoveryReport;
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

function inspectFile(root: string, file: EccOwnedFile): PolicyDeliveryComponent["files"][number] {
  const live = inspectDestination(root, file.path);
  if (live.state === "absent") return { path: file.path, state: "missing" };
  if (live.state === "unreadable") return { path: file.path, state: "unreadable" };
  const document =
    file.operation === "merge-json" ? parseJsonObject(live.bytes.toString("utf8")) : undefined;
  const digest =
    file.operation === "copy-file"
      ? ownedFileSha256(live.bytes)
      : document === undefined
        ? undefined
        : ownedFragmentDigest(document, file.ownedKeys);
  return { path: file.path, state: digest === file.contentSha256 ? "current" : "drifted" };
}

/** Shared source/receipt comparison; the caller supplies the already-resolved policy blocker. */
export function summarizePolicyDelivery(
  root: string,
  targets: readonly string[],
  policy: OrgPolicy | undefined,
  policyBlocked: boolean,
  env: NodeJS.ProcessEnv = {},
  contextDir = "ai-coding",
): PolicyDeliveryReport {
  const binding = inspectBinding(root, targets, env);
  const governance = policy && governanceOwnsAihSurfaces(policy) ? policy.governance : undefined;
  const requested =
    governance?.externalSelections.find((selection) => selection.framework === "ecc")?.items ?? [];
  const receipt = readEccMaterializationReceipt(root);
  const owned = receipt.state === "valid" ? receipt.receipt.components : [];
  const rootReal = owned.length > 0 ? materializationRoot(root) : root;
  const components = requested
    .map<PolicyDeliveryComponent>((item) => {
      const component = owned.find((candidate) => candidate.id === item.id);
      const files = component?.files.map((file) => inspectFile(rootReal, file)) ?? [];
      const recordedTargets = component?.targets ?? [];
      const missingTargets = targets
        .filter((target) => !recordedTargets.includes(target as Cli))
        .sort();
      const unselectedTargets = recordedTargets
        .filter((target) => !targets.includes(target))
        .sort();
      const targetCoverage: NonNullable<PolicyDeliveryComponent["targetCoverage"]> = {
        state:
          component?.targets === undefined
            ? "unverified"
            : missingTargets.length || unselectedTargets.length
              ? "mismatch"
              : "matches",
        recordedTargets,
        missingTargets: component?.targets === undefined ? [] : missingTargets,
        unselectedTargets,
      };
      const state =
        component === undefined
          ? "missing-receipt"
          : component.provenance.repository !== item.source.repository ||
              component.provenance.commit !== item.source.commit ||
              component.provenance.componentPath !== item.source.path
            ? "source-mismatch"
            : files.some((file) => file.state !== "current")
              ? "drifted"
              : "receipt-current";
      return {
        id: item.id,
        source: item.source,
        state,
        files,
        nativeLoading: "unverified",
        practiceEffect: item.kind === "skill" ? "guidance" : "component-specific",
        authorization: component ? "recorded-unverified" : "not-recorded",
        targetCoverage,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unsupportedTargets =
    requested.length === 0
      ? []
      : targets
          .filter(
            (target) => !(GOVERNED_MATERIALIZATION_TARGETS as readonly string[]).includes(target),
          )
          .sort();
  const selectedIds = new Set(requested.map((item) => item.id));
  const unrequestedOwnedComponents = owned
    .filter((item) => !selectedIds.has(item.id))
    .map((item) => item.id)
    .sort();
  const selectedSource = requested[0]?.source;
  const expectedGuidance =
    selectedSource && governance?.policyVersion
      ? expectedPolicyRequiredGuidance(
          contextDir,
          owned.filter((item) => selectedIds.has(item.id)),
          {
            policyVersion: governance.policyVersion,
            source: { repository: selectedSource.repository, commit: selectedSource.commit },
            targets: targets as Cli[],
          },
        )
      : undefined;
  const startupGuidance = inspectPolicyRequiredGuidance(root, contextDir, expectedGuidance);
  const needsGuidance = hasRequiredGuidanceComponents(
    owned.filter((item) => selectedIds.has(item.id)),
  );
  const commandPermissions = inspectCommandPermissions(root, policy, targets);
  const codexRoles = targets.includes("codex")
    ? inspectGovernedCodexRoleRegistration(
        root,
        components
          .filter((component) => component.state === "receipt-current")
          .flatMap((component) =>
            component.files.flatMap((file) => {
              const id = /^\.codex\/agents\/([a-z0-9][a-z0-9_-]*)\.toml$/.exec(file.path)?.[1];
              return id ? [{ id, configFile: file.path }] : [];
            }),
          ),
      )
    : undefined;
  const blocking =
    policyBlocked ||
    binding.state === "blocked" ||
    receipt.state === "malformed" ||
    unsupportedTargets.length > 0 ||
    components.some((component) => component.state !== "receipt-current") ||
    components.some((component) => component.targetCoverage?.state === "mismatch") ||
    (needsGuidance && startupGuidance.state !== "current") ||
    (!needsGuidance && startupGuidance.state !== "absent") ||
    !["not-requested", "current"].includes(commandPermissions.state) ||
    (codexRoles !== undefined && codexRoles.state !== "current") ||
    unrequestedOwnedComponents.length > 0;
  return {
    ...(governance?.policyVersion === undefined ? {} : { policyVersion: governance.policyVersion }),
    blocking,
    policyBlocked,
    binding,
    startupGuidance,
    commandPermissions,
    ...(codexRoles === undefined ? {} : { codexRoles }),
    targets: [...targets].sort(),
    unsupportedTargets,
    receipt: receipt.state,
    components,
    ...(policy && governance?.externalSelections.some((item) => item.framework === "ecc")
      ? {
          selection: describeEccEffectiveDiscovery({
            policy,
            targets: targets.filter((target): target is EccMaterializationTarget =>
              (GOVERNED_MATERIALIZATION_TARGETS as readonly string[]).includes(target),
            ),
            components: components.map((component) => ({
              id: component.id,
              provenance: {
                repository: component.source.repository,
                commit: component.source.commit,
                componentPath: component.source.path,
              },
              ownership:
                component.state === "missing-receipt" || component.state === "source-mismatch"
                  ? component.state
                  : "receipt-recorded",
              files:
                component.state === "missing-receipt" || component.state === "source-mismatch"
                  ? []
                  : component.files,
            })),
          }),
        }
      : {}),
    excludedOptionalAssets:
      policy?.schemaVersion === 3
        ? [...new Set(policy.authoringSelections.exclusions.map((item) => item.assetId))].sort()
        : [],
    unrequestedOwnedComponents,
    nativeLoading:
      components.length > 0 || commandPermissions.state !== "not-requested"
        ? "unverified"
        : "not-requested",
    detail:
      "Receipt-current means the recorded component source and owned bytes match. Receipt authorization is recorded, not freshly reverified by this read-only comparison. It does not establish target startup, native loading, or practice enforcement. Required selections come only from the selected policy; exclusions affect optional content.",
    nextStep: "aih policy evaluate --json",
  };
}

/** Fresh read for each readiness computation; no cached canary can clear a policy blocker. */
export async function inspectPolicyDelivery(
  ctx: PlanContext,
): Promise<PolicyDeliveryReport | undefined> {
  try {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    const receipt = readEccMaterializationReceipt(ctx.root);
    const contextDir = readAihConfig(ctx.root)?.contextDir ?? ctx.contextDir;
    const guidance = inspectPolicyRequiredGuidance(ctx.root, contextDir);
    if (
      !policy &&
      receipt.state === "absent" &&
      guidance.state === "absent" &&
      !readPolicyBinding(ctx.root) &&
      !hasCommandPermissionOwnership(ctx.root)
    )
      return undefined;
    const effective = policy ? (await resolveRuntimeOrgPolicy(ctx, policy)).effective : undefined;
    return summarizePolicyDelivery(
      ctx.root,
      ctx.targets ?? ["claude"],
      policy,
      effective?.blocking ?? false,
      ctx.env,
      contextDir,
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
        "Policy delivery could not be verified. Inspect the selected policy, project binding and ownership receipts before applying changes.",
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
    ...(report.codexRoles
      ? [
          `  Codex role registration: ${report.codexRoles.state}; expected roles=${report.codexRoles.expectedRoleIds.join(", ") || "none"}; native loading=unverified${report.codexRoles.detail ? `; ${report.codexRoles.detail}` : ""}`,
        ]
      : []),
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
