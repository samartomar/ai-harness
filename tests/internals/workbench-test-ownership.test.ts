import { describe, expect, it } from "vitest";
import { classifyCiImpact } from "../../src/internals/ci-impact.js";
import { isWorkbenchTestPath } from "../../src/internals/workbench-test-ownership.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const testFiles = [
  "tests/org-policy/catalog.test.ts",
  "tests/org-policy/workbench/core/request.test.ts",
  "tests/org-policy/workbench/compilers/new-source.test.ts",
  "tests/ecc/module-selection-closure.test.ts",
  "tests/tools/packed-consumer.test.ts",
];

describe("backend policy lane ownership", () => {
  it("discovers nested source contracts without maintaining a file count", () => {
    expect(testFiles.filter(isWorkbenchTestPath)).toEqual(testFiles.slice(1));
    expect(isWorkbenchTestPath("tests/org-policy/workbench/notes.md")).toBe(false);
    expect(isWorkbenchTestPath("tests/org-policy/workbench-other/core.test.ts")).toBe(false);
  });

  it("keeps packed Core closure locks in the retained project", () => {
    expect(isWorkbenchTestPath("tests/tools/packed-consumer.test.ts")).toBe(true);
  });
  it("runs the complete discovered backend lane for a policy source change", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/workbench/prepared-catalog.ts"],
      testFiles,
    });
    expect(receipt.testLane).toBe("both");
    expect(receipt.selectedTests).toEqual([...testFiles].sort());
  });

  it.each([
    "src/org-policy/workbench/core/state.ts",
    "src/org-policy/workbench/catalog/contracts.ts",
    "src/org-policy/workbench/compilers/organization.ts",
    "src/org-policy/schema.ts",
  ])("retains Core checks for shared policy behavior in %s", (path) => {
    const receipt = classifyCiImpact({ baseSha, headSha, changedPaths: [path], testFiles });
    expect(receipt.testLane).toBe("both");
    expect(receipt.selectedTests).toContain("tests/org-policy/catalog.test.ts");
    expect(receipt.selectedTests).toContain("tests/ecc/module-selection-closure.test.ts");
  });
});
