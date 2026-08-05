import { describe, expect, it } from "vitest";
import { diagnosticValue, isWellFormedUtf16 } from "../../src/verification/validation.js";

describe("verification diagnostic input validation", () => {
  it("recognizes valid UTF-16 pairs and rejects isolated surrogate halves", () => {
    expect(isWellFormedUtf16("plain \uD83D\uDE80 text")).toBe(true);
    expect(isWellFormedUtf16("bad \uD83D")).toBe(false);
    expect(isWellFormedUtf16("bad \uDE80")).toBe(false);
  });

  it("makes malformed and non-printable values safe for diagnostics", () => {
    expect(diagnosticValue("line\n\u0000\u007f\u0085\uD83D\uDE80\uD83DA\uDE80")).toBe(
      "line    🚀?A?",
    );
    expect(
      diagnosticValue({
        toString() {
          throw new Error("not printable");
        },
      }),
    ).toBe("[unprintable]");
  });
});
