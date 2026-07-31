import { describe, expect, it } from "vitest";
import {
  COMMON_ECC_COMPONENTS,
  LEAN_ECC_COMPONENTS,
  selectEccComponents,
  UPSTREAM_CORE_ECC_MODULE_IDS,
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
  it("keeps the default minimal closure deliberate and free of automatic platform or MCP surfaces", () => {
    const selected = selectEccComponents({
      stack: stack({ languages: ["TypeScript"], frameworks: ["React"] }),
      posture: "enterprise",
      profile: "minimal",
      declaredMcps: ["code-review-graph"],
    });

    expect(selected.components).toEqual(LEAN_ECC_COMPONENTS);
    expect(selected.components).not.toContain("baseline:platform");
    expect(selected.mcps).toEqual([]);
    expect(selected.recommendations).toEqual(["capability:security"]);
  });

  it("returns the exact upstream Core module closure without implicit MCPs", () => {
    const selected = selectEccComponents({
      stack: stack(),
      posture: "vibe",
      profile: "core",
    });

    expect(COMMON_ECC_COMPONENTS).toEqual(COMMON);
    expect(selected).toEqual({
      scope: "scoped",
      components: [],
      mcps: [],
      recommendations: [],
      moduleIds: [...UPSTREAM_CORE_ECC_MODULE_IDS],
    });
  });

  it("does not silently add detected language or framework catalogs to upstream Core", () => {
    const selected = selectEccComponents({
      stack: stack({
        languages: ["TypeScript/Node.js"],
        frameworks: ["React"],
        hasTypeScript: true,
      }),
      posture: "vibe",
      profile: "core",
    });

    expect(selected.components).toEqual([]);
    expect(selected.moduleIds).toEqual(UPSTREAM_CORE_ECC_MODULE_IDS);
  });

  it("treats repeatable advance declarations as additive and stable", () => {
    const selected = selectEccComponents({
      stack: stack(),
      posture: "vibe",
      profile: "core",
      declarations: ["lang:cpp", "skill:security-review", "lang:cpp"],
    });

    expect(selected.components).toEqual([
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

    expect(selected.components).toEqual([]);
  });

  it("keeps detected PHP and Vue-family identities distinct", () => {
    const selected = selectEccComponents({
      stack: stack({ languages: ["PHP"], frameworks: ["Nuxt"] }),
      posture: "vibe",
      profile: "core",
    });

    expect(selected.components).toEqual([]);
    expect(selected.components).not.toContain("framework:nextjs");
  });

  it("normalizes unqualified leaf declarations without duplicating common leaves", () => {
    const selected = selectEccComponents({
      stack: stack(),
      posture: "vibe",
      profile: "core",
      declarations: ["tdd-workflow", "security-review"],
    });

    expect(selected.components).toEqual(["skill:tdd-workflow", "skill:security-review"]);
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

    expect(team.components).toEqual([]);
    expect(team.recommendations).toEqual(["capability:security"]);
    expect(team.mcps).toEqual([]);
    expect(team.mcps).not.toContain("mcp:context7");
    expect(team.mcps).not.toContain("mcp:exa");
    expect(enterprise.components).toEqual([]);
    expect(enterprise.recommendations).toEqual(["capability:security"]);
    expect(enterprise.mcps).toEqual([]);
  });

  it("uses full only when explicitly requested", () => {
    expect(selectEccComponents({ stack: stack(), posture: "vibe", profile: "full" }).scope).toBe(
      "full",
    );
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
