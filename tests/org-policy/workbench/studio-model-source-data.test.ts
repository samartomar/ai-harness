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
it("authenticates current source data for each model built from the prepared package base", () => {
  const first = policyStudioModel();
  const emptyOptions = policyStudioModel(undefined, undefined, {
    verifiedBaseline: undefined,
    organizationManifestBytes: [],
    freshOrganizationPreparations: [],
  });
  expect(emptyOptions).toEqual(first);
  expect(emptyOptions.workbenchBundle).not.toBe(first.workbenchBundle);
  expect(apply).toHaveBeenCalledTimes(2);
});
