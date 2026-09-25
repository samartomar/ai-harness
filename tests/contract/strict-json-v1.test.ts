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

  it("refuses comments, trailing commas, stray characters, unbalanced delimiters and deep nesting before the recovering parser runs", () => {
    const refusal = (text: string): unknown => {
      try {
        parseStrictJsonObjectV1(text, "fixture");
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const nbsp = String.fromCharCode(0xa0);
    const deep = (depth: number) => `{"x":${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}}`;
    const cases: [string, RegExp][] = [
      // A comment full of closing brackets must not mask the nesting that follows it.
      [
        `/*${"]".repeat(100_000)}*/{"x":${"[".repeat(100_000)}0${"]".repeat(100_000)}}`,
        /^invalid JSON fixture: object root at offset 0$/,
      ],
      [`{"x":1}//${"[".repeat(100_000)}`, /^invalid JSON fixture: end of text at offset 7$/],
      ['{"x":/* c */1}', /^invalid JSON fixture: value at offset 5$/],
      ['{"x":[1,]}', /^invalid JSON fixture: value at offset 8$/],
      ['{"x":1,}', /^invalid JSON fixture: property name at offset 7$/],
      ['{"x":[1}', /^invalid JSON fixture: comma or closing bracket at offset 7$/],
      ['{"x":1]', /^invalid JSON fixture: comma or closing brace at offset 6$/],
      ['{"x":{"y":1}', /^invalid JSON fixture: comma or closing brace at offset 12$/],
      ['{"x":1}}', /^invalid JSON fixture: end of text at offset 7$/],
      [`{"x":${"[".repeat(100_000)}`, /^fixture nests deeper than 32 levels$/],
      [`{${nbsp}"x":1}`, /^invalid JSON fixture: property name at offset 1$/],
      ['{"x":1,"y":01}', /^invalid JSON fixture: comma or closing brace at offset 12$/],
      ['{"x":"\\x"}', /^invalid JSON fixture: escape character at offset 6$/],
      [deep(33), /^fixture nests deeper than 32 levels$/],
    ];
    for (const [text, reason] of cases) {
      const error = refusal(text);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(reason);
    }
    expect(parseStrictJsonObjectV1(deep(32), "fixture")).toHaveProperty("x");
    expect(parseStrictJsonObjectV1(`{"s":"${"[".repeat(100)}\\"{"}`, "fixture")).toEqual({
      s: `${"[".repeat(100)}"{`,
    });
  });

  it("bounds value nesting at 32 levels, typed, and freezes any depth without recursing", () => {
    const nested = (levels: number): unknown => {
      let value: unknown = 0;
      for (let level = 0; level < levels; level += 1) value = [value];
      return value;
    };
    for (const check of [assertStrictJsonValueV1, canonicalStrictJsonBytesV1]) {
      for (const levels of [33, 100_000]) {
        let refusal: unknown;
        try {
          check(nested(levels), "fixture");
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(TypeError);
        expect((refusal as Error).message).toMatch(/nests deeper than 32 levels$/);
      }
      expect(() => check(nested(32), "fixture")).not.toThrow();
    }
    const deep = nested(100_000);
    expect(deepFreezeStrictJsonV1(deep)).toBe(deep);
    let innermost = deep as unknown[];
    while (Array.isArray(innermost[0])) innermost = innermost[0] as unknown[];
    expect(Object.isFrozen(innermost)).toBe(true);
  });

  it("rejects malformed or non-NFC Unicode without normalization", () => {
    expect(() => parseStrictJsonObjectV1('{"value":"\\ud800"}', "fixture")).toThrow(
      /Unicode|surrogate/i,
    );
    expect(() => assertStrictJsonValueV1({ value: "re\u0300gle" }, "fixture")).toThrow(/NFC/i);
    expect(assertStrictJsonValueV1({ value: "règle" }, "fixture")).toEqual({ value: "règle" });
  });

  it.each([1, 32])(
    "preserves ASCII values repeated %s times and still checks Unicode",
    (repetitions) => {
      const ascii = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index))
        .join("")
        .repeat(repetitions);
      expect(canonicalStrictJsonBytesV1({ value: ascii }).toString("utf8")).toBe(
        JSON.stringify({ value: ascii }),
      );
      const prefix = "A".repeat(8192);
      for (const suffix of ["\ud800", "\udc00", "e\u0301"]) {
        expect(() => assertStrictJsonValueV1({ value: prefix + suffix }, "fixture")).toThrow(
          /Unicode|surrogate|NFC/i,
        );
      }
      const valid = { value: `${prefix}règle\u{1f600}` };
      expect(assertStrictJsonValueV1(valid, "fixture")).toBe(valid);
    },
  );

  it("rejects non-NFC keys and values plus malformed surrogate pairs at the direct canonical boundary", () => {
    for (const value of [
      { key: "re\u0300gle" },
      { "re\u0300gle": "value" },
      { key: "\ud800" },
      { key: "\udc00" },
      { key: "\udc00\ud800" },
    ]) {
      expect(() => canonicalStrictJsonBytesV1(value)).toThrow(/NFC|Unicode|surrogate/i);
      expect(() => canonicalStrictJsonSha256V1(value)).toThrow(/NFC|Unicode|surrogate/i);
    }
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

    const enumerableJsonData = { alpha: true } as Record<string, unknown>;
    Object.defineProperty(enumerableJsonData, "not-json-data", {
      enumerable: false,
      value: "ignored by the JSON data boundary",
    });
    expect(assertStrictJsonValueV1(enumerableJsonData, "fixture")).toBe(enumerableJsonData);
    expect(canonicalStrictJsonBytesV1(enumerableJsonData)).toEqual(
      canonicalStrictJsonBytesV1({ alpha: true }),
    );
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
    expect(assertSafeRelativePosixPathV1("skills/😀/règle.md", "path")).toBe("skills/😀/règle.md");
    for (const path of [
      "",
      "/absolute",
      "//host/share",
      "///device/path",
      "C:/drive",
      "C:relative",
      "\\\\host\\share",
      "\\\\?\\C:\\device",
      "./relative",
      ".",
      "one/./two",
      "one//two",
      "one/",
      "one/../two",
      "../one",
      "one\\two",
      "one%2ftwo",
      "one%2Ftwo",
      "one%5ctwo",
      "one%5Ctwo",
      "one%2f..%2ftwo",
      "one%5c..%5ctwo",
      "one?query",
      "one#fragment",
      "one:colon",
      "file://one",
      "one\u0000two",
      "one\u001ftwo",
      "skills/re\u0300gle.md",
    ]) {
      expect(() => assertSafeRelativePosixPathV1(path, "path")).toThrow(/path|relative|POSIX/i);
    }
    for (const hostileAlias of ["same/../same", "./same"]) {
      expect(() => assertSafeRelativePosixPathV1(hostileAlias, "path")).toThrow(
        /path|relative|POSIX/i,
      );
    }
  });
});
