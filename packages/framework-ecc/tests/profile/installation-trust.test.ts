import "../core-invocation.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ECC_PROFILE_INSTALLATION_TRUST_V1 } from "@aihq/core/framework-host";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import * as command from "../../src/profile/command.js";
import {
  type EccProfileLifecycleCommandDeps,
  executeEccProfileLifecycleCommand,
} from "../../src/profile/command.js";
import { readEccProfileOwnership } from "../../src/profile/lifecycle.js";
import { renderEccProjection } from "../../src/profile/render.js";
import { evidence, profile, projectionRoots } from "./render-fixture.js";

/**
 * Recovery anchors are Core's: the plugin ships none, and nothing a plugin
 * passes or mutates at runtime widens the record recovery is checked against.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(root: string, operation: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { lifecycle: operation },
  };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("ECC profile recovery anchors are Core-owned", () => {
  it("ships no installation trust record in the plugin", () => {
    expect("PACKAGED_ECC_PROFILE_INSTALLATION_TRUST" in command).toBe(false);
    const anchors = ECC_PROFILE_INSTALLATION_TRUST_V1.map((anchor) => anchor.projectionSha256);
    for (const file of sourceFiles(join(import.meta.dirname, "../../src"))) {
      const text = readFileSync(file, "utf8");
      for (const anchor of anchors) expect(text.includes(anchor), file).toBe(false);
    }
  });

  it("refuses recovery when the plugin passes its own anchor, and when it tries to widen Core's record", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-trust-"));
    roots.push(target);
    try {
      const installed = await renderEccProjection(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      await executeEccProfileLifecycleCommand(context(target, "install"), {
        loadProjection: async () => installed,
      });
      const source = readEccProfileOwnership(target)?.source;
      if (source === undefined) throw new Error("fixture install recorded no receipt");
      expect(ECC_PROFILE_INSTALLATION_TRUST_V1).not.toContainEqual(source);

      const pluginAnchors = {
        installedSourceTrust: [source],
      } as unknown as EccProfileLifecycleCommandDeps;
      for (const operation of ["repair", "rollback", "uninstall"]) {
        await expect(
          executeEccProfileLifecycleCommand(context(target, operation), pluginAnchors),
        ).rejects.toThrow(/framework-profile-recovery-unanchored/);
      }

      expect(() =>
        (ECC_PROFILE_INSTALLATION_TRUST_V1 as unknown as unknown[]).push(source),
      ).toThrow(TypeError);
      await expect(
        executeEccProfileLifecycleCommand(context(target, "uninstall"), {}),
      ).rejects.toThrow(/framework-profile-recovery-unanchored/);
      expect(readEccProfileOwnership(target)?.source).toEqual(source);
    } finally {
      await sources.cleanup();
    }
  }, 120_000);
});
