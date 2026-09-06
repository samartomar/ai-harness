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
  TEST_LANE: "core",
  WORKBENCH_RESULT: "skipped",
  PROVIDER_RESULT: "skipped",
  AFFECTED_PROVIDERS_JSON: "[]",
  REQUIRES_PACKED_ARTIFACT: "false",
  REQUIRES_GENERIC_BROWSER_JOURNEYS: "false",
} as const;

function runGate(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [gate], {
    encoding: "utf8",
    env: { ...process.env, ...selectedPullRequest, ...overrides },
  });
}

const fullLane = {
  EVENT_NAME: "push",
  FULL_SUITE: "true",
  TEST_LANE: "full",
  WORKBENCH_RESULT: "success",
  PROVIDER_RESULT: "skipped",
  AFFECTED_PROVIDERS_JSON: "[]",
  REQUIRES_PACKED_ARTIFACT: "true",
  REQUIRES_GENERIC_BROWSER_JOURNEYS: "true",
  RELEASE_PREP_RESULT: "skipped",
  SELECTED_RESULT: "skipped",
  FULL_RESULT: "success",
  WINDOWS_RESULT: "success",
} as const;

describe("required CI lane gate", () => {
  it("accepts an authoritative selected pull-request lane", () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Accepted selected CI lane.");
  });

  it("accepts a complete protected-main fallback lane", () => {
    const result = runGate(fullLane);
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
    const result = runGate({ ...fullLane, ...overrides });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe("");
  });

  it("fails closed when the complete Windows lane is cancelled", () => {
    const result = runGate({ ...fullLane, WINDOWS_RESULT: "cancelled" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe("");
  });

  it("requires the provider receipt to execute its exact lane", () => {
    const provider = {
      TEST_LANE: "workbench",
      WORKBENCH_RESULT: "skipped",
      AFFECTED_PROVIDERS_JSON: '["ecc"]',
      REQUIRES_PACKED_ARTIFACT: "true",
      REQUIRES_GENERIC_BROWSER_JOURNEYS: "false",
    };
    expect(runGate({ ...provider, PROVIDER_RESULT: "success" }).status).toBe(0);
    expect(runGate({ ...provider, PROVIDER_RESULT: "skipped" }).status).not.toBe(0);
  });

  it("accepts Matt's registered provider receipt only when its required lane succeeds", () => {
    const matt = {
      TEST_LANE: "workbench",
      WORKBENCH_RESULT: "skipped",
      AFFECTED_PROVIDERS_JSON: '["mattpocock"]',
      REQUIRES_PACKED_ARTIFACT: "true",
      REQUIRES_GENERIC_BROWSER_JOURNEYS: "false",
    };
    expect(runGate({ ...matt, PROVIDER_RESULT: "success" }).status).toBe(0);
    expect(runGate({ ...matt, PROVIDER_RESULT: "skipped" }).status).not.toBe(0);
  });

  it("accepts the exact Ponytail provider receipt only when its required lane succeeds", () => {
    const ponytail = {
      TEST_LANE: "workbench",
      WORKBENCH_RESULT: "skipped",
      AFFECTED_PROVIDERS_JSON: '["ponytail"]',
      REQUIRES_PACKED_ARTIFACT: "true",
      REQUIRES_GENERIC_BROWSER_JOURNEYS: "false",
    };
    expect(runGate({ ...ponytail, PROVIDER_RESULT: "success" }).status).toBe(0);
    expect(runGate({ ...ponytail, PROVIDER_RESULT: "skipped" }).status).not.toBe(0);
  });
  it("uses the generic browser lane once when a mixed change already owns provider contracts", () => {
    const mixed = {
      TEST_LANE: "both",
      WORKBENCH_RESULT: "success",
      PROVIDER_RESULT: "skipped",
      AFFECTED_PROVIDERS_JSON: '["ecc"]',
      REQUIRES_PACKED_ARTIFACT: "true",
      REQUIRES_GENERIC_BROWSER_JOURNEYS: "true",
    };
    expect(runGate(mixed).status).toBe(0);
    expect(runGate({ ...mixed, PROVIDER_RESULT: "success" }).status).not.toBe(0);
  });
});
