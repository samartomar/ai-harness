import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import { createGovernanceDoctorOperationalContextV1 } from "../../src/governance-doctor/operational-v1.js";
import {
  assertGovernanceDoctorRepairPreconditionV1,
  GOVERNANCE_DOCTOR_REPAIR_PRECONDITION_DIAGNOSTIC_ID_V1,
  observeGovernanceDoctorRepairPreconditionV1,
} from "../../src/governance-doctor/repair-precondition-v1.js";
import { mintGovernanceDoctorRepairPreconditionScopeV1 } from "../../src/governance-doctor/repair-scope-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { canonContextDirCheck } from "../../src/lint/run.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-precondition-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CANON = "ai-coding";

/** The branded operational context this run would carry, with one field varied. */
function operationalContext(overrides: Record<string, unknown> = {}) {
  const run = fakeRunner(() => undefined);
  return createGovernanceDoctorOperationalContextV1({
    apply: false,
    contextDir: CANON,
    env: {},
    host: makeHostAdapter({ env: {}, platform: "linux", run }),
    json: true,
    options: {},
    root,
    run,
    verify: true,
    ...overrides,
  } as unknown as PlanContext);
}

/** The scope the trusted command boundary would mint for this run. */
function scope() {
  return mintGovernanceDoctorRepairPreconditionScopeV1(operationalContext());
}

function observe() {
  return observeGovernanceDoctorRepairPreconditionV1(scope());
}

