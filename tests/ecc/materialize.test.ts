import { describe, expect, it } from "vitest";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import { eccManifestOperationSelected, filterEccManifestPlan } from "../../src/ecc/materialize.js";

interface FixtureOperation {
  kind: "copy-file" | "merge-json" | "remove-tree";
  moduleId: string;
  sourceRelativePath: string;
  destinationPath: string;
}

function operation(
  sourceRelativePath: string,
  moduleId: string,
  kind: FixtureOperation["kind"] = "copy-file",
): FixtureOperation {
  return {
    kind,
    moduleId,
    sourceRelativePath,
    destinationPath: `/fixture/${sourceRelativePath}`,
  };
}

function fixturePlan() {
  const operations: FixtureOperation[] = [
    operation("rules/common/testing.md", "rules-core"),
    operation("commands/tdd.md", "commands-core"),
    operation("mcp-configs/mcp-servers.json", "platform-configs"),
    operation("scaffolds/cursor/hooks.json", "platform-configs", "merge-json"),
    operation("AGENTS.md", "agents-core"),
    operation(".agents/plugins/marketplace.json", "agents-core"),
    operation("agents/code-reviewer.md", "agents-core"),
    operation("agents/react-reviewer.md", "agents-core"),
    operation("agents/react-build-resolver.md", "agents-core"),
    operation("agents/e2e-runner.md", "agents-core"),
    operation("agents/a11y-architect.md", "agents-core"),
    operation("agents/mle-reviewer.md", "agents-core"),
    operation(".agents/skills/tdd-workflow/SKILL.md", "agents-core"),
    operation(".agents/skills/react-patterns/SKILL.md", "agents-core"),
    operation(".agents/skills/deep-research/SKILL.md", "agents-core"),
    operation("skills/tdd-workflow/SKILL.md", "workflow-quality"),
    operation("skills/verification-loop/SKILL.md", "workflow-quality"),
    operation("skills/strategic-compact/SKILL.md", "workflow-quality"),
    operation("skills/coding-standards/SKILL.md", "framework-language"),
    operation("skills/react-patterns/SKILL.md", "framework-language"),
    operation("skills/react-testing/SKILL.md", "framework-language"),
    operation("skills/rust-patterns/SKILL.md", "framework-language"),
    operation("skills/deep-research/SKILL.md", "research-apis"),
  ];
  return {
    operations: [...operations],
    statePreview: { operations: operations.map((entry) => ({ ...entry })) },
  };
}

function scopedSelection(): EccComponentSelection {
  return {
    scope: "scoped",
    components: [
      "baseline:rules",
      "baseline:agents",
      "baseline:platform",
      "baseline:commands",
      "skill:tdd-workflow",
      "skill:verification-loop",
      "skill:strategic-compact",
      "skill:coding-standards",
      "agent:code-reviewer",
      "framework:react",
      "agent:react-reviewer",
      "agent:react-build-resolver",
      "agent:e2e-runner",
      "agent:a11y-architect",
    ],
    mcps: ["mcp:sequential-thinking"],
    recommendations: [],
  };
}

describe("filterEccManifestPlan", () => {
  it("exposes the same scoped operation predicate for prune reconciliation", () => {
    const selected = scopedSelection();
    expect(
      eccManifestOperationSelected(
        operation("skills/react-patterns/SKILL.md", "framework-language"),
        selected,
      ),
    ).toBe(true);
    expect(
      eccManifestOperationSelected(
        operation("skills/cpp-testing/SKILL.md", "framework-language"),
        selected,
      ),
    ).toBe(false);
    expect(
      eccManifestOperationSelected(
        operation("skills/react-testing/SKILL.md", "aih-scoped-skills"),
        selected,
      ),
    ).toBe(true);
    expect(
      eccManifestOperationSelected(operation("anything", "anything"), {
        ...selected,
        scope: "full",
      }),
    ).toBe(true);
  });

  it("keeps selected files and target scaffolding while filtering unrelated agents and skills", () => {
    const plan = fixturePlan();

    filterEccManifestPlan(plan, scopedSelection());

    const expected = [
      "rules/common/testing.md",
      "commands/tdd.md",
      "mcp-configs/mcp-servers.json",
      "scaffolds/cursor/hooks.json",
      "AGENTS.md",
      ".agents/plugins/marketplace.json",
      "agents/code-reviewer.md",
      "agents/react-reviewer.md",
      "agents/react-build-resolver.md",
      "agents/e2e-runner.md",
      "agents/a11y-architect.md",
      ".agents/skills/tdd-workflow/SKILL.md",
      ".agents/skills/react-patterns/SKILL.md",
      "skills/tdd-workflow/SKILL.md",
      "skills/verification-loop/SKILL.md",
      "skills/strategic-compact/SKILL.md",
      "skills/coding-standards/SKILL.md",
      "skills/react-patterns/SKILL.md",
      "skills/react-testing/SKILL.md",
    ];
    expect(plan.operations.map((entry) => entry.sourceRelativePath)).toEqual(expected);
    expect(plan.statePreview.operations).toEqual(plan.operations);
    expect(JSON.stringify(plan)).not.toContain("mle-reviewer");
    expect(JSON.stringify(plan)).not.toContain("rust-patterns");
    expect(JSON.stringify(plan)).not.toContain("deep-research");
  });

  it("is idempotent and keeps operations/state preview in lockstep", () => {
    const plan = fixturePlan();
    filterEccManifestPlan(plan, scopedSelection());
    const once = JSON.stringify(plan);

    filterEccManifestPlan(plan, scopedSelection());

    expect(JSON.stringify(plan)).toBe(once);
    expect(plan.statePreview.operations).toEqual(plan.operations);
  });

  it("leaves an explicit full plan unfiltered", () => {
    const plan = fixturePlan();
    const before = JSON.stringify(plan);

    filterEccManifestPlan(plan, { ...scopedSelection(), scope: "full" });

    expect(JSON.stringify(plan)).toBe(before);
  });

  it("fails closed on unsupported operation shapes", () => {
    const plan = fixturePlan();
    plan.operations.push(operation("unknown", "agents-core", "remove-tree"));
    plan.statePreview.operations.push(operation("unknown", "agents-core", "remove-tree"));

    expect(() => filterEccManifestPlan(plan, scopedSelection())).toThrow(
      /unsupported ECC manifest operation kind: remove-tree/,
    );
  });

  it("fails closed when operation and state-preview inputs drift", () => {
    const plan = fixturePlan();
    plan.statePreview.operations.pop();

    expect(() => filterEccManifestPlan(plan, scopedSelection())).toThrow(
      /operation\/state preview drift/,
    );
  });
});
