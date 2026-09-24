import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CI_SELECTOR_VERSION,
  classifyCiImpact,
  validateCiImpactReceipt,
} from "../../src/internals/ci-impact.js";
import { runCiImpactCommand } from "../../src/internals/ci-impact-command.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { isWorkbenchTestPath } from "../../src/internals/workbench-test-ownership.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const testFiles = [
  "tests/docs/readme-assets.test.ts",
  "tests/org-policy/catalog.test.ts",
  "tests/org-policy/workbench/data-command.test.ts",
  "tests/org-policy/workbench/prepared-catalog.test.ts",
  "tests/release-readiness.test.ts",
  "tests/workspace/manifest.test.ts",
];

function repositoryTests(root = "tests"): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    return entry.isDirectory() ? repositoryTests(path) : path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("CI impact classifier", () => {
  it.each([
    "tests/org-policy/workbench/browser/artifact.spec.ts",
    "tests/org-policy/workbench/browser/setup.ts",
    "tests/other/browser/unknown.spec.ts",
    "tests/org-policy/workbench/browser/unknown.ts",
    "tests/org-policy/workbench/browser/config.json",
  ])("retains the full fallback for unowned browser-like input %s", (path) => {
    const receipt = classifyCiImpact({ baseSha, headSha, changedPaths: [path], testFiles });
    expect(receipt.fullSuite).toBe(true);
    expect(receipt.fallbackReasons).toContain(`unknown-path:${path}`);
  });

  it("includes ECC callers when the shared MCP renderer changes", () => {
    const consumers = [
      "tests/ecc/mcp-explicit-add.test.ts",
      "tests/ecc-profile/mcp-profile.test.ts",
      "tests/ecc-profile/native-registration.test.ts",
      "tests/ecc-profile/parity-receipt.test.ts",
      "tests/mcp/render.test.ts",
    ];
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/mcp/render.ts"],
      testFiles: [...consumers, "tests/workspace/manifest.test.ts"],
    });
    expect(receipt.fullSuite).toBe(false);
    expect(receipt.selectedTests).toEqual(expect.arrayContaining(consumers));
    expect(receipt.selectedTests).not.toContain("tests/workspace/manifest.test.ts");
    expect(receipt.operatingSystems).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(validateCiImpactReceipt(receipt)).toEqual(receipt);
  });

  it("writes the receipt and GitHub outputs from bounded git observations", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-ci-impact-command-"));
    const receiptPath = join(root, "receipt.json");
    const githubOutput = join(root, "github-output.txt");
    const stdout: string[] = [];
    const run = fakeRunner((argv, options) => {
      expect(options?.cwd).toBe(root);
      if (argv[1] === "diff") return { stdout: "src/version.ts\0" };
      if (argv[1] === "ls-files") return { stdout: `${testFiles.join("\0")}\0` };
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    try {
      const receipt = await runCiImpactCommand(
        ["--base", baseSha, "--head", headSha, "--output", receiptPath],
        {
          cwd: root,
          githubOutput,
          run,
          writeStdout: (value) => stdout.push(value),
        },
      );

      expect(receipt.releasePreparation).toBe(true);
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(receipt);
      expect(stdout.join("")).toContain('"releasePreparation": true');
      expect(readFileSync(githubOutput, "utf8")).toContain("release_preparation=true\n");
      expect(readFileSync(githubOutput, "utf8")).toContain("test_lane=core\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a deterministic auditable receipt for a focused domain change", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/catalog.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({
      schemaVersion: "aih-ci-impact-v2",
      selectorVersion: CI_SELECTOR_VERSION,
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/catalog.ts"],
      riskClass: "cross-platform",
      testLane: "both",
      fullSuite: false,
      releasePreparation: false,
      operatingSystems: ["ubuntu-latest", "macos-latest", "windows-latest"],
      selectedTests: [
        "tests/org-policy/catalog.test.ts",
        "tests/org-policy/workbench/data-command.test.ts",
        "tests/org-policy/workbench/prepared-catalog.test.ts",
      ],
    });
    expect(receipt.matchedRules).toContain("workbench-shared-input");
    expect(validateCiImpactReceipt(receipt)).toEqual(receipt);
  });

  it.each([
    ["Core version identity", ["src/version.ts", "src/org-policy/catalog.ts"]],
    ["enterprise decision manifest", ["release/enterprise-change.json"]],
  ])(
    "detects release preparation from %s without trusting a branch name",
    (_name, changedPaths) => {
      const receipt = classifyCiImpact({ baseSha, headSha, changedPaths, testFiles });

      expect(receipt.releasePreparation).toBe(true);
    },
  );

  it("does not classify an ordinary dependency lock change as release preparation", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["package-lock.json"],
      testFiles,
    });

    expect(receipt.releasePreparation).toBe(false);
  });

  it.each(["release/enterprise-change.json", "src/internals/release-preflight.ts"])(
    "routes indirectly selected Workbench release checks to their authoritative lane for %s",
    (changedPath) => {
      const workbenchReleaseTest = "tests/internals/check-workbench-release-compatibility.test.ts";
      const receipt = classifyCiImpact({
        baseSha,
        headSha,
        changedPaths: [changedPath],
        testFiles: [...testFiles, workbenchReleaseTest],
      });

      expect(receipt.selectedTests).toContain(workbenchReleaseTest);
      expect(receipt).toMatchObject({
        fullSuite: false,
        testLane: "core",
      });
      expect(validateCiImpactReceipt(receipt)).toEqual(receipt);
      expect(() => validateCiImpactReceipt({ ...receipt, testLane: "both" })).toThrow(
        "CI test lane",
      );
    },
  );

  it("uses the bounded documentation suite for public documentation", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["README.md", "guides/enterprise-admin-guide.md"],
      testFiles,
    });

    expect(receipt.riskClass).toBe("docs");
    expect(receipt).toMatchObject({ testLane: "docs" });
    expect(receipt.fullSuite).toBe(false);
    expect(receipt.operatingSystems).toEqual(["ubuntu-latest"]);
    expect(receipt.selectedTests).toEqual(["tests/docs/readme-assets.test.ts"]);
  });

  it("selects Core and retained backend policy tests for a prepared catalog change", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/workbench/prepared-catalog.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({
      riskClass: "cross-platform",
      testLane: "both",
      fullSuite: false,
      selectedTests: [
        "tests/org-policy/catalog.test.ts",
        "tests/org-policy/workbench/data-command.test.ts",
        "tests/org-policy/workbench/prepared-catalog.test.ts",
      ],
    });
  });

  it("keeps Catalog consumer boundary inputs in the conservative Workbench scope", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/catalog-package/framework-descriptors.ts", "src/org-policy/catalog.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({
      testLane: "both",
      affectedProviders: [],
    });
  });

  it("keeps selector ownership of every discovered backend policy test", () => {
    const discoveredTests = repositoryTests();
    const expectedWorkbenchTests = discoveredTests
      .filter(isWorkbenchTestPath)
      .sort((left, right) => left.localeCompare(right));
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/workbench/prepared-catalog.ts"],
      testFiles: discoveredTests,
    });

    expect(expectedWorkbenchTests.length).toBeGreaterThan(0);
    expect(receipt.selectedTests).toEqual(expect.arrayContaining(expectedWorkbenchTests));
    expect(
      receipt.selectedTests.some(
        (test) => test.startsWith("tests/org-policy/") && !isWorkbenchTestPath(test),
      ),
    ).toBe(true);
  });

  it.each([
    ["unknown path", ["new-surface/thing.ts"], "unknown-path:new-surface/thing.ts"],
    ["empty change set", [], "empty-change-set"],
    ["lockfile", ["package-lock.json"], "global-input:package-lock.json"],
    ["workflow", [".github/workflows/ci.yml"], "global-input:.github/workflows/ci.yml"],
    ["lane config", ["vitest.config.ts"], "global-input:vitest.config.ts"],
    ["schema", ["schemas/report.schema.json"], "global-input:schemas/report.schema.json"],
    [
      "fixture",
      ["tests/fixtures/ecc-profile/install.json"],
      "global-input:tests/fixtures/ecc-profile/install.json",
    ],
    ["selector", ["src/internals/ci-impact.ts"], "selector-self-change"],
    ["selected-test launcher", [".github/scripts/run-selected-tests.mjs"], "selector-self-change"],
    ["lane gate", [".github/scripts/require-ci-lane.mjs"], "selector-self-change"],
  ])("falls back to the complete matrix for %s", (_name, changedPaths, reason) => {
    const receipt = classifyCiImpact({ baseSha, headSha, changedPaths, testFiles });

    expect(receipt.riskClass).toBe("full");
    expect(receipt).toMatchObject({ testLane: "full" });
    expect(receipt.fullSuite).toBe(true);
    expect(receipt.operatingSystems).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(receipt.fallbackReasons).toContain(reason);
    expect(receipt.selectedTests).toEqual(testFiles);
  });

  it("falls back when a source domain has no selected test", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/new-domain/implementation.ts"],
      testFiles,
    });

    expect(receipt.fullSuite).toBe(true);
    expect(receipt.fallbackReasons).toContain("unexpected-empty-test-selection");
  });

  it.each([
    ["backend policy source", ["src/org-policy/workbench/prepared-catalog.ts"], "both"],
    ["future backend policy source", ["src/org-policy/workbench/future.ts"], "both"],
    ["policy data command", ["src/org-policy/workbench/data-command.ts"], "both"],
    ["backend policy test", ["tests/org-policy/workbench/prepared-catalog.test.ts"], "workbench"],
    ["Core source", ["src/workspace/manifest.ts"], "core"],
    ["Core test", ["tests/workspace/manifest.test.ts"], "core"],
    ["shared policy source", ["src/org-policy/schema.ts"], "both"],
    [
      "mixed Core and backend policy change",
      ["src/workspace/manifest.ts", "src/org-policy/workbench/prepared-catalog.ts"],
      "both",
    ],
  ])("assigns the %s change to the %s test lane", (_name, changedPaths, testLane) => {
    const receipt = classifyCiImpact({ baseSha, headSha, changedPaths, testFiles });

    expect(receipt).toMatchObject({ testLane, fullSuite: false });
  });

  it("rejects receipts whose claimed selection is internally inconsistent", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/catalog.ts"],
      testFiles,
    });

    expect(() =>
      validateCiImpactReceipt({ ...receipt, providerTests: ["tests/fake.test.ts"] }),
    ).toThrow(/provider tests/u);
    expect(() => validateCiImpactReceipt({ ...receipt, headSha: "main" })).toThrow(/SHA/u);
    expect(() => validateCiImpactReceipt({ ...receipt, releasePreparation: true })).toThrow(
      /release preparation/u,
    );
    expect(() =>
      validateCiImpactReceipt({ ...receipt, operatingSystems: ["ubuntu-latest"] }),
    ).toThrow(/operating systems/u);
    expect(() => validateCiImpactReceipt({ ...receipt, testLane: "workbench" } as never)).toThrow(
      /test lane/u,
    );
    expect(() =>
      validateCiImpactReceipt({
        ...receipt,
        fallbackReasons: ["z-reason", "a-reason"],
      }),
    ).toThrow(/fallback reasons/u);
    expect(() => validateCiImpactReceipt({ ...receipt, unexpected: true } as never)).toThrow(
      /fields/u,
    );
  });
});
