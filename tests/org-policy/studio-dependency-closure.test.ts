import { describe, expect, it } from "vitest";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
} from "../../src/org-policy/workbench/selection-engine.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

const administrator = { kind: "administrator" } as const;

describe("Workbench dependency closure boundary", () => {
  it("records an exact prepared root while Core owns closure evaluation", () => {
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
    expect(result.accepted).toBe(true);
    expect(resolveWorkbenchSelection(model.workbenchBundle, result.state).assetIds).toEqual([
      asset.id,
    ]);
  });
});
