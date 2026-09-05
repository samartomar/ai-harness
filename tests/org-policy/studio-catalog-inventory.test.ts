import { describe, expect, it } from "vitest";
import { AuthoringCatalogBundleV1Schema } from "../../src/org-policy/workbench/contracts.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

describe("Workbench prepared inventory", () => {
  it("embeds a small valid Core-prepared catalog for generic inventory wiring", () => {
    const model = tinyStudioModel();
    expect(AuthoringCatalogBundleV1Schema.safeParse(model.workbenchBundle).success).toBe(true);
    expect(Object.keys(model.workbenchBundle.assets)).toHaveLength(3);
    expect(Object.keys(model.workbenchBindings)).toHaveLength(3);
  });
});
