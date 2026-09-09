import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/org-policy/effective.js", () => {
  throw new Error("pure identity imports must not load effective policy runtime");
});

describe("policy identity helpers", () => {
  it("preserves canonical object ordering, array ordering, and source digest bytes", async () => {
    const { candidateIdentityDigest, stableJson } = await import(
      "../../src/org-policy/policy-identity.js"
    );
    expect(stableJson({ z: [3, { b: false, a: "x" }], a: { y: null, x: true } })).toBe(
      '{"a":{"x":true,"y":null},"z":[3,{"a":"x","b":false}]}',
    );
    expect(stableJson(["first", { z: 1, a: 2 }, "last"])).toBe('["first",{"a":2,"z":1},"last"]');
    expect(
      candidateIdentityDigest({
        source: { type: "mcp", server: "context7", subject: "https://example.test/context7" },
      } as Parameters<typeof candidateIdentityDigest>[0]),
    ).toBe("sha256:a18f5d80256cb6e6981c344ccf4a36f6bb1d0487fabf2566823086f8823d932a");
  });

  it("loads identity, hook, and scan helpers without the effective policy runtime", async () => {
    await expect(import("../../src/org-policy/policy-identity.js")).resolves.toBeDefined();
    await expect(import("../../src/org-policy/hook-registrar.js")).resolves.toBeDefined();
    await expect(import("../../src/org-policy/hook-registrar-native.js")).resolves.toBeDefined();
    await expect(import("../../src/trust/scan.js")).resolves.toBeDefined();
  });
});
