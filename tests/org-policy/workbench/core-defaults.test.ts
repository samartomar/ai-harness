import { describe, expect, it } from "vitest";
import {
  defaultStudioPolicy,
  exportStudioPolicy,
  parseStudioPolicyImport,
  policyStudioModel,
} from "../../../src/org-policy/studio-model.js";
import { projectWorkbenchPolicy } from "../../../src/org-policy/workbench/compile-policy.js";
import { importWorkbenchPolicySelections } from "../../../src/org-policy/workbench/policy-import.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";

const defaultAssetIds = [
  "aih/package:skill-pack/docs-quality",
  "aih/package:skill-pack/governance-quality",
  "aih/package:skill-pack/review-quality",
  "aih/sequential-thinking",
  "aih/usage-metering",
] as const;

const defaultCapabilityRoots = [
  "package:skill-pack/docs-quality",
  "package:skill-pack/governance-quality",
  "package:skill-pack/review-quality",
] as const;

const defaultControlIds = ["sequential-thinking", "usage-metering"] as const;

function emptyPolicy() {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "1",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      externalCuration: [],
      externalSelections: [],
    },
  };
}

describe("Core Workbench defaults", () => {
  it("projects the five shipped Core defaults through canonical Workbench state", () => {
    const model = policyStudioModel();
    const policy = defaultStudioPolicy();
    const governance = policy.governance;

    expect(model.initialPolicy).toEqual(policy);
    expect(policy.schemaVersion).toBe(3);
    expect(policy.capabilityPackages?.roots).toEqual(defaultCapabilityRoots);
    expect(governance?.catalog.reviewed.map((candidate) => candidate.id)).toEqual(
      defaultControlIds,
    );
    expect(governance?.activations.map((activation) => activation.candidate)).toEqual(
      defaultControlIds,
    );
    expect(governance?.authority.approvals).toEqual([]);
    if (policy.schemaVersion !== 3) throw new Error("expected a Workbench policy");
    expect(policy.authoringSelections.roots.map((root) => root.assetId).sort()).toEqual(
      defaultAssetIds,
    );
  });

  it("preserves an explicitly imported policy and its exclusion without merging defaults", () => {
    const model = policyStudioModel();
    const excluded = defaultAssetIds[0];
    const reduction = reduceWorkbenchAction(model.workbenchBundle, createWorkbenchState(), {
      type: "add-exclusion",
      assetId: excluded,
      origin: { kind: "administrator" },
    });
    expect(reduction.accepted).toBe(true);
    const authored = projectWorkbenchPolicy(
      emptyPolicy(),
      reduction.state,
      model.workbenchBundle,
      model.workbenchBindings,
      "author",
      model.workbenchSourceInputs,
    );
    expect(authored.accepted, authored.diagnostics.join("; ")).toBe(true);
    const imported = parseStudioPolicyImport(exportStudioPolicy(authored.policy));

    const reopened = policyStudioModel(undefined, undefined, { initialPolicy: imported });
    expect(reopened.initialPolicy).toEqual(imported);
    expect(reopened.initialPolicy.capabilityPackages).toBeUndefined();
    if (reopened.initialPolicy.schemaVersion !== 3)
      throw new Error("expected the imported Workbench policy");
    expect(reopened.initialPolicy.authoringSelections.roots).toEqual([]);
    expect(reopened.initialPolicy.authoringSelections.exclusions).toMatchObject([
      { assetId: excluded, origin: { kind: "administrator" } },
    ]);
  });

  it("round trips the default through canonical import and consume projection", () => {
    const model = policyStudioModel();
    const imported = importWorkbenchPolicySelections(
      model.initialPolicy,
      model.workbenchBundle,
      model.workbenchBindings,
      model.workbenchSourceInputs,
    );
    expect(imported).toMatchObject({ accepted: true, diagnostics: [] });

    const roundTripped = projectWorkbenchPolicy(
      model.initialPolicy,
      imported.state,
      model.workbenchBundle,
      model.workbenchBindings,
      "consume",
      model.workbenchSourceInputs,
    );
    expect(roundTripped).toEqual({
      accepted: true,
      diagnostics: [],
      policy: model.initialPolicy,
    });
  });
});
