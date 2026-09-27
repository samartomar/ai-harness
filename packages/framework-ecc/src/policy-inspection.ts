import { doc, type FrameworkPolicyDeliveryHookV1, plan } from "@aihq/core/framework-host";
import { currentCoreRuntime, withEccInvocation } from "./invocation.js";

const GOVERNED_TARGETS = ["claude", "codex", "kimi", "cursor", "opencode", "kiro"] as const;

/** Read-only Catalog policy selection and developer-managed delivery guidance. */
const hook: FrameworkPolicyDeliveryHookV1 = {
  prepare: (ctx) =>
    withEccInvocation(ctx, async () => ({
      result: await currentCoreRuntime().executePlan(
        plan("ECC guidance", doc("ECC", "Run aih ecc for the exact ECC commands.")),
        currentCoreRuntime().planContext,
      ),
    })),
  inspect: () => ({
    governedTargets: GOVERNED_TARGETS,
    describeSelection: (input) => {
      const selection = input.policy.governance?.externalSelections?.find(
        (entry) => entry.framework === "ecc",
      );
      const roots = new Set(selection?.roots ?? []);
      return {
        targets: input.targets.filter((target) => GOVERNED_TARGETS.some((item) => item === target)),
        components: input.components.map((component) => ({
          id: component.id,
          requirement: "required" as const,
          selectionReason: roots.has(component.id)
            ? ("selected-root" as const)
            : ("selected-choice" as const),
          retainedBy: [],
          source: { ...component.provenance },
          owner: "developer-managed" as const,
          ownership: "planned" as const,
          destinations: [],
        })),
        authoringExclusions:
          input.policy.schemaVersion === 3
            ? input.policy.authoringSelections.exclusions.map((entry) => ({ ...entry }))
            : [],
        unavailable: [],
        refused: [],
        dependencyAuthority: "unverified" as const,
        otherOwners: [],
      };
    },
  }),
};

export const policyDelivery = Object.freeze(hook);
