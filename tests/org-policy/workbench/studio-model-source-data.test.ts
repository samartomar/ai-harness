import { beforeEach, expect, it, vi } from "vitest";

const apply = vi.hoisted(() => vi.fn());
vi.mock("../../../src/org-policy/workbench/core/source-data.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/org-policy/workbench/core/source-data.js")>();
  apply.mockImplementation(actual.applyWorkbenchSourceDataV1);
  return { ...actual, applyWorkbenchSourceDataV1: apply };
});

import { policyStudioModel } from "../../../src/org-policy/studio-model.js";

beforeEach(() => apply.mockClear());
it("authenticates the configured source cache once after preparing package overlays", () => {
  policyStudioModel();
  expect(apply).toHaveBeenCalledTimes(1);
});
