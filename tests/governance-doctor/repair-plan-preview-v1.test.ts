import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import {
  createGovernanceDoctorOperationalContextV1,
  type GovernanceDoctorOperationV1,
  runGovernanceDoctorOperationV1,
} from "../../src/governance-doctor/operational-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";
import {
  GOVERNANCE_DOCTOR_REPAIR_PLAN_PREVIEW_V1_LIMITS,
  GOVERNANCE_DOCTOR_REPAIR_PREVIEW_NOTICE_V1,
  GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1,
  mintGovernanceDoctorRepairPlanPreviewV1,
  presentGovernanceDoctorRepairPlanPreviewV1,
} from "../../src/governance-doctor/repair-plan-preview-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { policyEvaluateCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
/** A synthetic root: no diagnostic is executed, so nothing inspects this checkout. */
const FIXTURE_ROOT = "/tmp/aih-governance-doctor-repair-preview-fixture";
const RULES_PATH = "ai-coding/rules";
const NOW = 1_777_000_000_000;
const policyRevisionSha256 = "b".repeat(64);

function prose(text = "Read the bounded result.") {
  return { attribution: "aih:governance-doctor", text };
}

function profile(overrides: Record<string, unknown> = {}) {
  return createGovernanceDoctorProfileV1({
    conflicts: [
      { conflictId: "other-surface", conflictsWithSurfaceId: "surface:aih.other", note: prose() },
    ],
    diagnosticIds: [DOCTOR, POLICY],
    effectVersion: "1",
    guidance: prose(),
    nextActionId: DOCTOR,
    prerequisites: [{ note: prose(), prerequisiteId: "policy", satisfiedBy: "org-policy" }],
    profileVersion: "1",
    protocol: "GovernanceDoctorProfileV1",
    repairPosture: "guided-only",
    roles: [{ owner: "aih", roleId: "owner", summary: prose() }],
    schemaVersion: "1",
    surfaceId: "surface:aih.governance-doctor",
    targetId: "target:aih.governance-doctor",
    ...overrides,
  });
}

function planContext(): PlanContext {
  const run = vi.fn(async () => ({ code: 0, spawnError: false, stderr: "", stdout: "" }));
  return {
    apply: false,
    contextDir: "ai-coding",
    env: {},
    host: makeHostAdapter({ env: {}, platform: "linux", run }),
    json: false,
    options: {},
    root: FIXTURE_ROOT,
    run,
    verify: true,
  };
}

function stubbedProbe(verdict: "pass" | "fail") {
  return {
    actions: [
      {
        describe: "diagnostic",
        kind: "probe" as const,
        run: async () => ({ name: "diagnostic", verdict }),
      },
    ],
  };
}

/** Both code-owned planners are stubbed, so no diagnostic ever inspects this checkout. */
async function operation(
  overrides: Record<string, unknown> = {},
): Promise<GovernanceDoctorOperationV1> {
  const doctorPlan = vi
    .spyOn(doctorCommand, "plan")
    .mockReturnValue({ ...stubbedProbe("pass"), capability: "doctor" });
  const policyPlan = vi.spyOn(policyEvaluateCommand, "plan").mockReturnValue({
    ...stubbedProbe("pass"),
    capability: "policy evaluate",
  });
  try {
    return await runGovernanceDoctorOperationV1({
      context: createGovernanceDoctorOperationalContextV1(planContext()),
      policy: { decision: "allowed", revisionSha256: policyRevisionSha256 },
      profile: profile(),
      ...overrides,
    });
  } finally {
    doctorPlan.mockRestore();
    policyPlan.mockRestore();
  }
}

const NULL_PLAN_FIELDS = {
  effects: [],
  executable: false,
  expiresAtEpochMs: null,
  notice: GOVERNANCE_DOCTOR_REPAIR_PREVIEW_NOTICE_V1,
  planSha256: null,
  protocol: "GovernanceDoctorRepairPlanPreviewV1",
  recipeId: null,
  summarySha256: null,
};

describe("presentGovernanceDoctorRepairPlanPreviewV1", () => {
  it("reports no-mechanical-repair for a completed healthy audit, minting nothing", async () => {
    const built = await operation();
    const previewed = presentGovernanceDoctorRepairPlanPreviewV1({
      operation: built,
      profile: profile(),
    });

    expect(previewed).toEqual({ ...NULL_PLAN_FIELDS, outcome: "no-mechanical-repair" });
    expect(Object.isFrozen(previewed)).toBe(true);
  });

  it("reports unavailable for a refused audit and for a run that produced none", async () => {
    const denied = await operation({
      policy: { decision: "denied", revisionSha256: policyRevisionSha256 },
    });
    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({ operation: denied, profile: profile() }),
    ).toEqual({ ...NULL_PLAN_FIELDS, outcome: "unavailable" });

    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({ operation: undefined, profile: undefined }),
    ).toEqual({ ...NULL_PLAN_FIELDS, outcome: "unavailable" });
  });

  it("reports posture-unavailable when the profile does not declare guided-only repair", async () => {
    const built = await operation({ profile: profile({ repairPosture: "unavailable" }) });
    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({
        operation: built,
        profile: profile({ repairPosture: "unavailable" }),
      }),
    ).toEqual({ ...NULL_PLAN_FIELDS, outcome: "posture-unavailable" });
  });

  it("collapses malformed and extra-field input into unavailable, throwing nothing", async () => {
    for (const value of [
      null,
      1,
      {},
      { operation: {}, profile: profile() },
      { extra: 1, operation: await operation(), profile: profile() },
    ])
      expect(presentGovernanceDoctorRepairPlanPreviewV1(value)).toEqual({
        ...NULL_PLAN_FIELDS,
        outcome: "unavailable",
      });
  });

  it("never leaks the fixture root, evidence prose, or OS text in any outcome", async () => {
    const rendered = JSON.stringify(
      presentGovernanceDoctorRepairPlanPreviewV1({
        operation: await operation(),
        profile: profile(),
      }),
    );
    expect(rendered).not.toContain(FIXTURE_ROOT);
    expect(rendered).not.toContain("Read the bounded result.");
  });
});

