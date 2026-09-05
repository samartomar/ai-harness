import { describe, expect, it } from "vitest";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
  workbenchSelectionCounts,
} from "../../src/org-policy/workbench/selection-engine.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

const administrator = { kind: "administrator" } as const;

describe("Workbench methodology selection boundary", () => {
  it("records a generic root without presenting source-specific framework rows", () => {
    const model = tinyStudioModel();
    const asset = Object.values(model.workbenchBundle.assets).find(
      (item) => item.authoring.action === "record-selection",
    );
    if (asset === undefined) throw new Error("expected prepared external-selection asset");
    const result = reduceWorkbenchAction(model.workbenchBundle, createWorkbenchState(), {
      type: "select-root",
      assetId: asset.id,
      origin: administrator,
    });
    expect(workbenchSelectionCounts(model.workbenchBundle, result.state)).toMatchObject({
      rootCount: 1,
    });
  });
});
