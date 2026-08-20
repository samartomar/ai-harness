import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGovernanceDoctorOperationalContextV1 } from "../../src/governance-doctor/operational-v1.js";
import {
  createGovernanceDoctorRepairCustodyV1,
  governanceDoctorRepairReadV1,
} from "../../src/governance-doctor/repair-custody-v1.js";
import { mintGovernanceDoctorRepairPreconditionScopeV1 } from "../../src/governance-doctor/repair-scope-v1.js";
import {
  assertGovernanceDoctorRepairTargetOccupancyV1,
  observeGovernanceDoctorRepairTargetOccupancyV1,
} from "../../src/governance-doctor/repair-target-occupancy-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { REPAIR_FIXTURE_CONTEXT_DIR, repairFixturePlan } from "./repair-execution-fixture-v1.js";

const CANON = "ai-coding";

function freshRoot(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "aih-occupancy-")));
}

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

/** Runs one case against a throwaway tree and hands back the verdict. */
function verdictAfter(prepare: (root: string) => void): string {
  const root = freshRoot();
  try {
    prepare(root);
    return observeGovernanceDoctorRepairTargetOccupancyV1(scopeFor(root)).state;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("repair target occupancy", () => {
  it("reports unoccupied only for a genuinely free name under a real directory", () => {
    expect(verdictAfter(() => undefined)).toBe("unoccupied");
  });

  /**
   * The case `existsSync` gets wrong. It follows the link, finds nothing, and
   * reports absence -- while the name is taken and `mkdir` would refuse it. A
   * no-follow look sees the link itself.
   */
  it("reports occupied for a dangling link the shipped checks read as absent", () => {
    expect(
      verdictAfter((root) => symlinkSync(join(root, "nowhere"), join(root, CANON), "dir")),
    ).toBe("occupied");
  });

  it("reports occupied for every other thing that can hold the name", () => {
    expect(verdictAfter((root) => mkdirSync(join(root, CANON)))).toBe("occupied");
    expect(verdictAfter((root) => writeFileSync(join(root, CANON), "not a directory"))).toBe(
      "occupied",
    );
    expect(
      verdictAfter((root) => {
        mkdirSync(join(root, "real"));
        symlinkSync(join(root, "real"), join(root, CANON), "dir");
      }),
    ).toBe("occupied");
  });

  /**
   * `ENOENT` on the child means the name is free only because the parent was
   * already proved to be a real directory. Without that proof the same error
   * arrives from a root that is a file, a link, or gone -- none of which is an
   * absent `ai-coding`.
   */
  it("reports indeterminate rather than unoccupied when the root is not a real directory", () => {
    const root = freshRoot();
    const scope = scopeFor(root);
    try {
      // Minted against a real directory, then replaced underneath the run.
      rmSync(root, { recursive: true, force: true });
      expect(observeGovernanceDoctorRepairTargetOccupancyV1(scope).state).toBe("indeterminate");
      writeFileSync(root, "the root is a file now");
      expect(observeGovernanceDoctorRepairTargetOccupancyV1(scope).state).toBe("indeterminate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Review finding. A canonical path is not an identity: rename the scoped
   * directory away and put a fresh one at the same path, and both the `lstat`
   * and the canonical-form check still pass. The probe would then describe a
   * directory the scope was never minted against -- and report an absent
   * `ai-coding` inside it as free.
   */
  it("reports indeterminate when the root path holds a different directory than the scope", () => {
    const root = freshRoot();
    const moved = `${root}-moved`;
    const scope = scopeFor(root);
    try {
      expect(observeGovernanceDoctorRepairTargetOccupancyV1(scope).state).toBe("unoccupied");
      renameSync(root, moved);
      // A fresh directory, canonical and real, at exactly the bound path.
      mkdirSync(root);
      expect(observeGovernanceDoctorRepairTargetOccupancyV1(scope).state).toBe("indeterminate");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it("binds the verdict to the scope and refuses every substitute for it", () => {
    const root = freshRoot();
    try {
      const scope = scopeFor(root);
      const observed = observeGovernanceDoctorRepairTargetOccupancyV1(scope);
      expect(observed.rootSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(observed.targetPath).toBe(CANON);
      expect(Object.isFrozen(observed)).toBe(true);
      expect(JSON.stringify(observed)).not.toContain(root);
      for (const [label, value] of [
        ["bare root", root],
        ["plain object", { ...scope }],
        ["proxy", new Proxy(scope, {})],
        ["null", null],
        ["undefined", undefined],
      ] as const)
        expect(() => observeGovernanceDoctorRepairTargetOccupancyV1(value), label).toThrow(
          /repair precondition scope is not AIH-owned/,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses every substitute for an observed record", () => {
    const root = freshRoot();
    try {
      const observed = observeGovernanceDoctorRepairTargetOccupancyV1(scopeFor(root));
      expect(assertGovernanceDoctorRepairTargetOccupancyV1(observed)).toBe(observed);
      for (const [label, value] of [
        ["plain object", { ...observed }],
        ["proxy", new Proxy(observed, {})],
        ["parse", JSON.parse(JSON.stringify(observed))],
        ["extra field", { ...observed, eligible: true }],
        ["null", null],
      ] as const)
        expect(() => assertGovernanceDoctorRepairTargetOccupancyV1(value), label).toThrow(
          TypeError,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Custody owns the same no-follow rule and enforces it at the effect boundary,
 * where a wrong answer would actually write. This probe restates that rule
 * because it must not import mutation capability to reach it, so the two are
 * pinned to agree on the only thing both decide: whether the name is absent.
 *
 * If either later drifts -- an `existsSync` creeping into one, a symlink branch
 * loosened in the other -- this fails, rather than leaving the probe and the
 * boundary quietly disagreeing about the same tree.
 */
describe("agreement with the custody rule at the effect boundary", () => {
  const cases: readonly (readonly [string, (root: string) => void])[] = [
    ["free name", () => undefined],
    ["directory", (root: string) => mkdirSync(join(root, CANON))],
    ["regular file", (root: string) => writeFileSync(join(root, CANON), "x")],
    [
      "dangling link",
      (root: string) => symlinkSync(join(root, "nowhere"), join(root, CANON), "dir"),
    ],
    [
      "live link",
      (root: string) => {
        mkdirSync(join(root, "real"));
        symlinkSync(join(root, "real"), join(root, CANON), "dir");
      },
    ],
  ];

  it("calls the name absent in exactly the same cases custody does", async () => {
    for (const [label, prepare] of cases) {
      const root = freshRoot();
      try {
        prepare(root);
        const plan = await repairFixturePlan({
          effects: [
            {
              arguments: { path: CANON },
              effectId: "ensure-canon",
              templateId: "ensure-canon-directory",
            },
          ],
          root,
          scopePaths: [CANON],
        });
        const custody = createGovernanceDoctorRepairCustodyV1({
          contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
          plan,
          root,
        });
        const custodySaysAbsent = governanceDoctorRepairReadV1(custody, CANON).state === "absent";
        const probeSaysFree =
          observeGovernanceDoctorRepairTargetOccupancyV1(scopeFor(root)).state === "unoccupied";
        expect(probeSaysFree, label).toBe(custodySaysAbsent);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
