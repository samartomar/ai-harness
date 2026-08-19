import { existsSync, readFileSync } from "node:fs";
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
  GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
  mintGovernanceDoctorRepairEligibilityV1,
} from "../../src/governance-doctor/repair-eligibility-v1.js";
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

function stubbedProbe(output: Record<string, unknown>) {
  return {
    actions: [
      {
        describe: "diagnostic",
        kind: "probe" as const,
        run: async () => output as never,
      },
    ],
  };
}

const HEALTHY = { name: "diagnostic", verdict: "pass" };
/** The exact tuple `aih doctor` reports when the canonical context dir is absent. */
const CONTEXT_DIR_MISSING = {
  code: "canon.context-dir-missing",
  detail: "ai-coding not scaffolded - run: aih scaffold --apply",
  name: "context-dir",
  verdict: "skip",
};

/** Both code-owned planners are stubbed, so no diagnostic ever inspects this checkout. */
async function operation(
  overrides: Record<string, unknown> = {},
  doctorCheck: Record<string, unknown> = HEALTHY,
  // Makes the policy planner fail, which the adapter turns into that
  // diagnostic's evidence gap. The Doctor diagnostic is unaffected, because the
  // finding mapping is all-or-nothing per diagnostic.
  policyUnavailable = false,
): Promise<GovernanceDoctorOperationV1> {
  const doctorPlan = vi
    .spyOn(doctorCommand, "plan")
    .mockReturnValue({ ...stubbedProbe(doctorCheck), capability: "doctor" });
  const policyPlan = vi.spyOn(policyEvaluateCommand, "plan").mockImplementation(() => {
    if (policyUnavailable) throw new Error("policy planner unavailable");
    return { ...stubbedProbe(HEALTHY), capability: "policy evaluate" };
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
  // Default for the outcomes that never reach an audited result at all.
  auditCompleteness: null,
  effects: [],
  executable: false,
  expiresAtEpochMs: null,
  notice: GOVERNANCE_DOCTOR_REPAIR_PREVIEW_NOTICE_V1,
  planSha256: null,
  protocol: "GovernanceDoctorRepairPlanPreviewV1",
  recipeId: null,
  summarySha256: null,
};

/** The record the trusted command boundary mints for this run's own root. */
function eligibilityFor(built: GovernanceDoctorOperationV1) {
  return mintGovernanceDoctorRepairEligibilityV1(
    GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
    GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
    built.record.rootSha256,
  );
}

describe("presentGovernanceDoctorRepairPlanPreviewV1", () => {
  it("reports no-mechanical-repair for a completed healthy audit, minting nothing", async () => {
    const built = await operation();
    const previewed = presentGovernanceDoctorRepairPlanPreviewV1({
      eligibility: eligibilityFor(built),
      operation: built,
      profile: profile(),
    });

    // No repair to plan, and the audit saw everything -- the two facts are
    // reported separately so neither implies the other.
    expect(previewed).toEqual({
      ...NULL_PLAN_FIELDS,
      auditCompleteness: "completed",
      outcome: "no-mechanical-repair",
    });
    expect(Object.isFrozen(previewed)).toBe(true);
  });

  it("reports unavailable for a refused audit and for a run that produced none", async () => {
    const denied = await operation({
      policy: { decision: "denied", revisionSha256: policyRevisionSha256 },
    });
    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility: eligibilityFor(denied),
        operation: denied,
        profile: profile(),
      }),
    ).toEqual({ ...NULL_PLAN_FIELDS, outcome: "unavailable" });

    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility: undefined,
        operation: undefined,
        profile: undefined,
      }),
    ).toEqual({ ...NULL_PLAN_FIELDS, outcome: "unavailable" });
  });

  it("reports posture-unavailable when the profile does not declare guided-only repair", async () => {
    const built = await operation({ profile: profile({ repairPosture: "unavailable" }) });
    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility: eligibilityFor(built),
        operation: built,
        profile: profile({ repairPosture: "unavailable" }),
      }),
    ).toEqual({
      ...NULL_PLAN_FIELDS,
      auditCompleteness: "completed",
      outcome: "posture-unavailable",
    });
  });

  it("collapses malformed, missing-key, and extra-field input into unavailable, throwing nothing", async () => {
    const built = await operation();
    for (const value of [
      null,
      1,
      {},
      { operation: built, profile: profile() },
      { eligibility: eligibilityFor(built), operation: {}, profile: profile() },
      { eligibility: eligibilityFor(built), extra: 1, operation: built, profile: profile() },
    ])
      expect(presentGovernanceDoctorRepairPlanPreviewV1(value)).toEqual({
        ...NULL_PLAN_FIELDS,
        outcome: "unavailable",
      });
  });

  it("collapses a structurally shaped but unbranded operation into unavailable", async () => {
    const built = await operation();
    // A parse of the operation's own facts is byte-identical but carries no
    // module brand: it must never earn even the no-repair label, because a
    // label implies the audit it summarizes was a real one.
    const forged = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility: eligibilityFor(built),
        operation: forged,
        profile: profile(),
      }),
    ).toEqual({ ...NULL_PLAN_FIELDS, outcome: "unavailable" });
  });

  it("never leaks the fixture root, evidence prose, or OS text in any outcome", async () => {
    const built = await operation();
    const rendered = JSON.stringify(
      presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility: eligibilityFor(built),
        operation: built,
        profile: profile(),
      }),
    );
    expect(rendered).not.toContain(FIXTURE_ROOT);
    expect(rendered).not.toContain("Read the bounded result.");
  });
});

