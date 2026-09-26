import {
  doc,
  type FrameworkGovernedSelectionV1,
  type FrameworkPolicyDeliveryHookV1,
  plan,
} from "@aihq/core/framework-host";
import { currentCoreRuntime, withEccInvocation } from "../invocation.js";
import { inspectGovernedCodexRoleRegistration } from "../profile/governed-codex-roles.js";

const HISTORICAL_TARGETS = ["claude", "codex", "kimi", "cursor", "opencode", "kiro"] as const;

/** Read an earlier aih delivery receipt for reporting; no new delivery is offered. */
export function eccPolicyInspection(): FrameworkPolicyDeliveryHookV1 {
  const hook: FrameworkPolicyDeliveryHookV1 = {
    prepare: (ctx) =>
      withEccInvocation(ctx, async () => ({
        result: await currentCoreRuntime().executePlan(
          plan(
            "ECC delivery retired",
            doc("ECC", "Run aih ecc for developer-managed installation guidance."),
          ),
          currentCoreRuntime().planContext,
        ),
      })),
    inspect: (ctx) => ({
      governedTargets: HISTORICAL_TARGETS,
      inspectCodexRoles: (roles) => inspectGovernedCodexRoleRegistration(ctx.root, roles),
      describeSelection: (input): FrameworkGovernedSelectionV1 => {
        const selection = input.policy.governance?.externalSelections?.find(
          (entry) => entry.framework === "ecc",
        );
        const roots = new Set(selection?.roots ?? []);
        const unattributed = new Set(selection?.unattributedItems ?? []);
        return {
          targets: input.targets.filter((target) =>
            HISTORICAL_TARGETS.some((item) => item === target),
          ),
          components: input.components.map((component) => ({
            id: component.id,
            requirement: "required",
            selectionReason: roots.has(component.id)
              ? "selected-root"
              : unattributed.has(component.id)
                ? "legacy-unattributed"
                : Array.isArray(selection?.roots)
                  ? "selected-choice"
                  : "legacy-unattributed",
            retainedBy: [],
            source: { ...component.provenance },
            owner: "aih-materialization",
            ownership: component.ownership,
            destinations: component.files.map((file) => ({
              path: file.path,
              discovery: /(^|\/)skills\/[^/]+\//.test(file.path)
                ? file.path.endsWith("/SKILL.md")
                  ? ("project-skill-entry" as const)
                  : ("projected-supporting-content" as const)
                : ("projected-content" as const),
            })),
          })),
          authoringExclusions:
            input.policy.schemaVersion === 3
              ? input.policy.authoringSelections.exclusions.map((entry) => ({ ...entry }))
              : [],
          unavailable: [],
          refused: [],
          dependencyAuthority: "unverified",
          otherOwners: [
            {
              owner: "native-plugin",
              scope: "user-or-account",
              state: "unverified",
              detail:
                "Project materialization does not enumerate, filter, or remove account-owned native plugin content.",
            },
            {
              owner: "legacy-or-user-content",
              scope: "project",
              state: "preserved-unless-receipt-owned",
              detail:
                "Same-named or legacy project content remains outside subtraction unless an unchanged AIH receipt proves ownership.",
            },
          ],
        };
      },
    }),
  };
  return Object.freeze(hook);
}
