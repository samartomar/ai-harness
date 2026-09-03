import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const gate = join(process.cwd(), ".github", "scripts", "require-ci-lane.mjs");
const selectedPullRequest = {
  EVENT_NAME: "pull_request",
  FULL_SUITE: "false",
  CLASSIFY_RESULT: "success",
  RELEASE_PREP_RESULT: "success",
  QUALITY_RESULT: "success",
  SELECTED_RESULT: "success",
  FULL_RESULT: "skipped",
  WINDOWS_RESULT: "skipped",
} as const;

function runGate(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [gate], {
    encoding: "utf8",
    env: { ...process.env, ...selectedPullRequest, ...overrides },
  });
}

describe("required CI lane gate", () => {
  it("accepts an authoritative selected pull-request lane", () => {
    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Accepted selected CI lane.");
  });

  it("accepts a complete protected-main fallback lane", () => {
    const result = runGate({
      EVENT_NAME: "push",
      FULL_SUITE: "true",
      RELEASE_PREP_RESULT: "skipped",
      SELECTED_RESULT: "skipped",
      FULL_RESULT: "success",
      WINDOWS_RESULT: "success",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Accepted complete CI lane.");
  });

  it.each([
    ["classifier", { CLASSIFY_RESULT: "failure" }],
    ["quality", { QUALITY_RESULT: "cancelled" }],
    ["release guard", { RELEASE_PREP_RESULT: "skipped" }],
    ["selected tests", { SELECTED_RESULT: "failure" }],
    ["unexpected full lane", { FULL_RESULT: "success" }],
    ["invalid decision", { FULL_SUITE: "maybe" }],
    ["unsupported event", { EVENT_NAME: "workflow_dispatch" }],
  ])("fails closed for %s", (_name, overrides) => {
    const result = runGate(overrides);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe("");
  });

  it.each([
    ["selected lane ran", { SELECTED_RESULT: "success" }],
    ["Ubuntu/macOS failure", { FULL_RESULT: "failure" }],
  ])("fails closed when the complete lane has %s", (_name, overrides) => {
    const result = runGate({
      EVENT_NAME: "push",
      FULL_SUITE: "true",
      RELEASE_PREP_RESULT: "skipped",
      SELECTED_RESULT: "skipped",
      FULL_RESULT: "success",
      WINDOWS_RESULT: "success",
      ...overrides,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe("");
  });

  it("fails closed when the complete Windows lane is cancelled", () => {
    const result = runGate({
      EVENT_NAME: "push",
      FULL_SUITE: "true",
      RELEASE_PREP_RESULT: "skipped",
      SELECTED_RESULT: "skipped",
      FULL_RESULT: "success",
      WINDOWS_RESULT: "cancelled",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe("");
  });
});
