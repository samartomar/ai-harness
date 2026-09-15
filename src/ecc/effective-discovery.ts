import type { OrgPolicy } from "../org-policy/schema.js";
import type { EccSelectionExclusion } from "./materialization-selection.js";
import type { EccMaterializationTarget, EccTargetedRefusal } from "./materialization-target.js";
import type { EccStructuralRelationView } from "./selection-closure.js";
import { eccMandatoryRequirementIds } from "./selection-closure.js";

export type EccSelectionReason =
  | "selected-root"
  | "selected-choice"
  | "required-dependency"
  | "legacy-unattributed";

export type EccDiscoveryOwnershipState =
  | "planned"
  | "receipt-recorded"
  | "missing-receipt"
  | "source-mismatch";

export interface EccDiscoveryComponentInput {
  id: string;
  provenance: { repository: string; commit: string; componentPath: string };
  files: readonly { path: string }[];
  ownership: EccDiscoveryOwnershipState;
}

export interface EccEffectiveDiscoveryComponent {
  id: string;
  requirement: "required";
  selectionReason: EccSelectionReason;
  retainedBy: readonly string[];
  source: { repository: string; commit: string; componentPath: string };
  owner: "aih-materialization";
  ownership: EccDiscoveryOwnershipState;
  destinations: readonly {
    path: string;
    discovery: "project-skill-entry" | "projected-supporting-content" | "projected-content";
  }[];
}

export interface EccEffectiveDiscoveryReport {
  targets: readonly EccMaterializationTarget[];
  components: readonly EccEffectiveDiscoveryComponent[];
  authoringExclusions: readonly {
    assetId: string;
    sourceId: string;
    sourceRevisionId: string;
    contentDigest: string;
  }[];
  unavailable: readonly EccSelectionExclusion[];
  refused: readonly EccTargetedRefusal[];
  otherOwners: readonly {
    owner: "native-plugin" | "legacy-or-user-content";
    scope: "user-or-account" | "project";
    state: "unverified" | "preserved-unless-receipt-owned";
    detail: string;
  }[];
  dependencyAuthority: "qualified-source-relations" | "unverified";
}

export interface EccEffectiveDiscoveryInput {
  policy: OrgPolicy;
  targets: readonly EccMaterializationTarget[];
  components: readonly EccDiscoveryComponentInput[];
  unavailable?: readonly EccSelectionExclusion[];
  refused?: readonly EccTargetedRefusal[];
  relations?: EccStructuralRelationView;
}

function requiredClosure(
  roots: ReadonlySet<string>,
  relations: EccStructuralRelationView,
): Map<string, Set<string>> {
  const retainedBy = new Map<string, Set<string>>();
  for (const root of roots) {
    const pending = [root];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      if (current !== root) {
        const owners = retainedBy.get(current) ?? new Set<string>();
        owners.add(root);
        retainedBy.set(current, owners);
      }
      pending.push(...eccMandatoryRequirementIds(current, relations));
    }
  }
  return retainedBy;
}

function discoveryKind(
  path: string,
): EccEffectiveDiscoveryComponent["destinations"][number]["discovery"] {
  if (!/(^|\/)skills\/[^/]+\//.test(path)) return "projected-content";
  return path.endsWith("/SKILL.md") ? "project-skill-entry" : "projected-supporting-content";
}

/**
 * Join the policy's exact selection intent to the target adapter's exact file
 * plan without performing installation or inferring ownership by display name.
 * The result is shared by dry-run output and read-only report surfaces.
 */
export function describeEccEffectiveDiscovery(
  input: EccEffectiveDiscoveryInput,
): EccEffectiveDiscoveryReport {
  const selection = input.policy.governance?.externalSelections?.find(
    (candidate) => candidate.framework === "ecc",
  );
  const hasExplicitRoots = Array.isArray(selection?.roots);
  const roots = new Set(selection?.roots ?? []);
  const unattributed = new Set(selection?.unattributedItems ?? []);
  const dependencies =
    input.relations === undefined
      ? new Map<string, Set<string>>()
      : requiredClosure(roots, input.relations);

  return {
    targets: [...input.targets],
    components: input.components.map((component) => {
      const retainedBy = [...(dependencies.get(component.id) ?? [])].sort();
      const selectionReason: EccSelectionReason = roots.has(component.id)
        ? "selected-root"
        : retainedBy.length > 0
          ? "required-dependency"
          : unattributed.has(component.id)
            ? "legacy-unattributed"
            : hasExplicitRoots
              ? "selected-choice"
              : "legacy-unattributed";
      return {
        id: component.id,
        requirement: "required",
        selectionReason,
        retainedBy,
        source: { ...component.provenance },
        owner: "aih-materialization",
        ownership: component.ownership,
        destinations: component.files.map((file) => ({
          path: file.path,
          discovery: discoveryKind(file.path),
        })),
      };
    }),
    authoringExclusions:
      input.policy.schemaVersion === 3
        ? input.policy.authoringSelections.exclusions.map((exclusion) => ({
            assetId: exclusion.assetId,
            sourceId: exclusion.sourceId,
            sourceRevisionId: exclusion.sourceRevisionId,
            contentDigest: exclusion.contentDigest,
          }))
        : [],
    unavailable: [...(input.unavailable ?? [])],
    refused: [...(input.refused ?? [])],
    dependencyAuthority:
      input.relations === undefined ? "unverified" : "qualified-source-relations",
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
}
