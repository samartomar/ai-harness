import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compilePolicy } from "../../../../src/org-policy/workbench/policy-compiler.js";
import { createWorkbenchState } from "../../../../src/org-policy/workbench/selection-engine.js";
import { fixture } from "../authoring-fixture.js";

describe("internal Core authoring oracle", () => {
  it("rejects invalid base policy and preserved governance without mutation", () => {
    const { bundle, bindings, policy } = fixture();
    for (const input of [{}, { ...policy, governance: { catalog: "invalid" } }]) {
      const before = structuredClone(input);
      expect(compilePolicy(input, createWorkbenchState(), bundle, bindings)).toMatchObject({
        accepted: false,
        policy: input,
      });
      expect(input).toEqual(before);
    }
  });
  it("verifies serialized draft bytes before projection", () => {
    const { bundle, bindings, policy } = fixture();
    const bytesBase64 = Buffer.from('{"draft":true}', "utf8").toString("base64");
    const digest = `sha256:${createHash("sha256").update(Buffer.from(bytesBase64, "base64")).digest("hex")}`;
    const state = {
      ...createWorkbenchState(),
      drafts: [
        {
          id: "draft:one",
          declaration: {
            kind: "organization-manifest" as const,
            bytesBase64,
            byteLength: 14,
            digest,
          },
        },
      ],
    };
    expect(compilePolicy(policy, state, bundle, bindings)).toMatchObject({ accepted: true });
    for (const declaration of [
      { ...state.drafts[0]!.declaration, digest: `sha256:${"a".repeat(64)}` },
      { ...state.drafts[0]!.declaration, byteLength: 13 },
      { ...state.drafts[0]!.declaration, bytesBase64: `${bytesBase64}\n` },
    ]) {
      expect(
        compilePolicy(
          policy,
          { ...state, drafts: [{ id: "draft:one", declaration }] },
          bundle,
          bindings,
        ),
      ).toMatchObject({ accepted: false, policy });
    }
  });
  it("rejects a schema-valid draft state whose compiled policy exceeds the Core reader limit", () => {
    const { bundle, bindings, policy } = fixture();
    const bytes = Buffer.alloc(550_000, 120);
    const state = {
      ...createWorkbenchState(),
      drafts: [
        {
          id: "draft:oversized",
          declaration: {
            kind: "imported-evidence" as const,
            bytesBase64: bytes.toString("base64"),
            byteLength: bytes.length,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        },
      ],
    };

    const input = {
      ...policy,
      command: {
        deny: { add: [{ pattern: "x".repeat(300_000), reason: "export limit" }], remove: [] },
      },
    };
    expect(compilePolicy(input, state, bundle, bindings)).toEqual({
      accepted: false,
      policy: input,
      diagnostics: ["Compiled policy exceeds the 1000000-byte Core reader limit"],
    });
  });
  it("returns a validated versioned policy for an empty authoring state", () => {
    const { bundle, bindings, policy } = fixture();
    const authored = compilePolicy(policy, createWorkbenchState(), bundle, bindings);
    expect(authored.accepted).toBe(true);
    expect(authored.policy).toMatchObject({
      schemaVersion: 3,
      authoringSelections: { selectionVersion: "workbench-selection/v1", roots: [] },
    });
    expect(
      compilePolicy(authored.policy, createWorkbenchState(), bundle, bindings, "consume"),
    ).toEqual(authored);
  });
});
