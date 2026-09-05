import { describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import { runStagedChecks } from "../../src/internals/staged-check.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const toolchain = {
  nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
  npmCli: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
};

const npmRun = (...args: string[]): string[] => [
  toolchain.nodeExecutable,
  toolchain.npmCli,
  "run",
  ...args,
];

const npmExec = (...args: string[]): string[] => [
  toolchain.nodeExecutable,
  toolchain.npmCli,
  "exec",
  "--no",
  "--",
  ...args,
];

describe("staged repository checks", () => {
  it("runs formatting and focused tests without invoking the complete suite", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return {};
    });

    const result = await runStagedChecks(
      {
        baseSha,
        headSha,
        stagedPaths: ["src/org-policy/catalog.ts", "tests/org-policy/catalog.test.ts"],
        testFiles: ["tests/org-policy/catalog.test.ts", "tests/workspace/manifest.test.ts"],
      },
      run,
      toolchain,
    );

    expect(result.code).toBe(0);
    expect(calls).toContainEqual(
      npmExec("biome", "check", "src/org-policy/catalog.ts", "tests/org-policy/catalog.test.ts"),
    );
    expect(calls).toContainEqual(npmExec("vitest", "run", "tests/org-policy/catalog.test.ts"));
    expect(calls).not.toContainEqual(npmRun("test", "--silent"));
    expect(calls.flat().join(" ")).not.toMatch(/--coverage/u);
  });

  it("reserves the extended process budget for exact staged Vitest commands", async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    const run = fakeRunner((argv, options) => {
      calls.push({ argv, timeoutMs: options?.timeoutMs });
      return {};
    });

    await runStagedChecks(
      {
        baseSha,
        headSha,
        stagedPaths: ["README.md", "src/org-policy/catalog.ts"],
        testFiles: ["tests/org-policy/catalog.test.ts"],
      },
      run,
      toolchain,
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        { argv: npmRun("--silent", "check:artifacts"), timeoutMs: 120_000 },
        { argv: npmExec("biome", "check", "src/org-policy/catalog.ts"), timeoutMs: 120_000 },
        { argv: npmRun("--silent", "docs:lint"), timeoutMs: 120_000 },
        { argv: npmExec("vitest", "run", "tests/org-policy/catalog.test.ts"), timeoutMs: 300_000 },
      ]),
    );
  });

  it("uses absolute Node and npm CLI argv without Windows command shims", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return {};
    });

    await runStagedChecks(
      {
        baseSha,
        headSha,
        stagedPaths: ["src/org-policy/catalog.ts"],
        testFiles: ["tests/org-policy/catalog.test.ts"],
      },
      run,
      toolchain,
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((argv) => argv[0] === toolchain.nodeExecutable)).toBe(true);
    expect(calls.every((argv) => argv[1] === toolchain.npmCli)).toBe(true);
    expect(calls.flat()).not.toContain("npm");
    expect(calls.flat()).not.toContain("npm.cmd");
    expect(calls.flat()).not.toContain("npx");
    expect(calls.flat()).not.toContain("npx.cmd");
  });

  it("runs documentation policy and documentation contract tests for docs", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return {};
    });

    const result = await runStagedChecks(
      {
        baseSha,
        headSha,
        stagedPaths: ["README.md"],
        testFiles: ["tests/docs/readme-assets.test.ts"],
      },
      run,
      toolchain,
    );

    expect(result.code).toBe(0);
    expect(calls).toContainEqual(npmRun("--silent", "docs:lint"));
    expect(calls).toContainEqual(npmExec("vitest", "run", "tests/docs/readme-assets.test.ts"));
  });

  it("uses bounded repository-contract tests for a full-suite fallback", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return {};
    });

    const result = await runStagedChecks(
      {
        baseSha,
        headSha,
        stagedPaths: ["package-lock.json"],
        testFiles: [
          "tests/package-identity.test.ts",
          "tests/release-readiness.test.ts",
          "tests/release/preflight.test.ts",
          "tests/workspace/manifest.test.ts",
        ],
      },
      run,
      toolchain,
    );

    expect(result.receipt.fullSuite).toBe(true);
    expect(calls).toContainEqual(
      npmExec(
        "vitest",
        "run",
        "tests/package-identity.test.ts",
        "tests/release-readiness.test.ts",
        "tests/release/preflight.test.ts",
      ),
    );
    expect(calls).not.toContainEqual(npmExec("vitest", "run", ...result.receipt.selectedTests));
  });

  it("stops at the first failed command", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (argv.includes("biome")) return { code: 1, stderr: "format error" };
      return {};
    });

    const result = await runStagedChecks(
      {
        baseSha,
        headSha,
        stagedPaths: ["src/org-policy/catalog.ts"],
        testFiles: ["tests/org-policy/catalog.test.ts"],
      },
      run,
      toolchain,
    );

    expect(result.code).toBe(1);
    expect(result.failure).toContain("format error");
    expect(calls.flat()).not.toContain("vitest");
  });
});
