import { describe, expect, it } from "vitest";
import { quoteWindowsHookArg } from "../../src/tools/token-optimizer-runtime.js";

/** The previous regular-expression form (the same js/polynomial-redos shape), kept as the reference. */
function reference(value: string): string {
  if (!/[\s"]/.test(value)) return value;
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

describe("Token Optimizer Windows hook argument quoting", () => {
  it("quotes exactly as before for every string over backslash, quote, space, tab and a letter", () => {
    let checked = 0;
    for (const value of corpus(["\\", '"', " ", "\t", "a"], 6)) {
      expect(quoteWindowsHookArg(value), JSON.stringify(value)).toBe(reference(value));
      checked += 1;
    }
    expect(checked).toBe(19_531);
  });

  it.each([
    ["C:\\tools\\python.exe", "C:\\tools\\python.exe"],
    ["C:\\Program Files\\python.exe", '"C:\\Program Files\\python.exe"'],
    ["C:\\hook root\\", '"C:\\hook root\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
  ])("quotes %j as %j", (value, quoted) => {
    expect(quoteWindowsHookArg(value)).toBe(quoted);
    expect(reference(value)).toBe(quoted);
  });

  it("stays linear on long runs of backslashes", () => {
    const run = "\\".repeat(200_000);
    const started = performance.now();
    expect(quoteWindowsHookArg(`${run} `)).toBe(`"${run} "`);
    expect(quoteWindowsHookArg(`${run}"`)).toBe(`"${run}${run}\\""`);
    expect(quoteWindowsHookArg(` ${run}`)).toBe(`" ${run}${run}"`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
