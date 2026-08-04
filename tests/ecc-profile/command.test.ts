import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeEccCommand } from "../../src/ecc/pipeline.js";
import {
  createPackagedEccProfileEvidence,
  executeEccProfileLifecycleCommand,
} from "../../src/ecc-profile/command.js";
import {
  ECC_PROFILE_OWNERSHIP_PATH,
  readEccProfileOwnership,
} from "../../src/ecc-profile/lifecycle.js";
import { renderEccProjectionWithTrust } from "../../src/ecc-profile/render.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { evidence, profile, projectionRoots } from "./render-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(root: string, operation: string, apply: boolean): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { lifecycle: operation },
  };
}

describe("ECC profile lifecycle command", () => {
  it("materializes the package-bound review and projected-source receipts in a disposable root", () => {
    const packaged = createPackagedEccProfileEvidence();
    roots.push(packaged.evidenceRoot);

    expect(packaged.profile.source.reviewReceipt).toEqual(packaged.evidence.reviewReceipt);
    expect(
      existsSync(
        join(packaged.evidenceRoot, ...packaged.evidence.reviewReceipt.evidencePath.split("/")),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(packaged.evidenceRoot, "evidence", "ecc", "projected-source-closure-v1.json"),
      ),
    ).toBe(true);
  });

  it("previews without target writes, then installs and uninstalls through the authenticated lifecycle", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-"));
    roots.push(target);
    try {
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const loadProjection = vi.fn(async () => projection);

      const preview = await executeEccCommand(context(target, "install", false), {
        profileLifecycle: { loadProjection },
      });
      expect(preview.applied).toBe(false);
      expect(preview.writes.length).toBeGreaterThan(0);
      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);

      const installed = await executeEccProfileLifecycleCommand(context(target, "install", true), {
        loadProjection,
      });
      expect(installed.applied).toBe(true);
      expect(readEccProfileOwnership(target)?.state).toBe("active");

      await executeEccProfileLifecycleCommand(context(target, "uninstall", true), {
        loadProjection,
      });
      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
      expect(loadProjection).toHaveBeenCalledTimes(3);
    } finally {
      await sources.cleanup();
    }
  }, 120_000);

  it("fails closed on unknown operations and incompatible legacy selection flags", async () => {
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-invalid-"));
    roots.push(target);
    const loadProjection = vi.fn();

    await expect(
      executeEccProfileLifecycleCommand(context(target, "replace-everything", false), {
        loadProjection,
      }),
    ).rejects.toThrow(/lifecycle.*install.*update.*repair.*rollback.*uninstall/i);
    const conflicting = context(target, "install", false);
    conflicting.options.with = ["security-review"];
    await expect(
      executeEccProfileLifecycleCommand(conflicting, { loadProjection }),
    ).rejects.toThrow(/--with.*lifecycle/i);
    const profileConflict = context(target, "install", false);
    profileConflict.options.profile = "core";
    await expect(
      executeEccProfileLifecycleCommand(profileConflict, { loadProjection }),
    ).rejects.toThrow(/--profile.*lifecycle/i);
    expect(loadProjection).not.toHaveBeenCalled();
  });
});
