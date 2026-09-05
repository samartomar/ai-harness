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
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
  workbenchSelectionCounts,
} from "../../../src/org-policy/workbench/selection-engine.js";

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
