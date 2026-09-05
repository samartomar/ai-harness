import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();
const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
const baseEnvironment = {
  EVENT_NAME: "pull_request",
  FULL_SUITE: "false",
  TEST_LANE: "workbench",
  CLASSIFY_RESULT: "success",
  RELEASE_PREP_RESULT: "success",
  QUALITY_RESULT: "success",
  SELECTED_RESULT: "success",
  FULL_RESULT: "skipped",
  WINDOWS_RESULT: "skipped",
  WORKBENCH_RESULT: "success",
};

function gate(environment: Record<string, string>) {
  return spawnSync(process.execPath, [resolve(root, ".github/scripts/require-ci-lane.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ...baseEnvironment, ...environment },
  });
}

describe("Workbench CI browser ownership", () => {
  it("owns Chromium once and makes its result a required dependency", () => {
    const job = workflow.jobs.workbench_browser;
    expect(job).toBeDefined();
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.if).toContain("needs.classify.outputs.test_lane");
    expect(
      job.steps.some((step: { run?: string }) => step.run?.includes("test:workbench:pr")),
    ).toBe(true);
    expect(workflow.jobs.required_verify.needs).toContain("workbench_browser");
    const gateStep = workflow.jobs.required_verify.steps.find((step: { run?: string }) =>
      step.run?.includes("require-ci-lane.mjs"),
    );
    expect(gateStep.env.WORKBENCH_RESULT).toContain("needs.workbench_browser.result");
  });

  it("keeps every CI job and nightly matrix free of heap enlargements", () => {
    const nightly = parse(
      readFileSync(resolve(root, ".github/workflows/nightly-safety.yml"), "utf8"),
    );
    for (const job of [...Object.values(workflow.jobs), ...Object.values(nightly.jobs)]) {
      expect(JSON.stringify(job)).not.toContain("max-old-space-size");
    }
  });

  it.each(["failure", "cancelled", "skipped", ""])(
    "cannot convert a %s Workbench browser job to green",
    (result) => {
      expect(gate({ WORKBENCH_RESULT: result }).status).not.toBe(0);
    },
  );

  it("accepts a skipped browser job only for a non-Workbench lane", () => {
    expect(gate({ TEST_LANE: "core", WORKBENCH_RESULT: "skipped" }).status).toBe(0);
    expect(gate({ TEST_LANE: "core", WORKBENCH_RESULT: "failure" }).status).not.toBe(0);
    expect(gate({ TEST_LANE: "invalid", WORKBENCH_RESULT: "skipped" }).status).not.toBe(0);
  });

  it("requires browser success for complete fallback matrices too", () => {
    const full = {
      FULL_SUITE: "true",
      TEST_LANE: "full",
      SELECTED_RESULT: "skipped",
      FULL_RESULT: "success",
      WINDOWS_RESULT: "success",
    };
    expect(gate({ ...full, WORKBENCH_RESULT: "success" }).status).toBe(0);
    expect(gate({ ...full, WORKBENCH_RESULT: "skipped" }).status).not.toBe(0);
  });
});

describe("selected Core and Workbench execution ownership", () => {
  it("runs affected Core tests once and delegates all Workbench tests to its required lane", () => {
    const directory = mkdtempSync(join(tmpdir(), "aih-workbench-ci-routing-"));
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error("unsafe test fixture cleanup");
    try {
      mkdirSync(join(directory, "node_modules/vitest"), { recursive: true });
      writeFileSync(
        join(directory, "node_modules/vitest/vitest.mjs"),
        "console.log(JSON.stringify(process.argv.slice(2)));",
      );
      const execute = (lane: string) =>
        spawnSync(
          process.execPath,
          [
            "--import",
            pathToFileURL(resolve(root, "node_modules/tsx/dist/loader.mjs")).href,
            resolve(root, ".github/scripts/run-selected-tests.mjs"),
          ],
          {
            cwd: directory,
            encoding: "utf8",
            env: {
              ...process.env,
              FULL_SUITE: "false",
              TEST_LANE: lane,
              SELECTED_TESTS_JSON: JSON.stringify([
                "tests/org-policy/studio-new.test.ts",
                "tests/org-policy/schema.test.ts",
              ]),
            },
          },
        );
      const both = execute("both");
      expect(both.status, both.stderr).toBe(0);
      expect(JSON.parse(both.stdout.trim())).toEqual([
        "run",
        "--maxWorkers=2",
        "--testTimeout=15000",
        "tests/org-policy/schema.test.ts",
      ]);
      const inconsistent = execute("core");
      expect(inconsistent.status).not.toBe(0);
      expect(inconsistent.stderr).toContain("Workbench tests require");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
