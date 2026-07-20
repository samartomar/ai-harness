import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  eccDoubleInstallCheck,
  eccModeExclusivityCheck,
} from "../../../src/binding/frameworks/ecc-doctor.js";
import {
  type BindingLock,
  type BindingOwnershipEntry,
  writeBindingLockAtomic,
} from "../../../src/binding/lock.js";
import type { BindingDeclaration } from "../../../src/binding/schema.js";
import type { PlanContext } from "../../../src/internals/plan.js";
import { fakeRunner } from "../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../src/platform/detect.js";

/**
 * W4d — the two ECC doctor probes (`eccDoubleInstallCheck`,
 * `eccModeExclusivityCheck`). Both are pure read-only diagnostics over a
 * project root's `.claude/settings.json`, `.claude/rules/ecc/` (project and
 * home scope), and the binding lock — no Runner calls are ever made, so
 * `fakeRunner` here always reports a spawn error (unused by these checks).
 */

const SHA_A = "a".repeat(64);

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-doctor-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-ecc-doctor-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => ({ code: 1, spawnError: true }));
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: home },
    options: {},
  };
}

function writeProjectSettings(body: unknown | string): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

function writeManualEccCopy(base: string): void {
  mkdirSync(join(base, ".claude", "rules", "ecc"), { recursive: true });
  writeFileSync(join(base, ".claude", "rules", "ecc", "patterns.md"), "# ecc rules\n", "utf8");
}

describe("eccDoubleInstallCheck", () => {
  it("passes with a clean detail when neither surface is present", () => {
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toBe("no ECC plugin enable and no manual ECC rules copy found");
  });

  it("passes when only the plugin is enabled", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@aih-ecc": true } });
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("ECC plugin enabled (ecc@aih-ecc)");
    expect(res.detail).toContain("no manual ECC rules copy found");
  });

  it("passes when only a manual project-scope copy exists", () => {
    writeManualEccCopy(root);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("manual ECC rules copy present (project:.claude/rules/ecc)");
    expect(res.detail).toContain("no ECC plugin enabled");
  });

  it("passes when only a manual home-scope copy exists", () => {
    writeManualEccCopy(home);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("manual ECC rules copy present (home:.claude/rules/ecc)");
  });

  it("fails when both the plugin and a project-scope manual copy are present", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@aih-ecc": true } });
    writeManualEccCopy(root);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("ECC plugin enabled (ecc@aih-ecc)");
    expect(res.detail).toContain("project:.claude/rules/ecc");
    expect(res.detail).toContain("stacks duplicates");
  });

  it("fails when both the plugin and a home-scope manual copy are present", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@aih-ecc": true } });
    writeManualEccCopy(home);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("home:.claude/rules/ecc");
  });

  it("tolerates malformed settings.json — treated as no plugin signal, never throws", () => {
    writeProjectSettings("{ not valid json");
    writeManualEccCopy(root);
    expect(() => eccDoubleInstallCheck(ctx())).not.toThrow();
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("manual ECC rules copy present");
  });

  it("ignores a non-ecc-prefixed enabledPlugins key", () => {
    writeProjectSettings({ enabledPlugins: { "superpowers@aih-superpowers": true } });
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toBe("no ECC plugin enable and no manual ECC rules copy found");
  });
});

