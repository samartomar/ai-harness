import { beforeEach, expect, it, vi } from "vitest";

const apply = vi.hoisted(() => vi.fn());
vi.mock("../../../src/org-policy/workbench/core/source-data.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/org-policy/workbench/core/source-data.js")>();
  apply.mockImplementation(actual.applyWorkbenchSourceDataV1);
  return { ...actual, applyWorkbenchSourceDataV1: apply };
});

import {
  packageOnlyPolicyStudioModelV1,
  policyStudioModel,
} from "../../../src/org-policy/studio-model.js";
import { createAdminEngine } from "../../../src/org-policy/workbench/engine/index.js";

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

/**
 * The package-only model the hosted build embeds: the same package base with
 * no local read, no clock and no source-data overlay, so the file a build
 * writes is the same on every machine.
 */
it("builds the package-only model without the source-data overlay", () => {
  const model = packageOnlyPolicyStudioModelV1();
  expect(apply).not.toHaveBeenCalled();
  expect(model.workbenchBundle).toBeDefined();
});

it("builds the same package-only model twice, under another clock and another folder", () => {
  const first = packageOnlyPolicyStudioModelV1();
  const second = packageOnlyPolicyStudioModelV1();
  expect(second).toEqual(first);
  expect(second.workbenchBundle).not.toBe(first.workbenchBundle);

  const cwd = vi.spyOn(process, "cwd").mockReturnValue("/nowhere/else");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2031-04-05T06:07:08.000Z"));
  try {
    expect(packageOnlyPolicyStudioModelV1()).toEqual(first);
  } finally {
    vi.useRealTimers();
    cwd.mockRestore();
  }
});

it("is accepted by the admin engine with a valid catalog", () => {
  const engine = createAdminEngine(packageOnlyPolicyStudioModelV1());
  expect(engine.ok).toBe(true);
  if (!engine.ok) return;
  expect(engine.value.state().catalogValid).toBe(true);
});
