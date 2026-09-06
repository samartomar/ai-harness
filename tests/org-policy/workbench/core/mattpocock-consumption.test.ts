import { describe, expect, it } from "vitest";
import { resolveEffectiveOrgPolicy } from "../../../../src/org-policy/effective.js";
import type { OrgPolicy } from "../../../../src/org-policy/schema.js";
import type { WorkbenchStateV1 } from "../../../../src/org-policy/workbench/contracts.js";
import { compilePolicy } from "../../../../src/org-policy/workbench/policy-compiler.js";
import { consumeWorkbenchPolicy } from "../../../../src/org-policy/workbench/policy-consumption.js";
import { importWorkbenchPolicySelections } from "../../../../src/org-policy/workbench/policy-import.js";
import { defaultPreparedWorkbenchCatalog } from "../../../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../../src/org-policy/workbench/selection-engine.js";

const assetId = "mattpocock/skill:tdd";
function authoredMattSelection() {
  const prepared = defaultPreparedWorkbenchCatalog();
  const asset = prepared.bundle.assets[assetId];
  if (asset === undefined) throw new Error("Missing packaged Matt TDD skill");
  const state = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
    type: "select-root",
    assetId,
    origin: { kind: "administrator" },
  }).state;
  const authored = compilePolicy(
    { schemaVersion: 2, minimumPosture: "vibe", references: { repoContract: "repo" } },
    state,
    prepared.bundle,
    prepared.bindings,
    "author",
    prepared.sourceInputs,
  );
  expect(authored.accepted).toBe(true);
  return { prepared, asset, state, policy: authored.policy };
}

describe("packaged Matt skill intent", () => {
  it("round-trips exact pins into Core requested intent without execution authority", () => {
    const { prepared, asset, state, policy } = authoredMattSelection();
    const transported = JSON.parse(JSON.stringify(policy));
    const imported = importWorkbenchPolicySelections(
      transported,
      prepared.bundle,
      prepared.bindings,
    );
    expect(imported.accepted).toBe(true);
    expect(imported.state).toEqual(state);
    expect(transported.authoringSelections.roots).toEqual([
      expect.objectContaining({
        assetId,
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
      }),
    ]);
    expect(transported.authoringSources).toBeUndefined();
    const consumed = consumeWorkbenchPolicy(transported, createWorkbenchState());
    expect(consumed).toMatchObject({
      accepted: true,
      policy: transported,
      requestedIntent: [assetId],
      selectedControls: [],
      diagnostics: [],
    });
    const effective = resolveEffectiveOrgPolicy(transported as OrgPolicy);
    expect(effective.authoringIntent).toEqual({ requestedIntent: [assetId], selectedControls: [] });
    expect(effective.candidates).toEqual([]);
    expect(effective.activeMcpServerIds).toEqual([]);
    expect(effective.externalSelections).toEqual([]);
    expect(transported.governance.authority.approvals).toEqual([]);
    expect(transported.governance.activations).toEqual([]);
  });

  it.each(["sourceRevisionId", "contentDigest"] as const)(
    "refuses a changed %s before consuming saved Matt intent",
    (field) => {
      const { policy } = authoredMattSelection();
      const tampered = structuredClone(policy);
      const selected = tampered.authoringSelections as WorkbenchStateV1;
      const root = selected.roots[0];
      if (root === undefined) throw new Error("Missing saved Matt root");
      root[field] = field === "sourceRevisionId" ? "0".repeat(40) : `sha256:${"0".repeat(64)}`;
      for (const pin of root.resolvedItems) if (pin.assetId === assetId) pin[field] = root[field];
      const consumed = consumeWorkbenchPolicy(tampered, createWorkbenchState());
      expect(consumed.accepted).toBe(false);
      expect(consumed.diagnostics.join(" ")).toMatch(/stale/i);
      expect(consumed.requestedIntent).toEqual([]);
      expect(consumed.selectedControls).toEqual([]);
      const effective = resolveEffectiveOrgPolicy(tampered as OrgPolicy);
      expect(effective.blocking).toBe(true);
      expect(effective.activeMcpServerIds).toEqual([]);
    },
  );

  it("keeps the Matt skill additive beside an explicitly selected ECC methodology", () => {
    const { prepared, state, policy } = authoredMattSelection();
    const combined = reduceWorkbenchAction(prepared.bundle, state, {
      type: "select-root",
      assetId: "ecc/profile:methodology",
      origin: { kind: "administrator" },
    }).state;
    const authored = compilePolicy(policy, combined, prepared.bundle, prepared.bindings);
    expect(authored.accepted).toBe(true);
    expect(combined.roots.map((root) => root.assetId)).toEqual([
      "ecc/profile:methodology",
      assetId,
    ]);
    expect(prepared.bundle.assets[assetId]?.exclusiveSlot).toBeUndefined();
    expect(
      consumeWorkbenchPolicy(authored.policy, createWorkbenchState()).requestedIntent,
    ).toContain(assetId);
  });
});
