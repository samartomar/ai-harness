import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import {
  executeGovernanceDoctorRepairCommandV1,
  governanceDoctorRepairCommand,
} from "../../src/governance-doctor/repair-command-v1.js";
import type { GovernanceDoctorRepairLiveCanonicalPlanResultV1 } from "../../src/governance-doctor/repair-live-canon-plan-v1.js";
import { governanceDoctorRepairEffectSummaryV1 } from "../../src/governance-doctor/repair-plan-v1.js";
import { type PlanResult, summarizeResult } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyEvaluateCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  type RepairFixtureHome,
  repairFixtureClaimStoreDirectory,
  repairFixtureIsolatedHome,
  repairFixturePlan,
} from "./repair-execution-fixture-v1.js";

const confirmation = vi.hoisted(() => ({
  prompt: vi.fn(),
}));

const repairInterposition = vi.hoisted(() => ({
  afterClaim: undefined as undefined | (() => void),
  canonicalPlan: undefined as undefined | GovernanceDoctorRepairLiveCanonicalPlanResultV1,
  effectChangeThrows: false,
  claimWriteStalls: false,
  executorThrows: false,
  verifierThrows: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...input: Parameters<typeof actual.writeSync>): number =>
      repairInterposition.claimWriteStalls ? 0 : actual.writeSync(...input),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

vi.mock("../../src/governance-doctor/repair-confirmation-v1.js", () => ({
  promptGovernanceDoctorRepairConfirmationV1: confirmation.prompt,
}));

vi.mock("../../src/governance-doctor/repair-live-canon-plan-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/governance-doctor/repair-live-canon-plan-v1.js")
    >();
  return {
    ...actual,
    deriveGovernanceDoctorRepairLiveCanonicalPlanV1: (input: unknown) =>
      repairInterposition.canonicalPlan ??
      actual.deriveGovernanceDoctorRepairLiveCanonicalPlanV1(input),
  };
});

vi.mock("../../src/governance-doctor/repair-claim-store-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-claim-store-v1.js")>();
  const actualAcquire =
    actual.acquireGovernanceDoctorRepairClaimV1 as typeof actual.acquireGovernanceDoctorRepairClaimV1 & {
      readonly isPostExclusiveCreateRefusalV1: (value: unknown) => boolean;
    };
  const acquire = (input: unknown) => {
    const claim = actualAcquire(input);
    repairInterposition.afterClaim?.();
    return claim;
  };
  Object.defineProperty(acquire, "isPostExclusiveCreateRefusalV1", {
    value: actualAcquire.isPostExclusiveCreateRefusalV1,
  });
  return {
    ...actual,
    acquireGovernanceDoctorRepairClaimV1: acquire,
  };
});

vi.mock("../../src/governance-doctor/repair-executor-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-executor-v1.js")>();
  return {
    ...actual,
    applyGovernanceDoctorRepairExecutionOutcomeV1: (claimed: unknown) => {
      if (repairInterposition.executorThrows)
        throw new Error("executor failure after durable claim");
      return actual.applyGovernanceDoctorRepairExecutionOutcomeV1(claimed);
    },
  };
});

vi.mock("../../src/governance-doctor/repair-attempt-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-attempt-v1.js")>();
  return {
    ...actual,
    didGovernanceDoctorRepairAttemptEffectChangeV1: (input: unknown) => {
      if (repairInterposition.effectChangeThrows)
        throw new Error("effect change probe leaked C:/private/repo/path");
      return actual.didGovernanceDoctorRepairAttemptEffectChangeV1(input);
    },
  };
});

vi.mock("../../src/governance-doctor/repair-verifier-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-verifier-v1.js")>();
  return {
    ...actual,
    verifyGovernanceDoctorRepairV1: (input: unknown) => {
      if (repairInterposition.verifierThrows)
        throw new Error("verifier leaked C:/private/repo/path");
      return actual.verifyGovernanceDoctorRepairV1(input);
    },
  };
});