/**
 * The one mechanically mappable finding. Its effect path is the module's own
 * code-owned constant; eligibility is a gate on minting, never the source of a
 * path, so no eligible run can produce an effect anywhere but `ai-coding`.
 */
describe("mechanical context-directory preview", () => {
  const CANONICAL = GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1;

  async function eligiblePreview(eligibilityOverride?: unknown) {
    const built = await operation({}, CONTEXT_DIR_MISSING);
    return {
      built,
      previewed: presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility:
          eligibilityOverride === undefined ? eligibilityFor(built) : eligibilityOverride,
        operation: built,
        profile: profile(),
      }),
    };
  }

  it("mints one create-managed-directory effect at the code-owned canonical path", async () => {
    const { previewed } = await eligiblePreview();
    expect(previewed.outcome).toBe("plan");
    expect(previewed.executable).toBe(false);
    expect(previewed.effects).toEqual([
      {
        arguments: { path: CANONICAL },
        effectId: "ensure-canonical-context-dir",
        effectKind: "create-managed-directory",
      },
    ]);
    expect(previewed.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(previewed.recipeId).toBe(GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1);
    expect(JSON.stringify(previewed)).not.toContain(FIXTURE_ROOT);
    // A derived plan says nothing about how much the audit saw, so the preview
    // has to say it separately. Whatever this fixture's audit managed to
    // resolve, the plan must never be the thing that implies completeness.
    expect(previewed.auditCompleteness).toBe("completed");
  });

  /**
   * The combination the execution slice has to keep straight: a real repair is
   * planned, and the audit behind it still did not see the whole workstation.
   * Neither fact cancels the other, and the preview reports both, so nothing
   * downstream can read "a plan exists" as "the workstation is understood".
   */
  it("still reports partial when a plan is derived from a partial audit", async () => {
    const built = await operation({}, CONTEXT_DIR_MISSING, true);
    const previewed = presentGovernanceDoctorRepairPlanPreviewV1({
      eligibility: eligibilityFor(built),
      operation: built,
      profile: profile(),
    });
    expect(previewed.outcome).toBe("plan");
    expect(previewed.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(previewed.auditCompleteness).toBe("partial");
  });

  it("creates no plan when the eligibility record was not minted", async () => {
    const { previewed } = await eligiblePreview(null);
    expect(previewed).toEqual({ ...NULL_PLAN_FIELDS, outcome: "unavailable" });
  });

  it("creates no plan for any hostile substitute for eligibility", async () => {
    const built = await operation({}, CONTEXT_DIR_MISSING);
    const real = eligibilityFor(built);
    if (real === undefined) throw new Error("expected a minted eligibility record");
    const spread = { ...real };
    const accessor: Record<string, unknown> = { ...spread };
    Object.defineProperty(accessor, "markerContextDir", { enumerable: true, get: () => CANONICAL });
    const mismatchedRoot = mintGovernanceDoctorRepairEligibilityV1(
      CANONICAL,
      CANONICAL,
      "b".repeat(64),
    );
    for (const [label, eligibility] of [
      ["plain object", { ...spread }],
      ["spread copy", spread],
      ["proxy", new Proxy(real, {})],
      ["accessor", accessor],
      ["altered brand", { ...spread, protocol: "GovernanceDoctorRepairEligibilityV2" }],
      ["alternate path", { ...spread, markerContextDir: "ai-coding-2" }],
      ["true", true],
      ["raw path", CANONICAL],
      ["callback", () => real],
      ["mismatched root", mismatchedRoot],
    ] as const)
      expect(
        presentGovernanceDoctorRepairPlanPreviewV1({
          eligibility,
          operation: built,
          profile: profile(),
        }),
        label,
      ).toEqual({
        ...NULL_PLAN_FIELDS,
        // A record that is merely wrong for this root leaves the audit itself
        // intact and classified, so the preview still reports what the audit
        // saw. Everything else here is refused before the audit is read, or
        // throws into the closed collapse, and has nothing to classify.
        auditCompleteness: label === "mismatched root" ? "completed" : null,
        outcome: "unavailable",
      });
  });

  it("keeps no-mechanical-repair for a healthy audit even when eligibility holds", async () => {
    const built = await operation();
    expect(
      presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility: eligibilityFor(built),
        operation: built,
        profile: profile(),
      }).outcome,
    ).toBe("no-mechanical-repair");
  });
});

