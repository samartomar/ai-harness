import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { BASELINE_SOURCES } from "../../src/internals/baseline-sources.js";

function registryPin(owner: string, repo: string): string {
  const source = BASELINE_SOURCES.flatMap((baseline) => [...baseline.sources]).find(
    (candidate) => candidate.owner === owner && candidate.repo === repo,
  );
  if (!source) throw new Error(`missing registry source ${owner}/${repo}`);
  return source.pinnedSha;
}

describe("production baseline catalogs", () => {
  it("binds ECC components to the existing registry pin and locked common baseline", () => {
    const catalog = baselineCatalogById("ecc");
    expect(catalog.pinnedSha).toBe(registryPin("affaan-m", "ECC"));
    const ids = catalog.components.map((component) => component.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "runtime:ecc-installer",
        "module:rules-core",
        "module:agents-core",
        "module:commands-core",
        "module:hooks-runtime",
        "module:platform-configs",
        "module:workflow-quality",
        "module:framework-language",
        "module:security",
        "module:orchestration",
        "module:document-processing",
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
      ]),
    );
    expect(ids.filter((id) => id.startsWith("module:"))).toHaveLength(32);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("binds Superpowers runtime and installable skills to its registry pin", () => {
    const catalog = baselineCatalogById("superpowers");
    expect(catalog.pinnedSha).toBe(registryPin("obra", "Superpowers"));
    expect(catalog.components.map((component) => component.id)).toEqual([
      "runtime:superpowers-plugin",
      "skill:brainstorming",
      "skill:dispatching-parallel-agents",
      "skill:executing-plans",
      "skill:finishing-a-development-branch",
      "skill:receiving-code-review",
      "skill:requesting-code-review",
      "skill:subagent-driven-development",
      "skill:systematic-debugging",
      "skill:test-driven-development",
      "skill:using-git-worktrees",
      "skill:using-superpowers",
      "skill:verification-before-completion",
      "skill:writing-plans",
      "skill:writing-skills",
    ]);
  });

  it("can rebind the known catalog layout to an org-vetted newer pin", () => {
    const next = "e".repeat(40);
    expect(baselineCatalogById("ecc", next).pinnedSha).toBe(next);
    expect(() => baselineCatalogById("ecc", "deadbeef")).toThrow();
    expect(() => baselineCatalogById("unknown")).toThrow(/unknown/i);
  });
});