describe("repair precondition probe", () => {
  it("is eligible when the canonical directory is absent, and reports the frozen identity", () => {
    const observed = observe();
    expect(observed.eligible).toBe(true);
    expect(observed.diagnosticId).toBe("aih.repair.precondition.canon-context-v1");
    expect(observed.diagnosticId).toBe(GOVERNANCE_DOCTOR_REPAIR_PRECONDITION_DIAGNOSTIC_ID_V1);
    expect(Object.isFrozen(observed)).toBe(true);
    // Evidence is bound, not a bare verdict.
    expect(observed.recipeId).toBe("aih.repair.recipe.canon-context-dir-v1");
    expect(observed.targetPath).toBe("ai-coding");
    expect(observed.rootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.observations).toEqual([
      { code: "canon.context-dir-missing", name: "context-dir", verdict: "skip" },
      { code: null, name: "canon markdown lint", verdict: "skip" },
    ]);
    // Only the sanitized projection travels: no detail, ever.
    expect(JSON.stringify(observed)).not.toContain("scaffolded");
    expect(JSON.stringify(observed)).not.toContain(root);
  });

  it("stops being eligible once the directory exists, and is eligible again when it is removed", () => {
    expect(observe().eligible).toBe(true);
    mkdirSync(join(root, CANON), { recursive: true });
    // The recipe is unnecessary: the state it repairs no longer holds.
    expect(observe().eligible).toBe(false);
    rmSync(join(root, CANON), { recursive: true, force: true });
    expect(observe().eligible).toBe(true);
  });

  /**
   * The canon lint check emits a code-less `skip` from two places: the directory
   * being absent, and an existing tree with informational findings. Only the
   * first may qualify.
   *
   * The informational branch sits after the directory-exists guard, so it can
   * only fire while the context-dir check reports `pass`. This pins the property
   * that makes that structural fact load-bearing: with the directory present,
   * eligibility is false no matter what the lint reports, because the bundle
   * requires the context-dir tuple to be *present* and the set to have exactly
   * two members.
   *
   * This test alone does not exercise the ambiguous skip -- no bounded fixture
   * reaches that branch. The forced case lives in
   * `repair-precondition-lint-ambiguity-v1.test.ts`, which intercepts the module
   * so the lint really does return that tuple and proves the probe still
   * refuses. The two together cover the case; neither does on its own.
   */
  it("cannot qualify while the context-dir check passes, whatever the lint reports", () => {
    mkdirSync(join(root, CANON), { recursive: true });
    expect(canonContextDirCheck(root, CANON).verdict).toBe("pass");
    expect(observe().eligible).toBe(false);
    // A populated canon tree is likewise ineligible: the bundle needs both
    // tuples, and the first one is gone.
    writeFileSync(join(root, CANON, "RULE_ROUTER.md"), "# Router\n");
    expect(observe().eligible).toBe(false);
  });

  it("observes the same context-dir check the Doctor probe runs", () => {
    // The extraction exists so there is one implementation, not two that drift.
    expect(canonContextDirCheck(root, CANON)).toEqual({
      name: "context-dir",
      verdict: "skip",
      detail: `${CANON} not scaffolded — run: aih scaffold --apply`,
      code: "canon.context-dir-missing",
    });
    mkdirSync(join(root, CANON), { recursive: true });
    expect(canonContextDirCheck(root, CANON).verdict).toBe("pass");
  });

  /**
   * The reason this probe exists. Doctor surveys host concerns -- runnable AI
   * CLIs, `rg`/`fd`/`jq` on PATH -- that no repository state can clear, and that
   * would make the full result permanently ineligible. None of them may enter or
   * alter this bounded question.
   */
  it("is unaffected by the host gaps that make the full Doctor result ineligible", async () => {
    const run = fakeRunner(() => undefined);
    const planned = await doctorCommand.plan?.({
      apply: false,
      contextDir: CANON,
      env: {},
      host: makeHostAdapter({ env: {}, platform: "linux", run }) as never,
      json: true,
      options: {},
      root,
      run,
      verify: true,
    } as never);
    const describes = (planned as unknown as { actions: Array<Record<string, unknown>> }).actions
      .filter((action) => action.kind === "probe")
      .map((action) => String(action.describe));
    expect(describes.some((name) => /cli|tool/i.test(name))).toBe(true);
    expect(observe().eligible).toBe(true);
  });

  /**
   * A resolved absolute path is a format, not an authority. Every substitute --
   * including the correct root as a bare string -- must be refused, and refused
   * before either underlying check runs.
   */
  it("refuses every unbranded scope before it touches the filesystem", () => {
    const real = scope();
    const spread = { ...real };
    const accessor: Record<string, unknown> = { ...spread };
    Object.defineProperty(accessor, "rootRealPath", { enumerable: true, get: () => root });
    for (const [label, value] of [
      ["bare root string", root],
      ["plain object", { ...spread }],
      ["spread copy", spread],
      ["proxy", new Proxy(real, {})],
      ["accessor", accessor],
      ["parse", JSON.parse(JSON.stringify(real))],
      ["prototype child", Object.create(real) as unknown],
      ["relative path", "relative/path"],
      ["empty", ""],
      ["null", null],
      ["undefined", undefined],
      ["number", 7],
    ] as const)
      expect(() => observeGovernanceDoctorRepairPreconditionV1(value), label).toThrow(TypeError);
  });

  /**
   * The refusal has to come from the scope gate, not from something downstream
   * happening to throw. The discriminator is the message: with the brand check
   * removed, `bound.rootRealPath` reads `undefined` off a string and the first
   * `join` raises a *different* `TypeError`, so this assertion fails rather than
   * passing for the wrong reason. Neutralizing the gate locally was used to
   * confirm that.
   */
  it("makes no filesystem observation for an unbranded scope", () => {
    expect(() => observeGovernanceDoctorRepairPreconditionV1(root)).toThrow(
      /repair precondition scope is not AIH-owned/,
    );
  });
});

describe("repair precondition brand", () => {
  it("refuses every substitute for an observed record", () => {
    const observed = observe();
    const spread = { ...observed };
    const accessor: Record<string, unknown> = {
      diagnosticId: observed.diagnosticId,
      protocol: "GovernanceDoctorRepairPreconditionV1",
    };
    Object.defineProperty(accessor, "eligible", { enumerable: true, get: () => true });
    for (const [label, value] of [
      ["plain object", { ...spread }],
      ["spread copy", spread],
      ["proxy", new Proxy(observed, {})],
      ["accessor", accessor],
      ["parse", JSON.parse(JSON.stringify(observed))],
      ["prototype child", Object.create(observed) as unknown],
      ["null", null],
      ["undefined", undefined],
      ["true", true],
    ] as const)
      expect(() => assertGovernanceDoctorRepairPreconditionV1(value), label).toThrow(TypeError);
  });

  it("accepts the record it observed", () => {
    const observed = observe();
    expect(assertGovernanceDoctorRepairPreconditionV1(observed).eligible).toBe(true);
  });
});

