import { describe, expect, it } from "vitest";
import { assertNoCmdInjection } from "../../src/internals/shell-safety.js";

describe("assertNoCmdInjection", () => {
  it("accepts an ordinary Windows path, including Program Files (x86)", () => {
    expect(() =>
      assertNoCmdInjection("C:\\Program Files (x86)\\app\\scratch", "--scratch"),
    ).not.toThrow();
  });

  // The full cmd.exe injection/expansion set — note % (%VAR% expansion) and ! (delayed
  // expansion) are rejected, which a path-only guard would miss.
  for (const bad of ["a & calc", "a | b", "a > f", "a < f", "a^b", 'a"b', "a%PATH%b", "a!v!b"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertNoCmdInjection(bad, "--scratch")).toThrow(/metacharacter/);
    });
  }

  it("rejects an embedded newline", () => {
    expect(() => assertNoCmdInjection("a\nrmdir", "--scratch")).toThrow(/metacharacter/);
  });
});
