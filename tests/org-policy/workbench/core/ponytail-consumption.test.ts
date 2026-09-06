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
  workbenchSelectionCounts,
} from "../../../../src/org-policy/workbench/selection-engine.js";

const mainSkill = "ponytail/skill:ponytail";
const profileId = "ponytail/profile:methodology";
const auxiliarySkill = "ponytail/skill:ponytail-review";
const requestIds = [
  "ponytail/hook:session-start",
  "ponytail/hook:subagent-start",
  "ponytail/hook:user-prompt-submit",
  "ponytail/mcp:ponytail",
];
const administrator = { kind: "administrator" } as const;
const basePolicy = {
  schemaVersion: 2,
  minimumPosture: "vibe",
  references: { repoContract: "repo" },
};

function authoredPonytailIntent() {
  const prepared = defaultPreparedWorkbenchCatalog();
  let state = createWorkbenchState();
  for (const assetId of [auxiliarySkill, ...requestIds]) {
    if (prepared.bundle.assets[assetId] === undefined)
      throw new Error(`Missing packaged Ponytail asset ${assetId}`);
    const result = reduceWorkbenchAction(prepared.bundle, state, {
      type: assetId === auxiliarySkill ? "select-root" : "record-request",
      assetId,
      origin: administrator,
    });
    expect(result.accepted).toBe(true);
    state = result.state;
  }
  const authored = compilePolicy(
    basePolicy,
    state,
    prepared.bundle,
    prepared.bindings,
    "author",
    prepared.sourceInputs,
  );
  expect(authored.accepted).toBe(true);
  return { prepared, state, policy: authored.policy };
}

