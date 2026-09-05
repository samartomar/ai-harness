import { describe, expect, it } from "vitest";
import { tinyEnterpriseStudioModel } from "./studio-test-fixture.js";

describe("Enterprise Workbench composition boundary", () => {
  it("keeps enterprise posture and sanctioned targets in the portable authoring model", () => {
    const model = tinyEnterpriseStudioModel();
    expect(model.initialPolicy.minimumPosture).toBe("enterprise");
    expect(model.initialPolicy.governance?.supportedClis).toEqual(["codex"]);
  });
});
