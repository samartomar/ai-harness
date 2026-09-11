import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { classifyCiImpact, validateCiImpactReceipt } from "../../src/internals/ci-impact.js";
import {
  CI_STATIC_SCRIPTS,
  localVerificationGaps,
  localVerificationSteps,
} from "../../src/internals/ci-local-verification.js";
import { runLocalVerification } from "../../src/internals/ci-local-verification-command.js";
import { fakeRunner, type RunOptions, type RunResult } from "../../src/internals/proc.js";
import { providerTestsFor } from "../../src/internals/workbench-provider-ownership.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const coreTest = "tests/workspace/manifest.test.ts";
const providerTest = "tests/org-policy/workbench/providers/ecc.test.ts";
const providerTests = providerTestsFor(["ecc"]);
const testFiles = ["tests/docs/readme-assets.test.ts", coreTest, ...providerTests];
const args = ["--base", "main", "--head", "HEAD"];

function impact(changedPaths: string[]) {
  return classifyCiImpact({ baseSha, headSha, changedPaths, testFiles });
}

function harness(
  overrides: {
    changed?: string[];
    unstaged?: string[];
    staged?: string[];
    untracked?: string[];
    deleted?: string[];
    sameRevision?: boolean;
    headMismatch?: boolean;
    fail?: (argv: string[]) => Partial<RunResult> | undefined;
  } = {},
) {
  const calls: Array<{ argv: string[]; options: RunOptions | undefined }> = [];
  const output: string[] = [];
  const run = fakeRunner((argv, options) => {
    calls.push({ argv, options });
    const failure = overrides.fail?.(argv);
    if (failure) return failure;
    if (argv[0] !== "git") return { stdout: "gate passed\n" };
    if (argv[1] === "rev-parse") {
      const ref = argv.at(-1);
      if (ref === "main^{commit}") return { stdout: overrides.sameRevision ? headSha : baseSha };
      if (ref === "other^{commit}" && overrides.headMismatch) return { stdout: "c".repeat(40) };
      return { stdout: headSha };
    }
    if (argv[1] === "diff") {
      const changed = argv.some((arg) => arg.includes("..."))
        ? (overrides.changed ?? ["src/workspace/manifest.ts"])
        : argv.includes("--cached")
          ? (overrides.staged ?? [])
          : (overrides.unstaged ?? []);
      return { stdout: changed.join("\0") };
    }
    if (argv[1] === "ls-files") {
      if (argv.includes("--deleted")) return { stdout: (overrides.deleted ?? []).join("\0") };
      if (argv.includes("tests"))
        return { stdout: [...testFiles, ...(overrides.untracked ?? [])].join("\0") };
      return { stdout: (overrides.untracked ?? []).join("\0") };
    }
    throw new Error(`Unexpected command: ${argv.join(" ")}`);
  });
  return {
    calls,
    output,
    options: {
      run,
      env: { npm_execpath: "/fixture/npm-cli.js" },
      platform: "win32" as const,
      write: (text: string) => output.push(text),
    },
  };
}