/**
 * The mint is the trust boundary: everything downstream refuses whatever it did
 * not produce, so what it agrees to produce is the whole of the question.
 */
describe("repair precondition scope mint", () => {
  it("binds one run to its own canonical root and this recipe's literal target", () => {
    const minted = scope();
    expect(minted.rootRealPath).toBe(root);
    expect(minted.targetPath).toBe(CANON);
    expect(minted.recipeId).toBe("aih.repair.recipe.canon-context-dir-v1");
    expect(minted.rootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(minted)).toBe(true);

    // The binding is to *this* root, not a constant that would let a scope
    // minted for one repository stand beside another's observation.
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-precondition-other-")));
    try {
      expect(
        mintGovernanceDoctorRepairPreconditionScopeV1(operationalContext({ root: other }))
          .rootSha256,
      ).not.toBe(minted.rootSha256);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  /**
   * `--context-dir`, `AIH_CONTEXT_DIR`, and a committed marker can all move a
   * repository's canon somewhere other than `ai-coding`. This recipe's target is
   * the literal `ai-coding` and nothing else, so a run pointed elsewhere must
   * mint nothing: otherwise the probe would report "`ai-coding` is missing --
   * eligible" about a repository whose canon is present and healthy under a
   * different name, and the effect that follows would create a directory no
   * finding asked for.
   */
  it("refuses a run whose resolved context directory is not the canonical one", () => {
    for (const contextDir of ["docs/ai", "ai-coding-2", "AI-CODING", " ai-coding", ""])
      expect(
        () => mintGovernanceDoctorRepairPreconditionScopeV1(operationalContext({ contextDir })),
        contextDir,
      ).toThrow(/repair precondition scope requires the canonical context directory/);
  });

  it("refuses an operational context AIH did not brand", () => {
    const real = operationalContext();
    for (const [label, value] of [
      ["plain look-alike", { protocol: "GovernanceDoctorOperationalContextV1" }],
      ["spread copy", { ...real }],
      ["proxy", new Proxy(real, {})],
      ["prototype child", Object.create(real) as unknown],
      ["root string", root],
      ["null", null],
      ["undefined", undefined],
    ] as const)
      expect(() => mintGovernanceDoctorRepairPreconditionScopeV1(value), label).toThrow(
        /operation requires an AIH-owned operational context/,
      );
  });

  it("refuses a root that is not absolute", () => {
    for (const bad of ["relative/path", "ai-coding", ""])
      expect(
        () => mintGovernanceDoctorRepairPreconditionScopeV1(operationalContext({ root: bad })),
        bad,
      ).toThrow(/repair precondition scope requires an absolute repository root/);
  });

  /**
   * A spelling that merely *reaches* the checkout is not the checkout: the rest
   * of the foundation digests the canonical form, so a root that is not already
   * its own canonical form would bind this scope to a path no other record
   * agrees with. A trailing separator is the portable instance of that.
   */
  it("refuses a root that is not its own canonical form", () => {
    expect(() =>
      mintGovernanceDoctorRepairPreconditionScopeV1(operationalContext({ root: root + sep })),
    ).toThrow(/repair precondition scope root is not its own canonical form/);
  });

  it("refuses a root that cannot be resolved", () => {
    expect(() =>
      mintGovernanceDoctorRepairPreconditionScopeV1(
        operationalContext({ root: join(root, "absent-child") }),
      ),
    ).toThrow(/repair precondition scope root cannot be resolved/);
  });
});
