import { describe, expect, it } from "vitest";

import {
  type AuthoringAssetV1,
  type AuthoringCatalogBundleV1,
  parseAuthoringCatalogBundleV1,
  WorkbenchStateV1Schema,
} from "../../../src/org-policy/workbench/contracts.js";
import { verifyWorkbenchDraftBytesV1 } from "../../../src/org-policy/workbench/core/verification.js";
import {
  createWorkbenchState,
  previewWorkbenchTransactionV1,
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
  workbenchSelectionCounts,
  workbenchStatesEqualV1,
} from "../../../src/org-policy/workbench/selection-engine.js";
import {
  mcpRuntimeOverlapPresentation,
  selectionComparisonPresentation,
} from "../../../src/org-policy/workbench/ui/selection-comparison.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const administrator = { kind: "administrator" } as const;
const sourceId = "source:aih";
const sourceRevisionId = "git:e833fc64";

function asset(
  id: string,
  action: AuthoringAssetV1["authoring"]["action"],
  overrides: Partial<AuthoringAssetV1> = {},
): AuthoringAssetV1 {
  const control = action === "select-control";
  return {
    id,
    sourceId,
    sourceRevisionId,
    contentDigest: digest(id.includes("changed") ? "c" : "b"),
    originalPath: `catalog/${id.replace(":", "-")}.json`,
    derivation: "built-in",
    kind: "control",
    label: id,
    detailChunkId: `detail:${id}`,
    declaredHostCapabilities: [],
    authoring: {
      action,
      ...(control ? { projectorId: "mcp-managed-settings" as const } : {}),
      supportedTargets: control ? ["claude"] : [],
    },
    ...overrides,
  };
}

function catalog(
  assets: Record<string, AuthoringAssetV1>,
  relations: AuthoringCatalogBundleV1["relations"] = [],
  templates: AuthoringCatalogBundleV1["templates"] = {},
): AuthoringCatalogBundleV1 {
  return {
    version: "authoring-catalog-bundle/v1",
    sources: {
      [sourceId]: {
        id: sourceId,
        distributor: { kind: "aih", locator: "@aihq/core" },
        upstreamOrigin: { kind: "aih", locator: "@aihq/core" },
        inputFormat: "pinned-baseline/v1",
        revision: { id: sourceRevisionId, contentDigest: digest("a") },
        compiler: { id: "test", version: "1" },
      },
    },
    assets,
    groups: {},
    relations,
    templates,
    evidence: {},
    provenance: { bundleDigest: digest("d") },
    detailChunks: Object.fromEntries(
      Object.values(assets).map((item) => [
        item.detailChunkId,
        { bytes: "{}", digest: digest("e") },
      ]),
    ),
  };
}

const base = catalog({
  "request:one": asset("request:one", "record-request"),
  "control:one": asset("control:one", "select-control"),
});

