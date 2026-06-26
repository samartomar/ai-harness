import { describe, expect, it } from "vitest";
import { type LintRuleCtx, lintDoc } from "../../src/lint/rules.js";

/** A lint ctx with one planned canon file; override per test. */
function ctx(overrides: Partial<LintRuleCtx> = {}): LintRuleCtx {
  return {
    path: "ai-coding/RULE_ROUTER.md",
    plannedPaths: new Set(["ai-coding/RULE_ROUTER.md"]),
    fileExists: () => false,
    ...overrides,
  };
}

function findings(src: string, ruleId: string, c: LintRuleCtx = ctx()) {
  return lintDoc(c.path, src, c).filter((f) => f.ruleId === ruleId);
}

describe("lint rules — Bucket B prose (advisory / info)", () => {
  it("soft-imperative flags 'should' in prose but not in a fenced code block", () => {
    expect(findings("You should validate the input.", "soft-imperative")).toHaveLength(1);
    expect(findings("Validate the input before saving.", "soft-imperative")).toHaveLength(0);
    // Arrange: same word inside fenced code is skipped.
    const fenced = "Validate it.\n\n```sh\n# you should run this\n```\n";
    expect(findings(fenced, "soft-imperative")).toHaveLength(0);
  });

  it("soft-imperative is info-tier (report-only, never fails CI)", () => {
    const f = findings("You should do it.", "soft-imperative")[0];
    expect(f?.severity).toBe("info");
  });

  it("taste-word flags an untestable adjective but not inside backticks", () => {
    expect(findings("Write engaging prose.", "taste-word")).toHaveLength(1);
    expect(findings("The `engaging` flag is set.", "taste-word")).toHaveLength(0);
  });

  it("trailing-etc and enum-without-list fire on open sets", () => {
    expect(findings("Classify as junior, mid, etc.", "trailing-etc")).toHaveLength(1);
    expect(findings("Pick one of the usual categories.", "enum-without-list")).toHaveLength(1);
  });

  it("context-budget fires (info) only on long prose", () => {
    const long = `${"word ".repeat(1600)}`;
    expect(findings(long, "context-budget")).toHaveLength(1);
    expect(findings("A short doc.", "context-budget")).toHaveLength(0);
    // Fenced code is stripped before counting, so a big code block alone does not trip it.
    const bigCode = `intro\n\n\`\`\`\n${"x ".repeat(2000)}\n\`\`\`\n`;
    expect(findings(bigCode, "context-budget")).toHaveLength(0);
  });
});

describe("lint rules — canon-ref-resolves (FAIL tier, the headline rule)", () => {
  it("passes a planned backtick path and a basename-only reference", () => {
    expect(
      findings("See `ai-coding/RULE_ROUTER.md` for routing.", "canon-ref-resolves"),
    ).toHaveLength(0);
    // Bare `RULE_ROUTER.md` resolves by basename against the planned dir-prefixed path.
    expect(findings("Read `RULE_ROUTER.md` first.", "canon-ref-resolves")).toHaveLength(0);
  });

  it("fails a dangling Kiro #[[file:...]] reference", () => {
    const f = findings("Load #[[file:ai-coding/MISSING.md]] now.", "canon-ref-resolves");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("fail");
  });

  it("resolves a known sibling-canon file the harness writes via scaffold", () => {
    // bootstrap-ai references `architecture.md` (written by `aih scaffold`), not in its plan.
    expect(findings("Fill `ai-coding/architecture.md`.", "canon-ref-resolves")).toHaveLength(0);
  });

  it("resolves a reference present on disk even when not in the plan", () => {
    const c = ctx({ plannedPaths: new Set(), fileExists: (p) => p === "ai-coding/RULE_ROUTER.md" });
    expect(findings("See `ai-coding/RULE_ROUTER.md`.", "canon-ref-resolves", c)).toHaveLength(0);
  });

  it("ignores URLs and syntax-doc placeholders", () => {
    expect(
      findings("Docs at https://example.com/guide.md here.", "canon-ref-resolves"),
    ).toHaveLength(0);
    // The Kiro adapter note documents the syntax literally as #[[file:...]].
    expect(
      findings("Reference a file with `#[[file:...]]` syntax.", "canon-ref-resolves"),
    ).toHaveLength(0);
    expect(
      findings("Load `ai-coding/adapters/<your-tool>.md`.", "canon-ref-resolves"),
    ).toHaveLength(0);
  });
});

describe("lint rules — placeholder / skeleton", () => {
  it("placeholder-leftover hard-fails real scaffolding sentinels", () => {
    expect(findings("Set <insert role> here.", "placeholder-leftover")[0]?.severity).toBe("fail");
    expect(findings("Replace [INSERT NAME] now.", "placeholder-leftover")).toHaveLength(1);
    expect(findings("Left a TODO marker.", "placeholder-leftover")).toHaveLength(1);
  });

  it("placeholder-leftover does NOT fire on aih's intentional italic skeletons", () => {
    // The carve-out that makes the rule safe on aih output.
    expect(findings("_Expand: what this system does_", "placeholder-leftover")).toHaveLength(0);
    expect(findings("_None detected — add your own._", "placeholder-leftover")).toHaveLength(0);
  });

  it("skeleton-unfilled (info) fires only on a scaffolded context file with italic skeletons", () => {
    const scaffold = ctx({ path: "ai-coding/architecture.md" });
    const f = lintDoc(
      scaffold.path,
      "# Architecture\n\n_Expand: what this system does_\n",
      scaffold,
    ).filter((x) => x.ruleId === "skeleton-unfilled");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("info");
    // A filled doc (no italic-only line) does not fire.
    const filled = lintDoc(
      scaffold.path,
      "# Architecture\n\nThe service ingests orders.\n",
      scaffold,
    ).filter((x) => x.ruleId === "skeleton-unfilled");
    expect(filled).toHaveLength(0);
    // The rule does not apply to non-scaffold docs (e.g. RULE_ROUTER).
    expect(findings("_Expand: x_", "skeleton-unfilled")).toHaveLength(0);
  });
});
