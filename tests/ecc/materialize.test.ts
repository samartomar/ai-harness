import { describe, expect, it } from "vitest";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import {
  classifyGovernedEccOperation,
  eccComponentSourcePaths,
  eccManifestOperationSelected,
  eccMaterializationSpec,
  filterEccManifestPlan,
  filterGovernedEccManifestPlan,
} from "../../src/ecc/materialize.js";

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
  destinationPath = `/fixture/${sourceRelativePath}`,
): FixtureOperation {
  return {
    kind,
    moduleId,
    sourceRelativePath,
    destinationPath,
  };
}

function fixturePlan() {
  const operations: FixtureOperation[] = [
    operation("rules/common/testing.md", "rules-core"),
    operation("rules/react/testing.md", "rules-core"),
    operation("rules/web/security.md", "rules-core"),
    operation("rules/typescript/testing.md", "rules-core"),
    operation("commands/tdd.md", "commands-core"),
    operation("hooks/pretooluse.js", "hooks-runtime"),
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
    operation("skills/unified-memory/SKILL.md", "skill-unified-memory"),
    operation("skills/verification-loop/SKILL.md", "workflow-quality"),
    operation("skills/strategic-compact/SKILL.md", "workflow-quality"),
    operation("skills/coding-standards/SKILL.md", "framework-language"),
    operation("skills/react-patterns/SKILL.md", "framework-language"),
    operation("skills/react-testing/SKILL.md", "framework-language"),
    operation("skills/rust-patterns/SKILL.md", "framework-language"),
    operation("skills/deep-research/SKILL.md", "research-apis"),
    operation("skills/swiftui-patterns/SKILL.md", "swift-apple"),
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
  it("deduplicates materialized module ids while retaining the first trusted selection order", () => {
    const spec = eccMaterializationSpec({
      ...scopedSelection(),
      moduleIds: ["rules-core", "rules-core", "agents-core"],
      components: ["baseline:rules", "baseline:agents"],
      mcps: [],
    });

    expect(spec.moduleIds).toEqual(["rules-core", "agents-core"]);
  });

  it("materializes exactly the declared upstream Core modules", () => {
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: [],
      mcps: [],
      recommendations: [],
      moduleIds: [
        "rules-core",
        "agents-core",
        "commands-core",
        "hooks-runtime",
        "platform-configs",
        "skill-unified-memory",
        "workflow-quality",
      ],
    };
    const filtered = fixturePlan();
    filterEccManifestPlan(filtered, selected);

    expect([...new Set(filtered.operations.map((entry) => entry.moduleId))].sort()).toEqual([
      "agents-core",
      "commands-core",
      "hooks-runtime",
      "platform-configs",
      "rules-core",
      "skill-unified-memory",
      "workflow-quality",
    ]);
    expect(JSON.stringify(filtered)).not.toContain("framework-language");
    expect(JSON.stringify(filtered)).not.toContain("research-apis");
    expect(JSON.stringify(filtered)).not.toContain("swift-apple");
  });

  it("materializes real Swift skill content for the lang:swift selector", () => {
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["lang:swift"],
      mcps: [],
      recommendations: [],
    };
    const filtered = fixturePlan();
    filterEccManifestPlan(filtered, selected);

    expect(filtered.operations.map((entry) => entry.sourceRelativePath)).toContain(
      "skills/swiftui-patterns/SKILL.md",
    );
    expect(eccComponentSourcePaths("lang:swift")).toContain("skills/swiftui-patterns");
    expect(eccComponentSourcePaths("lang:swift")).not.toContain("rules/swift");
  });

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
      "rules/react/testing.md",
      "rules/web/security.md",
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
    expect(JSON.stringify(plan)).not.toContain("rules/typescript");
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

  const governedSelections: Array<[string, EccComponentSelection]> = [
    ["core", { ...scopedSelection(), components: [], mcps: [], moduleIds: ["rules-core"] }],
    [
      "platform",
      { ...scopedSelection(), components: [], mcps: [], moduleIds: ["platform-configs"] },
    ],
    ["full", { ...scopedSelection(), scope: "full" }],
  ];

  it.each(governedSelections)(
    "filters mixed MCP and host-hook operations for governed %s selection while retaining ECC content",
    (_name, selection) => {
      const mixedModule = selection.moduleIds?.[0] ?? "rules-core";
      const operations: FixtureOperation[] = [
        operation(
          "rules/common/testing.md",
          mixedModule,
          "copy-file",
          "/fixture/.claude/rules/common/testing.md",
        ),
        operation(
          "agents/code-reviewer.md",
          mixedModule,
          "copy-file",
          "/fixture/.claude/agents/code-reviewer.md",
        ),
        operation(
          "skills/tdd-workflow/SKILL.md",
          mixedModule,
          "copy-file",
          "/fixture/.claude/skills/tdd-workflow/SKILL.md",
        ),
        operation("commands/tdd.md", mixedModule, "copy-file", "/fixture/.claude/commands/tdd.md"),
        operation("rules/common/mcp.md", mixedModule, "copy-file", "/fixture/.mcp.json"),
        operation(
          "commands/settings.md",
          mixedModule,
          "copy-file",
          "/fixture/.claude/settings.json",
        ),
        operation(
          "commands/hook.md",
          "hooks-runtime",
          "copy-file",
          "/fixture/.claude/hooks/post-tool-use.js",
        ),
      ];
      const plan = {
        operations,
        statePreview: { operations: operations.map((entry) => ({ ...entry })) },
      };

      filterGovernedEccManifestPlan(plan, selection, {
        projectRoot: "/fixture",
        homeDir: "/home/aih",
        target: "claude",
      });

      expect(plan.operations.map((entry) => entry.sourceRelativePath)).toEqual([
        "rules/common/testing.md",
        "agents/code-reviewer.md",
        "skills/tdd-workflow/SKILL.md",
        "commands/tdd.md",
      ]);
      expect(plan.statePreview.operations).toEqual(plan.operations);
    },
  );

  it.each([
    [
      "unknown destination",
      operation("commands/tdd.md", "commands-core", "copy-file", "/fixture/package.json"),
    ],
    [
      "unsafe source",
      operation(
        "./commands/tdd.md",
        "commands-core",
        "copy-file",
        "/fixture/.claude/commands/tdd.md",
      ),
    ],
    [
      "unsafe destination",
      operation(
        "commands/tdd.md",
        "commands-core",
        "copy-file",
        "//fixture/.claude/commands/tdd.md",
      ),
    ],
    [
      "outside Windows destination",
      operation(
        "skills/tdd/SKILL.md",
        "workflow-quality",
        "copy-file",
        "C:/Windows/skills/tdd/SKILL.md",
      ),
    ],
  ] as const)("fails closed on governed %s", (_name, entry) => {
    const plan = { operations: [entry], statePreview: { operations: [{ ...entry }] } };
    expect(() =>
      filterGovernedEccManifestPlan(
        plan,
        { ...scopedSelection(), scope: "full" },
        {
          projectRoot: "/fixture",
          homeDir: "/home/aih",
          target: "claude",
        },
      ),
    ).toThrow(/unclassifiable governed ECC content operation|unsafe ECC (source|destination) path/);
  });

  it("rejects a content-looking destination outside the authorized project and home roots", () => {
    const entry = operation(
      "skills/tdd-workflow/SKILL.md",
      "workflow-quality",
      "copy-file",
      "/tmp/skills/tdd-workflow/SKILL.md",
    );
    const plan = { operations: [entry], statePreview: { operations: [{ ...entry }] } };

    expect(() =>
      filterGovernedEccManifestPlan(
        plan,
        { ...scopedSelection(), scope: "full" },
        {
          projectRoot: "/fixture",
          homeDir: "/home/aih",
          target: "claude",
        },
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });

  it("rejects a same-root source-to-target remap and duplicate normalized destination", () => {
    const remapped = operation(
      "rules/common/testing.md",
      "rules-core",
      "copy-file",
      "/fixture/.claude/skills/common/testing.md",
    );
    const remapPlan = { operations: [remapped], statePreview: { operations: [{ ...remapped }] } };
    expect(() =>
      filterGovernedEccManifestPlan(
        remapPlan,
        { ...scopedSelection(), scope: "full" },
        {
          projectRoot: "/fixture",
          homeDir: "/home/aih",
          target: "claude",
        },
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);

    const first = operation(
      "skills/tdd-workflow/SKILL.md",
      "workflow-quality",
      "copy-file",
      "/fixture/.claude/skills/tdd-workflow/SKILL.md",
    );
    const second = operation(
      "skills/tdd-workflow/SKILL.md",
      "workflow-quality",
      "copy-file",
      "/fixture/.claude/skills/tdd-workflow/SKILL.md",
    );
    const collisionPlan = {
      operations: [first, second],
      statePreview: { operations: [{ ...first }, { ...second }] },
    };
    expect(() =>
      filterGovernedEccManifestPlan(
        collisionPlan,
        { ...scopedSelection(), scope: "full" },
        {
          projectRoot: "/fixture",
          homeDir: "/home/aih",
          target: "claude",
        },
      ),
    ).toThrow(/normalized governed ECC destination collision/);
  });

  it("fails closed on unsupported operation shapes", () => {
    const plan = fixturePlan();
    plan.operations.push(operation("unknown", "agents-core", "remove-tree"));
    plan.statePreview.operations.push(operation("unknown", "agents-core", "remove-tree"));

    expect(() => filterEccManifestPlan(plan, scopedSelection())).toThrow(
      /unsupported ECC manifest operation kind: remove-tree/,
    );
  });

  it("rejects malformed manifest arrays and operation identities before governed filtering", () => {
    expect(() =>
      filterEccManifestPlan(
        { operations: null, statePreview: { operations: [] } } as never,
        scopedSelection(),
      ),
    ).toThrow(/invalid ECC manifest plan operation arrays/);

    const malformed = {
      operations: [
        {
          kind: "copy-file",
          moduleId: 1,
          sourceRelativePath: "commands/tdd.md",
          destinationPath: "/fixture/.claude/commands/tdd.md",
        },
      ],
      statePreview: {
        operations: [
          {
            kind: "copy-file",
            moduleId: 1,
            sourceRelativePath: "commands/tdd.md",
            destinationPath: "/fixture/.claude/commands/tdd.md",
          },
        ],
      },
    };
    expect(() => filterEccManifestPlan(malformed as never, scopedSelection())).toThrow(
      /invalid ECC manifest operation shape/,
    );
  });

  it("fails closed on unclassifiable governed operation kinds, identities, and merge forms", () => {
    const roots = { projectRoot: "/fixture", homeDir: "/home/aih", target: "claude" };
    expect(() =>
      classifyGovernedEccOperation(
        operation("commands/tdd.md", "commands-core", "remove-tree") as never,
        roots,
      ),
    ).toThrow(/unsupported ECC manifest operation kind/);
    expect(() =>
      classifyGovernedEccOperation(
        operation("commands/tdd.md", " ", "copy-file", "/fixture/.claude/commands/tdd.md"),
        roots,
      ),
    ).toThrow(/invalid ECC manifest module identity/);
    expect(() =>
      classifyGovernedEccOperation(
        operation(
          "commands/tdd.md",
          "commands-core",
          "merge-json",
          "/fixture/.claude/commands/tdd.md",
        ),
        roots,
      ),
    ).toThrow(/unclassifiable governed ECC merge-json operation/);
  });

  it("retains the exact home-scoped Codex AGENTS mapping under governed filtering", () => {
    expect(
      classifyGovernedEccOperation(
        operation(".codex/AGENTS.md", "agents-core", "copy-file", "/home/aih/.codex/AGENTS.md"),
        { projectRoot: "/fixture", homeDir: "/home/aih", target: "codex" },
      ),
    ).toBe("ecc-content");
  });

  it.each([
    [".opencode/index.ts", "/home/aih/.config/opencode/index.ts"],
    [".opencode/opencode.json", "/home/aih/.config/opencode/opencode.json"],
    [".opencode/plugins/ecc-hooks.ts", "/home/aih/.config/opencode/plugins/ecc-hooks.ts"],
    [".opencode/dist/plugins/ecc-hooks.js", "/home/aih/.config/opencode/dist/plugins/ecc-hooks.js"],
  ])(
    "classifies OpenCode executable package content as host runtime: %s",
    (source, destination) => {
      expect(
        classifyGovernedEccOperation(
          operation(source, "platform-configs", "copy-file", destination),
          { projectRoot: "/fixture", homeDir: "/home/aih", target: "opencode" },
        ),
      ).toBe("host-runtime");
    },
  );

  it("fails closed when operation and state-preview inputs drift", () => {
    const plan = fixturePlan();
    plan.statePreview.operations.pop();

    expect(() => filterEccManifestPlan(plan, scopedSelection())).toThrow(
      /operation\/state preview drift/,
    );
  });

  it("maps logical selectors to exact source closures", () => {
    expect(eccComponentSourcePaths("baseline:agents")).toEqual([
      ".agents/plugins/marketplace.json",
      "AGENTS.md",
    ]);
    expect(eccComponentSourcePaths("agent:code-reviewer")).toEqual(["agents/code-reviewer.md"]);
    expect(eccComponentSourcePaths("baseline:rules")).toEqual(["rules/common", "rules/README.md"]);
    expect(eccComponentSourcePaths("framework:react")).toEqual([
      ".agents/skills/frontend-patterns",
      "rules/react",
      "rules/web",
      "skills/frontend-patterns",
      "skills/react-patterns",
      "skills/react-performance",
      "skills/react-testing",
    ]);
    expect(eccComponentSourcePaths("capability:documents")).toEqual([
      "skills/nutrient-document-processing",
      "skills/visa-doc-translate",
    ]);
  });
});
