import { describe, expect, it } from "vitest";
import { organizationManifestCatalogBundleV1 } from "../../../../src/org-policy/workbench/catalog-bundle.js";
import { planWorkbenchAdoptionV1 } from "../../../../src/org-policy/workbench/core/adoption-plan-v1.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../../src/org-policy/workbench/selection-engine.js";
import { tinyStudioModel } from "../../studio-test-fixture.js";

function selected(assetId: string) {
  const model = tinyStudioModel();
  const reduced = reduceWorkbenchAction(model.workbenchBundle, createWorkbenchState(), {
    type: assetId === "fixture:request" ? "record-request" : "select-root",
    assetId,
    origin: { kind: "administrator" },
  });
  if (!reduced.accepted) throw new Error("fixture action rejected");
  return { model, state: reduced.state };
}

describe("Workbench adoption handoff", () => {
  it("keeps selected ECC components pending evidence until a concrete project lifecycle can evaluate them", () => {
    const { model, state } = selected("fixture:external");
    expect(planWorkbenchAdoptionV1(model.workbenchBundle, state, model.workbenchBindings)).toEqual({
      accepted: true,
      diagnostics: [],
      items: [
        expect.objectContaining({
          assetId: "fixture:external",
          state: "pending-evidence",
        }),
      ],
    });
    expect(
      planWorkbenchAdoptionV1(model.workbenchBundle, state, model.workbenchBindings).items[0],
    ).not.toHaveProperty("command");
  });

  it("does not imply an adoption route for selected ECC MCP configuration", () => {
    const { model, state } = selected("fixture:external");
    const external = model.workbenchBindings["fixture:external"]?.external;
    if (external === undefined) throw new Error("fixture external binding missing");
    external.item.kind = "mcp";
    const [item] = planWorkbenchAdoptionV1(
      model.workbenchBundle,
      state,
      model.workbenchBindings,
    ).items;
    expect(item).toMatchObject({ assetId: "fixture:external", state: "pending-route" });
    expect(item).not.toHaveProperty("command");
  });

  it("keeps a Core-prepared connected custom Skill pending evidence and derives its vet command from the saved pin", () => {
    // Exercise the real organization compiler without unrelated package sources.
    const bundle = organizationManifestCatalogBundleV1(
      JSON.stringify({
        version: "organization-authoring-manifest/v1",
        source: {
          id: "source:connected-github-skill",
          revisionId: "a".repeat(40),
          locator: "https://github.com/anthropics/skills",
        },
        assets: [
          {
            id: "frontend-design",
            kind: "skill",
            label: "Frontend design",
            path: "skills/frontend-design/SKILL.md",
          },
        ],
      }),
    );
    const asset = Object.values(bundle.assets).find(
      (candidate) => candidate.sourceId === "source:connected-github-skill",
    );
    if (asset === undefined) throw new Error("prepared connected Skill missing");
    const reduced = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: asset.id,
      origin: { kind: "administrator" },
    });
    if (!reduced.accepted) throw new Error("fixture action rejected");
    const plan = planWorkbenchAdoptionV1(bundle, reduced.state, {});
    expect(plan.items).toEqual([
      expect.objectContaining({
        assetId: asset.id,
        state: "pending-evidence",
        command: `aih skill vet anthropics/skills --pin ${"a".repeat(40)} --name frontend-design --apply`,
      }),
    ]);
    expect(plan.items[0]?.reason).toMatch(/no authenticated Core preparation result/i);
    expect(plan.items[0]?.nextAction).toMatch(/local vet record/i);
  });

  it("hands a package-root selection to the existing local status command before any apply", () => {
    const { model, state } = selected("fixture:external");
    model.workbenchBindings["fixture:external"] = {
      kind: "package-root",
      packageRoot: {
        catalogRepository: "samartomar/ai-harness",
        root: "package:skill-pack/docs-quality",
      },
    };
    expect(
      planWorkbenchAdoptionV1(model.workbenchBundle, state, model.workbenchBindings).items,
    ).toEqual([
      expect.objectContaining({
        state: "ready-to-preview",
        command: "aih capability package status package:skill-pack/docs-quality",
      }),
    ]);
  });

  it("does not turn malformed state or Core controls into an install action", () => {
    const model = tinyStudioModel();
    expect(
      planWorkbenchAdoptionV1(model.workbenchBundle, { roots: [] }, model.workbenchBindings),
    ).toMatchObject({ accepted: false, items: [] });
    const { model: controlModel, state } = selected("fixture:control");
    const [control] = planWorkbenchAdoptionV1(
      controlModel.workbenchBundle,
      state,
      controlModel.workbenchBindings,
    ).items;
    expect(control).toMatchObject({ state: "pending-approval" });
    expect(control).not.toHaveProperty("command");
  });

  it("withholds a custom Skill command when the saved pin has drifted", () => {
    const model = tinyStudioModel();
    const source = model.workbenchBundle.sources["source:fixture-core"]!;
    source.upstreamOrigin = { kind: "git", locator: "acme/review-skills" };
    source.revision.id = "a".repeat(40);
    const asset = model.workbenchBundle.assets["fixture:request"]!;
    asset.sourceRevisionId = source.revision.id;
    asset.kind = "skill";
    asset.originalPath = "skills/review/SKILL.md";
    const reduced = reduceWorkbenchAction(model.workbenchBundle, createWorkbenchState(), {
      type: "record-request",
      assetId: "fixture:request",
      origin: { kind: "administrator" },
    });
    if (!reduced.accepted) throw new Error("fixture action rejected");
    source.revision.id = "b".repeat(40);
    asset.sourceRevisionId = source.revision.id;

    const plan = planWorkbenchAdoptionV1(
      model.workbenchBundle,
      reduced.state,
      model.workbenchBindings,
    );
    expect(plan).toMatchObject({
      accepted: false,
      diagnostics: ["Stale requested content: fixture:request"],
      items: [
        {
          assetId: "fixture:request",
          state: "pending-selection",
        },
      ],
    });
    expect(plan.items[0]).not.toHaveProperty("command");
  });

  it("suppresses every action command when one selected item is stale", () => {
    const model = tinyStudioModel();
    model.workbenchBindings["fixture:external"] = {
      kind: "package-root",
      packageRoot: {
        catalogRepository: "samartomar/ai-harness",
        root: "package:skill-pack/docs-quality",
      },
    };
    let state = createWorkbenchState();
    const selectedExternal = reduceWorkbenchAction(model.workbenchBundle, state, {
      type: "select-root",
      assetId: "fixture:external",
      origin: { kind: "administrator" },
    });
    if (!selectedExternal.accepted) throw new Error("fixture external action rejected");
    state = selectedExternal.state;
    const requested = reduceWorkbenchAction(model.workbenchBundle, state, {
      type: "record-request",
      assetId: "fixture:request",
      origin: { kind: "administrator" },
    });
    if (!requested.accepted) throw new Error("fixture request action rejected");
    model.workbenchBundle.assets["fixture:request"]!.contentDigest = `sha256:${"f".repeat(64)}`;

    const plan = planWorkbenchAdoptionV1(
      model.workbenchBundle,
      requested.state,
      model.workbenchBindings,
    );
    expect(plan.accepted).toBe(false);
    expect(plan.diagnostics).toEqual(["Stale requested content: fixture:request"]);
    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((item) => item.command === undefined)).toBe(true);
  });
});
