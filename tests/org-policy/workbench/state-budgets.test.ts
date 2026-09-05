import { describe, expect, it } from "vitest";
import {
  WorkbenchStateV1Schema,
  workbenchStateBudgetIssueV1,
} from "../../../src/org-policy/workbench/contracts.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
} from "../../../src/org-policy/workbench/selection-engine.js";
import { fixture } from "./authoring-fixture.js";

describe("aggregate Workbench state bounds", () => {
  it("rejects cumulative draft bytes transactionally before they exceed the policy envelope", () => {
    const { bundle } = fixture();
    const draft = (id: string) => ({
      id,
      declaration: {
        kind: "imported-evidence" as const,
        digest: "sha256:" + "a".repeat(64),
        byteLength: 330_000,
        bytesBase64: "YQ==".repeat(110_000),
      },
    });
    // Use canonical base64 for this opaque payload; Core verifies its digest separately.
    const first = draft("draft:a");
    first.declaration.bytesBase64 = "YWFh".repeat(110_000);
    const second = draft("draft:b");
    second.declaration.bytesBase64 = first.declaration.bytesBase64;
    const once = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "add-draft",
      draft: first,
    });
    expect(once.accepted).toBe(true);
    const twice = reduceWorkbenchAction(bundle, once.state, { type: "add-draft", draft: second });
    expect(twice.accepted).toBe(false);
    expect(twice.state).toBe(once.state);
    expect(
      WorkbenchStateV1Schema.safeParse({ ...once.state, drafts: [first, second] }).success,
    ).toBe(false);
  });
  it("refuses oversized pin collections before reading their nested elements", () => {
    const { bundle, select } = fixture();
    const state = select("tool");
    const pins = new Array(5_001);
    Object.defineProperty(pins, 0, {
      get() {
        throw new Error("nested traversal is forbidden");
      },
    });
    const oversized = { ...state, roots: [{ ...state.roots[0]!, resolvedItems: pins }] };
    expect(workbenchStateBudgetIssueV1(oversized)).toContain("aggregate budget");
    expect(
      reduceWorkbenchAction(bundle, createWorkbenchState(), {
        type: "restore-state",
        state: oversized,
      }).accepted,
    ).toBe(false);
    expect(() => resolveWorkbenchSelection(bundle, oversized)).toThrow(/aggregate budget/);
  });
  it("rejects malformed collections and serialization failures with bounded diagnostics", () => {
    expect(workbenchStateBudgetIssueV1({ roots: {} })).toContain("aggregate budget");
    const hostile = {
      ...createWorkbenchState(),
      toJSON() {
        throw new Error("untrusted serialization");
      },
    };
    expect(workbenchStateBudgetIssueV1(hostile)).toContain("aggregate budget");
  });
});