describe("local CI verification", () => {
  it("retains every unconditional CI quality check without adding a parallel classifier", () => {
    const workflow = parseYaml(readFileSync(".github/workflows/ci.yml", "utf8")) as {
      jobs: { quality: { steps: Array<{ run?: string; if?: string }> } };
    };
    const checks = workflow.jobs.quality.steps
      .filter((step) => step.run && step.run !== "npm ci --ignore-scripts")
      .map((step) => {
        expect(step.if).toBeUndefined();
        return step.run === "npx biome ci src tests" ? "npm run lint:ci" : step.run;
      });
    expect(CI_STATIC_SCRIPTS.map((script) => `npm run ${script}`)).toEqual(checks);
  });

  it.each([
    ["docs", ["README.md"], ["ci:run-selected"]],
    ["Core", ["src/workspace/manifest.ts"], ["ci:run-selected"]],
    ["provider", [providerTest], ["ci:run-selected", "test:workbench:providers"]],
    [
      "browser",
      ["tests/org-policy/workbench/browser/artifact.spec.ts"],
      ["ci:run-selected", "test:workbench:pr"],
    ],
    [
      "shared",
      [providerTest, "src/org-policy/schema.ts"],
      ["ci:run-selected", "test:workbench:pr"],
    ],
    ["unknown", ["unknown/input.json"], ["test:cov", "test:workbench:pr"]],
    ["selector", ["src/internals/ci-local-verification.ts"], ["test:cov", "test:workbench:pr"]],
  ])("dispatches the %s selection to its existing lanes", (_name, paths, expected) => {
    const steps = localVerificationSteps(impact(paths));
    expect(steps.slice(CI_STATIC_SCRIPTS.length).map((step) => step.script)).toEqual(expected);
    if (expected.includes("test:cov")) {
      expect(steps.find((step) => step.script === "test:cov")?.args).toContain("--maxWorkers=2");
    }
  });

  it("executes static and provider lanes sequentially with the complete ownership receipt", async () => {
    const h = harness({ changed: [providerTest] });
    const receipt = await runLocalVerification(args, h.options);
    const commands = h.calls.filter(({ argv }) => argv[0] !== "git");
    expect(commands.map(({ argv }) => argv[3])).toEqual([
      ...CI_STATIC_SCRIPTS,
      "ci:run-selected",
      "test:workbench:providers",
    ]);
    expect(commands.every(({ argv }) => argv[0] === process.execPath)).toBe(true);
    expect(commands.at(-1)?.options?.env).toMatchObject({
      AFFECTED_PROVIDERS_JSON: '["ecc"]',
      PROVIDER_TESTS_JSON: JSON.stringify(providerTests),
    });
    expect(commands.at(-2)?.options?.env).toMatchObject({
      SELECTED_TESTS_JSON: JSON.stringify(receipt.selectedTests),
      TEST_LANE: "workbench",
      FULL_SUITE: "false",
      REQUIRES_GENERIC_BROWSER_JOURNEYS: "false",
    });
    expect(h.output.join("")).toContain("provider:ecc");
    expect(h.output.join("")).toContain("Hosted gap:");
  });

  it("plans committed, staged, unstaged and untracked edits without executing a gate", async () => {
    const newTest = "tests/workspace/new.test.ts";
    const h = harness({
      changed: ["README.md"],
      unstaged: ["src/workspace/manifest.ts"],
      staged: [providerTest],
      untracked: [newTest],
    });
    const receipt = await runLocalVerification([...args, "--include-working", "--plan"], h.options);
    expect(receipt.changedPaths).toEqual(
      ["README.md", "src/workspace/manifest.ts", providerTest, newTest].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect(receipt.selectedTests).toContain(newTest);
    expect(receipt.affectedProviders).toEqual(["ecc"]);
    expect(h.calls.every(({ argv }) => argv[0] === "git")).toBe(true);
    expect(
      h.calls
        .filter(({ argv }) => argv[1] === "diff")
        .every(({ argv }) => argv.includes("--no-renames")),
    ).toBe(true);
    expect(h.output.join("")).toContain("Plan only; no verification commands ran.");
  });

  it("permits identical revisions only for an explicit nonempty local working observation", async () => {
    const h = harness({ sameRevision: true, changed: [], unstaged: [coreTest] });
    const receipt = await runLocalVerification([...args, "--include-working", "--plan"], h.options);
    expect(receipt.baseSha).toBe(receipt.headSha);
    expect(receipt.changedPaths).toEqual([coreTest]);
    expect(() => validateCiImpactReceipt(receipt)).toThrow("base and head SHA must differ");
    const clean = harness({ sameRevision: true, changed: [] });
    await expect(
      runLocalVerification([...args, "--include-working", "--plan"], clean.options),
    ).rejects.toThrow("base and head SHA must differ");
  });

  it("falls back when a provider test is deleted from the working tree", async () => {
    const h = harness({ changed: [], unstaged: [providerTest], deleted: [providerTest] });
    const receipt = await runLocalVerification([...args, "--include-working", "--plan"], h.options);
    expect(receipt.fullSuite).toBe(true);
    expect(receipt.fallbackReasons).toContain(`missing-provider-test:${providerTest}`);
    expect(receipt.selectedTests).not.toContain(providerTest);
  });

  it("refuses to verify a different checkout or silently omit working changes", async () => {
    const mismatch = harness({ headMismatch: true });
    await expect(
      runLocalVerification(["--base", "main", "--head", "other"], mismatch.options),
    ).rejects.toThrow("checkout HEAD must match");
    const dirty = harness({ untracked: ["src/workspace/new.ts"] });
    await expect(runLocalVerification(args, dirty.options)).rejects.toThrow("--include-working");
    for (const h of [mismatch, dirty])
      expect(h.calls.every(({ argv }) => argv[0] === "git")).toBe(true);
  });

  it.each([
    ["--base", "main"],
    ["--base", "--bad", "--head", "HEAD"],
    [...args, "--skip-security"],
    [...args, "--plan", "--plan"],
  ])("rejects invalid options before observing Git: %j", async (...invalid) => {
    const h = harness();
    await expect(runLocalVerification(invalid, h.options)).rejects.toThrow(/Usage:/u);
    expect(h.calls).toHaveLength(0);
  });

  it.each([{ code: 1 }, { spawnError: true }, { truncated: true }, { code: null }])(
    "fails closed on incomplete Git or gate output: %j",
    async (failure) => {
      const observation = harness({ fail: () => failure });
      await expect(runLocalVerification(args, observation.options)).rejects.toThrow(
        "git rev-parse failed",
      );
      const gate = harness({ fail: (argv) => (argv[3] === "typecheck" ? failure : undefined) });
      await expect(runLocalVerification(args, gate.options)).rejects.toThrow(
        "Local verification failed: typecheck",
      );
      expect(gate.calls.at(-1)?.argv[3]).toBe("typecheck");
      expect(gate.output.join("")).not.toContain("Local selected verification passed");
    },
  );

  it("reports untested operating systems and security checks even when local execution succeeds", () => {
    const gaps = localVerificationGaps(impact(["src/workspace/manifest.ts"]), "win32").join("\n");
    expect(gaps).toContain("ubuntu-latest, macos-latest");
    expect(gaps).toContain("CodeQL");
    expect(gaps).toContain("protected checks");
    expect(localVerificationGaps(impact(["src/version.ts"]), "linux").join("\n")).toContain(
      "Release-preparation authorization",
    );
  });
});
