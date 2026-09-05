import { describe, expect, it } from "vitest";
import { projectWorkbenchPolicy } from "../../../src/org-policy/workbench/compile-policy.js";
import {
  type WorkbenchAuthoringSourceV1,
  workbenchAuthoringSourcesBudgetIssueV1,
} from "../../../src/org-policy/workbench/contracts.js";
import {
  importWorkbenchPolicySelections,
  serializeWorkbenchRepairV1,
} from "../../../src/org-policy/workbench/policy-import.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";
import { fixture } from "./authoring-fixture.js";

function sourceFixture() {
  const test = fixture();
  const input: WorkbenchAuthoringSourceV1 = {
    kind: "organization-manifest",
    sourceId: "source:test",
    sourceRevisionId: "revision:1",
    inputFormat: "organization-authoring-manifest/v1",
    digest: "sha256:" + "a".repeat(64),
    byteLength: 2,
    bytesBase64: "e30=",
  };
  test.bundle.sources[input.sourceId] = {
    id: input.sourceId,
    distributor: { kind: "organization", locator: "acme/input" },
    upstreamOrigin: { kind: "organization", locator: "acme/input" },
    revision: { id: input.sourceRevisionId, contentDigest: input.digest },
    inputFormat: input.inputFormat,
    compiler: { id: "compiler:test", version: "1" },
    policyInputRequired: true,
  };
  return { ...test, input, inputs: { [input.sourceId]: input } };
}

describe("portable authoring source inputs", () => {
  it("carries only inputs referenced by pinned selections and removes them with the final root", () => {
    const { bundle, bindings, policy, select, input, inputs } = sourceFixture();
    const state = select("other");
    const emitted = projectWorkbenchPolicy(policy, state, bundle, bindings, "author", {
      ...inputs,
      unused: { ...input, sourceId: "source:unused" },
    });
    expect(emitted.accepted).toBe(true);
    expect(emitted.policy.authoringSources).toEqual([input]);
    expect(emitted.policy.authoringSelections).toMatchObject({ drafts: [] });
    expect(emitted.policy.governance).toMatchObject({ activations: [], catalog: { reviewed: [] } });
    expect(importWorkbenchPolicySelections(emitted.policy, bundle, bindings, inputs)).toMatchObject(
      { accepted: true, state, diagnostics: [] },
    );
    expect(
      projectWorkbenchPolicy(emitted.policy, state, bundle, bindings, "consume", inputs).accepted,
    ).toBe(true);
    const removed = projectWorkbenchPolicy(
      emitted.policy,
      createWorkbenchState(),
      bundle,
      bindings,
      "author",
      inputs,
    );
    expect(removed.accepted).toBe(true);
    expect(removed.policy).not.toHaveProperty("authoringSources");
  });
  it("rejects missing, duplicate, unreferenced, mismatched-revision, and changed-byte inputs transactionally", () => {
    const { bundle, bindings, policy, select, input, inputs } = sourceFixture();
    const state = select("other");
    expect(projectWorkbenchPolicy(policy, state, bundle, bindings)).toMatchObject({
      accepted: false,
      policy,
      diagnostics: ["Missing authoring source input: source:test"],
    });
    const emitted = projectWorkbenchPolicy(
      policy,
      state,
      bundle,
      bindings,
      "author",
      inputs,
    ).policy;
    const { authoringSources: omitted, ...missing } = emitted;
    expect(omitted).toEqual([input]);
    for (const invalid of [
      missing,
      { ...emitted, authoringSources: [input, input] },
      { ...emitted, authoringSources: [input, { ...input, sourceId: "source:unreferenced" }] },
      { ...emitted, authoringSources: [{ ...input, sourceRevisionId: "revision:wrong" }] },
      { ...emitted, authoringSources: [{ ...input, bytesBase64: "W10=" }] },
    ]) {
      expect(importWorkbenchPolicySelections(invalid, bundle, bindings, inputs).accepted).toBe(
        false,
      );
      expect(
        projectWorkbenchPolicy(invalid, state, bundle, bindings, "consume", inputs),
      ).toMatchObject({ accepted: false, policy: invalid });
    }
  });
  it("preserves stale source inputs through exact subtraction until the source has no remaining pins", () => {
    const { bundle, bindings, policy, select, input, inputs } = sourceFixture();
    const state = select("external", "other");
    const emitted = projectWorkbenchPolicy(
      policy,
      state,
      bundle,
      bindings,
      "author",
      inputs,
    ).policy;
    bundle.sources[input.sourceId]!.revision.contentDigest = "sha256:" + "b".repeat(64);
    expect(importWorkbenchPolicySelections(emitted, bundle, bindings, inputs)).toMatchObject({
      accepted: true,
      diagnostics: ["Stale authoring source input: source:test"],
    });
    const action = {
      type: "remove-root",
      assetId: "other",
      origin: { kind: "administrator" },
    } as const;
    const repaired = serializeWorkbenchRepairV1(emitted, state, action, bundle, bindings, inputs);
    expect(repaired.accepted).toBe(true);
    expect(repaired.policy?.authoringSources).toEqual([input]);
    const last = reduceWorkbenchAction(bundle, repaired.state, {
      type: "remove-root",
      assetId: "external",
      origin: { kind: "administrator" },
    });
    expect(last.accepted).toBe(true);
    expect(
      projectWorkbenchPolicy(repaired.policy!, last.state, bundle, bindings, "author", inputs)
        .policy,
    ).not.toHaveProperty("authoringSources");
  });
  it("checks total source input capacity before reading nested envelopes", () => {
    let read = false;
    const hostile = Array.from({ length: 65 }, () =>
      Object.defineProperty({}, "bytesBase64", {
        get() {
          read = true;
          throw Error("nested");
        },
      }),
    );
    expect(workbenchAuthoringSourcesBudgetIssueV1(hostile)).toContain("aggregate budget");
    expect(read).toBe(false);
    expect(
      workbenchAuthoringSourcesBudgetIssueV1([
        { bytesBase64: "a".repeat(400004), byteLength: 300001 },
        { bytesBase64: "a".repeat(400004), byteLength: 300001 },
      ]),
    ).toContain("aggregate budget");
  });
});
