import { describe, expect, it } from "vitest";
import { resolveClis, SUPPORTED_CLIS } from "../../src/internals/clis.js";

describe("resolveClis", () => {
  it("defaults to Claude Code when nothing is selected", () => {
    expect(resolveClis({})).toEqual(["claude"]);
  });

  it("selects every supported CLI with --all-tools", () => {
    expect(resolveClis({ allTools: true })).toEqual([...SUPPORTED_CLIS]);
  });

  it("parses a comma list, trimming and lowercasing", () => {
    expect(resolveClis({ cli: "Codex, CURSOR ,claude" })).toEqual(["codex", "cursor", "claude"]);
  });

  it("drops unknown names but keeps the valid ones", () => {
    expect(resolveClis({ cli: "claude,bogus,codex" })).toEqual(["claude", "codex"]);
  });

  it("falls back to the default when every name is unknown", () => {
    expect(resolveClis({ cli: "nope,unknown" })).toEqual(["claude"]);
  });

  it("dedupes repeated names", () => {
    expect(resolveClis({ cli: "codex,codex,cursor" })).toEqual(["codex", "cursor"]);
  });

  it("ignores an empty --cli value", () => {
    expect(resolveClis({ cli: "   " })).toEqual(["claude"]);
  });

  it("--all-tools wins over --cli", () => {
    expect(resolveClis({ cli: "codex", allTools: true })).toEqual([...SUPPORTED_CLIS]);
  });

  // strict mode = the non-interactive `--cli` FLAG: a typo must fail closed rather
  // than silently writing Claude config the operator never asked for.
  it("strict mode throws on any unknown name", () => {
    expect(() => resolveClis({ cli: "claude,codx" }, { strict: true })).toThrow(/codx/);
  });

  it("strict mode throws (not claude-default) when every name is unknown", () => {
    expect(() => resolveClis({ cli: "nope,unknown" }, { strict: true })).toThrow(/unknown --cli/);
  });

  it("strict mode still accepts an all-valid list, deduped", () => {
    expect(resolveClis({ cli: "codex,codex,cursor" }, { strict: true })).toEqual([
      "codex",
      "cursor",
    ]);
  });
});
