import { describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { packageOnlyPolicyStudioModelV1 } from "../../../src/org-policy/studio-model.js";
import { createAdminEngine } from "../../../src/org-policy/workbench/engine/index.js";
import { workbenchBrowseBundleV1 } from "../../../src/org-policy/workbench/engine/scan-presentation.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

/**
 * LANE A, the Sources feature (inventory rows 7, 11 and 12) and the parity fix
 * that puts the catalog views on the BROWSE projection the hand-built page
 * browses (`workbenchBrowseBundleV1`), while selection, import and download
 * keep the complete bundle.
 */

function admin(model: PolicyStudioModel = tinyStudioModel()) {
  const created = createAdminEngine(model);
  if (!created.ok) throw new Error(created.errors.join("; "));
  return created.value;
}

describe("catalog browse (row 11)", () => {
  it("lists the open source's items with the page's own results line", () => {
    const engine = admin();
    const sourceId = engine.state().frameworks[0]?.sourceId;
    const view = engine.browseCatalog({ sourceId });
    expect(view.total).toBe(3);
    expect(view.page).toBe(0);
    expect(view.pageCount).toBe(1);
    expect(view.rangeText).toBe("Showing 1–3 of 3 items");
    // One page holds everything, so the page label stays away.
    expect(view.pageText).toBe("");
    expect(view.items.map((item) => item.assetId).sort()).toEqual([
      "fixture:control",
      "fixture:external",
      "fixture:request",
    ]);
    expect(view.emptyMessage).toBeUndefined();
  });

  it("filters by search and says, in the page's words, when nothing matches", () => {
    const engine = admin();
    const sourceId = engine.state().frameworks[0]?.sourceId;
    expect(engine.browseCatalog({ sourceId, query: "control" }).total).toBe(1);
    const empty = engine.browseCatalog({ sourceId, query: "no-such-catalog-item" });
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
    expect(empty.emptyMessage).toBe(
      'No catalog items match "no-such-catalog-item" in the selected source.',
    );
  });

  it("filters by type and counts what the other types still hold", () => {
    const engine = admin();
    const sourceId = engine.state().frameworks[0]?.sourceId;
    const hooks = engine.browseCatalog({ sourceId, kind: "hook" });
    expect(hooks.items.map((item) => item.assetId)).toEqual(["fixture:control"]);
    const agents = engine.browseCatalog({ sourceId, kind: "agent" });
    expect(agents.total).toBe(0);
    expect(agents.otherTypeMatches).toBe(3);
    expect(agents.emptyMessage).toBe(
      "No agents are available in the selected source. 3 items are available in other types.",
    );
  });

  it("names the sources the way a person recognizes them, never a raw URL", () => {
    const engine = admin();
    const view = engine.browseCatalog({ sourceId: "source:fixture-core" });
    expect(view.sourceLabel).toBe("@aihq/fixture");
    expect(view.sourceOptions.map((option) => option.label)).toEqual(["@aihq/fixture"]);
    expect(engine.state().frameworks.map((entry) => entry.label)).toEqual(["@aihq/fixture"]);
  });
});

describe("kind ledger (row 7)", () => {
  it("counts the prepared catalog per kind, and never a token or cost figure", () => {
    const engine = admin();
    expect(engine.kindLedger()).toEqual([
      { kind: "skill", label: "Skills", total: 1, selected: 0, percent: 0 },
      { kind: "command", label: "Command", total: 0, selected: 0, percent: 0 },
      { kind: "agent", label: "Agents", total: 0, selected: 0, percent: 0 },
      { kind: "mcp", label: "MCP servers", total: 1, selected: 0, percent: 0 },
      { kind: "hook", label: "Hooks", total: 1, selected: 0, percent: 0 },
    ]);
  });

  it("follows the draft when an item is selected", () => {
    const engine = admin();
    expect(engine.setItemSelected("fixture:control", true).ok).toBe(true);
    const hook = engine.kindLedger().find((entry) => entry.kind === "hook");
    expect(hook).toEqual({ kind: "hook", label: "Hooks", total: 1, selected: 1, percent: 100 });
  });
});

describe("item inspector (row 12)", () => {
  it("gives the three tabs' content for a browsable item", () => {
    const engine = admin();
    const item = engine.inspectItem("fixture:control");
    if (item === undefined) throw new Error("expected an inspection");
    expect(item.assetId).toBe("fixture:control");
    expect(item.title.length).toBeGreaterThan(0);
    expect(item.facts.some((fact) => fact.label === "Provided by")).toBe(true);
    expect(item.security.statusLabel.length).toBeGreaterThan(0);
    expect(item.security.limitation).toContain("it does not approve, install, or grant access");
    expect(JSON.parse(item.policyJson)).toMatchObject({
      identity: { assetId: "fixture:control", type: "hook" },
    });
  });

  it("refuses an unknown item with undefined, never a throw", () => {
    const engine = admin();
    expect(engine.inspectItem("no-such-item")).toBeUndefined();
    expect(engine.inspectItem("")).toBeUndefined();
  });
});

describe("the browse projection is display only", () => {
  it("lists what the hand-built page browses, not the complete bundle", () => {
    const model = packageOnlyPolicyStudioModelV1();
    const engine = admin(model);
    const complete = model.workbenchBundle;
    const browse = workbenchBrowseBundleV1(complete);
    const listed = new Set(
      engine
        .state()
        .frameworks.flatMap((framework) =>
          framework.groups.flatMap((group) => group.items.map((item) => item.assetId)),
        ),
    );
    expect(listed.size).toBeGreaterThan(0);
    for (const assetId of listed) expect(browse.assets[assetId]).toBeDefined();
    // Whatever the projection drops is dropped from every catalog view.
    for (const assetId of Object.keys(complete.assets))
      if (browse.assets[assetId] === undefined) expect(listed.has(assetId)).toBe(false);
    expect(engine.inspectItem("aih/github")).toBeUndefined();
  });

  it("keeps the complete bundle for selection and download", () => {
    const engine = admin();
    const before = engine.state().policyText;
    expect(engine.setItemSelected("fixture:control", true).ok).toBe(true);
    const file = engine.download();
    expect(file.ok).toBe(true);
    expect(engine.state().policyText).not.toBe(before);
    expect(engine.state().selectedAssetIds).toContain("fixture:control");
  });
});
