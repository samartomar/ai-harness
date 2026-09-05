import { expect, it } from "vitest";
import { resolveEffectiveOrgPolicy } from "../../../../src/org-policy/effective.js";
import type { OrgPolicy } from "../../../../src/org-policy/schema.js";
import { serializeWorkbenchRepairV1 } from "../../../../src/org-policy/workbench/policy-import.js";
import { fixture } from "../authoring-fixture.js";

it("keeps a repaired saved policy with an unavailable source inert in the default Core consumer", () => {
  const { bundle, bindings, policy, select } = fixture();
  const state = select("external", "other");
  bundle.assets.external!.contentDigest = "sha256:" + "b".repeat(64);
  bundle.assets.other!.contentDigest = "sha256:" + "c".repeat(64);
  const input = {
    ...policy,
    schemaVersion: 3,
    minimumCoreVersion: "0.6.0",
    authoringSelections: { selectionVersion: "workbench-selection/v1", ...state },
  };
  const repair = serializeWorkbenchRepairV1(
    input,
    state,
    { type: "remove-root", assetId: "external", origin: { kind: "administrator" } },
    bundle,
    bindings,
  );
  expect(repair.accepted).toBe(true);
  const effective = resolveEffectiveOrgPolicy(repair.policy as OrgPolicy);
  expect(effective).toMatchObject({
    blocking: true,
    projectionBlocking: true,
    candidates: [],
    activeMcpServerIds: [],
    externalSelections: [],
  });
  expect(effective.capabilityPackages).toBeUndefined();
  expect(effective.authoringDiagnostics).toEqual([
    "missing authoring source input for source:test",
  ]);
});