describe("packaged Ponytail intent", () => {
  it("round-trips skills and explicit hook/MCP requests without granting runtime authority", () => {
    const { prepared, state, policy } = authoredPonytailIntent();
    const transported = JSON.parse(JSON.stringify(policy));
    const imported = importWorkbenchPolicySelections(
      transported,
      prepared.bundle,
      prepared.bindings,
    );
    expect(imported.accepted).toBe(true);
    expect(imported.state).toEqual(state);
    expect(transported.authoringSources).toBeUndefined();
    expect(workbenchSelectionCounts(prepared.bundle, state)).toMatchObject({
      rootCount: 1,
      requestCount: 4,
      selectedControlCount: 0,
    });
    for (const request of state.requests) {
      const asset = prepared.bundle.assets[request.assetId];
      if (asset === undefined) throw new Error("Missing requested Ponytail asset");
      expect(request).toMatchObject({
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
      });
    }
    const requestedIntent = [auxiliarySkill, ...requestIds].sort();
    expect(consumeWorkbenchPolicy(transported, createWorkbenchState())).toMatchObject({
      accepted: true,
      requestedIntent,
      selectedControls: [],
      diagnostics: [],
    });
    const effective = resolveEffectiveOrgPolicy(transported as OrgPolicy);
    expect(effective.authoringIntent).toEqual({ requestedIntent, selectedControls: [] });
    expect(effective.candidates).toEqual([]);
    expect(effective.activeMcpServerIds).toEqual([]);
    expect(effective.externalSelections).toEqual([]);
    expect(transported.governance.authority.approvals).toEqual([]);
    expect(transported.governance.activations).toEqual([]);
  });

  it.each([
    ["roots", "sourceRevisionId"],
    ["roots", "contentDigest"],
    ["requests", "sourceRevisionId"],
    ["requests", "contentDigest"],
  ] as const)("rejects a stale %s %s before consuming any intent", (collection, field) => {
    const { policy } = authoredPonytailIntent();
    const tampered = structuredClone(policy);
    const selections = tampered.authoringSelections as WorkbenchStateV1;
    const pin = selections[collection][0];
    if (pin === undefined) throw new Error(`Missing saved ${collection} pin`);
    pin[field] = field === "sourceRevisionId" ? "0".repeat(40) : `sha256:${"0".repeat(64)}`;
    if (collection === "roots") {
      for (const resolved of selections.roots[0]?.resolvedItems ?? [])
        if (resolved.assetId === pin.assetId) resolved[field] = pin[field];
    }
    const consumed = consumeWorkbenchPolicy(tampered, createWorkbenchState());
    expect(consumed.accepted).toBe(false);
    expect(consumed.diagnostics.join(" ")).toMatch(/stale/i);
    expect(consumed.requestedIntent).toEqual([]);
    expect(consumed.selectedControls).toEqual([]);
    const effective = resolveEffectiveOrgPolicy(tampered as OrgPolicy);
    expect(effective.blocking).toBe(true);
    expect(effective.activeMcpServerIds).toEqual([]);
    expect(effective.candidates).toEqual([]);
    expect(effective.externalSelections).toEqual([]);
    expect(effective.capabilityPackages).toBeUndefined();
    expect((tampered as OrgPolicy).governance?.authority.approvals).toEqual([]);
    expect((tampered as OrgPolicy).governance?.activations).toEqual([]);
  });

  it.each([
    ["roots", "assetId"],
    ["roots", "sourceId"],
    ["requests", "assetId"],
    ["requests", "sourceId"],
  ] as const)("keeps an unavailable %s %s inert", (collection, field) => {
    const { policy } = authoredPonytailIntent();
    const unavailable = structuredClone(policy);
    const selections = unavailable.authoringSelections as WorkbenchStateV1;
    const pin = selections[collection][0];
    if (pin === undefined) throw new Error("Missing Ponytail pin");
    const originalId = pin.assetId;
    pin[field] = field === "assetId" ? "ponytail/skill:unavailable" : "source:ponytail-unavailable";
    if (collection === "roots") {
      for (const resolved of selections.roots[0]?.resolvedItems ?? [])
        if (resolved.assetId === originalId) resolved[field] = pin[field];
    } else
      selections.requests.sort((left, right) =>
        left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0,
      );
    const consumed = consumeWorkbenchPolicy(unavailable, createWorkbenchState());
    expect(consumed.accepted).toBe(false);
    expect(consumed.diagnostics.join(" ")).toMatch(/missing|unknown/i);
    expect(consumed.diagnostics.join(" ")).toContain(pin[field]);
    expect(consumed.requestedIntent).toEqual([]);
    expect(consumed.selectedControls).toEqual([]);
    const effective = resolveEffectiveOrgPolicy(unavailable as OrgPolicy);
    expect(effective).toMatchObject({
      blocking: true,
      projectionBlocking: true,
      candidates: [],
      activeMcpServerIds: [],
      externalSelections: [],
    });
    expect(effective.capabilityPackages).toBeUndefined();
    expect((unavailable as OrgPolicy).governance?.authority.approvals).toEqual([]);
    expect((unavailable as OrgPolicy).governance?.activations).toEqual([]);
  });

  it("keeps methodology optional and auxiliary skills additive beside ECC", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const empty = createWorkbenchState();
    expect(compilePolicy(basePolicy, empty, prepared.bundle, prepared.bindings).accepted).toBe(
      true,
    );
    const ecc = reduceWorkbenchAction(prepared.bundle, empty, {
      type: "select-root",
      assetId: "ecc/profile:methodology",
      origin: administrator,
    });
    expect(ecc.accepted).toBe(true);
    const additive = reduceWorkbenchAction(prepared.bundle, ecc.state, {
      type: "select-root",
      assetId: auxiliarySkill,
      origin: administrator,
    });
    expect(additive.accepted).toBe(true);
    expect(prepared.bundle.assets[auxiliarySkill]?.exclusiveSlot).toBeUndefined();
    for (const assetId of [mainSkill, profileId]) {
      const conflicted = reduceWorkbenchAction(prepared.bundle, additive.state, {
        type: "select-root",
        assetId,
        origin: administrator,
      });
      expect(conflicted.accepted).toBe(false);
      expect(conflicted.state).toEqual(additive.state);
      expect(conflicted.diagnostics).toContainEqual(
        expect.objectContaining({ code: "methodology-conflict" }),
      );
    }
  });

  it("expands the methodology template into pinned skills without implicit hook or MCP requests", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const template = Object.values(prepared.bundle.templates).find((value) =>
      value.roots.some((root) => root.assetId === profileId),
    );
    if (template === undefined) throw new Error("Missing Ponytail methodology template");
    const result = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
      type: "apply-template",
      templateId: template.id,
    });
    expect(result.accepted).toBe(true);
    expect(result.state.requests).toEqual([]);
    expect(
      result.state.roots.flatMap((root) => root.resolvedItems.map((item) => item.assetId)),
    ).toContain(mainSkill);
    const reverseConflict = reduceWorkbenchAction(prepared.bundle, result.state, {
      type: "select-root",
      assetId: "ecc/profile:methodology",
      origin: administrator,
    });
    expect(reverseConflict.accepted).toBe(false);
    expect(reverseConflict.state).toEqual(result.state);
    expect(reverseConflict.diagnostics).toContainEqual(
      expect.objectContaining({ code: "methodology-conflict" }),
    );
    const authored = compilePolicy(basePolicy, result.state, prepared.bundle, prepared.bindings);
    expect(authored.accepted).toBe(true);
    const consumed = consumeWorkbenchPolicy(authored.policy, createWorkbenchState());
    expect(consumed.accepted).toBe(true);
    expect(consumed.requestedIntent).toContain(mainSkill);
    expect(
      importWorkbenchPolicySelections(authored.policy, prepared.bundle, prepared.bindings),
    ).toMatchObject({
      accepted: true,
      state: result.state,
    });
    expect(consumed.selectedControls).toEqual([]);
    for (const requestId of requestIds) expect(consumed.requestedIntent).not.toContain(requestId);
  });
});
