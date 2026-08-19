import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGovernanceDoctorOperationalContextV1 } from "../../src/governance-doctor/operational-v1.js";
import { observeGovernanceDoctorRepairPreconditionV1 } from "../../src/governance-doctor/repair-precondition-v1.js";
import { mintGovernanceDoctorRepairPreconditionScopeV1 } from "../../src/governance-doctor/repair-scope-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/**
 * The bundle is two filesystem observations, and a live tree can change between
 * them.
 *
 * The structural argument that separates the two code-less lint skips -- the
 * informational branch runs after the directory-exists guard, so it can only
 * fire while the context-dir check reports `pass` -- holds within *one* reading.
 * It says nothing across two. A directory created after the context-dir check
 * and before the lint check yields tuple 1 from the first observation and tuple
 * 2 from the second, reproducing the bundle over a state the tree was never in.
 *
 * This forces exactly that interleaving by making the mocked lint check create
 * the directory as its side effect, which is the only way to place the write
 * deterministically inside the window. The probe must not report eligible: the
 * confirming reading sees the directory present, the context-dir check passes,
 * and the observed set is no longer the bundle.
 */
vi.mock("../../src/lint/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lint/run.js")>();
  const { mkdirSync } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    canonLintCheck: (root: string, contextDir: string) => {
      mkdirSync(joinPath(root, contextDir), { recursive: true });
      return {
        name: "canon markdown lint",
        verdict: "skip" as const,
        detail: "informational finding",
      };
    },
  };
});

const CANON = "ai-coding";

function scopeFor(root: string) {
  const run = fakeRunner(() => undefined);
  return mintGovernanceDoctorRepairPreconditionScopeV1(
    createGovernanceDoctorOperationalContextV1({
      apply: false,
      contextDir: CANON,
      env: {},
      host: makeHostAdapter({ env: {}, platform: "linux", run }),
      json: true,
      options: {},
      root,
      run,
      verify: true,
    } as unknown as PlanContext),
  );
}

describe("a directory that appears between the bundle's two checks", () => {
  it("cannot produce eligible evidence, because the reading is confirmed", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-precondition-race-")));
    try {
      expect(existsSync(join(root, CANON))).toBe(false);
      const observed = observeGovernanceDoctorRepairPreconditionV1(scopeFor(root));

      // The interleaving really happened: the lint check created the directory.
      expect(existsSync(join(root, CANON))).toBe(true);
      // And the record reports the confirming reading, in which the context-dir
      // check passes -- not the composite that never existed.
      expect(observed.observations).toEqual([
        { code: null, name: "canon markdown lint", verdict: "skip" },
      ]);
      expect(observed.eligible).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
