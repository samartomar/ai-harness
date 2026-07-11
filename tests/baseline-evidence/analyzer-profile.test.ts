import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import {
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";

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
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

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
    expect(requiredBaselineDetectorsForComponent(component(id, paths))).toEqual(
      includesCisco ? ["skillspector", "cisco"] : ["skillspector"],
    );
  });

  it("requires Cisco when a declared harness root contains SKILL.md content", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-analyzer-profile-"));
    roots.push(root);
    mkdirSync(join(root, ".kiro", "skills", "reviewer"), { recursive: true });
    writeFileSync(join(root, ".kiro", "skills", "reviewer", "SKILL.md"), "# Reviewer\n");
    const nested = component("runtime:ecc-kiro", [".kiro"]);

    expect(requiredBaselineAnalyzersForComponent(nested, root)).toEqual([
      "aih-native",
      "skillspector@docker",
      "cisco@uvx",
    ]);
    expect(requiredBaselineDetectorsForComponent(nested, root)).toEqual([
      "skillspector",
      "cisco",
    ]);
  });
});