describe("eccModeExclusivityCheck", () => {
  function eccDeclaration(mode?: "lean" | "full"): BindingDeclaration {
    return {
      schemaVersion: 1,
      framework: { id: "ecc", host: "claude", ...(mode ? { mode } : {}) },
      source: {
        kind: "git",
        repository: "samartomar/ECC",
        commitSha: "c".repeat(40),
        treeDigest: SHA_A,
      },
    };
  }

  function eccLock(overrides: Partial<BindingLock> = {}): BindingLock {
    return {
      schemaVersion: 1,
      declaration: eccDeclaration("lean"),
      writes: [],
      scannedDigest: SHA_A,
      loadedDigest: SHA_A,
      match: true,
      ownership: [],
      ...overrides,
    };
  }

  function homeOwnershipEntry(target: string): BindingOwnershipEntry {
    return {
      kind: "file",
      target,
      preExisting: { absent: true },
      applied: SHA_A,
      postApplyDigest: SHA_A,
    };
  }

  it("passes when no binding lock is present", () => {
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toBe("no binding lock present — nothing to enforce");
  });

  it("passes when the bound framework is not ecc", () => {
    writeBindingLockAtomic(
      root,
      eccLock({
        declaration: {
          schemaVersion: 1,
          framework: { id: "superpowers", host: "claude" },
          source: {
            kind: "git",
            repository: "obra/superpowers",
            commitSha: "d".repeat(40),
            treeDigest: SHA_A,
          },
        },
      }),
    );
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("not ecc");
  });

  it("passes for a lean lock with no ecc@ plugin entry (matching state)", () => {
    writeBindingLockAtomic(
      root,
      eccLock({ ownership: [homeOwnershipEntry("home:.claude/rules/common")] }),
    );
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("lean mode lock with no ecc@ plugin entry");
  });

  it("fails for a lean lock when an ecc@ plugin entry is enabled", () => {
    writeBindingLockAtomic(
      root,
      eccLock({ ownership: [homeOwnershipEntry("home:.claude/rules/common")] }),
    );
    writeProjectSettings({ enabledPlugins: { "ecc@aih-ecc": true } });
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("lean mode lock");
    expect(res.detail).toContain("ecc@aih-ecc");
  });

  it("passes for a full lock with an ecc@ plugin entry enabled (matching state)", () => {
    writeBindingLockAtomic(
      root,
      eccLock({
        declaration: eccDeclaration("full"),
        ownership: [homeOwnershipEntry("home:.claude/plugins/cache/ecc@aih-ecc")],
      }),
    );
    writeProjectSettings({ enabledPlugins: { "ecc@aih-ecc": true } });
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("full mode lock with an ecc@ plugin entry");
  });

  it("fails for a full lock with no plugin entry while lean home-scoped ownership exists", () => {
    writeBindingLockAtomic(
      root,
      eccLock({
        declaration: eccDeclaration("full"),
        ownership: [homeOwnershipEntry("home:.claude/rules/common")],
      }),
    );
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("full mode lock");
    expect(res.detail).toContain("home:.claude/rules/common");
  });

  it("passes for a full lock with no plugin entry and no home-scoped ownership either", () => {
    writeBindingLockAtomic(root, eccLock({ declaration: eccDeclaration("full"), ownership: [] }));
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain(
      "full mode lock with no ecc@ plugin entry and no lean home-scoped ownership",
    );
  });

  it("fails with the lock's error message (not a crash) on a corrupt lock", () => {
    mkdirSync(join(root, ".aih", "binding"), { recursive: true });
    writeFileSync(join(root, ".aih", "binding", "lock.json"), "{ not valid json", "utf8");
    expect(() => eccModeExclusivityCheck(ctx())).not.toThrow();
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("not valid JSON");
  });
});

describe("ECC doctor probes — determinism", () => {
  it("produce identical Check output across two consecutive runs on the same state", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@aih-ecc": true } });
    writeManualEccCopy(root);
    writeBindingLockAtomic(root, {
      schemaVersion: 1,
      declaration: {
        schemaVersion: 1,
        framework: { id: "ecc", host: "claude", mode: "lean" },
        source: {
          kind: "git",
          repository: "samartomar/ECC",
          commitSha: "c".repeat(40),
          treeDigest: SHA_A,
        },
      },
      writes: [],
      scannedDigest: SHA_A,
      loadedDigest: SHA_A,
      match: true,
      ownership: [],
    } satisfies BindingLock);

    const c = ctx();
    expect(eccDoubleInstallCheck(c)).toEqual(eccDoubleInstallCheck(c));
    expect(eccModeExclusivityCheck(c)).toEqual(eccModeExclusivityCheck(c));
  });
});
