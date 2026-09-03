import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const testFiles = [
  "tests/docs/readme-assets.test.ts",
  "tests/org-policy/catalog.test.ts",
  "tests/org-policy/studio-surface-invariants.test.ts",
  "tests/release-readiness.test.ts",
  "tests/workspace/manifest.test.ts",
];

describe("CI impact classifier", () => {
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
      schemaVersion: "aih-ci-impact-v1",
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
        "tests/org-policy/studio-surface-invariants.test.ts",
      ],
    });
    expect(receipt.matchedRules).toContain("source-domain:org-policy");
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

  it.each([
    ["unknown path", ["new-surface/thing.ts"], "unknown-path:new-surface/thing.ts"],
    ["empty change set", [], "empty-change-set"],
    ["lockfile", ["package-lock.json"], "global-input:package-lock.json"],
    ["workflow", [".github/workflows/ci.yml"], "global-input:.github/workflows/ci.yml"],
    ["lane config", ["vitest.workbench.config.ts"], "global-input:vitest.workbench.config.ts"],
    ["schema", ["schemas/report.schema.json"], "global-input:schemas/report.schema.json"],
    [
      "fixture",
      ["tests/fixtures/ecc-profile/install.json"],
      "global-input:tests/fixtures/ecc-profile/install.json",
    ],
    ["selector", ["src/internals/ci-impact.ts"], "selector-self-change"],
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
    ["Workbench source", ["src/org-policy/studio-template.ts"], "workbench"],
    ["Workbench entry point", ["src/org-policy/generate.ts"], "workbench"],
    ["Workbench test", ["tests/org-policy/studio-surface-invariants.test.ts"], "workbench"],
    ["Core source", ["src/workspace/manifest.ts"], "core"],
    ["Core test", ["tests/workspace/manifest.test.ts"], "core"],
    ["shared policy source", ["src/org-policy/schema.ts"], "both"],
    [
      "mixed Core and Workbench change",
      ["src/workspace/manifest.ts", "src/org-policy/studio-template.ts"],
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
      validateCiImpactReceipt({ ...receipt, selectedTests: ["tests/workspace/manifest.test.ts"] }),
    ).toThrow(/selected tests/u);
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
