import { describe, expect, it } from "vitest";
import {
  COMMON_ECC_COMPONENTS,
  selectEccComponents,
} from "../../src/ecc/components.js";
import type { RepoStack } from "../../src/profile/scan.js";

function stack(overrides: Partial<RepoStack> = {}): RepoStack {
  return {
    languages: [],
    frameworks: [],
    cloud: [],
    databases: [],
    deployment: [],
    hasTypeScript: false,
    scripts: {},
    entryPoints: [],
    browserTest: false,
    isMonorepo: false,
    ...overrides,
  };
}

const COMMON = [
  "baseline:rules",
  "baseline:agents",
  "baseline:platform",
  "baseline:commands",
  "skill:tdd-workflow",
  "skill:verification-loop",
  "skill:strategic-compact",
  "skill:coding-standards",
  "agent:code-reviewer",
  "agent:code-architect",
  "agent:architect",
  "agent:planner",
  "agent:tdd-guide",
  "agent:build-error-resolver",
  "agent:refactor-cleaner",
  "agent:code-simplifier",
  "agent:silent-failure-hunter",
  "agent:pr-test-analyzer",
  "agent:doc-updater",
  "agent:docs-lookup",
  "agent:code-explorer",
  "agent:security-reviewer",
  "agent:type-design-analyzer",
  "agent:performance-optimizer",
] as const;

describe("selectEccComponents", () => {
  it("returns the exact common baseline and local MCP for an empty vibe project", () => {
    const selected = selectEccComponents({
      stack: stack(),
      posture: "vibe",
      profile: "core",
    });

    expect(COMMON_ECC_COMPONENTS).toEqual(COMMON);
    expect(selected).toEqual({
      scope: "scoped",
      components: [...COMMON],
      mcps: ["mcp:sequential-thinking"],
      recommendations: [],
    });
  });

  it("adds TypeScript and React riders, including the web agents", () => {
    const selected = selectEccComponents({
      stack: stack({
        languages: ["TypeScript/Node.js"],
        frameworks: ["React"],
        hasTypeScript: true,
      }),
      posture: "vibe",
      profile: "core",
    });

    expect(selected.components).toEqual([
      ...COMMON,
      "lang:typescript",
      "agent:typescript-reviewer",
      "framework:react",
      "agent:react-reviewer",
      "agent:react-build-resolver",
      "agent:e2e-runner",
      "agent:a11y-architect",
    ]);
  });

  it("treats repeatable advance declarations as additive and stable", () => {
    const selected = selectEccComponents({
      stack: stack(),
      posture: "vibe",
      profile: "core",
      declarations: ["lang:cpp", "skill:security-review", "lang:cpp"],
    });

    expect(selected.components).toEqual([
      ...COMMON,
      "lang:cpp",
      "agent:cpp-reviewer",
      "agent:cpp-build-resolver",
      "skill:security-review",
    ]);
  });

  it("does not invent components for an unmapped detected language", () => {
    const selected = selectEccComponents({
      stack: stack({ languages: ["C/C++"] }),
      posture: "vibe",
      profile: "core",
    });

    expect(selected.components).toEqual([...COMMON]);
  });

  it("modulates security content and GitHub MCP by posture without defaulting egress", () => {
    const team = selectEccComponents({
      stack: stack(),
      posture: "team",
      profile: "core",
      declaredMcps: ["code-review-graph", "codebase-memory-mcp", "context7", "exa"],
    });
    const enterprise = selectEccComponents({
      stack: stack(),
      posture: "enterprise",
      profile: "core",
    });

    expect(team.components).toEqual([...COMMON]);
    expect(team.recommendations).toEqual(["capability:security"]);
    expect(team.mcps).toEqual([
      "mcp:sequential-thinking",
      "mcp:code-review-graph",
      "mcp:codebase-memory-mcp",
      "mcp:github",
    ]);
    expect(team.mcps).not.toContain("mcp:context7");
    expect(team.mcps).not.toContain("mcp:exa");
    expect(enterprise.components).toEqual([...COMMON, "capability:security"]);
    expect(enterprise.recommendations).toEqual([]);
    expect(enterprise.mcps).toEqual(["mcp:sequential-thinking", "mcp:github"]);
  });

  it("uses full only when explicitly requested", () => {
    expect(
      selectEccComponents({ stack: stack(), posture: "vibe", profile: "full" }).scope,
    ).toBe("full");
    expect(
      selectEccComponents({ stack: stack(), posture: "enterprise", profile: "core" }).scope,
    ).toBe("scoped");
  });

  it("rejects unknown declarations with the offending component", () => {
    expect(() =>
      selectEccComponents({
        stack: stack(),
        posture: "vibe",
        profile: "core",
        declarations: ["skill:not-real"],
      }),
    ).toThrow(/unknown ECC component declaration: skill:not-real/);
  });
});
