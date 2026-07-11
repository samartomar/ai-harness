import { describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { requiredBaselineAnalyzersForComponent } from "../../src/baseline-evidence/analyzer-profile.js";

function component(id: string, paths: string[]) {
  return defineBaselineCatalog({
    id: "fixture",
    owner: "owner",
    repo: "repo",
    pinnedSha: "a".repeat(40),
    components: [{ id, paths }],
  }).components[0]!;
}

describe("required baseline analyzer applicability", () => {
  it.each([
    ["runtime:ecc-installer", ["package.json", "scripts/lib"], false],
    ["agent:reviewer", ["agents/reviewer.md"], false],
    ["module:docs", ["docs/en"], false],
    ["skill:tdd", ["skills/tdd-workflow"], true],
    ["module:quality", ["scripts/check.js", "skills/verification-loop"], true],
  ])("selects Cisco only for declared skill content in %s", (id, paths, includesCisco) => {
    const required = requiredBaselineAnalyzersForComponent(component(id, paths));
    expect(required).toEqual(
      includesCisco
        ? ["aih-native", "skillspector@docker", "cisco@uvx"]
        : ["aih-native", "skillspector@docker"],
    );
  });
});
