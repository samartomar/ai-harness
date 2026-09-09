import { expect, it, vi } from "vitest";

vi.mock("../../../src/org-policy/workbench/prepared-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/org-policy/workbench/prepared-catalog.js")>();
  const fixture = await import("./source-data-test-fixture.js");
  // This diagnostic only needs an admitted Git source to prove the recovery
  // message. Package admission is exercised by prepared-catalog tests.
  return { ...actual, prepareWorkbenchCatalog: fixture.tinySourceDataPreparedCatalogV1 };
});

import { prepareAuthoringSourcesForConsumptionV1 } from "../../../src/org-policy/workbench/core/authoring-sources.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";
import { fixtureAssetId, tinySourceDataPreparedCatalogV1 } from "./source-data-test-fixture.js";

it("names the exact missing Git snapshot and independent import recovery without moving saved pins", () => {
  const base = tinySourceDataPreparedCatalogV1();
  const state = reduceWorkbenchAction(base.bundle, createWorkbenchState(), {
    type: "select-root",
    assetId: fixtureAssetId,
    origin: { kind: "administrator" },
  }).state;
  const root = state.roots[0];
  if (!root) throw Error("fixture root");
  root.sourceId = "source:recovery-test";
  root.sourceRevisionId = "f".repeat(40);
  root.resolvedItems = [
    {
      assetId: root.assetId,
      sourceId: root.sourceId,
      sourceRevisionId: root.sourceRevisionId,
      contentDigest: root.contentDigest,
    },
  ];
  const original = JSON.stringify(state);
  const result = prepareAuthoringSourcesForConsumptionV1(state, undefined, base);
  expect(result.accepted).toBe(false);
  expect(result.diagnostics.join(" ")).toContain("source:recovery-test");
  expect(result.diagnostics.join(" ")).toContain(root.sourceRevisionId);
  expect(result.diagnostics.join(" ")).toContain("aih policy data import");
  expect(result.diagnostics.join(" ")).toContain("--proof-root");
  expect(JSON.stringify(state)).toBe(original);
});