describe("Workbench reducer", () => {
  it("persists and clears a rationale only for the exact current request pin", () => {
    const requested = asset("mcp:rationale", "record-request", { kind: "mcp" });
    const bundle = catalog({ [requested.id]: requested });
    const state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "record-request",
      assetId: requested.id,
      origin: administrator,
    }).state;
    const pin = state.requests[0]!;
    const saved = reduceWorkbenchAction(bundle, state, {
      type: "set-rationale",
      entry: "request",
      ...pin,
      rationale: "Needed for the reviewed repository integration.",
    }).state;
    expect(saved.requests[0]?.rationale).toBe("Needed for the reviewed repository integration.");
    expect(
      reduceWorkbenchAction(bundle, saved, { type: "set-rationale", entry: "request", ...pin })
        .state.requests[0],
    ).not.toHaveProperty("rationale");
  });
  it("advises only on an exact provider-declared MCP runtime identity", () => {
    const aih = asset("mcp:github-aih", "record-request", {
      kind: "mcp",
      runtimeIdentity: "mcp:github",
    });
    const ecc = asset("mcp:github-ecc", "record-request", {
      kind: "mcp",
      runtimeIdentity: "mcp:github",
    });
    const unrelated = asset("mcp:github-label", "record-request", { kind: "mcp" });
    const bundle = catalog({ [aih.id]: aih, [ecc.id]: ecc, [unrelated.id]: unrelated });
    const state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "record-request",
      assetId: aih.id,
      origin: administrator,
    }).state;
    expect(mcpRuntimeOverlapPresentation(ecc, bundle, state)).toMatchObject({
      kind: "potential-overlap",
      runtimeIdentity: "mcp:github",
      candidates: [{ assetId: aih.id }],
    });
    expect(mcpRuntimeOverlapPresentation(unrelated, bundle, state).kind).toBe("none");
  });
  it("normalizes state equality and transaction deltas while rejecting malformed inputs", () => {
    const selected = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:one",
      origin: administrator,
    }).state;
    const reordered = {
      drafts: [],
      requests: [],
      exclusions: [],
      roots: selected.roots.map((root) => Object.fromEntries(Object.entries(root).reverse())),
    } as unknown as typeof selected;
    expect(workbenchStatesEqualV1(selected, reordered)).toBe(true);
    expect(workbenchStatesEqualV1(selected, createWorkbenchState())).toBe(false);
    expect(workbenchStatesEqualV1({ roots: null }, selected)).toBe(false);
    const preview = previewWorkbenchTransactionV1(base, reordered, [
      {
        type: "record-request",
        assetId: "request:one",
        origin: administrator,
      },
    ]);
    expect(preview.changes.roots).toEqual({ added: [], removed: [] });
    for (const malformed of [
      { roots: null },
      { ...selected, roots: Array(10_001).fill(selected.roots[0]) },
    ]) {
      expect(previewWorkbenchTransactionV1(base, malformed as typeof selected, [])).toMatchObject({
        accepted: false,
        state: malformed,
      });
    }
  });

  it("retains fresh conflict origins when another origin is stale and rejects a mismatched candidate pin", () => {
    const old = asset("skill:old", "record-selection");
    const next = asset("skill:new", "record-selection");
    const bundle = catalog({ [old.id]: old, [next.id]: next }, [
      {
        fromAssetId: old.id,
        toAssetId: next.id,
        kind: "conflicts",
      },
    ]);
    let state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: old.id,
      origin: administrator,
    }).state;
    state = reduceWorkbenchAction(bundle, state, {
      type: "select-root",
      assetId: old.id,
      origin: { kind: "legacy-unattributed" },
    }).state;
    const stale = state.roots.find((root) => root.origin.kind === "legacy-unattributed")!;
    stale.contentDigest = digest("c");
    stale.resolvedItems[0]!.contentDigest = digest("c");
    expect(resolveWorkbenchSelection(bundle, state)).toMatchObject({
      assetIds: [old.id],
      staleAssetIds: [old.id],
    });
    const comparison = selectionComparisonPresentation(next, bundle, state);
    expect(comparison.kind).toBe("conflict");
    expect(comparison.steps).toContainEqual({
      type: "remove-root",
      assetId: old.id,
      origin: administrator,
    });
    expect(comparison.preview.state.roots.some((root) => root.assetId === next.id)).toBe(true);
    expect(
      selectionComparisonPresentation({ ...next, contentDigest: digest("c") }, bundle, state)
        .preview.accepted,
    ).toBe(false);
  });
  it("previews atomic replacement and preserves the original state when a later step fails", () => {
    const selected = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:one",
      origin: administrator,
    }).state;
    const remove = { type: "remove-root", assetId: "control:one", origin: administrator } as const;
    const failed = previewWorkbenchTransactionV1(base, selected, [
      remove,
      { type: "select-root", assetId: "control:missing", origin: administrator },
    ]);
    expect(failed).toMatchObject({
      accepted: false,
      state: selected,
      changes: { removedAssetIds: [], roots: { removed: [] } },
    });
    expect(failed.action).toBeUndefined();
    const success = previewWorkbenchTransactionV1(base, selected, [
      remove,
      { type: "record-request", assetId: "request:one", origin: administrator },
    ]);
    expect(success).toMatchObject({
      accepted: true,
      changes: {
        removedAssetIds: ["control:one"],
        requests: { added: [{ assetId: "request:one" }] },
      },
    });
    expect(reduceWorkbenchAction(base, selected, success.action).state).toEqual(success.state);
    expect(selected.roots).toHaveLength(1);
    for (const steps of [
      [],
      Array.from({ length: 257 }, () => remove),
      [{ type: "restore-state" as const, state: selected }],
    ]) {
      expect(previewWorkbenchTransactionV1(base, selected, steps)).toMatchObject({
        accepted: false,
        state: selected,
      });
    }
  });

  it("compares declared conflicts through selecting origins and previews whole-template collateral", () => {
    const old = asset("skill:old", "record-selection", { label: "Grill me" });
    const next = asset("skill:new", "record-selection", { label: "Grill me" });
    const group = asset("group:one", "record-selection");
    const extra = asset("skill:extra", "record-selection");
    const blocked = asset("skill:blocked", "record-selection");
    const bundle = catalog(
      {
        [old.id]: old,
        [next.id]: next,
        [group.id]: group,
        [extra.id]: extra,
        [blocked.id]: blocked,
      },
      [{ fromAssetId: group.id, toAssetId: old.id, kind: "requires" }],
    );
    const selected = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: group.id,
      origin: administrator,
    }).state;
    expect(selectionComparisonPresentation(next, bundle, selected).kind).toBe("none");
    expect(selectionComparisonPresentation(old, bundle, selected).kind).toBe("already-in-draft");
    bundle.relations.push({ fromAssetId: old.id, toAssetId: next.id, kind: "conflicts" });
    const origin = { kind: "template", id: "template:one", digest: digest("f") } as const;
    let templated = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: group.id,
      origin,
    }).state;
    templated = reduceWorkbenchAction(bundle, templated, {
      type: "select-root",
      assetId: extra.id,
      origin,
    }).state;
    templated = reduceWorkbenchAction(bundle, templated, {
      type: "add-exclusion",
      assetId: "skill:blocked",
      origin,
    }).state;
    const comparison = selectionComparisonPresentation(next, bundle, templated);
    expect(comparison.kind).toBe("conflict");
    expect(comparison.steps[0]).toEqual({
      type: "remove-template",
      templateId: origin.id,
      digest: origin.digest,
    });
    expect(comparison.preview.accepted).toBe(true);
    expect(comparison.preview.changes.removedAssetIds).toEqual([group.id, extra.id, old.id].sort());
    expect(comparison.preview.changes.roots.removed).toHaveLength(2);
    expect(comparison.preview.changes.exclusions.removed).toEqual([
      expect.objectContaining({ assetId: blocked.id, origin }),
    ]);
    expect(comparison.preview.changes.addedAssetIds).toEqual([next.id]);
    const direct = reduceWorkbenchAction(bundle, selected, {
      type: "select-root",
      assetId: old.id,
      origin: administrator,
    }).state;
    const multiple = selectionComparisonPresentation(next, bundle, direct);
    expect(multiple.steps.filter((step) => step.type === "remove-root")).toHaveLength(2);
    expect(multiple.preview.state.roots.map((root) => root.assetId)).toEqual([next.id]);
  });

  it("allows the same methodology key and offers replacement only for a different one", () => {
    const first = asset("profile:first", "record-selection", {
      exclusiveSlot: "methodology",
      methodologyKey: "method:one",
    });
    const same = asset("profile:same", "record-selection", {
      exclusiveSlot: "methodology",
      methodologyKey: "method:one",
    });
    const different = asset("profile:other", "record-selection", {
      exclusiveSlot: "methodology",
      methodologyKey: "method:two",
    });
    const bundle = catalog({ [first.id]: first, [same.id]: same, [different.id]: different });
    const state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: first.id,
      origin: administrator,
    }).state;
    expect(selectionComparisonPresentation(same, bundle, state).kind).toBe("none");
    const comparison = selectionComparisonPresentation(different, bundle, state);
    expect(comparison.kind).toBe("conflict");
    expect(comparison.preview.state.roots.map((root) => root.assetId)).toEqual([different.id]);
  });
  it("records an exact request pin without selecting a control", () => {
    const result = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "record-request",
      assetId: "request:one",
      origin: administrator,
    });

    expect(result).toMatchObject({
      accepted: true,
      state: {
        roots: [],
        requests: [
          { assetId: "request:one", sourceId, sourceRevisionId, contentDigest: digest("b") },
        ],
      },
    });
    expect(workbenchSelectionCounts(base, result.state)).toMatchObject({
      requestCount: 1,
      selectedControlCount: 0,
      rootCount: 0,
    });
  });

  it("rejects malformed runtime actions without mutating state", () => {
    const initial = createWorkbenchState();
    expect(
      reduceWorkbenchAction(base, initial, {
        type: "select-root",
        assetId: "control:one",
        origin: "administrator",
      }),
    ).toMatchObject({ accepted: false, state: initial, diagnostics: [{ code: "invalid-action" }] });
  });
  it("rejects malformed saved state and unknown exclusion mutations", () => {
    const root = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:one",
      origin: administrator,
    }).state.roots[0]!;
    const malformed = {
      roots: [root, root],
      exclusions: [],
      requests: [],
      drafts: [],
    } as unknown as ReturnType<typeof createWorkbenchState>;
    expect(
      reduceWorkbenchAction(base, malformed, {
        type: "remove-root",
        assetId: "control:one",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: false, diagnostics: [{ code: "invalid-action" }] });
    expect(
      reduceWorkbenchAction(base, createWorkbenchState(), {
        type: "add-exclusion",
        assetId: "missing:asset",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: false, diagnostics: [{ code: "unknown-asset" }] });
  });
  it("rejects a new action whose authoring action is incompatible", () => {
    const result = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "record-request",
      assetId: "control:one",
      origin: administrator,
    });
    expect(result).toMatchObject({
      accepted: false,
      diagnostics: [{ code: "unsupported-action" }],
    });
  });

  it("retains the captured dependency pin and diagnoses a changed prerequisite", () => {
    const before = catalog(
      {
        "control:root": asset("control:root", "select-control"),
        "control:dependency": asset("control:dependency", "select-control"),
      },
      [{ fromAssetId: "control:root", toAssetId: "control:dependency", kind: "requires" }],
    );
    const selected = reduceWorkbenchAction(before, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:root",
      origin: administrator,
    });
    const after = catalog(
      {
        "control:root": asset("control:root", "select-control"),
        "control:dependency": asset("control:dependency", "select-control", {
          contentDigest: digest("f"),
        }),
      },
      before.relations,
    );

    expect(resolveWorkbenchSelection(after, selected.state).staleAssetIds).toEqual([
      "control:dependency",
      "control:root",
    ]);
    expect(
      reduceWorkbenchAction(after, selected.state, {
        type: "remove-root",
        assetId: "control:root",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: true, state: createWorkbenchState() });
  });

  it("allows stale roots with the same asset id to be removed one origin at a time", () => {
    const selected = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:one",
      origin: administrator,
    });
    const template = { kind: "template", id: "template:one", digest: digest("a") } as const;
    const twice = reduceWorkbenchAction(base, selected.state, {
      type: "select-root",
      assetId: "control:one",
      origin: template,
    });
    const changed = catalog({
      "request:one": asset("request:one", "record-request"),
      "control:one": asset("control:one", "select-control", { contentDigest: digest("f") }),
    });

    const firstRemoval = reduceWorkbenchAction(changed, twice.state, {
      type: "remove-root",
      assetId: "control:one",
      origin: administrator,
    });
    expect(firstRemoval).toMatchObject({
      accepted: true,
      state: { roots: [{ origin: template }] },
    });
    expect(
      reduceWorkbenchAction(changed, firstRemoval.state, {
        type: "remove-root",
        assetId: "control:one",
        origin: template,
      }),
    ).toMatchObject({ accepted: true, state: createWorkbenchState() });
  });

  it("applies template roots and exclusions transactionally", () => {
    const template = {
      id: "template:baseline",
      digest: digest("a"),
      roots: [{ assetId: "control:one", mode: "select" as const, includeOptionalMembers: false }],
      exclusions: ["request:one"],
    };
    const withTemplate = catalog(base.assets, [], { [template.id]: template });
    const result = reduceWorkbenchAction(withTemplate, createWorkbenchState(), {
      type: "apply-template",
      templateId: template.id,
    });
    expect(result).toMatchObject({
      accepted: true,
      state: {
        roots: [{ assetId: "control:one", origin: { kind: "template", id: template.id } }],
        exclusions: [{ assetId: "request:one", origin: { kind: "template", id: template.id } }],
      },
    });
    const removed = reduceWorkbenchAction(withTemplate, result.state, {
      type: "remove-template",
      templateId: template.id,
      digest: template.digest,
    });
    expect(removed).toMatchObject({ accepted: true, state: { roots: [], exclusions: [] } });
  });

  it("removes only a template's exact roots and exclusions", () => {
    const template = {
      id: "template:shared",
      digest: digest("a"),
      roots: [{ assetId: "control:one", mode: "select" as const, includeOptionalMembers: false }],
      exclusions: ["request:one"],
    };
    const withTemplate = catalog(base.assets, [], { [template.id]: template });
    const adminExcluded = reduceWorkbenchAction(withTemplate, createWorkbenchState(), {
      type: "add-exclusion",
      assetId: "request:one",
      origin: administrator,
    });
    const applied = reduceWorkbenchAction(withTemplate, adminExcluded.state, {
      type: "apply-template",
      templateId: template.id,
    });
    const removed = reduceWorkbenchAction(withTemplate, applied.state, {
      type: "remove-template",
      templateId: template.id,
      digest: template.digest,
    });
    expect(removed).toMatchObject({
      accepted: true,
      state: { roots: [], exclusions: [{ assetId: "request:one", origin: administrator }] },
    });
  });
  it("suppresses an excluded optional member but rejects a required exclusion", () => {
    const graph = catalog(
      {
        "control:root": asset("control:root", "select-control"),
        "control:child": asset("control:child", "select-control"),
      },
      [
        {
          fromAssetId: "control:root",
          toAssetId: "control:child",
          kind: "member",
          membership: "optional",
        },
      ],
    );
    const root = reduceWorkbenchAction(graph, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:root",
      origin: administrator,
      includeOptionalMembers: true,
    });
    const excluded = reduceWorkbenchAction(graph, root.state, {
      type: "add-exclusion",
      assetId: "control:child",
      origin: administrator,
    });
    expect(resolveWorkbenchSelection(graph, excluded.state).assetIds).toEqual(["control:root"]);
    const requiredGraph = catalog(graph.assets, [
      { fromAssetId: "control:root", toAssetId: "control:child", kind: "requires" },
    ]);
    expect(
      reduceWorkbenchAction(requiredGraph, root.state, {
        type: "add-exclusion",
        assetId: "control:child",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: false, diagnostics: [{ code: "excluded-required-asset" }] });
  });

  it("keeps structural roots as provenance while selecting required children", () => {
    const graph = catalog(
      {
        "control:root": asset("control:root", "select-control"),
        "control:child": asset("control:child", "select-control"),
      },
      [{ fromAssetId: "control:root", toAssetId: "control:child", kind: "requires" }],
    );
    const state = reduceWorkbenchAction(graph, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:root",
      origin: administrator,
      mode: "structural",
    }).state;
    expect(resolveWorkbenchSelection(graph, state).assetIds).toEqual(["control:child"]);
    expect(workbenchSelectionCounts(graph, state).rootCount).toBe(1);
  });

  it("diagnoses stale exclusions while allowing their direct removal", () => {
    const excluded = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "add-exclusion",
      assetId: "request:one",
      origin: administrator,
    });
    const changed = catalog({
      "request:one": asset("request:one", "record-request", { contentDigest: digest("f") }),
      "control:one": asset("control:one", "select-control"),
    });
    expect(
      reduceWorkbenchAction(changed, excluded.state, {
        type: "restore-state",
        state: excluded.state,
      }),
    ).toMatchObject({ accepted: false, diagnostics: [{ code: "unknown-asset" }] });
    expect(
      reduceWorkbenchAction(changed, excluded.state, {
        type: "remove-exclusion",
        assetId: "request:one",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: true, state: { exclusions: [] } });
  });
  it("keeps a shared prerequisite when one of two roots is removed, including a cycle", () => {
    const graph = catalog(
      {
        "control:a": asset("control:a", "select-control"),
        "control:b": asset("control:b", "select-control"),
        "control:shared": asset("control:shared", "select-control"),
      },
      [
        { fromAssetId: "control:a", toAssetId: "control:b", kind: "requires" },
        { fromAssetId: "control:b", toAssetId: "control:a", kind: "requires" },
        { fromAssetId: "control:a", toAssetId: "control:shared", kind: "requires" },
        { fromAssetId: "control:b", toAssetId: "control:shared", kind: "requires" },
      ],
    );
    const first = reduceWorkbenchAction(graph, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:a",
      origin: administrator,
    });
    const template = { kind: "template", id: "template:b", digest: digest("a") } as const;
    const second = reduceWorkbenchAction(graph, first.state, {
      type: "select-root",
      assetId: "control:b",
      origin: template,
    });
    const removed = reduceWorkbenchAction(graph, second.state, {
      type: "remove-root",
      assetId: "control:a",
      origin: administrator,
    });
    expect(resolveWorkbenchSelection(graph, removed.state).assetIds).toEqual([
      "control:a",
      "control:b",
      "control:shared",
    ]);
  });

  it("lets a required path override an optional path to the same excluded leaf", () => {
    const graph = catalog(
      {
        "control:root": asset("control:root", "select-control"),
        "control:middle": asset("control:middle", "select-control"),
        "control:leaf": asset("control:leaf", "select-control"),
      },
      [
        {
          fromAssetId: "control:root",
          toAssetId: "control:leaf",
          kind: "member",
          membership: "optional",
        },
        { fromAssetId: "control:root", toAssetId: "control:middle", kind: "requires" },
        { fromAssetId: "control:middle", toAssetId: "control:leaf", kind: "requires" },
      ],
    );
    const selected = reduceWorkbenchAction(graph, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:root",
      origin: administrator,
      includeOptionalMembers: true,
    });
    expect(
      reduceWorkbenchAction(graph, selected.state, {
        type: "add-exclusion",
        assetId: "control:leaf",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: false, diagnostics: [{ code: "excluded-required-asset" }] });
  });

  it("removes one origin while preserving the other exact root", () => {
    const template = { kind: "template", id: "template:one", digest: digest("a") } as const;
    const first = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:one",
      origin: administrator,
    });
    const both = reduceWorkbenchAction(base, first.state, {
      type: "select-root",
      assetId: "control:one",
      origin: template,
    });
    expect(
      reduceWorkbenchAction(base, both.state, {
        type: "remove-root",
        assetId: "control:one",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: true, state: { roots: [{ origin: template }] } });
    expect(
      reduceWorkbenchAction(base, both.state, {
        type: "remove-root",
        assetId: "control:one",
        origin: template,
      }),
    ).toMatchObject({ accepted: true, state: { roots: [{ origin: administrator }] } });
  });
  it("allows the same methodology profile under multiple origins", () => {
    const methods = catalog({
      "method:ecc": asset("method:ecc", "record-selection", {
        exclusiveSlot: "methodology",
        methodologyKey: "ecc",
      }),
    });
    const first = reduceWorkbenchAction(methods, createWorkbenchState(), {
      type: "select-root",
      assetId: "method:ecc",
      origin: administrator,
    });
    expect(
      reduceWorkbenchAction(methods, first.state, {
        type: "select-root",
        assetId: "method:ecc",
        origin: { kind: "template", id: "template:ecc", digest: digest("a") },
      }),
    ).toMatchObject({ accepted: true });
  });
  it("removes template requests by exact origin while preserving other versions and administrators", () => {
    const graph = catalog({ "request:one": asset("request:one", "record-request") });
    const template = { kind: "template", id: "template:one", digest: digest("a") } as const;
    const otherVersion = { ...template, digest: digest("c") };
    let state = createWorkbenchState();
    for (const origin of [template, otherVersion, administrator]) {
      const result = reduceWorkbenchAction(graph, state, {
        type: "record-request",
        assetId: "request:one",
        origin,
      });
      expect(result.accepted).toBe(true);
      state = result.state;
    }
    const result = previewWorkbenchTransactionV1(graph, state, [
      {
        type: "remove-template",
        templateId: template.id,
        digest: template.digest,
      },
    ]);
    expect(result.accepted).toBe(true);
    expect(result.state.requests.map((request) => request.origin)).toEqual(
      expect.arrayContaining([otherVersion, administrator]),
    );
    expect(result.state.requests).toHaveLength(2);
    expect(result.changes.requests.removed.map((request) => request.origin)).toEqual([template]);
  });
  it("rolls back an indirect methodology conflict", () => {
    const methods = catalog(
      {
        "control:root": asset("control:root", "select-control"),
        "method:ecc": asset("method:ecc", "record-selection", {
          exclusiveSlot: "methodology",
          methodologyKey: "ecc",
        }),
        "method:other": asset("method:other", "record-selection", {
          exclusiveSlot: "methodology",
          methodologyKey: "other",
        }),
      },
      [
        { fromAssetId: "control:root", toAssetId: "method:ecc", kind: "requires" },
        { fromAssetId: "control:root", toAssetId: "method:other", kind: "requires" },
      ],
    );
    expect(
      reduceWorkbenchAction(methods, createWorkbenchState(), {
        type: "select-root",
        assetId: "control:root",
        origin: administrator,
      }),
    ).toMatchObject({ accepted: false, diagnostics: [{ code: "methodology-conflict" }] });
  });

  it("verifies exact serialized draft bytes only in the Core verifier", () => {
    const bytesBase64 = Buffer.from('{"draft":true}', "utf8").toString("base64");
    const draft = {
      id: "draft:one",
      declaration: {
        kind: "organization-manifest" as const,
        bytesBase64,
        byteLength: 14,
        digest: "sha256:7eaa58740d42b13ae37e1946a9471552f3a2b276d13687d4c10ee05f81dcc4c5",
      },
    };
    expect(verifyWorkbenchDraftBytesV1(draft)).toEqual(draft);
    expect(() =>
      verifyWorkbenchDraftBytesV1({
        ...draft,
        declaration: { ...draft.declaration, byteLength: 13 },
      }),
    ).toThrow(/byte length/);
  });
  it("rejects duplicate or noncanonical serialized state and cross-source evidence subjects", () => {
    const root = reduceWorkbenchAction(base, createWorkbenchState(), {
      type: "select-root",
      assetId: "control:one",
      origin: administrator,
    }).state.roots[0]!;
    expect(
      WorkbenchStateV1Schema.safeParse({
        roots: [root, root],
        exclusions: [],
        requests: [],
        drafts: [],
      }).success,
    ).toBe(false);
    const invalid = {
      ...base,
      evidence: {
        "evidence:one": {
          id: "evidence:one",
          projectionVersion: "evidence-summary/v1",
          subjects: [
            {
              assetId: "control:one",
              sourceId: "source:other",
              sourceRevisionId,
              contentDigest: digest("b"),
            },
          ],
          evidenceDigest: digest("e"),
          coveredPaths: ["evidence/one.json"],
          verification: { state: "unverified" },
          scan: { outcome: "unknown", coverage: "none" },
          qualification: { state: "unknown" },
          findings: [],
        },
      },
    };
    expect(() => parseAuthoringCatalogBundleV1(invalid)).toThrow(
      /Evidence subject must exactly match/,
    );
  });
});
