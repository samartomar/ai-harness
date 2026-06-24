import { describe, expect, it } from "vitest";
import { deepMerge, isPlainObject, parseJsoncText } from "../../src/internals/merge.js";

describe("deepMerge", () => {
  it("preserves keys present only in base (existing user config)", () => {
    const base = { mcpServers: { userServer: { command: "x" } } };
    const incoming = { mcpServers: { aihServer: { command: "y" } } };
    const out = deepMerge(base, incoming);
    expect(out).toEqual({
      mcpServers: { userServer: { command: "x" }, aihServer: { command: "y" } },
    });
  });

  it("unions primitive arrays (dedup, base order first)", () => {
    expect(deepMerge(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("lets incoming win for scalar conflicts", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("returns base when incoming is undefined", () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("parseJsoncText", () => {
  it("tolerates comments and trailing commas", () => {
    expect(parseJsoncText('{ // c\n "a": 1, }')).toEqual({ a: 1 });
  });

  it("returns undefined for empty input", () => {
    expect(parseJsoncText("   ")).toBeUndefined();
  });
});

describe("isPlainObject", () => {
  it("distinguishes objects from arrays and null", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
});
