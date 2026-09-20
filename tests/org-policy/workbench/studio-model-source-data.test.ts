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

/**
 * The real catalog pulls a managed MCP server in for a selection of any kind,
 * which the tiny fixture cannot reproduce. These run here, not in the pure
 * engine tests, because loading the packaged model is too slow for that lane.
 */
function engineNeedingManagedMcp() {
  const created = createAdminEngine(packageOnlyPolicyStudioModelV1());
  if (!created.ok) throw new Error(created.errors.join("; "));
  const engine = created.value;
  const tool = engine.state().aiTools[0];
  if (tool === undefined) throw new Error("the package catalog lists no AI tool");
  engine.toggleAiTool(tool.id);
  engine.setPosture("enterprise");
  const item = engine
    .state()
    .frameworks.flatMap((framework) => framework.groups.flatMap((group) => group.items))
    .find((candidate) => candidate.selectable);
  if (item === undefined) throw new Error("the package catalog offers no selectable item");
  engine.setItemSelected(item.assetId, true);
  return engine;
}

it("blocks the download until managed MCP projection is enabled, then writes the allow-list", () => {
  const engine = engineNeedingManagedMcp();
  expect(engine.state().managedMcpOptIn).toBe(false);
  expect(engine.state().managedMcpServers.length).toBeGreaterThan(0);
  expect(engine.check().blockers).toContain("enable managed MCP projection");
  const blocked = engine.download();
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.errors.join(" ")).toContain("enable managed MCP projection");

  expect(engine.setManagedMcpOptIn(true)).toEqual({
    ok: true,
    message:
      "Managed MCP projection enabled for selected Core MCP controls. It is saved only when those controls are present.",
  });
  expect(engine.state().managedMcpOptIn).toBe(true);
  expect(engine.check().blockers).toEqual([]);

  const file = engine.download();
  expect(file.ok).toBe(true);
  if (!file.ok) return;
  const written = JSON.parse(file.value.text) as {
    mcp?: { allowManagedOnly?: boolean; allowedServers?: string[] };
  };
  expect(written.mcp?.allowManagedOnly).toBe(true);
  expect(written.mcp?.allowedServers).toEqual([...engine.state().managedMcpServers]);
});

it("refuses to switch managed MCP projection off while selected Core MCP controls need it", () => {
  const engine = engineNeedingManagedMcp();
  engine.setManagedMcpOptIn(true);
  expect(engine.setManagedMcpOptIn(false)).toEqual({
    ok: false,
    message:
      "Managed MCP projection remains enabled because selected Core MCP controls need it. Remove those controls before disabling this setting.",
  });
  expect(engine.state().managedMcpOptIn).toBe(true);
});
