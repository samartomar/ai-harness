import { describe, expect, it } from "vitest";
import type { ContextBloat } from "../../src/report/bloat.js";
import type { LoadGroupModel } from "../../src/report/loadgroups.js";
import {
  budgetClarification,
  commandForArtifact,
  type NextStepsInput,
  nextSteps,
  nextStepsDigest,
  nextStepsHeadline,
} from "../../src/report/nextsteps.js";

const bloat = (totalTokens: number, overBudget: boolean): ContextBloat =>
  ({ files: [], totalBytes: 0, totalTokens, budgetTokens: 40000, overBudget }) as ContextBloat;
const model = (worstTokens: number, overBudget: boolean): LoadGroupModel =>
  ({ worstTokens, budgetTokens: 40000, overBudget }) as LoadGroupModel;

describe("commandForArtifact", () => {
  it("maps each managed artifact to its exact command", () => {
    expect(commandForArtifact("gitleaks")).toBe("aih guardrails --apply");
    expect(commandForArtifact("pre-commit")).toBe("aih guardrails --apply");
    expect(commandForArtifact("devcontainer")).toBe("aih sandbox --apply");
    expect(commandForArtifact(".mcp.json")).toBe("aih mcp --apply");
    expect(commandForArtifact("context-dir")).toBe("aih scaffold --apply");
    expect(commandForArtifact("something-unknown")).toBe("aih init --apply");
  });
});

describe("nextSteps", () => {
  const base: NextStepsInput = { initialized: true };

  it("groups absent artifacts by command (no duplicate command lines)", () => {
    const steps = nextSteps({
      ...base,
      adoption: { present: 1, total: 4, absent: ["gitleaks", "pre-commit", "devcontainer"] },
    });
    // gitleaks + pre-commit collapse into ONE guardrails line; devcontainer is its own.
    expect(steps).toHaveLength(2);
    expect(
      steps.some((s) => s.includes("gitleaks, pre-commit") && s.includes("aih guardrails --apply")),
    ).toBe(true);
    expect(steps.some((s) => s.includes("devcontainer") && s.includes("aih sandbox --apply"))).toBe(
      true,
    );
  });

  it("adds a telemetry step when telemetry isn't wired and no events captured", () => {
    const steps = nextSteps({ ...base, usageEvents: 0 });
    expect(
      steps.some((s) => s.includes("aih usage --apply") && s.includes("aih track --apply")),
    ).toBe(true);
  });

  it("drops the telemetry step once it's WIRED (even with 0 events yet — no false nag)", () => {
    const steps = nextSteps({ ...base, usageEvents: 0, telemetryWired: true });
    expect(steps.some((s) => s.includes("aih usage --apply"))).toBe(false);
  });

  it("adds an `aih tools` step when shell tools are missing", () => {
    const steps = nextSteps({ ...base, toolsMissing: 2 });
    expect(
      steps.some((s) => s.includes("2 missing shell tool(s)") && s.includes("aih tools")),
    ).toBe(true);
  });

  it("surfaces installed-but-untargeted CLIs with the exact wire command (the kiro case)", () => {
    const steps = nextSteps({
      ...base,
      targets: ["claude", "codex", "gemini"],
      installedUntargeted: ["opencode", "kiro"],
    });
    expect(
      steps.some(
        (s) =>
          s.includes("opencode, kiro") &&
          s.includes("aih init --cli claude,codex,gemini,opencode,kiro --apply"),
      ),
    ).toBe(true);
  });

  it("emits nothing for an uninitialized repo (never nags a non-adopter)", () => {
    expect(
      nextSteps({
        initialized: false,
        adoption: { present: 0, total: 4, absent: ["gitleaks"] },
        usageEvents: 0,
      }),
    ).toHaveLength(0);
  });

  it("emits nothing when fully set up (all present, usage flowing)", () => {
    expect(
      nextSteps({ ...base, adoption: { present: 4, total: 4, absent: [] }, usageEvents: 12 }),
    ).toHaveLength(0);
  });
});

describe("budgetClarification", () => {
  it("reconciles an over-budget CORPUS with a within-budget per-turn cost", () => {
    const note = budgetClarification(bloat(46588, true), model(1687, false));
    expect(note).toContain("FULL corpus");
    expect(note).toContain("PER TURN");
    expect(note).toContain("1,687");
  });

  it("warns when the per-turn cost itself is over budget", () => {
    const note = budgetClarification(bloat(50000, true), model(45000, true));
    expect(note).toContain("OVER");
    expect(note).toContain("--token-budget");
  });

  it("says nothing when everything is within budget", () => {
    expect(budgetClarification(bloat(10000, false), model(1000, false))).toBeUndefined();
  });
});

describe("nextStepsDigest + headline", () => {
  it("renders 'all clear' when there is nothing to do", () => {
    const input: NextStepsInput = {
      initialized: true,
      adoption: { present: 4, total: 4, absent: [] },
      usageEvents: 5,
    };
    expect(nextStepsHeadline(input)).toBe("Next steps — all clear");
    expect(nextStepsDigest(input)).toContain("Nothing to do");
  });

  it("renders numbered, command-bearing steps + the budget note (the syntegris shape)", () => {
    const input: NextStepsInput = {
      initialized: true,
      adoption: { present: 3, total: 4, absent: ["gitleaks"] },
      usageEvents: 0,
      bloat: bloat(46588, true),
      perTurn: model(1687, false),
    };
    expect(nextStepsHeadline(input)).toBe("Next steps — 2 actions");
    const body = nextStepsDigest(input);
    expect(body).toContain("1. Add gitleaks → `aih guardrails --apply`");
    expect(body).toContain("aih usage --apply");
    expect(body).toContain("PER TURN"); // the budget reconciliation rode along
  });
});
