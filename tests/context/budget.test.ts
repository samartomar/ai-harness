import { describe, expect, it } from "vitest";
import {
  buildContextBudgetReport,
  classifyContextFile,
  scoreContextFile,
  selectLazyCanonFiles,
} from "../../src/index.js";

describe("context budget engine", () => {
  it("classifies context candidates with fail-closed hostile and secret paths", () => {
    expect(classifyContextFile("src/index.ts")).toMatchObject({
      path: "src/index.ts",
      classification: "conditional-include",
    });
    expect(classifyContextFile("ai-coding/RULE_ROUTER.md")).toMatchObject({
      path: "ai-coding/RULE_ROUTER.md",
      classification: "conditional-include",
    });
    expect(classifyContextFile("package-lock.json")).toMatchObject({
      path: "package-lock.json",
      classification: "soft-exclude",
    });
    expect(classifyContextFile(".env.local")).toMatchObject({
      path: ".env.local",
      classification: "hard-exclude",
    });
    expect(classifyContextFile("secrets/prod.env")).toMatchObject({
      path: "secrets/prod.env",
      classification: "hard-exclude",
    });
    for (const secretPath of [
      ".envrc",
      ".env-prod",
      ".ENV.local",
      "config/.env.test",
      "Secrets/prod.env",
    ]) {
      expect(classifyContextFile(secretPath), secretPath).toMatchObject({
        classification: "hard-exclude",
      });
    }

    const hostile = classifyContextFile("../secrets/prod.env");
    expect(hostile.classification).toBe("hard-exclude");
    expect(hostile.path).toMatch(/^hostile-path-[a-f0-9]{12}$/);
    expect(hostile.reasons).toContain("hostile path rejected");

    for (const hostilePath of ["C:tmp/foo.ts", "C:secrets/prod.env", "src/file.ts:stream"]) {
      expect(classifyContextFile(hostilePath), hostilePath).toMatchObject({
        classification: "hard-exclude",
      });
      expect(classifyContextFile(hostilePath).path).toMatch(/^hostile-path-[a-f0-9]{12}$/);
    }
  });

  it("scores files by path type relevance and bounded token weight", () => {
    const source = scoreContextFile({
      path: "src/verification/passes.ts",
      bytes: 1600,
      relevance: 0.9,
    });
    const generated = scoreContextFile({
      path: "dist/cli.js",
      bytes: 1600,
      relevance: 0.9,
    });
    const lock = scoreContextFile({
      path: "package-lock.json",
      bytes: 80000,
      relevance: 0.1,
    });

    expect(source).toMatchObject({
      path: "src/verification/passes.ts",
      classification: "conditional-include",
      decision: "include",
      tokenEstimate: 400,
    });
    expect(source.score).toBeGreaterThan(generated.score);
    expect(generated.classification).toBe("soft-exclude");
    expect(lock).toMatchObject({
      classification: "soft-exclude",
      decision: "exclude",
    });

    const small = scoreContextFile({ path: "src/same.ts", bytes: 400, relevance: 0.5 });
    const large = scoreContextFile({ path: "src/same-copy.ts", bytes: 200_000, relevance: 0.5 });
    expect(small.score).toBeGreaterThan(large.score);

    expect(
      scoreContextFile({ path: "src/generated-lock.ts", type: "lockfile", bytes: 100 }),
    ).toMatchObject({
      type: "lockfile",
      classification: "soft-exclude",
      decision: "exclude",
      reasons: expect.arrayContaining(["large lock artifact"]),
    });
    expect(
      scoreContextFile({ path: "package-lock.json", type: "source", bytes: 100 }),
    ).toMatchObject({
      type: "lockfile",
      classification: "soft-exclude",
      decision: "exclude",
      reasons: expect.arrayContaining(["large lock artifact"]),
    });
    expect(scoreContextFile({ path: "dist/cli.js", type: "source", bytes: 100 })).toMatchObject({
      type: "generated",
      classification: "soft-exclude",
      decision: "exclude",
      reasons: expect.arrayContaining(["generated artifact"]),
    });
    expect(scoreContextFile({ path: "README", type: "doc", bytes: 100 })).toMatchObject({
      type: "doc",
      classification: "conditional-include",
      reasons: expect.arrayContaining(["documentation file"]),
    });
  });

  it("builds a structured report with included and excluded files plus reason traces", () => {
    const report = buildContextBudgetReport(
      [
        { path: "src/index.ts", bytes: 800, relevance: 0.9 },
        { path: "tests/context/budget.test.ts", bytes: 1600, relevance: 0.8 },
        { path: "docs/ARCHITECTURE.md", bytes: 20000, relevance: 0.2 },
        { path: "package-lock.json", bytes: 120000, relevance: 0.3 },
        { path: ".env", bytes: 12, relevance: 1 },
      ],
      { maxTokens: 700 },
    );

    expect(report.included.map((file) => file.path)).toEqual([
      "src/index.ts",
      "tests/context/budget.test.ts",
    ]);
    expect(report.totalTokenEstimate).toBe(600);
    expect(report.excluded.map((file) => [file.path, file.classification, file.decision])).toEqual([
      ["docs/ARCHITECTURE.md", "conditional-include", "exclude"],
      [".env", "hard-exclude", "exclude"],
      ["package-lock.json", "soft-exclude", "exclude"],
    ]);
    expect(report.reasonTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/index.ts", decision: "include" }),
        expect.objectContaining({ path: ".env", classification: "hard-exclude" }),
      ]),
    );
  });

  it("selects a lazy task-relevant canon slice instead of loading the whole canon", () => {
    const files = selectLazyCanonFiles({
      contextDir: ".ai-context/",
      taskKind: "implementation",
      touchedPaths: ["src/context/index.ts", "src/internals/fsxn.ts"],
    });

    expect(files.map((file) => file.path)).toEqual([
      ".ai-context/RULE_ROUTER.md",
      ".ai-context/rules/agent-behavior-core.md",
      ".ai-context/project.md",
      ".ai-context/rules/engine-invariants.md",
      ".ai-context/rules/environment.md",
    ]);
    expect(files.every((file) => file.classification === "conditional-include")).toBe(true);
    expect(files.map((file) => file.path)).not.toContain(".ai-context/adapters/claude.md");
    expect(files.map((file) => file.path)).not.toContain(
      ".ai-context/rules/doc-and-truth-homes.md",
    );
  });

  it("keeps budget ordering deterministic and prefers smaller ties", () => {
    const report = buildContextBudgetReport(
      [
        { path: "src/Beta.ts", bytes: 400, relevance: 0.5 },
        { path: "src/alpha.ts", bytes: 400, relevance: 0.5 },
        { path: "src/big.ts", bytes: 200_000, relevance: 0.5 },
        { path: "src/small.ts", bytes: 400, relevance: 0.5 },
      ],
      { maxFileTokens: 100_000, maxTokens: 100_000 },
    );

    expect(report.included.map((file) => file.path)).toEqual([
      "src/Beta.ts",
      "src/alpha.ts",
      "src/small.ts",
      "src/big.ts",
    ]);
  });

  it("loads environment rules for security work touching context path classification", () => {
    const files = selectLazyCanonFiles({
      contextDir: "ai-coding",
      taskKind: "security",
      touchedPaths: ["src/context/index.ts"],
    });

    expect(files.map((file) => file.path)).toContain("ai-coding/rules/environment.md");
  });
});
