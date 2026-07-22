import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultGstackInstaller, GSTACK_SETUP_COMMAND } from "../../../src/binding/index.js";
import type { RunResult } from "../../../src/internals/proc.js";
import { GSTACK_FIXTURE_FILES, scannedGstackFixture } from "./gstack-support.js";

describe("defaultGstackInstaller — pristine work-copy staging (spike cache-hygiene lesson)", () => {
  let cacheHome: string;

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), "aih-gstack-installer-test-"));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it("spawns setup from a scratch copy, never the resolved cache checkout, and cleans the stage", async () => {
    const { resolved } = scannedGstackFixture(cacheHome, "pinned-tree");
    const seen: { argv: string[]; cwd: string | undefined }[] = [];
    const runner = (argv: string[], opts?: { cwd?: string }): Promise<RunResult> => {
      seen.push({ argv, cwd: opts?.cwd });
      // Prove the stage carries the checkout's own bytes at spawn time: the
      // setup entry point copied from the fixture tree must be present.
      const cwd = opts?.cwd;
      expect(cwd).toBeDefined();
      expect(existsSync(join(cwd as string, "setup"))).toBe(true);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" } as RunResult);
    };

    const result = await defaultGstackInstaller({
      resolved,
      root: cacheHome,
      home: cacheHome,
      gstackHomeAbs: join(cacheHome, "gstack-home"),
      runner,
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    const call = seen[0] as { argv: string[]; cwd: string | undefined };
    expect(call.argv).toEqual([...GSTACK_SETUP_COMMAND]);
    // The load-bearing property: cwd is a scratch stage, NOT the pinned cache
    // checkout (bun install/build in the cache would dirty the next resolve).
    expect(call.cwd).not.toBe(resolved.treePath);
    expect(call.cwd?.includes("aih-gstack-setup-")).toBe(true);
    // The stage is removed after the run (success path).
    expect(existsSync(call.cwd as string)).toBe(false);
    // The pinned checkout itself is untouched by the run: same file set as the
    // fixture definition, no node_modules-style additions.
    for (const rel of Object.keys(GSTACK_FIXTURE_FILES)) {
      expect(existsSync(join(resolved.treePath, ...rel.split("/")))).toBe(true);
    }
    expect(existsSync(join(resolved.treePath, "node_modules"))).toBe(false);
  });
});
