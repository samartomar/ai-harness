import { describe, expect, it } from "vitest";
import { projectWorkbenchPolicy } from "../../../src/org-policy/workbench/compile-policy.js";
import type { WorkbenchStateV1 } from "../../../src/org-policy/workbench/contracts.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";

const origin = { kind: "administrator" } as const;

import { fixture } from "./authoring-fixture.js";

describe("pure policy compilation", () => {
  it("rejects an exported policy over the Core byte limit without replacing the input", () => {
    const { bundle, bindings, policy } = fixture();
    const oversized = {
      ...policy,
      command: {
        deny: { add: [{ pattern: "界".repeat(334_000), reason: "bounded export" }], remove: [] },
      },
    };
    expect(projectWorkbenchPolicy(oversized, createWorkbenchState(), bundle, bindings)).toEqual({
      accepted: false,
      policy: oversized,
      diagnostics: ["Compiled policy exceeds the 1000000-byte Core reader limit"],
    });
  });

  it("projects controls through Core bindings while preserving authority and custom entries", () => {
    const { bundle, bindings, policy, select } = fixture();
    const input = {
      ...policy,
      governance: {
        supportedClis: ["codex"],
        catalog: { reviewed: [], custom: [{ id: "custom" }] },
        authority: { approvals: [{ id: "existing" }] },
        activations: [],
      },
    };
    const before = structuredClone(input);
    const result = projectWorkbenchPolicy(input, select("tool"), bundle, bindings);
    expect(result.accepted).toBe(true);
    expect(result.policy.governance).toMatchObject({
      catalog: { reviewed: [{ id: "tool" }], custom: [{ id: "custom" }] },
      authority: { approvals: [{ id: "existing" }] },
      activations: [{ candidate: "tool", state: "active", targets: ["codex"] }],
    });
    expect(input).toEqual(before);
    expect(result.policy.schemaVersion).toBe(3);
  });
  it("preserves ordinary ECC hook controls while replacing managed projections", () => {
    const { bundle, bindings, policy, select } = fixture();
    const eccHookControls = {
      profile: "standard",
      disabledIds: ["pre:observe", "post:quality-gate"],
    };
    const input = {
      ...policy,
      governance: {
        ...((policy as Record<string, unknown>).governance as Record<string, unknown>),
        eccHookControls,
      },
    };

    const result = projectWorkbenchPolicy(input, select("tool"), bundle, bindings);

    expect(result.accepted).toBe(true);
    expect((result.policy.governance as Record<string, unknown>).eccHookControls).toEqual(
      eccHookControls,
    );
  });
  it("separates pinned requests from controls and rejects stale request identities", () => {
    const { bundle, bindings, policy } = fixture();
    const state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "record-request",
      assetId: "request",
      origin,
    }).state;
    const result = projectWorkbenchPolicy(policy, state, bundle, bindings);
    expect(result.accepted).toBe(true);
    expect(result.policy.governance).toMatchObject({ activations: [], catalog: { reviewed: [] } });
    expect(result.policy.authoringSelections).toMatchObject({ requests: [{ assetId: "request" }] });
    state.requests[0]!.sourceRevisionId = "revision:old";
    expect(projectWorkbenchPolicy(policy, state, bundle, bindings)).toMatchObject({
      accepted: false,
      policy,
    });
  });
  it("rejects malformed state before it can project a policy", () => {
    const { bundle, bindings, policy } = fixture();
    const malformed = { ...createWorkbenchState(), roots: [{}] } as unknown as WorkbenchStateV1;
    expect(projectWorkbenchPolicy(policy, malformed, bundle, bindings)).toMatchObject({
      accepted: false,
      policy,
    });
  });
  it("refuses a selected control with no organization-sanctioned target", () => {
    const { bundle, bindings, policy, select } = fixture();
    const input = { ...policy, governance: { supportedClis: ["claude"] } };
    expect(projectWorkbenchPolicy(input, select("tool"), bundle, bindings)).toMatchObject({
      accepted: false,
      policy: input,
      diagnostics: ["No organization-sanctioned target for: tool"],
    });
  });
  it("refuses package roots that would require different catalogs", () => {
    const { bundle, bindings, policy, select } = fixture();
    const original = bundle.assets.package;
    if (!original) throw new Error("fixture package missing");
    bundle.assets["package:other"] = {
      ...original,
      id: "package:other",
      detailChunkId: "detail:package:other",
    };
    bindings["package:other"] = {
      kind: "package-root",
      packageRoot: { catalogRepository: "other/catalog", root: "skill:other" },
    };
    expect(
      projectWorkbenchPolicy(policy, select("package", "package:other"), bundle, bindings),
    ).toMatchObject({
      accepted: false,
      policy,
      diagnostics: ["Selected package roots require different catalogs"],
    });
  });
  it("rejects a changed dependency pin without mutating the policy", () => {
    const { bundle, bindings, policy, select } = fixture();
    bundle.relations.push({ kind: "requires", fromAssetId: "external", toAssetId: "other" });
    const state = select("external");
    bundle.assets.other!.contentDigest = "sha256:" + "b".repeat(64);
    expect(projectWorkbenchPolicy(policy, state, bundle, bindings)).toMatchObject({
      accepted: false,
      policy,
      diagnostics: ["Stale selected content: external", "Stale selected content: other"],
    });
  });
  it("rejects imported exclusions that contradict required selection", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("tool");
    const asset = bundle.assets.tool;
    if (!asset) throw new Error("fixture tool missing");
    state.exclusions.push({
      assetId: "tool",
      origin,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
    });
    expect(projectWorkbenchPolicy(policy, state, bundle, bindings).accepted).toBe(false);
  });
  it("rejects conflicting legacy fields during Core consumption", () => {
    const { bundle, bindings, policy, select } = fixture();
    const authored = projectWorkbenchPolicy(policy, select("tool"), bundle, bindings);
    const governance = authored.policy.governance as Record<string, unknown>;
    governance.activations = [{ candidate: "tool", state: "inactive", targets: ["codex"] }];
    expect(
      projectWorkbenchPolicy(authored.policy, select("tool"), bundle, bindings, "consume"),
    ).toMatchObject({ accepted: false });
  });
  it("round-trips the compiled projection through consumption", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("tool", "external", "package", "other");
    const authored = projectWorkbenchPolicy(policy, state, bundle, bindings);
    expect(authored.accepted).toBe(true);
    const consumed = projectWorkbenchPolicy(authored.policy, state, bundle, bindings, "consume");
    expect(consumed.accepted).toBe(true);
    expect(consumed.policy).toEqual(authored.policy);
  });
  it("keeps a structural external root only in v3 while projecting its required external leaf", () => {
    const { bundle, bindings, policy } = fixture();
    const external = bindings.external?.external;
    if (!external) throw new Error("fixture external binding missing");
    bindings.other = {
      kind: "external-selection",
      external: { owner: "acme", item: { ...external.item, id: "skill:other" } },
    };
    bundle.relations.push({ kind: "requires", fromAssetId: "external", toAssetId: "other" });
    const state = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: "external",
      origin,
      mode: "structural",
    }).state;

    const result = projectWorkbenchPolicy(policy, state, bundle, bindings);
    expect(result.accepted).toBe(true);
    expect(result.policy.authoringSelections).toMatchObject({
      roots: [{ assetId: "external", mode: "structural" }],
    });
    expect((result.policy.governance as Record<string, unknown>).externalSelections).toEqual([
      {
        framework: "acme",
        items: [{ ...external.item, id: "skill:other" }],
        roots: [],
        unattributedItems: ["skill:other"],
      },
    ]);
  });
  it("removes projected package roots when their last generic root is removed", () => {
    const { bundle, bindings, policy, select } = fixture();
    const authored = projectWorkbenchPolicy(policy, select("package"), bundle, bindings);
    const removed = projectWorkbenchPolicy(
      authored.policy,
      createWorkbenchState(),
      bundle,
      bindings,
    );
    expect(removed.accepted).toBe(true);
    expect(removed.policy.capabilityPackages).toBeUndefined();
  });
  it("rejects competing legacy package roots during consumption", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("package");
    const authored = projectWorkbenchPolicy(policy, state, bundle, bindings);
    authored.policy.capabilityPackages = {
      catalog: { provider: "github", repository: "acme/catalog" },
      roots: ["skill:wrong"],
    };
    expect(
      projectWorkbenchPolicy(authored.policy, state, bundle, bindings, "consume").accepted,
    ).toBe(false);
  });
  it("rejects unsupported selection actions and missing registered control bindings", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("tool");
    expect(projectWorkbenchPolicy(policy, state, bundle, {}).diagnostics).toContain(
      "Core control binding is missing: tool",
    );
    bundle.assets.tool!.authoring.action = "record-request";
    expect(projectWorkbenchPolicy(policy, state, bundle, bindings).accepted).toBe(false);
  });
  it("requires zero or one distinct methodology regardless of source ownership", () => {
    const { bundle, bindings, policy, select } = fixture();
    const state = select("external", "other");
    bundle.assets.external!.exclusiveSlot = "methodology";
    bundle.assets.external!.methodologyKey = "first";
    bundle.assets.other!.exclusiveSlot = "methodology";
    bundle.assets.other!.methodologyKey = "second";
    expect(projectWorkbenchPolicy(policy, state, bundle, bindings).accepted).toBe(false);
    bundle.assets.other!.methodologyKey = "first";
    expect(projectWorkbenchPolicy(policy, state, bundle, bindings).accepted).toBe(true);
    expect(projectWorkbenchPolicy(policy, createWorkbenchState(), bundle, bindings).accepted).toBe(
      true,
    );
  });
});