describe("repair plan preview static boundary", () => {
  const sourceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/governance-doctor",
  );

  /** Transitive local import closure, same specifier grammar as the module graph. */
  function importClosure(entry: string, visited = new Set<string>()): readonly string[] {
    const source = resolve(sourceRoot, entry);
    if (visited.has(source)) return [];
    visited.add(source);
    const text = readFileSync(source, "utf8");
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
    return [
      source,
      ...imports.flatMap((specifier) => {
        if (!specifier.startsWith("./")) return [];
        return importClosure(specifier.replace(/^\.\//, "").replace(/\.js$/, ".ts"), visited);
      }),
    ];
  }

  /**
   * The preview module is the one bridge from the CLI into the Repair
   * foundation, so it carries its own purity rules: the only platform module it
   * may load is `node:crypto` (the plan nonce), and no dynamic seam, process
   * surface, or filesystem reach may ever appear in it.
   */
  it("loads no platform capability beyond node:crypto and opens no dynamic seam", () => {
    const source = readFileSync(resolve(sourceRoot, "repair-plan-preview-v1.ts"), "utf8");
    for (const token of [
      "node:fs",
      "node:child_process",
      "node:net",
      "node:http",
      "node:os",
      "node:process",
      "process.env",
      "process.argv",
      "require(",
      "import(",
      "eval",
      "new Function",
      "globalThis",
      "PlanContext",
      "CommandSpec",
    ])
      expect(source, token).not.toContain(token);
  });

  /**
   * The command route's whole transitive closure must never reach the
   * execution half of the foundation. A new intra-foundation edge -- say the
   * plan module importing the executor -- would be invisible to a direct-text
   * check on the command file, so the closure itself is the assertion.
   */
  it("keeps the executor half of the foundation out of the command route's closure", () => {
    const closure = importClosure("command-v1.ts").map((file) => file.replace(/\\/g, "/"));
    for (const excluded of [
      "repair-claim-store-v1.ts",
      "repair-claim-v1.ts",
      "repair-consent-v1.ts",
      "repair-content-v1.ts",
      "repair-custody-v1.ts",
      "repair-executor-v1.ts",
      "repair-verifier-v1.ts",
    ])
      expect(
        closure.some((file) => file.endsWith(excluded)),
        excluded,
      ).toBe(false);
    expect(closure.some((file) => file.endsWith("repair-plan-preview-v1.ts"))).toBe(true);
    expect(closure.some((file) => file.endsWith("repair-plan-v1.ts"))).toBe(true);
  });
});

describe("mintGovernanceDoctorRepairPlanPreviewV1", () => {
  it("mints and presents a bounded plan from code-derived effects only", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const built = await operation();
      const previewed = mintGovernanceDoctorRepairPlanPreviewV1(built, profile(), {
        effects: [
          {
            arguments: { path: RULES_PATH },
            effectId: "ensure-rules-directory",
            templateId: "ensure-managed-directory",
          },
        ],
        scopePaths: [RULES_PATH],
      });

      expect(previewed.outcome).toBe("plan");
      expect(previewed.executable).toBe(false);
      expect(previewed.planSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(previewed.summarySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(previewed.recipeId).toBe(GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1);
      expect(previewed.expiresAtEpochMs).toBe(
        NOW + GOVERNANCE_DOCTOR_REPAIR_PLAN_PREVIEW_V1_LIMITS.expiryWindowMs,
      );
      expect(previewed.effects).toEqual([
        {
          arguments: { path: RULES_PATH },
          effectId: "ensure-rules-directory",
          effectKind: "create-managed-directory",
        },
      ]);
      expect(previewed.notice).toBe(GOVERNANCE_DOCTOR_REPAIR_PREVIEW_NOTICE_V1);
      expect(Object.isFrozen(previewed)).toBe(true);
      expect(JSON.stringify(previewed)).not.toContain(FIXTURE_ROOT);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses derived effects the frozen recipe cannot join rather than presenting them", async () => {
    const built = await operation();
    expect(() =>
      mintGovernanceDoctorRepairPlanPreviewV1(built, profile(), {
        effects: [
          {
            arguments: { path: RULES_PATH },
            effectId: "outside-template",
            templateId: "absent-template",
          },
        ],
        scopePaths: [RULES_PATH],
      }),
    ).toThrow(TypeError);
  });
});
