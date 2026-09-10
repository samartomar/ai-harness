import { execFileSync } from "node:child_process";
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
import { providerTestsFor } from "../../src/internals/workbench-provider-ownership.js";
import { isWorkbenchTestPath } from "../../src/internals/workbench-test-ownership.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const testFiles = [
  "tests/docs/readme-assets.test.ts",
  "tests/org-policy/catalog.test.ts",
  "tests/org-policy/generate.test.ts",
  "tests/org-policy/studio-model.test.ts",
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
      expect(readFileSync(githubOutput, "utf8")).toContain("test_lane=both\n");
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
        "tests/org-policy/generate.test.ts",
        "tests/org-policy/studio-model.test.ts",
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
        testLane: "both",
        requiresGenericBrowserJourneys: true,
        requiresPackedArtifact: true,
      });
      expect(validateCiImpactReceipt(receipt)).toEqual(receipt);
      expect(() =>
        validateCiImpactReceipt({ ...receipt, requiresGenericBrowserJourneys: false }),
      ).toThrow("generic browser requirement");
      expect(() => validateCiImpactReceipt({ ...receipt, testLane: "core" })).toThrow(
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

  it("selects only the complete owned Workbench test lane for Workbench source", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/studio-template.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({
      riskClass: "cross-platform",
      testLane: "workbench",
      fullSuite: false,
      selectedTests: [
        "tests/org-policy/generate.test.ts",
        "tests/org-policy/studio-model.test.ts",
        "tests/org-policy/studio-surface-invariants.test.ts",
      ],
    });
    expect(receipt.selectedTests).not.toContain("tests/org-policy/catalog.test.ts");
  });

  it("keeps a provider-local change out of generic browser journeys while requiring its exact tests and packed artifact", () => {
    const providerTests = providerTestsFor(["ecc"]);
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/catalog-providers/ecc.ts"],
      testFiles: [...testFiles, ...providerTests],
    });

    expect(receipt).toMatchObject({
      testLane: "workbench",
      affectedProviders: ["ecc"],
      providerTests,
      requiresPackedArtifact: true,
      requiresGenericBrowserJourneys: false,
    });
  });

  it("routes Matt source and snapshot changes to its exact provider lane without generic browser journeys", () => {
    const providerTests = providerTestsFor(["mattpocock"] as never);
    for (const changedPath of [
      "src/org-policy/workbench/providers/mattpocock.ts",
      "src/org-policy/workbench/providers/mattpocock.snapshot.json",
    ]) {
      const receipt = classifyCiImpact({
        baseSha,
        headSha,
        changedPaths: [changedPath],
        testFiles: [...testFiles, ...providerTests],
      });
      expect(receipt).toMatchObject({
        affectedProviders: ["mattpocock"],
        providerTests,
        testLane: "workbench",
        requiresPackedArtifact: true,
        requiresGenericBrowserJourneys: false,
      });
    }
  });

  it("broadens generic pinned-skill compiler changes to the shared Workbench lane", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/workbench/compilers/pinned-skill-collection.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({
      affectedProviders: [],
      riskClass: "cross-platform",
      testLane: "both",
      requiresPackedArtifact: true,
      requiresGenericBrowserJourneys: true,
    });
  });

  it("routes Ponytail source and snapshot changes to its exact provider lane without generic browser journeys", () => {
    const providerTests = providerTestsFor(["ponytail"] as never);
    for (const changedPath of [
      "src/org-policy/workbench/providers/ponytail.ts",
      "src/org-policy/workbench/providers/ponytail.snapshot.json",
    ]) {
      const receipt = classifyCiImpact({
        baseSha,
        headSha,
        changedPaths: [changedPath],
        testFiles: [...testFiles, ...providerTests],
      });

      expect(receipt).toMatchObject({
        affectedProviders: ["ponytail"],
        providerTests,
        testLane: "workbench",
        requiresPackedArtifact: true,
        requiresGenericBrowserJourneys: false,
      });
    }
  });

  it("broadens generic pinned-component compiler changes to the shared Workbench lane", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/workbench/compilers/pinned-component-collection.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({
      affectedProviders: [],
      riskClass: "cross-platform",
      testLane: "both",
      requiresPackedArtifact: true,
      requiresGenericBrowserJourneys: true,
    });
  });
  it("falls back for baseline extractors until their cross-domain consumer union is explicit", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/baseline-evidence/catalog-providers/ecc.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({ fullSuite: true, testLane: "full" });
    expect(receipt.fallbackReasons).toContain(
      "baseline-provider-consumers:src/baseline-evidence/catalog-providers/ecc.ts",
    );
  });

  it("keeps direct shared catalog inputs in the conservative Workbench scope", () => {
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/ecc/materialize.ts", "src/usage/capture.ts"],
      testFiles,
    });

    expect(receipt).toMatchObject({
      testLane: "both",
      affectedProviders: [],
      requiresPackedArtifact: true,
      requiresGenericBrowserJourneys: true,
    });
  });

  it("keeps selector ownership identical to the discovered Workbench project", () => {
    const repositoryTests = execFileSync("git", ["ls-files", "--", "tests"], {
      encoding: "utf8",
    })
      .split(/\r?\n/u)
      .filter((path) => path.endsWith(".test.ts"));
    const expectedWorkbenchTests = repositoryTests
      .filter(isWorkbenchTestPath)
      .sort((left, right) => left.localeCompare(right));
    const receipt = classifyCiImpact({
      baseSha,
      headSha,
      changedPaths: ["src/org-policy/studio-template.ts"],
      testFiles: repositoryTests,
    });

    expect(expectedWorkbenchTests.length).toBeGreaterThan(0);
    expect(receipt.selectedTests).toEqual(expectedWorkbenchTests);
  });

  it.each([
    ["unknown path", ["new-surface/thing.ts"], "unknown-path:new-surface/thing.ts"],
    [
      "unknown compiled provider",
      ["src/org-policy/workbench/providers/future.ts"],
      "unknown-provider-path:src/org-policy/workbench/providers/future.ts",
    ],
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
    ["Workbench source", ["src/org-policy/studio-template.ts"], "workbench"],
    ["future Workbench source", ["src/org-policy/studio-new-surface.ts"], "workbench"],
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