const CANONICAL_CONTEXT_DIR = "ai-coding";
const CONTEXT_DIR_MISSING = {
  code: "canon.context-dir-missing" as const,
  detail: "ai-coding not scaffolded - run: aih scaffold --apply",
  name: "context-dir",
  verdict: "skip" as const,
};
const HEALTHY = { name: "diagnostic", verdict: "pass" as const };

interface ConfirmationInput {
  readonly plan: { readonly planSha256: string };
  readonly summary: { readonly summarySha256: string };
}

let home: RepairFixtureHome;
let root: string;

beforeEach(() => {
  home = repairFixtureIsolatedHome();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-repair-command-")));
  repairInterposition.afterClaim = undefined;
  repairInterposition.canonicalPlan = undefined;
  repairInterposition.effectChangeThrows = false;
  repairInterposition.claimWriteStalls = false;
  repairInterposition.executorThrows = false;
  repairInterposition.verifierThrows = false;
  // Repair is available only to the one marker-owned canonical target. The
  // marker itself is pre-existing fixture state, never an effect under test.
  writeFileSync(
    join(root, ".aih-config.json"),
    JSON.stringify({ contextDir: CANONICAL_CONTEXT_DIR, schemaVersion: 1, targets: [] }),
  );
  confirmation.prompt.mockImplementation(async (input: ConfirmationInput) => ({
    answer: input.plan.planSha256,
    kind: "answered",
  }));
  vi.spyOn(doctorCommand, "plan").mockImplementation((ctx) => ({
    actions: [
      {
        describe: "doctor diagnostic",
        kind: "probe" as const,
        run: async () =>
          existsSync(join(ctx.root, CANONICAL_CONTEXT_DIR)) ? HEALTHY : CONTEXT_DIR_MISSING,
      },
    ],
    capability: "doctor",
  }));
  vi.spyOn(policyEvaluateCommand, "plan").mockReturnValue({
    actions: [
      {
        describe: "policy diagnostic",
        kind: "probe" as const,
        run: async () => HEALTHY,
      },
    ],
    capability: "policy evaluate",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  home.release();
  rmSync(root, { force: true, recursive: true });
});

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    apply: false,
    contextDir: CANONICAL_CONTEXT_DIR,
    env: {},
    host: makeHostAdapter({ env: {}, platform: "linux", run }),
    json: false,
    options: {},
    root,
    run,
    verify: true,
    ...overrides,
  };
}

function rendered(result: PlanResult): string {
  return JSON.stringify(result.digests);
}

function digestText(result: PlanResult): string {
  return result.digests.map((digest) => digest.text).join("\n");
}

function claimFiles(): readonly string[] {
  const directory = repairFixtureClaimStoreDirectory(home.path);
  return existsSync(directory) ? readdirSync(directory) : [];
}

function assertUnaffectedFixture(result: PlanResult): void {
  expect(result.applied).toBe(false);
  expect(claimFiles()).toEqual([]);
  expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(false);
  expect(readdirSync(root)).toEqual([".aih-config.json"]);
  expect(rendered(result)).not.toContain(root);
}

