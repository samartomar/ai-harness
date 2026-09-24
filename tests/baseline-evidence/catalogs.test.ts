import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { loadFrameworkDescriptorSectionV1 } from "../../src/catalog-package/framework-descriptors.js";
import { AihError } from "../../src/errors.js";
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
    const eccProfiles = loadFrameworkDescriptorSectionV1<{
      profiles: { full: { modules: string[] } };
    }>("ecc", "profileGraph");
    const catalog = baselineCatalogById("ecc");
    expect(catalog.pinnedSha).toBe(registryPin("affaan-m", "ECC"));
    const ids = catalog.components.map((component) => component.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "runtime:ecc-installer",
        "runtime:ecc-kiro",
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
        "module:nasiko-control-plane",
        "baseline:rules",
        "baseline:agents",
        "lang:typescript",
        "framework:react",
        "capability:documents",
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
    expect(ids.filter((id) => id.startsWith("module:"))).toEqual(
      eccProfiles.profiles.full.modules.map((id) => `module:${id}`),
    );
    expect(ids.filter((id) => id.startsWith("module:"))).toHaveLength(26);
    expect(ids.some((id) => id.startsWith("module:docs-"))).toBe(false);
    expect(
      catalog.components.some((component) =>
        component.paths.some((path) => path.startsWith("docs/")),
      ),
    ).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "runtime:ecc-kiro",
      "module:agents-core",
      "module:platform-configs",
      "skill:tdd-workflow",
    ]) {
      expect(catalog.components.find((component) => component.id === id)).toMatchObject({
        skillContent: true,
      });
    }
    expect(
      catalog.components.find((component) => component.id === "runtime:ecc-installer"),
    ).not.toHaveProperty("skillContent");
    expect(
      catalog.components.find((component) => component.id === "runtime:ecc-installer")?.paths,
    ).toEqual(
      expect.arrayContaining([
        "scripts/lib/invocation-environment.js",
        "scripts/lib/opencode-paths.js",
      ]),
    );
    expect(
      catalog.components.find((component) => component.id === "baseline:agents")?.paths,
    ).toEqual([".agents/plugins/marketplace.json", "AGENTS.md"]);
    expect(catalog.components.find((component) => component.id === "agent:planner")?.paths).toEqual(
      ["agents/planner.md"],
    );
    expect(
      catalog.components.find((component) => component.id === "framework:react")?.paths,
    ).not.toContain("skills/frontend-slides");
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

  it("binds the layout only to the pin the installed Catalog carries, refusing others by both identities", () => {
    const carried = baselineCatalogById("ecc").pinnedSha;
    expect(baselineCatalogById("ecc", carried).pinnedSha).toBe(carried);
    const other = "e".repeat(40);
    let refusal: unknown;
    try {
      baselineCatalogById("ecc", other);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AihError);
    expect(refusal).toMatchObject({ code: "AIH_TRUST" });
    expect((refusal as AihError).message).toContain(carried);
    expect((refusal as AihError).message).toContain(other);
    expect(() => baselineCatalogById("unknown")).toThrow(/unknown/i);
  });
});
