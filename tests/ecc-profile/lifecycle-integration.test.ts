import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ECC_PROFILE_OWNERSHIP_PATH,
  planEccProfileLifecycle,
  readEccProfileOwnership,
} from "../../src/ecc-profile/lifecycle.js";
import {
  projectionFilesDigest,
  renderEccProjectionWithTrust,
} from "../../src/ecc-profile/render.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { evidence, profile, projectionRoots } from "./render-fixture.js";

function context(root: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: ".ai-context",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

describe("authenticated projection lifecycle", () => {
  it("installs, repeats, and uninstalls the complete derived projection", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-lifecycle-integration-"));
    try {
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      await executePlan(planEccProfileLifecycle(target, projection, "install"), context(target));

      const receipt = readEccProfileOwnership(target);
      expect(receipt?.source.projectionSha256).toBe(projectionFilesDigest(projection.files));
      expect(receipt?.files.map((file) => file.destination)).toEqual(
        projection.files.map((file) => file.destination).sort(),
      );
      expect(planEccProfileLifecycle(target, projection, "install").actions).toEqual([]);

      await executePlan(planEccProfileLifecycle(target, projection, "uninstall"), context(target));
      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
    } finally {
      await sources.cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  }, 120_000);
});