describe("aih repair command V1", () => {
  it("is a separate mutating, zero-write, dry-run-by-default CommandSpec", () => {
    expect(governanceDoctorRepairCommand.name).toBe("repair");
    expect(governanceDoctorRepairCommand.readOnly).not.toBe(true);
    expect(governanceDoctorRepairCommand.zeroWrite).toBe(true);
    expect(governanceDoctorRepairCommand.alwaysVerify).toBe(true);
    expect(governanceDoctorRepairCommand.requireExplicitApply).toBe(true);
    expect(governanceDoctorRepairCommand.aliases).toBeUndefined();
    expect(governanceDoctorRepairCommand.deprecatedAliases).toBeUndefined();
  });

  it("presents a bounded canonical plan and both full lower-case digests without authority", async () => {
    const result = await executeGovernanceDoctorRepairCommandV1(context());
    const output = rendered(result);
    const text = digestText(result);
    const data = result.digests[0]?.data as
      | {
          readonly planSha256?: string;
          readonly summarySha256?: string;
          readonly preconditionSha256?: string;
          readonly targetOccupancy?: string;
          readonly auditCompleteness?: string;
        }
      | undefined;

    assertUnaffectedFixture(result);
    expect(result.capability).toBe("repair");
    expect(output).toMatch(/"planSha256":"[a-f0-9]{64}"/);
    expect(output).toMatch(/"summarySha256":"[a-f0-9]{64}"/);
    expect(output).toContain('"targetPath":"ai-coding"');
    expect(output).toMatch(/"preconditionSha256":"[a-f0-9]{64}"/);
    expect(output).toContain('"targetOccupancy":"unoccupied"');
    expect(output).toContain('"auditCompleteness":"completed"');
    expect(output).not.toMatch(/consent|claim|receipt|effectVerification|postAudit/i);
    expect(data?.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data?.summarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(text).toContain(data?.planSha256 ?? "");
    expect(text).toContain(data?.summarySha256 ?? "");
    expect(text).toContain("ai-coding");
    expect(text).toContain(data?.preconditionSha256 ?? "");
    expect(text).toContain("Target occupancy: unoccupied");
    expect(text).toContain("Audit completeness: completed");
    expect(text).not.toMatch(/consent|claim|receipt|effectVerification|postAudit/i);
  });

  it("derives one live canonical plan on a temporary root despite an unrelated diagnostic refusal", async () => {
    vi.spyOn(policyEvaluateCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "unrelated policy diagnostic",
          kind: "probe" as const,
          run: async () => ({
            code: "org-policy.invalid",
            name: "unrelated-policy-check",
            verdict: "skip" as const,
          }),
        },
      ],
      capability: "policy evaluate",
    });

    const result = await executeGovernanceDoctorRepairCommandV1(context());
    const data = result.digests[0]?.data as Record<string, unknown> | undefined;

    expect(result.report?.exitCode()).toBe(0);
    expect(data).toMatchObject({
      auditCompleteness: "partial",
      targetPath: CANONICAL_CONTEXT_DIR,
      targetOccupancy: "unoccupied",
    });
    expect(data?.preconditionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data?.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data?.summarySha256).toMatch(/^[a-f0-9]{64}$/);
    assertUnaffectedFixture(result);
  });

  it("refuses a hostile multi-effect canonical result before preview, prompt, claim, or effect", async () => {
    const hostilePlan = await repairFixturePlan({
      effects: [
        {
          arguments: { path: CANONICAL_CONTEXT_DIR },
          effectId: "ensure-canonical-context-dir",
          templateId: "ensure-canon-directory",
        },
        {
          arguments: { path: "other-managed-file" },
          effectId: "normalize-other-managed-file",
          templateId: "normalize-canon-endings",
        },
      ],
      root,
      scopePaths: [CANONICAL_CONTEXT_DIR, "other-managed-file"],
    });
    repairInterposition.canonicalPlan = {
      auditCompleteness: "completed",
      kind: "plan",
      plan: hostilePlan,
      preconditionSha256: "a".repeat(64),
      summary: governanceDoctorRepairEffectSummaryV1(hostilePlan),
      targetOccupancy: "unoccupied",
    };

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    assertUnaffectedFixture(result);
    expect(result.digests[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "repair-plan-unavailable",
    });
    expect(confirmation.prompt).not.toHaveBeenCalled();
  });

  it("requires live interactive exact-digest consent before the staged attempt, then verifies and post-audits", async () => {
    const callerPrompter = { ask: vi.fn(async () => "caller supplied digest") };
    const doctor = vi.spyOn(doctorCommand, "plan");
    const policy = vi.spyOn(policyEvaluateCommand, "plan");

    const result = await executeGovernanceDoctorRepairCommandV1(
      context({ apply: true, prompter: callerPrompter }),
    );
    const output = rendered(result);

    expect(confirmation.prompt).toHaveBeenCalledTimes(1);
    expect(callerPrompter.ask).not.toHaveBeenCalled();
    // A pre-attempt audit and an independent fresh post-audit are both required.
    expect(doctor).toHaveBeenCalledTimes(2);
    expect(policy).toHaveBeenCalledTimes(2);
    expect(result.applied).toBe(true);
    expect(claimFiles()).toHaveLength(1);
    expect(readdirSync(root).sort()).toEqual([".aih-config.json", CANONICAL_CONTEXT_DIR]);
    expect(readdirSync(join(root, CANONICAL_CONTEXT_DIR))).toEqual([]);
    expect(result.writes).toContainEqual({
      describe: "create canonical managed directory",
      effect: "create",
      merged: false,
      path: CANONICAL_CONTEXT_DIR,
    });
    expect(summarizeResult(result)).toContain("Applied repair");
    expect(output).toContain('"effectVerification":"verified"');
    expect(output).toContain('"postAuditState":"healthy"');
    expect(output).toContain('"repairState":"complete"');
    expect(output).not.toContain(root);
    const text = digestText(result);
    expect(text).toMatch(/effectVerification\s*[:=]\s*["']?verified\b/i);
    expect(text).toMatch(/postAuditState\s*[:=]\s*["']?healthy\b/i);
    expect(text).toMatch(/repairState\s*[:=]\s*["']?complete\b/i);
  });

  it("reports a verified effect with an unrelated partial post-audit as qualified success", async () => {
    vi.spyOn(policyEvaluateCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "unrelated policy diagnostic",
          kind: "probe" as const,
          run: async () => ({
            code: "org-policy.invalid",
            name: "unrelated-policy-check",
            verdict: "skip" as const,
          }),
        },
      ],
      capability: "policy evaluate",
    });

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));
    const data = result.digests[0]?.data as Record<string, unknown> | undefined;

    expect(result.report?.exitCode()).toBe(0);
    expect(result.applied).toBe(true);
    expect(data).toMatchObject({
      effectVerification: "verified",
      postAuditState: "partial",
      repairState: "partial",
      targetPath: CANONICAL_CONTEXT_DIR,
    });
    expect(digestText(result)).toContain("repairState: partial");
    expect(claimFiles()).toHaveLength(1);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(true);
  });

  it("keeps a healthy bare run as a clean no-mechanical-repair preview", async () => {
    confirmation.prompt.mockClear();
    mkdirSync(join(root, CANONICAL_CONTEXT_DIR), { recursive: true });
    vi.spyOn(doctorCommand, "plan").mockImplementation(() => ({
      actions: [
        {
          describe: "doctor diagnostic",
          kind: "probe" as const,
          run: async () => HEALTHY,
        },
      ],
      capability: "doctor",
    }));

    const result = await executeGovernanceDoctorRepairCommandV1(context());

    expect(result.report?.exitCode()).toBe(0);
    expect(result.digests[0]?.data).toMatchObject({
      outcome: "no-mechanical-repair",
      targetOccupancy: "occupied",
    });
    expect(confirmation.prompt).not.toHaveBeenCalled();
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(true);
    expect(result.applied).toBe(false);
  });

  it("refuses apply before prompt, claim, or effect when no mechanical finding exists", async () => {
    confirmation.prompt.mockClear();
    mkdirSync(join(root, CANONICAL_CONTEXT_DIR), { recursive: true });
    vi.spyOn(doctorCommand, "plan").mockImplementation(() => ({
      actions: [
        {
          describe: "doctor diagnostic",
          kind: "probe" as const,
          run: async () => HEALTHY,
        },
      ],
      capability: "doctor",
    }));

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.digests[0]?.data).toMatchObject({ outcome: "refused" });
    expect(confirmation.prompt).not.toHaveBeenCalled();
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(true);
    expect(result.applied).toBe(false);
  });

  it("qualifies indeterminate target occupancy in dry-run and refuses apply before prompt or claim", async () => {
    repairInterposition.canonicalPlan = {
      auditCompleteness: "evidence-gap",
      kind: "target-occupancy-indeterminate",
      preconditionSha256: "d".repeat(64),
      targetOccupancy: "indeterminate",
    };

    const dryRun = await executeGovernanceDoctorRepairCommandV1(context());
    expect(dryRun.report?.exitCode()).toBe(1);
    expect(dryRun.digests[0]?.data).toMatchObject({
      auditCompleteness: "evidence-gap",
      outcome: "target-occupancy-indeterminate",
      preconditionSha256: "d".repeat(64),
      targetOccupancy: "indeterminate",
    });
    expect(digestText(dryRun)).toContain(`Precondition SHA-256: ${"d".repeat(64)}`);
    expect(digestText(dryRun)).toContain("Target occupancy: indeterminate");
    expect(digestText(dryRun)).toContain("Audit completeness: evidence-gap");
    assertUnaffectedFixture(dryRun);

    const apply = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));
    expect(apply.report?.exitCode()).toBe(1);
    expect(apply.digests[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "repair-target-occupancy-indeterminate",
    });
    expect(confirmation.prompt).not.toHaveBeenCalled();
    assertUnaffectedFixture(apply);
  });

  it("refuses an occupied canonical target before prompt, claim, or effect", async () => {
    writeFileSync(join(root, CANONICAL_CONTEXT_DIR), "operator-owned");

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.digests[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "repair-no-mechanical-repair",
    });
    expect(confirmation.prompt).not.toHaveBeenCalled();
    expect(claimFiles()).toEqual([]);
    expect(readFileSync(join(root, CANONICAL_CONTEXT_DIR), "utf8")).toBe("operator-owned");
    expect(result.applied).toBe(false);
  });

  it("refuses non-authoritative apply paths before prompt, consent, claim, or effect", async () => {
    const cases: readonly {
      readonly label: string;
      readonly ctx: () => PlanContext;
      readonly confirmation?: (input: ConfirmationInput) => unknown;
    }[] = [
      {
        label: "AIH_NO_PROMPT",
        ctx: () => context({ apply: true, env: { AIH_NO_PROMPT: "1" } }),
      },
      {
        label: "stdin or stdout is not a TTY",
        ctx: () => context({ apply: true }),
        confirmation: () => ({ kind: "non-interactive" }),
      },
      {
        label: "environment confirmation token",
        ctx: () => context({ apply: true, env: { AIH_REPAIR_CONFIRM: "a".repeat(64) } }),
        confirmation: () => ({ kind: "non-interactive" }),
      },
      {
        label: "file confirmation token",
        ctx: () => context({ apply: true, options: { confirmationFile: "repair-token.txt" } }),
        confirmation: () => ({ kind: "non-interactive" }),
      },
      {
        label: "caller confirmation callback",
        ctx: () => context({ apply: true, options: { confirm: () => "a".repeat(64) } }),
        confirmation: () => ({ kind: "non-interactive" }),
      },
      { label: "JSON apply", ctx: () => context({ apply: true, json: true }) },
      { label: "--yes", ctx: () => context({ apply: true, options: { yes: true } }) },
      {
        label: "EOF or blank",
        ctx: () => context({ apply: true }),
        confirmation: () => ({ answer: "", kind: "answered" }),
      },
      {
        label: "timeout",
        ctx: () => context({ apply: true }),
        confirmation: () => ({ kind: "timeout" }),
      },
      {
        label: "cancel or Ctrl-C",
        ctx: () => context({ apply: true }),
        confirmation: () => ({ kind: "cancelled" }),
      },
      {
        label: "y",
        ctx: () => context({ apply: true }),
        confirmation: () => ({ answer: "y", kind: "answered" }),
      },
      {
        label: "yes",
        ctx: () => context({ apply: true }),
        confirmation: () => ({ answer: "yes", kind: "answered" }),
      },
      {
        label: "uppercase digest",
        ctx: () => context({ apply: true }),
        confirmation: (input) => ({
          answer: input.plan.planSha256.toUpperCase(),
          kind: "answered",
        }),
      },
      {
        label: "wrong digest",
        ctx: () => context({ apply: true }),
        confirmation: () => ({ answer: "0".repeat(64), kind: "answered" }),
      },
      {
        label: "summary digest",
        ctx: () => context({ apply: true }),
        confirmation: (input) => ({ answer: input.summary.summarySha256, kind: "answered" }),
      },
      {
        label: "digest with trailing token",
        ctx: () => context({ apply: true }),
        confirmation: (input) => ({ answer: `${input.plan.planSha256} extra`, kind: "answered" }),
      },
    ];

    for (const testCase of cases) {
      confirmation.prompt.mockImplementation(
        async (input: ConfirmationInput) =>
          testCase.confirmation?.(input) ?? { answer: input.plan.planSha256, kind: "answered" },
      );
      const result = await executeGovernanceDoctorRepairCommandV1(testCase.ctx());
      assertUnaffectedFixture(result);
    }
  }, 5_000);

  it("bounds a rejected confirmation as a refusal without exposing its error", async () => {
    confirmation.prompt.mockRejectedValueOnce(
      new Error("confirmation leaked C:/private/repo/path"),
    );

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    assertUnaffectedFixture(result);
    expect(result.digests[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "confirmation-refused",
    });
    expect(rendered(result)).not.toContain("C:/private/repo/path");
  });

  it("reports a post-claim refusal as incomplete with a spent claim and no repair effect", async () => {
    repairInterposition.afterClaim = () => {
      mkdirSync(join(root, CANONICAL_CONTEXT_DIR));
    };

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.applied).toBe(true);
    expect(result.digests[0]?.data).toMatchObject({
      claimState: "spent",
      effectApplied: false,
      effectState: "not-applied",
      outcome: "failed",
      repairState: "failed",
      reason: "repair-incomplete-after-claim",
    });
    expect(claimFiles()).toHaveLength(1);
    expect(readdirSync(join(root, CANONICAL_CONTEXT_DIR))).toEqual([]);
    expect(result.writes).toEqual([
      {
        describe: "spend durable repair claim",
        effect: "create",
        merged: false,
        path: "<local repair claim store>",
      },
    ]);
    expect(rendered(result)).not.toContain(root);
  });

  it("reports an exclusive-create short write as spent with no target effect", async () => {
    repairInterposition.claimWriteStalls = true;

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.applied).toBe(true);
    expect(result.digests[0]?.data).toMatchObject({
      claimState: "spent",
      effectApplied: false,
      effectState: "not-applied",
      outcome: "failed",
      reason: "repair-incomplete-after-claim",
      repairState: "failed",
    });
    expect(claimFiles()).toHaveLength(1);
    expect(
      readFileSync(join(repairFixtureClaimStoreDirectory(home.path), claimFiles()[0] ?? "")),
    ).toEqual(Buffer.alloc(0));
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(false);
    expect(result.writes).toEqual([
      {
        describe: "spend durable repair claim",
        effect: "create",
        merged: false,
        path: "<local repair claim store>",
      },
    ]);
    expect(rendered(result)).not.toContain(root);
  });

  it("reports an executor failure after claim as effect-unknown without a target write", async () => {
    repairInterposition.executorThrows = true;

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.applied).toBe(true);
    expect(result.digests[0]?.data).toMatchObject({
      claimState: "spent",
      effectState: "unknown",
      outcome: "failed",
      reason: "repair-incomplete-after-claim",
      repairState: "failed",
    });
    expect(result.digests[0]?.data).not.toHaveProperty("effectApplied");
    expect(claimFiles()).toHaveLength(1);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(false);
    expect(result.writes).toEqual([
      {
        describe: "spend durable repair claim",
        effect: "create",
        merged: false,
        path: "<local repair claim store>",
      },
    ]);
    expect(rendered(result)).not.toContain(root);
  });

  it("reports a pre-claim stale observation as refused with no spent claim", async () => {
    confirmation.prompt.mockImplementation(async (input: ConfirmationInput) => {
      mkdirSync(join(root, CANONICAL_CONTEXT_DIR));
      return { answer: input.plan.planSha256, kind: "answered" };
    });

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.applied).toBe(false);
    expect(result.digests[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "precondition-ineligible",
    });
    expect(claimFiles()).toEqual([]);
    expect(readdirSync(root).sort()).toEqual([".aih-config.json", CANONICAL_CONTEXT_DIR]);
    expect(result.writes).toEqual([]);
    expect(rendered(result)).not.toContain(root);
  });

  it("bounds post-effect exceptions while preserving effect and completion facts", async () => {
    repairInterposition.verifierThrows = true;

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.applied).toBe(true);
    expect(result.digests[0]?.data).toMatchObject({
      claimState: "spent",
      effectApplied: true,
      effectVerification: "unverified",
      outcome: "failed",
      postAuditState: "unavailable",
      repairState: "failed",
      targetPath: CANONICAL_CONTEXT_DIR,
    });
    expect(claimFiles()).toHaveLength(1);
    expect(readdirSync(root).sort()).toEqual([".aih-config.json", CANONICAL_CONTEXT_DIR]);
    expect(result.writes).toContainEqual({
      describe: "create canonical managed directory",
      effect: "create",
      merged: false,
      path: CANONICAL_CONTEXT_DIR,
    });
    expect(rendered(result)).not.toContain("C:/private/repo/path");
    expect(rendered(result)).not.toContain(root);
  });

  it("reports an indeterminate effect-change probe as incomplete without a target write", async () => {
    repairInterposition.effectChangeThrows = true;

    const result = await executeGovernanceDoctorRepairCommandV1(context({ apply: true }));

    expect(result.report?.exitCode()).toBe(1);
    expect(result.applied).toBe(true);
    expect(result.digests[0]?.data).toMatchObject({
      claimState: "spent",
      effectApplied: true,
      effectChangeState: "unknown",
      outcome: "failed",
      repairState: "failed",
      targetPath: CANONICAL_CONTEXT_DIR,
    });
    expect(claimFiles()).toHaveLength(1);
    expect(readdirSync(root).sort()).toEqual([".aih-config.json", CANONICAL_CONTEXT_DIR]);
    expect(result.writes).toEqual([
      {
        describe: "spend durable repair claim",
        effect: "create",
        merged: false,
        path: "<local repair claim store>",
      },
    ]);
    expect(rendered(result)).not.toContain("C:/private/repo/path");
    expect(rendered(result)).not.toContain(root);
  });

  it("uses the 7a staged attempt rather than the generic one-shot executor", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/governance-doctor/repair-command-v1.ts"),
      "utf8",
    );
    expect(source).toContain("attemptGovernanceDoctorRepairV1");
    expect(source).toContain("verifyGovernanceDoctorRepairV1");
    expect(source).toContain("promptGovernanceDoctorRepairConfirmationV1");
    expect(source).toContain("local-tty-confirmation:v1");
    expect(source).not.toContain('"0".repeat(64)');
    expect(source).not.toContain("ctx.prompter");
    expect(source).not.toContain("executeGovernanceDoctorRepairV1");
  });
});
