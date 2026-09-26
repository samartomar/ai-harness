import { describe, expect, it } from "vitest";
import { windowsCommandArg } from "../../src/ecc-profile/native-registration.js";

/** The previous regular-expression form (CodeQL js/polynomial-redos), kept as the reference. */
function reference(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function* corpus(alphabet: readonly string[], maxLength: number): Generator<string> {
  yield "";
  let level = [""];
  for (let length = 1; length <= maxLength; length += 1) {
    const next: string[] = [];
    for (const prefix of level) for (const symbol of alphabet) next.push(prefix + symbol);
    yield* next;
    level = next;
  }
}

describe("windowsCommandArg", () => {
  it("quotes exactly as before for every string over backslash, quote, space and a letter", () => {
    let checked = 0;
    for (const value of corpus(["\\", '"', " ", "a"], 7)) {
      expect(windowsCommandArg(value), JSON.stringify(value)).toBe(reference(value));
      checked += 1;
    }
    expect(checked).toBe(21_845);
  });

  it.each([
    ["C:\\Program Files\\node.exe", '"C:\\Program Files\\node.exe"'],
    ["C:\\state root\\", '"C:\\state root\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['a\\"b', '"a\\\\\\"b"'],
    ["\u{1F600}\\", '"\u{1F600}\\\\"'],
  ])("quotes %j as %j", (value, quoted) => {
    expect(windowsCommandArg(value)).toBe(quoted);
    expect(reference(value)).toBe(quoted);
  });

  it("stays linear on long runs of backslashes", () => {
    const run = "\\".repeat(200_000);
    const started = performance.now();
    expect(windowsCommandArg(`${run}x`)).toBe(`"${run}x"`);
    expect(windowsCommandArg(`${run}"`)).toBe(`"${run}${run}\\""`);
    expect(windowsCommandArg(run)).toBe(`"${run}${run}"`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
