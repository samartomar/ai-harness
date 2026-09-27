import { describe, expect, it } from "vitest";
import { type Cli, SUPPORTED_CLIS } from "../../src/index.js";
import { SUPPORTED_CLIS as INTERNAL_SUPPORTED_CLIS } from "../../src/internals/clis.js";

// The public root re-exports Core's canonical target list, so a consumer can
// name the AI CLIs Core targets without a copied list or a deep import. It is
// the list of target identities only: it says nothing about which tools are
// installed, connected or selected.
describe("SUPPORTED_CLIS public export", () => {
  it("is the same canonical list the CLI resolves targets from", () => {
    expect(SUPPORTED_CLIS).toBe(INTERNAL_SUPPORTED_CLIS);
  });

  it("is a non-empty list of unique, serializable target names", () => {
    expect(SUPPORTED_CLIS.length).toBeGreaterThan(0);
    expect(new Set(SUPPORTED_CLIS).size).toBe(SUPPORTED_CLIS.length);
    for (const cli of SUPPORTED_CLIS) expect(cli).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(JSON.parse(JSON.stringify(SUPPORTED_CLIS))).toEqual([...SUPPORTED_CLIS]);
  });

  it("types each member as Cli", () => {
    const first: Cli = SUPPORTED_CLIS[0];
    expect(SUPPORTED_CLIS).toContain(first);
  });
});
