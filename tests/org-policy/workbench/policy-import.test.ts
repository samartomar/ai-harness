import { describe, expect, it } from "vitest";
import {
  projectWorkbenchPolicy,
  type WorkbenchPolicyBindingsV1,
} from "../../../src/org-policy/workbench/compile-policy.js";
import {
  importWorkbenchPolicySelections,
  serializeWorkbenchRepairV1,
} from "../../../src/org-policy/workbench/policy-import.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";
import { fixture } from "./authoring-fixture.js";

describe("portable selection import", () => {
  it("compares omitted V2 candidate defaults without coercing explicit invalid values", () => {
    const { bundle, bindings, policy } = fixture();
    const expected = { ...bindings.tool!.candidate!, findings: [], autoExecute: false };
    bindings.tool!.candidate = expected;
    const { findings: _findings, autoExecute: _autoExecute, ...omitted } = expected;
    const imported = (candidate: unknown) =>
      importWorkbenchPolicySelections(
        {
          ...policy,
          governance: {
            catalog: { reviewed: [candidate] },
            activations: [{ candidate: expected.id, state: "active", targets: expected.targets }],
          },
        },
        bundle,
        bindings,
      );
    expect(imported(omitted)).toMatchObject({ accepted: true });
    expect(imported({ ...omitted, findings: null })).toMatchObject({ accepted: false });
    expect(imported({ ...omitted, autoExecute: null })).toMatchObject({ accepted: false });
    expect(imported({ ...omitted, autoExecute: true })).toMatchObject({ accepted: false });
    expect(omitted).not.toHaveProperty("findings");
    expect(omitted).not.toHaveProperty("autoExecute");
  });

  it("restores exact v3 state without deriving new pins or origins", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("external");
    expect(
      importWorkbenchPolicySelections(
        {
          ...policy,
          schemaVersion: 3,
          minimumCoreVersion: "0.6.0",
          authoringSelections: { selectionVersion: "workbench-selection/v1", ...state },
        },
        bundle,
        bindings,
      ),
    ).toEqual({ accepted: true, state, diagnostics: [] });
  });
  it("preserves stale and missing saved roots for review and removal", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("external", "other");
    bundle.assets.external!.contentDigest = "sha256:" + "c".repeat(64);
    delete bundle.assets.other;
    const result = importWorkbenchPolicySelections(
      {
        ...policy,
        schemaVersion: 3,
        minimumCoreVersion: "0.6.0",
        authoringSelections: { selectionVersion: "workbench-selection/v1", ...state },
      },
      bundle,
      bindings,
    );
    expect(result.accepted).toBe(true);
    expect(result.state).toEqual(state);
    expect(result.diagnostics).toEqual([
      "Missing saved asset: other",
      "Stale saved asset: external",
      "Stale saved asset: other",
    ]);
  });
  it("keeps missing or stale exclusion-only imports in repair until exact removal", () => {
    for (const missing of [true, false]) {
      const { bundle, bindings, policy } = fixture();
      const state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
        type: "add-exclusion",
        assetId: "other",
        origin: { kind: "administrator" },
      }).state;
      if (missing) delete bundle.assets.other;
      else bundle.assets.other!.contentDigest = "sha256:" + "f".repeat(64);
      const input = {
        ...policy,
        schemaVersion: 3,
        minimumCoreVersion: "0.6.0",
        authoringSelections: { selectionVersion: "workbench-selection/v1", ...state },
      };
      expect(projectWorkbenchPolicy(input, state, bundle, bindings)).toMatchObject({
        accepted: false,
        diagnostics: ["Stale or missing exclusion identity: other"],
      });
      expect(importWorkbenchPolicySelections(input, bundle, bindings)).toEqual({
        accepted: true,
        state,
        diagnostics: [(missing ? "Missing" : "Stale") + " saved exclusion: other"],
      });
      expect(
        serializeWorkbenchRepairV1(
          input,
          state,
          {
            type: "remove-exclusion",
            assetId: "other",
            origin: { kind: "administrator" },
          },
          bundle,
          bindings,
        ),
      ).toMatchObject({
        accepted: false,
        state: createWorkbenchState(),
        diagnostics: ["Repair is complete; regenerate the policy through normal projection"],
      });
      expect(projectWorkbenchPolicy(input, createWorkbenchState(), bundle, bindings)).toMatchObject(
        { accepted: true },
      );
    }
  });
  it("rejects a live structural root whose action drifts outside its saved closure", () => {
    const { bundle, bindings, policy } = fixture();
    const state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: "external",
      origin: { kind: "administrator" },
      mode: "structural",
    }).state;
    bundle.assets.external!.authoring.action = "record-request";
    const result = importWorkbenchPolicySelections(
      {
        ...policy,
        schemaVersion: 3,
        minimumCoreVersion: "0.6.0",
        authoringSelections: { selectionVersion: "workbench-selection/v1", ...state },
      },
      bundle,
      bindings,
    );
    expect(result).toEqual({
      accepted: false,
      state: createWorkbenchState(),
      diagnostics: ["Saved structural root no longer supports selection: external"],
    });
  });
  it("rejects changed request and selection actions without applying saved intent", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = reduceWorkbenchAction(bundle, select("tool"), {
      type: "record-request",
      assetId: "request",
      origin: { kind: "administrator" },
    }).state;
    bundle.assets.tool!.authoring.action = "record-request";
    bundle.assets.request!.authoring.action = "record-selection";
    const result = importWorkbenchPolicySelections(
      {
        ...policy,
        schemaVersion: 3,
        minimumCoreVersion: "0.6.0",
        authoringSelections: { selectionVersion: "workbench-selection/v1", ...state },
      },
      bundle,
      bindings,
    );
    expect(result).toEqual({
      accepted: false,
      state: createWorkbenchState(),
      diagnostics: [
        "Saved asset no longer supports selection: tool",
        "Saved request no longer supports requests: request",
      ],
    });
  });
  it("rolls back V3 imports with live conflicts or competing methodology keys", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("external", "other");
    const input = {
      ...policy,
      schemaVersion: 3,
      minimumCoreVersion: "0.6.0",
      authoringSelections: { selectionVersion: "workbench-selection/v1", ...state },
    };
    bundle.relations.push({ kind: "conflicts", fromAssetId: "external", toAssetId: "other" });
    expect(importWorkbenchPolicySelections(input, bundle, bindings)).toEqual({
      accepted: false,
      state: createWorkbenchState(),
      diagnostics: ["Conflicting selections: external, other"],
    });

    bundle.relations.pop();
    bundle.assets.external!.exclusiveSlot = "methodology";
    bundle.assets.external!.methodologyKey = "ecc";
    bundle.assets.other!.exclusiveSlot = "methodology";
    bundle.assets.other!.methodologyKey = "superpowers";
    expect(importWorkbenchPolicySelections(input, bundle, bindings)).toEqual({
      accepted: false,
      state: createWorkbenchState(),
      diagnostics: ["Multiple methodology profiles: ecc, superpowers"],
    });
  });
  it("rejects malformed versions and malformed state transactionally", () => {
    const { bundle, bindings } = fixture();
    expect(importWorkbenchPolicySelections({}, bundle, bindings).accepted).toBe(false);
    expect(
      importWorkbenchPolicySelections(
        { schemaVersion: 3, minimumCoreVersion: "0.6.0", authoringSelections: {} },
        bundle,
        bindings,
      ).accepted,
    ).toBe(false);
  });
  it("rejects missing, malformed, and future V3 Core version floors", () => {
    const { bundle, bindings, policy } = fixture();
    const authoringSelections = {
      selectionVersion: "workbench-selection/v1",
      ...createWorkbenchState(),
    };
    for (const minimumCoreVersion of [undefined, 6, "0.6.1"] as const) {
      const value = {
        ...policy,
        schemaVersion: 3,
        ...(minimumCoreVersion === undefined ? {} : { minimumCoreVersion }),
        authoringSelections,
      };
      expect(importWorkbenchPolicySelections(value, bundle, bindings)).toEqual({
        accepted: false,
        state: createWorkbenchState(),
        diagnostics: ["Unsupported or missing minimum compatible Core version"],
      });
    }
  });
  it("preserves administrator clarification and sanctioned target narrowing across V2 migration", () => {
    const { bundle, bindings, policy } = fixture();
    const control = bindings.tool?.candidate;
    const asset = bundle.assets.tool;
    if (!control || !asset) throw new Error("fixture control missing");
    control.targets = ["claude", "codex"];
    asset.authoring.supportedTargets = ["claude", "codex"];
    const input = {
      ...policy,
      governance: {
        supportedClis: ["codex"],
        catalog: { reviewed: [control] },
        activations: [
          {
            candidate: control.id,
            state: "active",
            targets: ["codex"],
            clarification: "Requested by: administrator",
          },
        ],
      },
    };
    const imported = importWorkbenchPolicySelections(input, bundle, bindings);
    expect(imported.accepted).toBe(true);
    expect(imported.state.roots).toMatchObject([
      { assetId: "tool", origin: { kind: "administrator" } },
    ]);
    const projected = projectWorkbenchPolicy(input, imported.state, bundle, bindings);
    expect(projected.accepted).toBe(true);
    expect((projected.policy.governance as Record<string, unknown>).activations).toEqual([
      {
        candidate: "tool",
        state: "active",
        targets: ["codex"],
        clarification: "Requested by: administrator",
      },
    ]);
  });
  it("serializes only one exact stale V3 removal and keeps remaining intent inert", () => {
    const { bundle, bindings, policy, select } = fixture();
    let state = select("external", "other");
    state = reduceWorkbenchAction(bundle, state, {
      type: "record-request",
      assetId: "request",
      origin: { kind: "administrator" },
    }).state;
    state = reduceWorkbenchAction(bundle, state, {
      type: "add-exclusion",
      assetId: "package",
      origin: { kind: "administrator" },
    }).state;
    const input = {
      ...policy,
      schemaVersion: 3,
      minimumCoreVersion: "0.6.0",
      authoringSelections: { selectionVersion: "workbench-selection/v1" as const, ...state },
    };
    const before = structuredClone(input);
    bundle.assets.external!.contentDigest = "sha256:" + "b".repeat(64);
    bundle.assets.other!.contentDigest = "sha256:" + "c".repeat(64);
    bundle.assets.request!.contentDigest = "sha256:" + "d".repeat(64);

    const rootRepair = serializeWorkbenchRepairV1(
      input,
      state,
      { type: "remove-root", assetId: "external", origin: { kind: "administrator" } },
      bundle,
      bindings,
    );
    expect(rootRepair).toMatchObject({ accepted: true, inert: true });
    expect(rootRepair.diagnostics).toEqual([
      "Stale or unavailable saved request: request",
      "Stale saved asset: other",
    ]);
    expect(rootRepair.policy?.authoringSelections).not.toEqual(input.authoringSelections);
    expect(
      projectWorkbenchPolicy(rootRepair.policy!, rootRepair.state, bundle, bindings),
    ).toMatchObject({ accepted: false });
    expect(input).toEqual(before);

    const requestRepair = serializeWorkbenchRepairV1(
      input,
      state,
      { type: "remove-request", assetId: "request", origin: { kind: "administrator" } },
      bundle,
      bindings,
    );
    expect(requestRepair).toMatchObject({ accepted: true, inert: true });
    expect(requestRepair.diagnostics).toContain("Stale saved asset: external");

    const exclusionRepair = serializeWorkbenchRepairV1(
      input,
      state,
      { type: "remove-exclusion", assetId: "package", origin: { kind: "administrator" } },
      bundle,
      bindings,
    );
    expect(exclusionRepair).toMatchObject({ accepted: true, inert: true });
    expect(exclusionRepair.diagnostics).toContain("Stale saved asset: external");

    expect(
      serializeWorkbenchRepairV1(
        input,
        state,
        { type: "remove-root", assetId: "external", origin: { kind: "legacy-unattributed" } },
        bundle,
        bindings,
      ),
    ).toMatchObject({ accepted: false });
    expect(
      serializeWorkbenchRepairV1(
        input,
        state,
        { type: "remove-exclusion", assetId: "request", origin: { kind: "administrator" } },
        bundle,
        bindings,
      ),
    ).toMatchObject({ accepted: false });
    expect(
      serializeWorkbenchRepairV1(
        input,
        state,
        { type: "select-root", assetId: "external", origin: { kind: "administrator" } },
        bundle,
        bindings,
      ),
    ).toMatchObject({ accepted: false });
  });
  it("requires an exact template digest for stale template removal", () => {
    const { bundle, bindings, policy } = fixture();
    const digest = "sha256:" + "e".repeat(64);
    bundle.templates["template:repair"] = {
      id: "template:repair",
      roots: [{ assetId: "external", mode: "select", includeOptionalMembers: false }],
      exclusions: [],
      digest,
    };
    let state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "apply-template",
      templateId: "template:repair",
    }).state;
    state = reduceWorkbenchAction(bundle, state, {
      type: "select-root",
      assetId: "other",
      origin: { kind: "administrator" },
    }).state;
    const input = {
      ...policy,
      schemaVersion: 3,
      minimumCoreVersion: "0.6.0",
      authoringSelections: { selectionVersion: "workbench-selection/v1" as const, ...state },
    };
    bundle.assets.external!.contentDigest = "sha256:" + "f".repeat(64);
    bundle.assets.other!.contentDigest = "sha256:" + "c".repeat(64);
    expect(
      serializeWorkbenchRepairV1(
        input,
        state,
        {
          type: "remove-template",
          templateId: "template:repair",
          digest: "sha256:" + "a".repeat(64),
        },
        bundle,
        bindings,
      ),
    ).toMatchObject({ accepted: false });
    expect(
      serializeWorkbenchRepairV1(
        input,
        state,
        { type: "remove-template", templateId: "template:repair", digest },
        bundle,
        bindings,
      ),
    ).toMatchObject({ accepted: true, inert: true });
  });

  it("migrates exact legacy sources and requests without inventing template ownership", () => {
    const { bundle, bindings, policy } = fixture();
    bindings.request = { kind: "intent", legacyRequestId: "legacy-request", legacyRequestOrder: 0 };
    const input = {
      ...policy,
      governance: {
        externalSelections: [{ framework: "acme", items: [bindings.external!.external!.item] }],
        aihMcpRequests: [{ id: "legacy-request" }],
      },
      capabilityPackages: { catalog: { repository: "acme/catalog" }, roots: ["skill:test"] },
    };
    const result = importWorkbenchPolicySelections(input, bundle, bindings);
    expect(result.accepted).toBe(true);
    expect(result.state.roots.map((root) => [root.assetId, root.origin.kind])).toEqual([
      ["external", "legacy-unattributed"],
      ["package", "legacy-unattributed"],
    ]);
    expect(result.state.requests[0]).toMatchObject({
      assetId: "request",
      origin: { kind: "legacy-unattributed" },
    });
    expect(input.governance.aihMcpRequests).toEqual([{ id: "legacy-request" }]);
  });
  it("retains V2 external group, identity, curation, and closure safeguards", () => {
    const externalInput = (overrides: Record<string, unknown> = {}) => {
      const { bundle, bindings, policy } = fixture();
      bindings.other = {
        kind: "external-selection",
        external: {
          owner: "acme",
          item: {
            ...bindings.external!.external!.item,
            id: "skill:other",
          },
        },
      };
      return {
        bundle,
        bindings,
        policy,
        input: {
          ...policy,
          governance: {
            externalSelections: [
              {
                framework: "acme",
                items: [bindings.external!.external!.item],
                ...overrides,
              },
            ],
          },
        },
      };
    };
    const reject = (overrides: Record<string, unknown>, message: string) => {
      const { bundle, bindings, input } = externalInput(overrides);
      const result = importWorkbenchPolicySelections(input, bundle, bindings);
      expect(result).toMatchObject({ accepted: false, state: createWorkbenchState() });
      expect(result.diagnostics).toContain(message);
    };
    reject(
      {
        items: [
          fixture().bindings.external!.external!.item,
          fixture().bindings.external!.external!.item,
        ],
      },
      "Legacy source item is duplicated: skill:external",
    );
    reject({ roots: ["skill:missing"] }, "Legacy source root is not an item: skill:missing");
    reject(
      { roots: ["skill:external", "skill:external"] },
      "Legacy source root is duplicated: skill:external",
    );
    reject(
      { unattributedItems: ["skill:external", "skill:external"] },
      "Legacy unattributed source item is duplicated: skill:external",
    );
    reject(
      { unattributedItems: ["skill:missing"] },
      "Legacy unattributed source item is not an item: skill:missing",
    );
    reject(
      { roots: ["skill:external"], unattributedItems: ["skill:external"] },
      "Legacy source item is both root and unattributed: skill:external",
    );
    const curation = externalInput();
    (curation.input.governance as Record<string, unknown>).externalCuration = [
      { framework: "acme", items: [{ id: "skill:external" }] },
    ];
    expect(
      importWorkbenchPolicySelections(curation.input, curation.bundle, curation.bindings),
    ).toMatchObject({
      accepted: false,
      diagnostics: ["Legacy source item is both selected and curated: skill:external"],
    });
    const drifted = externalInput({
      items: [
        {
          ...fixture().bindings.external!.external!.item,
          source: { repository: "acme/other", commit: "b".repeat(40), path: "skill.md" },
        },
      ],
    });
    expect(
      importWorkbenchPolicySelections(drifted.input, drifted.bundle, drifted.bindings),
    ).toMatchObject({
      accepted: false,
      diagnostics: ["Legacy source items do not match the prepared catalog: acme"],
    });
    const unreachable = externalInput({
      roots: ["skill:external"],
      items: [
        fixture().bindings.external!.external!.item,
        { ...fixture().bindings.external!.external!.item, id: "skill:other" },
      ],
    });
    expect(
      importWorkbenchPolicySelections(unreachable.input, unreachable.bundle, unreachable.bindings),
    ).toMatchObject({
      accepted: false,
      diagnostics: [
        "Legacy source item is not reachable from a root or preserved item: skill:other",
      ],
    });
  });

  it("retains V2 one-owner and duplicate-source-group rules", () => {
    const { bundle, bindings, policy } = fixture();
    const item = bindings.external!.external!.item;
    const duplicate = importWorkbenchPolicySelections(
      {
        ...policy,
        governance: {
          externalSelections: [
            { framework: "acme", items: [item] },
            { framework: "acme", items: [item] },
          ],
        },
      },
      bundle,
      bindings,
    );
    expect(duplicate).toMatchObject({
      accepted: false,
      diagnostics: ["Legacy source group is duplicated: acme"],
    });
    bindings.other = {
      kind: "external-selection",
      external: { owner: "different", item: { ...item, id: "skill:other" } },
    };
    const owners = importWorkbenchPolicySelections(
      {
        ...policy,
        governance: {
          externalSelections: [
            { framework: "acme", items: [item] },
            { framework: "different", items: [bindings.other.external!.item] },
          ],
        },
      },
      bundle,
      bindings,
    );
    expect(owners).toMatchObject({
      accepted: false,
      diagnostics: ["Legacy policy permits only one external source owner"],
    });
  });

  it("retains V2 request identity, order, and candidate collision safeguards", () => {
    const requestInput = (requests: unknown[], bindingsPatch: WorkbenchPolicyBindingsV1) => {
      const { bundle, bindings, policy } = fixture();
      Object.assign(bindings, bindingsPatch);
      return importWorkbenchPolicySelections(
        { ...policy, governance: { aihMcpRequests: requests } },
        bundle,
        bindings,
      );
    };
    const duplicate = requestInput([{ id: "one" }, { id: "one" }], {
      request: { kind: "intent", legacyRequestId: "one", legacyRequestOrder: 0 },
    });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.diagnostics).toContain("Legacy request is duplicated: one");
    const outOfOrder = requestInput([{ id: "two" }, { id: "one" }], {
      request: { kind: "intent", legacyRequestId: "one", legacyRequestOrder: 0 },
      other: { kind: "intent", legacyRequestId: "two", legacyRequestOrder: 1 },
    });
    expect(outOfOrder.accepted).toBe(false);
    expect(outOfOrder.diagnostics).toContain(
      "Legacy requests do not follow the pinned declaration order",
    );
    const { bundle, bindings, policy } = fixture();
    bindings.request = { kind: "intent", legacyRequestId: "tool", legacyRequestOrder: 0 };
    const collision = importWorkbenchPolicySelections(
      {
        ...policy,
        governance: { aihMcpRequests: [{ id: "tool" }], catalog: { reviewed: [{ id: "tool" }] } },
      },
      bundle,
      bindings,
    );
    expect(collision).toMatchObject({
      accepted: false,
      diagnostics: ["Legacy request collides with a selectable candidate: tool"],
    });
  });

  it("migrates explicit source roots while retaining derived dependency pins", () => {
    const { bundle, bindings, policy } = fixture();
    bindings.other = {
      kind: "external-selection",
      external: {
        owner: "acme",
        item: { ...bindings.external!.external!.item, id: "skill:other" },
      },
    };
    bundle.relations.push({ kind: "requires", fromAssetId: "external", toAssetId: "other" });
    const input = {
      ...policy,
      governance: {
        externalSelections: [
          {
            framework: "acme",
            roots: ["skill:external"],
            items: [bindings.external!.external!.item, bindings.other.external!.item],
          },
        ],
      },
    };
    const result = importWorkbenchPolicySelections(input, bundle, bindings);
    expect(result.accepted).toBe(true);
    expect(result.state.roots).toHaveLength(1);
    expect(result.state.roots[0]).toMatchObject({
      origin: { kind: "administrator" },
      resolvedItems: [{ assetId: "external" }, { assetId: "other" }],
    });
  });
  it("rejects legacy drift, unknown packages/requests, and narrowed inactive controls without data loss", () => {
    const { bundle, bindings, policy } = fixture();
    const input = {
      ...policy,
      governance: {
        catalog: { reviewed: [bindings.tool!.candidate] },
        activations: [{ candidate: "tool", state: "inactive", targets: ["codex"] }],
        externalSelections: [{ framework: "acme", items: [{ id: "unknown" }] }],
        aihMcpRequests: [{ id: "unknown" }],
      },
      capabilityPackages: { catalog: { repository: "acme/catalog" }, roots: ["unknown"] },
    };
    const before = structuredClone(input);
    const result = importWorkbenchPolicySelections(input, bundle, bindings);
    expect(result.accepted).toBe(false);
    expect(result.state).toEqual(createWorkbenchState());
    expect(result.diagnostics).toHaveLength(4);
    expect(input).toEqual(before);
  });
  it("migrates an exact active control with sanctioned targets and rejects newly introduced dependencies", () => {
    const { bundle, bindings, policy } = fixture();
    const input = {
      ...policy,
      governance: {
        supportedClis: ["codex"],
        catalog: { reviewed: [bindings.tool!.candidate] },
        activations: [{ candidate: "tool", state: "active", targets: ["codex"] }],
      },
    };
    expect(importWorkbenchPolicySelections(input, bundle, bindings).state.roots[0]?.assetId).toBe(
      "tool",
    );
    bundle.relations.push({ kind: "requires", fromAssetId: "external", toAssetId: "other" });
    bindings.other = { ...bindings.external! };
    const legacy = {
      ...policy,
      governance: {
        externalSelections: [
          {
            framework: "acme",
            roots: ["skill:external"],
            items: [bindings.external!.external!.item],
          },
        ],
      },
    };
    expect(importWorkbenchPolicySelections(legacy, bundle, bindings).accepted).toBe(false);
  });
});
