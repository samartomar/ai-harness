import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import { verifiedEccInstallPlan } from "../../src/ecc/verified.js";
import type { Action, DigestAction, ExecAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-verified-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: root } }),
    env: { HOME: root },
    options: {},
  };
}

function authorization(componentId = "runtime:ecc-installer"): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

const execs = (actions: Action[]): ExecAction[] =>
  actions.filter((action): action is ExecAction => action.kind === "exec");

function driverSteps(actions: Action[]): Array<{ argv: string[]; cwd: string }> {
  const driver = execs(actions).find((action) => action.describe.includes("verified ECC checkout"));
  expect(driver).toBeDefined();
  const encoded = driver?.argv.at(-1);
  if (!encoded) throw new Error("missing verified ECC step payload");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Array<{
    argv: string[];
    cwd: string;
  }>;
}

describe("verifiedEccInstallPlan", () => {
  it("uses one sequential driver over the verified checkout and never npx", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["claude"], profile: "core", packs: ["typescript"] },
      [authorization()],
    );
    expect(execs(plan.actions)).toHaveLength(1);
    const steps = driverSteps(plan.actions);
    expect(steps[0]?.argv).toEqual([
      "npm",
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(steps[0]?.cwd).toBe(sourceRoot);
    expect(steps[1]?.argv).toEqual([
      process.execPath,
      join(sourceRoot, "scripts", "install-apply.js"),
      "--target",
      "claude",
      "--profile",
      "core",
      "typescript",
    ]);
    expect(steps[1]?.cwd).toBe(root);
    expect(JSON.stringify(steps)).not.toContain("npx");
    expect(JSON.stringify(steps)).not.toContain("https://");
  });

  it("keeps Codex on the add-only merge path inside the same sequential driver", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["codex"], profile: "core", packs: [] },
      [authorization()],
    );
    expect(execs(plan.actions)).toHaveLength(1);
    const steps = driverSteps(plan.actions);
    expect(steps[0]?.argv[0]).toBe("npm");
    expect(steps[1]?.argv.slice(0, 2)).toEqual(["node", "-e"]);
    expect(steps[1]?.argv).toContain(join(sourceRoot, "scripts", "codex", "merge-codex-config.js"));
    expect(
      plan.actions.some(
        (action) => action.kind === "write" && action.describe.includes("Codex config.toml"),
      ),
    ).toBe(true);
  });

  it("runs Kiro's script only from the verified checkout", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["kiro"], profile: "core", packs: [] },
      [authorization("runtime:ecc-kiro")],
    );
    const steps = driverSteps(plan.actions);
    expect(steps).toEqual([
      {
        argv: ["bash", join(sourceRoot, ".kiro", "install.sh"), root],
        cwd: sourceRoot,
      },
    ]);
  });

  it("emits machine-readable evidence authorization receipts", () => {
    const receipt = authorization();
    const plan = verifiedEccInstallPlan(
      ctx(),
      join(root, "tree"),
      { clis: ["claude"], profile: "core", packs: [] },
      [receipt],
    );
    const digest = plan.actions.find(
      (action): action is DigestAction =>
        action.kind === "digest" && action.describe.includes("evidence"),
    );
    expect(digest?.data).toEqual({ authorizations: [receipt] });
    expect(digest?.text).toContain("vendor");
    expect(digest?.text).toContain("runtime:ecc-installer");
  });
});
