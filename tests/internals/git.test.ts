import { describe, expect, it } from "vitest";
import { gitInt } from "../../src/internals/git.js";

describe("gitInt", () => {
  it.each(["", " ", " 1", "1 ", "7 commits", "-1", "1.5", "1e3", "9007199254740992", undefined])(
    "rejects malformed or unsafe git count %j",
    (raw) => {
      expect(gitInt(raw)).toBeUndefined();
    },
  );

  it("preserves complete safe non-negative base-10 counts, including zero", () => {
    expect(gitInt("0")).toBe(0);
    expect(gitInt("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