describe("repair plan preview static boundary", () => {
  const sourceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/governance-doctor",
  );

  /**
   * The transitive closure of modules a file actually *loads*.
   *
   * Two properties matter and both were once wrong here. Relative specifiers are
   * resolved against the importing file's own directory and followed whichever
   * direction they point, so a `../` edge out of this package cannot hide a
   * capability the closure is supposed to expose. And `import type` statements
   * are skipped, because they erase at compile time and load nothing -- counting
   * them would report capability the runtime never acquires.
   */
  function loadClosure(file: string, visited = new Set<string>()): readonly string[] {
    if (visited.has(file) || !existsSync(file)) return [];
    visited.add(file);
    const text = readFileSync(file, "utf8");
    const loaded = [...text.matchAll(/import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)].filter(
      (match) => match[1] === undefined,
    );
    return [
      file,
      ...loaded.flatMap((match) => {
        const specifier = match[2] ?? "";
        if (!specifier.startsWith(".")) return [];
        return loadClosure(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")), visited);
      }),
    ];
  }

  function importClosure(entry: string): readonly string[] {
    return loadClosure(resolve(sourceRoot, entry));
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
      // The eligibility record is a gate, never a source of a path: the effect
      // path must come from this module's own constant, so the module never
      // names the record's path fields at all.
      "markerContextDir",
      "resolvedContextDir",
    ])
      expect(source, token).not.toContain(token);
  });

  /** The one value the preview accepts from the command boundary stays pure too. */
  it("keeps its whole import closure free of platform capability", () => {
    for (const file of importClosure("repair-plan-preview-v1.ts")) {
      const text = readFileSync(file, "utf8");
      for (const token of ["node:fs", "node:child_process", "node:os", "node:process"])
        expect(text, `${file} ${token}`).not.toContain(token);
    }
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
