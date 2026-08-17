import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSafeRelativePosixPathV1,
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../../src/contract/strict-json-v1.js";

describe("strict JSON v1", () => {
  it("parses only strict JSON objects and rejects decoded duplicate keys", () => {
    expect(parseStrictJsonObjectV1('{"alpha":{"beta":true}}', "fixture")).toEqual({
      alpha: { beta: true },
    });
    expect(() => parseStrictJsonObjectV1('["not an object"]', "fixture")).toThrow(/object/i);
    expect(() => parseStrictJsonObjectV1('{"key":1,"\\u006bey":2}', "fixture")).toThrow(
      /duplicate/i,
    );
    expect(() => parseStrictJsonObjectV1('{"alpha":1,}', "fixture")).toThrow(/JSON|trailing/i);
    expect(() => parseStrictJsonObjectV1('{/* comment */"alpha":1}', "fixture")).toThrow(
      /JSON|comment/i,
    );
  });

  it("rejects malformed or non-NFC Unicode without normalization", () => {
    expect(() => parseStrictJsonObjectV1('{"value":"\\ud800"}', "fixture")).toThrow(
      /Unicode|surrogate/i,
    );
    expect(() => assertStrictJsonValueV1({ value: "re\u0300gle" }, "fixture")).toThrow(/NFC/i);
    expect(assertStrictJsonValueV1({ value: "règle" }, "fixture")).toEqual({ value: "règle" });
  });

  it("accepts only acyclic plain own-data JSON values", () => {
    const nullPrototype = Object.assign(Object.create(null), { alpha: true });
    expect(assertStrictJsonValueV1(nullPrototype, "fixture")).toBe(nullPrototype);
    expect(() => assertStrictJsonValueV1(new Date(), "fixture")).toThrow(/prototype|plain/i);

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "alpha", { enumerable: true, get: () => true });
    expect(() => assertStrictJsonValueV1(accessor, "fixture")).toThrow(/data property|accessor/i);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertStrictJsonValueV1(cycle, "fixture")).toThrow(/cycle/i);
  });

  it("deep-freezes validated values and exposes deterministic RFC 8785/JCS bytes and SHA-256", () => {
    const frozen = deepFreezeStrictJsonV1({ nested: { values: ["one"] } });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.nested.values)).toBe(true);

    const left = { z: [3, 2, 1], a: { beta: true, alpha: "value" } };
    const right = { a: { alpha: "value", beta: true }, z: [3, 2, 1] };
    const bytes = canonicalStrictJsonBytesV1(left);
    expect(bytes).toEqual(canonicalStrictJsonBytesV1(right));
    expect(bytes.toString("utf8")).toBe('{"a":{"alpha":"value","beta":true},"z":[3,2,1]}');
    expect(canonicalStrictJsonSha256V1(left)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(canonicalStrictJsonSha256V1(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts only safe relative POSIX paths", () => {
    expect(() => assertSafeRelativePosixPathV1("skills/reviewer/SKILL.md", "path")).not.toThrow();
    for (const path of [
      "",
      "/absolute",
      "C:/drive",
      "./relative",
      "one//two",
      "one/../two",
      "one\\two",
    ]) {
      expect(() => assertSafeRelativePosixPathV1(path, "path")).toThrow(/path|relative|POSIX/i);
    }
  });
});
