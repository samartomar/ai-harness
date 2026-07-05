import { describe, expect, it } from "vitest";
import { reportAdvisories, reportAdvisoryResults } from "../../src/report/advisories.js";
import type { LoadGroupModel } from "../../src/report/loadgroups.js";

/** A minimal LoadGroupModel — reportAdvisories only reads worst/worstTokens/budget/overBudget. */
const model = (over: boolean): LoadGroupModel =>
  ({
    groups: [],
    worst: {
      clis: ["claude"],
      bootloaderPaths: ["CLAUDE.md"],
      label: "claude → CLAUDE.md",
      files: [],
      tokens: over ? 12000 : 100,
      bytes: 0,
      present: true,
    },
    worstTokens: over ? 12000 : 100,
    budgetTokens: 8000,
    overBudget: over,
    onDemandFiles: [],
    onDemandTokens: 0,
  }) as LoadGroupModel;

describe("reportAdvisories", () => {
  it("models report advisories as structured warnings before adapting them to legacy skips", () => {
    const input = {
      model: model(true),
      adoption: { present: 2, total: 5, absent: ["mcp", "guardrails", "sandbox"] },
      contract: { unportable: 1, knownGaps: 0 },
      gate: false,
      initialized: true,
    };

    expect(
      reportAdvisoryResults(input).map((result) => ({
        passName: result.passName,
        verdict: result.verdict,
        code: result.evidence[0]?.type,
      })),
    ).toEqual([
      {
        passName: "context budget (advisory)",
        verdict: "warn",
        code: "report.context-over-budget",
      },
      { passName: "harness adoption", verdict: "warn", code: "report.low-adoption" },
      { passName: "contract truth (advisory)", verdict: "warn", code: "report.contract-untrue" },
    ]);

    expect(
      reportAdvisories(input).map((check) => ({
        name: check.name,
        verdict: check.verdict,
        code: check.code,
      })),
    ).toEqual([
      {
        name: "context budget (advisory)",
        verdict: "skip",
        code: "report.context-over-budget",
      },
      { name: "harness adoption", verdict: "skip", code: "report.low-adoption" },
      { name: "contract truth (advisory)", verdict: "skip", code: "report.contract-untrue" },
    ]);
  });

  it("over budget + --gate → coded fail under the gate name (drives the CI exit)", () => {
    const checks = reportAdvisories({ model: model(true), gate: true, initialized: false });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "per-turn token budget",
      verdict: "fail",
      code: "report.context-over-budget",
    });
  });

  it("under budget + --gate → uncoded pass (gate green, no finding)", () => {
    const checks = reportAdvisories({ model: model(false), gate: true, initialized: false });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "per-turn token budget", verdict: "pass" });
    expect(checks[0]?.code).toBeUndefined();
  });

  it("over budget without --gate → a non-gating skip advisory under a distinct name", () => {
    const checks = reportAdvisories({ model: model(true), gate: false, initialized: false });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.verdict).toBe("skip"); // skip never flips the exit code
    expect(checks[0]?.code).toBe("report.context-over-budget");
    expect(checks[0]?.name).not.toBe("per-turn token budget"); // not the gate probe
  });

  it("under budget without --gate → no advisory at all (bare report stays clean)", () => {
    expect(reportAdvisories({ model: model(false), gate: false, initialized: false })).toEqual([]);
  });

  it("adoption gaps in an initialised repo → a low-adoption skip advisory listing the misses", () => {
    const checks = reportAdvisories({
      model: model(false),
      adoption: { present: 2, total: 5, absent: ["mcp", "guardrails", "sandbox"] },
      gate: false,
      initialized: true,
    });
    const adoption = checks.find((c) => c.code === "report.low-adoption");
    expect(adoption?.verdict).toBe("skip");
    expect(adoption?.detail).toContain("missing: mcp, guardrails, sandbox");
  });

  it("does not nag about adoption in a repo that never opted in (no marker)", () => {
    const checks = reportAdvisories({
      model: model(false),
      adoption: { present: 2, total: 5, absent: ["mcp"] },
      gate: false,
      initialized: false,
    });
    expect(checks.some((c) => c.code === "report.low-adoption")).toBe(false);
  });

  it("a fully-adopted initialised repo raises no adoption advisory", () => {
    expect(
      reportAdvisories({
        model: model(false),
        adoption: { present: 5, total: 5, absent: [] },
        gate: false,
        initialized: true,
      }),
    ).toEqual([]);
  });

  it("org scope (no model, no adoption) → no advisories", () => {
    expect(reportAdvisories({ gate: false, initialized: true })).toEqual([]);
  });
});
