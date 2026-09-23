import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();
const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
const selectedRunner = resolve(root, ".github/scripts/run-selected-tests.mjs");

describe("headless installed Core CI ownership", () => {
  it("generates backend policy data in the isolated selected-test checkout", () => {
    const steps = workflow.jobs.selected_tests.steps as { run?: string }[];
    const install = steps.findIndex((step) => step.run === "npm ci --ignore-scripts");
    const generate = steps.findIndex((step) => step.run === "npm run build:policy-data");
    const selected = steps.findIndex((step) => step.run === "npm run --silent ci:run-selected");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(generate).toBeGreaterThan(install);
    expect(selected).toBeGreaterThan(generate);
  });

  it("requires an installed-package policy probe from the fail-closed quality job", () => {
    const quality = workflow.jobs.quality;
    const required = workflow.jobs.required_verify;
    expect(quality.steps.some((step: { run?: string }) => step.run === "npm run build")).toBe(true);
    expect(
      quality.steps.some(
        (step: { run?: string }) => step.run === "npm run verify:packed-core-policy",
      ),
    ).toBe(true);
    expect(required.needs).toContain("quality");
    expect(workflow.jobs.workbench_browser).toBeUndefined();
    expect(workflow.jobs.workbench_provider).toBeUndefined();
  });

  it("executes a selected backend policy test instead of filtering it into a removed browser lane", () => {
    const result = spawnSync(process.execPath, [selectedRunner], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        FULL_SUITE: "false",
        TEST_LANE: "workbench",
        SELECTED_TESTS_JSON: JSON.stringify(["tests/org-policy/workbench/data-command.test.ts"]),
        PROVIDER_TESTS_JSON: "[]",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Test Files\s+1 passed/);
    expect(result.stdout).toMatch(/Tests\s+1 passed/);
  }, 70_000);

  it("fails when a selected backend test is missing instead of silently skipping it", () => {
    const result = spawnSync(process.execPath, [selectedRunner], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        FULL_SUITE: "false",
        TEST_LANE: "workbench",
        SELECTED_TESTS_JSON: JSON.stringify(["tests/org-policy/workbench/missing.test.ts"]),
        PROVIDER_TESTS_JSON: "[]",
      },
    });
    expect(result.status).not.toBe(0);
  }, 70_000);
});