describe("legacy request projection", () => {
  function requestedFixture() {
    const result = fixture();
    const first = result.bundle.assets.request;
    if (!first) throw new Error("fixture request missing");
    result.bundle.assets["request:second"] = { ...first, id: "request:second" };
    result.bindings.request = {
      kind: "intent",
      legacyRequestId: "context7",
      legacyRequestOrder: 2,
    };
    result.bindings["request:second"] = {
      kind: "intent",
      legacyRequestId: "github",
      legacyRequestOrder: 0,
    };
    let state = createWorkbenchState();
    for (const assetId of ["request", "request:second"])
      state = reduceWorkbenchAction(result.bundle, state, {
        type: "record-request",
        assetId,
        origin,
      }).state;
    return { ...result, state };
  }
  it("mirrors exact administrator requests in the Core enum order and round trips", () => {
    const { bundle, bindings, policy, state } = requestedFixture();
    const result = projectWorkbenchPolicy(policy, state, bundle, bindings);
    expect(result.accepted).toBe(true);
    expect(result.policy.governance).toMatchObject({
      aihMcpRequests: [
        { id: "github", clarification: "Requested by: administrator" },
        { id: "context7", clarification: "Requested by: administrator" },
      ],
      activations: [],
      catalog: { reviewed: [] },
    });
    expect(projectWorkbenchPolicy(result.policy, state, bundle, bindings, "consume")).toEqual(
      result,
    );
  });
  it("keeps template and unattributed requests in the generic representation", () => {
    const { bundle, bindings, policy, state } = requestedFixture();
    const first = state.requests[0];
    const second = state.requests[1];
    if (!first || !second) throw new Error("fixture requests missing");
    first.origin = { kind: "legacy-unattributed" };
    second.origin = { kind: "template", id: "template:test", digest: "sha256:" + "c".repeat(64) };
    const result = projectWorkbenchPolicy(policy, state, bundle, bindings);
    expect(result.accepted).toBe(true);
    expect(result.policy.governance).not.toHaveProperty("aihMcpRequests");
    expect(result.policy.authoringSelections).toMatchObject({ requests: state.requests });
  });
  it("rejects competing legacy request fields rather than letting them prevail", () => {
    const { bundle, bindings, policy, state } = requestedFixture();
    const result = projectWorkbenchPolicy(policy, state, bundle, bindings);
    const governance = result.policy.governance as Record<string, unknown>;
    governance.aihMcpRequests = [
      { id: "playwright", clarification: "Requested by: administrator" },
    ];
    expect(projectWorkbenchPolicy(result.policy, state, bundle, bindings, "consume")).toMatchObject(
      {
        accepted: false,
        diagnostics: ["Legacy requests disagree with pinned authoring selections"],
      },
    );
  });
});
