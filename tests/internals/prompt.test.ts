import { describe, expect, it } from "vitest";
import { isInteractive } from "../../src/internals/prompt.js";

describe("isInteractive", () => {
  it("forces non-interactive when AIH_NO_PROMPT=1", () => {
    expect(isInteractive({ AIH_NO_PROMPT: "1" })).toBe(false);
  });

  it("is non-interactive when stdin/stdout are not both TTYs (the test/CI case)", () => {
    // vitest runs without a TTY, so this exercises the Boolean(stdin && stdout) path.
    expect(isInteractive({})).toBe(false);
  });
});
