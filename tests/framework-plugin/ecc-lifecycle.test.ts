import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  eccPrunePlanV1,
  eccStatePathsV1,
  prepareEccMaterializationRemovalV1,
} from "../../src/framework-plugin/ecc-lifecycle.js";
import { eccDoctorChecksV1 } from "../../src/framework-plugin/ecc-read.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource } from "./plugin-source.js";
import { eccDescriptorLoad } from "./source-plugin-mocks.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-lifecycle-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  const env = { HOME: home, USERPROFILE: home };
  return {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
}

const withPlugin = {
  loadPlugin: () => loadEccFromSource(),
  loadDescriptor: async () => eccDescriptorLoad(),
};

describe("ECC uninstall and prune without the plugin", () => {
  it("sees only the ECC state aih wrote, under the homes the invocation names", () => {
    expect(eccStatePathsV1(ctx())).toEqual([]);
    mkdirSync(join(home, ".aih", "ecc"), { recursive: true });
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    expect(eccStatePathsV1(ctx())).toEqual([join(root, ".aih", "ecc"), join(home, ".aih", "ecc")]);
  });

  it("prune adds nothing for ECC when no aih ECC state exists", async () => {
    await expect(eccPrunePlanV1(ctx(), ["codex"])).resolves.toEqual({
      actions: [],
      subtracted: 0,
    });
  });

  it("prune refuses by name, naming the state and the install command, when aih ECC state exists", async () => {
    mkdirSync(join(home, ".aih", "ecc"), { recursive: true });
    await expect(eccPrunePlanV1(ctx(), [])).rejects.toThrow(
      "framework-plugin-unavailable: @aihq/framework-ecc is not installed next to @aihq/core. Install it with: npm install",
    );
    await expect(eccPrunePlanV1(ctx(), [])).rejects.toThrow(
      `aih ECC state to reconcile: ${join(home, ".aih", "ecc")}`,
    );
  });

  it("doctor states that the ECC checks were not run, as a skip naming the install command", async () => {
    const checks = await eccDoctorChecksV1(ctx());
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "ECC checks", verdict: "skip" });
    expect(checks[0]?.detail).toContain(
      "ECC checks were not run: framework-plugin-unavailable: @aihq/framework-ecc is not installed",
    );
  });

  it("uninstall refuses the ECC removal by name before any cleanup", async () => {
    await expect(prepareEccMaterializationRemovalV1(ctx())).rejects.toThrow(
      /framework-plugin-unavailable: .*npm install/,
    );
  });
});

describe("ECC uninstall and prune with the plugin", () => {
  it("plans prune with Core's runtime bound to the invocation", async () => {
    const planned = await eccPrunePlanV1(ctx(), ["claude"], withPlugin);
    expect(planned.subtracted).toBe(0);
    expect(planned.actions.map((action) => action.describe)).toContain(
      "Preserve unreceipted ECC claude footprint",
    );
  });

  it("removes nothing when no receipt proves ownership", async () => {
    const remove = await prepareEccMaterializationRemovalV1(ctx(), withPlugin);
    await expect(remove()).resolves.toEqual({ removed: [], advisories: [] });
  });
});
