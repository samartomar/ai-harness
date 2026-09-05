import { describe, expect, it } from "vitest";
import { classifyCiImpact } from "../../src/internals/ci-impact.js";
import {
  isWorkbenchTestPath,
  WORKBENCH_CONTRACT_TEST_PATTERNS,
  WORKBENCH_PURE_TEST_EXCLUDE_PATTERNS,
  WORKBENCH_PURE_TEST_PATTERNS,
  WORKBENCH_RETAINED_TEST_PATTERNS,
  WORKBENCH_TEST_PATTERNS,
} from "../../src/internals/workbench-test-ownership.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const testFiles = [
  "tests/org-policy/catalog.test.ts",
  "tests/org-policy/studio-model.test.ts",
  "tests/org-policy/workbench/core/request.test.ts",
  "tests/org-policy/workbench/compilers/new-source.test.ts",
  "tests/ecc/module-selection-closure.test.ts",
  "tests/tools/prepare-packed-workbench.test.ts",
];

describe("Workbench lane ownership", () => {
  it("discovers nested source contracts without maintaining a file count", () => {
    expect(WORKBENCH_TEST_PATTERNS).toContain("tests/org-policy/workbench/**/*.test.ts");
    expect(testFiles.filter(isWorkbenchTestPath)).toEqual(testFiles.slice(1));
    expect(isWorkbenchTestPath("tests/org-policy/workbench/notes.md")).toBe(false);
    expect(isWorkbenchTestPath("tests/org-policy/workbench-other/core.test.ts")).toBe(false);
  });

  it("keeps packed Workbench closure locks in the retained project", () => {
    expect(isWorkbenchTestPath("tests/tools/prepare-packed-workbench.test.ts")).toBe(true);
    expect(WORKBENCH_RETAINED_TEST_PATTERNS).toContain(
      "tests/tools/prepare-packed-workbench.test.ts",
    );
  });
  it("routes a newly discovered typed root test through the pure project", () => {
    const newPureTest = "tests/org-policy/workbench/new-source.test.ts";
    expect(isWorkbenchTestPath(newPureTest)).toBe(true);
    expect(WORKBENCH_PURE_TEST_PATTERNS).toContain("tests/org-policy/workbench/**/*.test.ts");
    expect(WORKBENCH_PURE_TEST_EXCLUDE_PATTERNS).toEqual(WORKBENCH_CONTRACT_TEST_PATTERNS);
    expect(WORKBENCH_CONTRACT_TEST_PATTERNS).not.toContain(newPureTest);
    expect(WORKBENCH_RETAINED_TEST_PATTERNS).not.toContain(
      "tests/org-policy/workbench/**/*.test.ts",
    );
  });
  it("runs the complete discovered lane for a typed browser change", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/workbench/ui/main.ts"],
      testFiles,
    });
    expect(receipt.testLane).toBe("workbench");
    expect(receipt.selectedTests).toEqual([...testFiles.slice(1)].sort());
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
