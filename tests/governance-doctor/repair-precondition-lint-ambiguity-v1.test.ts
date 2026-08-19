import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
 * The one case a real fixture could not reach.
 *
 * `canonLintCheck` emits a code-less `skip` from two places: the context
 * directory being absent (`src/lint/run.ts`, immediately after the `existsSync`
 * guard) and an existing tree with informational findings (`infos.length > 0`,
 * at the end of the same function). Only the first belongs to the causal bundle,
 * and keyed alone the two are indistinguishable -- no `code` separates them, and
 * reading `detail` is forbidden.
 *
 * Driving the informational branch needs a canon file that is both AIH-authored
 * and lints to an `info`-severity finding; the candidates tried lint clean, so
 * that branch is not reachable from a bounded fixture. It is therefore forced
 * here by intercepting the module. That is test instrumentation only: the
 * production module gains no callback, no injected-check seam, and no
 * caller-supplied check collection, and the probe under test is the real one.
 * The mock lives in its own file so it cannot leak into the sibling suite.
 *
 * What this proves is the half the structural argument cannot: that *even when*
 * the lint really does return the ambiguous tuple, the probe stays ineligible,
 * because the bundle also requires the context-dir tuple and exactly two
 * members. The source-level fact -- that this branch can only run once the
 * directory exists, so the context-dir check must be reporting `pass` -- remains
 * the reason the two cases never overlap in production.
 */
vi.mock("../../src/lint/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lint/run.js")>();
  return {
    ...actual,
    canonLintCheck: () => ({
      name: "canon markdown lint",
      verdict: "skip" as const,
      detail: "informational finding",
    }),
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

describe("ambiguous informational canon-lint skip", () => {
  it("cannot qualify, even though its tuple is identical to the bundle's second member", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-lint-ambig-")));
    try {
      // The state the informational branch actually occurs in: the directory
      // exists, so the real context-dir check passes.
      mkdirSync(join(root, CANON), { recursive: true });
      const present = observeGovernanceDoctorRepairPreconditionV1(scopeFor(root));
      expect(present.observations).toEqual([
        { code: null, name: "canon markdown lint", verdict: "skip" },
      ]);
      expect(present.eligible).toBe(false);

      // The control: with the directory absent, the same forced lint tuple
      // completes the bundle -- which is exactly why the pair, not the tuple, is
      // the unit of eligibility.
      rmSync(join(root, CANON), { recursive: true, force: true });
      const absent = observeGovernanceDoctorRepairPreconditionV1(scopeFor(root));
      expect(absent.observations).toEqual([
        { code: "canon.context-dir-missing", name: "context-dir", verdict: "skip" },
        { code: null, name: "canon markdown lint", verdict: "skip" },
      ]);
      expect(absent.eligible).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
