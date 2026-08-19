import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import {
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES,
  governanceDoctorSha256V1,
} from "../../src/governance-doctor/capability-v1.js";
import {
  canonicalGovernanceDoctorOperationV1Bytes,
  createGovernanceDoctorOperationalContextV1,
  GOVERNANCE_DOCTOR_READ_ONLY_SURFACE_REVISION_V1,
  runGovernanceDoctorOperationV1,
} from "../../src/governance-doctor/operational-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { policyEvaluateCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { legacyChecksToVerificationRun } from "../../src/verification/legacy.js";

const root = resolve(__dirname, "..", "..");
const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
const STATUS = "aih.status.root";
const policyRevisionSha256 = createHash("sha256").update("policy").digest("hex");
const source = readFileSync(resolve(root, "src/governance-doctor/operational-v1.ts"), "utf8");

function prose(text = "Read the bounded result.") {
  return { attribution: "aih:governance-doctor", text };
}

function profile(overrides: Record<string, unknown> = {}) {
  return createGovernanceDoctorProfileV1({
    conflicts: [
      {
        conflictId: "other-surface",
        conflictsWithSurfaceId: "surface:aih.other",
        note: prose(),
      },
    ],
    diagnosticIds: [DOCTOR, POLICY],
    effectVersion: "1",
    guidance: prose(),
    nextActionId: DOCTOR,
    prerequisites: [
      { note: prose(), prerequisiteId: "policy", satisfiedBy: "org-policy" as const },
    ],
    profileVersion: "1",
    protocol: "GovernanceDoctorProfileV1" as const,
    repairPosture: "guided-only" as const,
    roles: [{ owner: "aih" as const, roleId: "owner", summary: prose() }],
    schemaVersion: "1",
    surfaceId: "surface:aih.governance-doctor",
    targetId: "target:aih.governance-doctor",
    ...overrides,
  });
}

function planContext(overrides: Partial<PlanContext> = {}): PlanContext {
  const run = vi.fn(async () => ({ code: 0, spawnError: false, stderr: "", stdout: "" }));
  return {
    apply: false,
    contextDir: "ai-coding",
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

async function operation(overrides: Record<string, unknown> = {}) {
  return await runGovernanceDoctorOperationV1({
    context: createGovernanceDoctorOperationalContextV1(planContext()),
    policy: { decision: "allowed" as const, revisionSha256: policyRevisionSha256 },
    profile: profile(),
    ...overrides,
  });
}

describe("GovernanceDoctor operational read-only adapter", () => {
  it("calls the exact fixed doctor and policy planners, runs probes in table order, and leaves unimplemented frozen IDs missing", async () => {
    const order: string[] = [];
    const doctorProbe = vi.fn(async () => {
      order.push("doctor-probe");
      return { name: "doctor", verdict: "pass" as const };
    });
    const policyProbe = vi.fn(async () => {
      order.push("policy-probe");
      return { name: "policy", verdict: "pass" as const };
    });
    const doctorPlan = vi.spyOn(doctorCommand, "plan").mockImplementation((context) => {
      order.push("doctor-plan");
      expect(context).toMatchObject({ apply: false, json: true, options: {}, verify: true });
      return {
        actions: [{ describe: "doctor", kind: "probe", run: doctorProbe }],
        capability: "doctor",
      };
    });
    const policyPlan = vi.spyOn(policyEvaluateCommand, "plan").mockImplementation((context) => {
      order.push("policy-plan");
      expect(context).toMatchObject({ apply: false, json: true, options: {}, verify: true });
      return {
        actions: [{ describe: "policy", kind: "probe", run: policyProbe }],
        capability: "policy evaluate",
      };
    });
    const result = await operation();
    expect(doctorPlan).toHaveBeenCalledTimes(1);
    expect(policyPlan).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["doctor-plan", "doctor-probe", "policy-plan", "policy-probe"]);
    expect(result.record.kind).toBe("completed");
    if (result.record.kind !== "completed") throw new Error("expected completed record");
    if (result.audit.kind !== "audited") throw new Error("expected audited result");
    expect(result.record.dispatchedDiagnosticIds).toEqual([DOCTOR, POLICY]);
    expect(result.audit.refusals).toEqual([]);
    doctorPlan.mockRestore();
    policyPlan.mockRestore();
  });

  it("derives missing-adapter only for a declared frozen ID with no code-owned adapter", async () => {
    const plan = vi.spyOn(doctorCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "doctor",
          kind: "probe",
          run: async () => ({ name: "doctor", verdict: "pass" as const }),
        },
      ],
      capability: "doctor",
    });
    const result = await operation({ profile: profile({ diagnosticIds: [DOCTOR, STATUS] }) });
    if (result.audit.kind !== "audited") throw new Error("expected audited result");
    expect(result.audit.refusals).toEqual([{ diagnosticId: STATUS, state: "missing-adapter" }]);
    plan.mockRestore();
  });

  it("snapshots an allowlisted context before branding and passes that exact sanitized snapshot to planning and probes", async () => {
    const original = planContext({
      json: false,
      options: { "attest-mcp-pins": true, "check-pin-currency": true },
      posture: "vibe",
      postureSource: "default",
      targets: ["claude"],
    });
    const expectedRootSha256 = governanceDoctorSha256V1(
      "aih.governance-doctor-operational-root-v1",
      {
        contextDir: original.contextDir,
        root: original.root,
      },
    );
    const trusted = createGovernanceDoctorOperationalContextV1(original);
    original.contextDir = "attacker-context";
    original.json = false;
    original.options = { "attest-mcp-pins": true };
    original.posture = "enterprise";
    original.postureSource = "marker";
    original.root = `${root}-attacker`;
    original.targets = ["kiro"];
    let plannedContext: PlanContext | undefined;
    let probeContext: PlanContext | undefined;
    const plan = vi.spyOn(doctorCommand, "plan").mockImplementation((context) => {
      plannedContext = context;
      return {
        actions: [
          {
            describe: "doctor",
            kind: "probe",
            run: async (probeCtx) => {
              probeContext = probeCtx;
              return { name: "doctor", verdict: "pass" as const };
            },
          },
        ],
        capability: "doctor",
      };
    });
    const result = await runGovernanceDoctorOperationV1({
      context: trusted,
      policy: { decision: "allowed", revisionSha256: policyRevisionSha256 },
      profile: profile({ diagnosticIds: [DOCTOR] }),
    });
    expect(result.record.rootSha256).toBe(expectedRootSha256);
    expect(probeContext).toBe(plannedContext);
    expect(plannedContext).toMatchObject({
      apply: false,
      contextDir: "ai-coding",
      json: true,
      options: {},
      posture: "vibe",
      postureSource: "default",
      root,
      verify: true,
    });
    expect(plannedContext).not.toHaveProperty("targets");
    expect(plannedContext).not.toHaveProperty("plannedMcpServers");
    expect(Object.isFrozen(plannedContext)).toBe(true);
    expect(Object.isFrozen(plannedContext?.env)).toBe(true);
    plan.mockRestore();
  });

  it("rejects a proxied operational context before any getter runs", () => {
    const get = vi.fn(() => {
      throw new Error("getter must not run");
    });
    const hostile = new Proxy(planContext(), { get }) as PlanContext;
    expect(() => createGovernanceDoctorOperationalContextV1(hostile)).toThrow(TypeError);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects accessor-bearing context, host, and environment records before reading them", () => {
    const topLevelGet = vi.fn(() => {
      throw new Error("top-level getter must not run");
    });
    const topLevel = { ...planContext() } as Record<string, unknown>;
    Object.defineProperty(topLevel, "apply", { configurable: true, get: topLevelGet });
    expect(() =>
      createGovernanceDoctorOperationalContextV1(topLevel as unknown as PlanContext),
    ).toThrow(TypeError);
    expect(topLevelGet).not.toHaveBeenCalled();

    const hostGet = vi.fn(() => {
      throw new Error("host getter must not run");
    });
    const accessorHost = planContext().host;
    Object.defineProperty(accessorHost, "platform", { configurable: true, get: hostGet });
    expect(() =>
      createGovernanceDoctorOperationalContextV1(planContext({ host: accessorHost })),
    ).toThrow(TypeError);
    expect(hostGet).not.toHaveBeenCalled();

    const envGet = vi.fn(() => {
      throw new Error("environment getter must not run");
    });
    const accessorEnv = {} as NodeJS.ProcessEnv;
    Object.defineProperty(accessorEnv, "SAFE", {
      configurable: true,
      enumerable: true,
      get: envGet,
    });
    expect(() =>
      createGovernanceDoctorOperationalContextV1(planContext({ env: accessorEnv })),
    ).toThrow(TypeError);
    expect(envGet).not.toHaveBeenCalled();

    const hostGetProxy = vi.fn(() => {
      throw new Error("host proxy getter must not run");
    });
    const environmentGetProxy = vi.fn(() => {
      throw new Error("environment proxy getter must not run");
    });
    const proxiedHost = new Proxy(planContext().host, { get: hostGetProxy });
    const proxiedEnvironment = new Proxy({}, { get: environmentGetProxy }) as NodeJS.ProcessEnv;
    expect(() =>
      createGovernanceDoctorOperationalContextV1(planContext({ host: proxiedHost })),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorOperationalContextV1(planContext({ env: proxiedEnvironment })),
    ).toThrow(TypeError);
    expect(hostGetProxy).not.toHaveBeenCalled();
    expect(environmentGetProxy).not.toHaveBeenCalled();
  });

  it("accepts the production process environment and host adapter through descriptor snapshots", () => {
    expect(() =>
      createGovernanceDoctorOperationalContextV1(planContext({ env: process.env })),
    ).not.toThrow();
  });

  it("has no caller-authored observation, callback, command, or path field", async () => {
    const trusted = createGovernanceDoctorOperationalContextV1(planContext());
    for (const extra of [
      { observations: [] },
      { callback: () => undefined },
      { command: ["status"] },
      { path: root },
    ])
      await expect(
        runGovernanceDoctorOperationV1({
          context: trusted,
          policy: { decision: "allowed", revisionSha256: policyRevisionSha256 },
          profile: profile(),
          ...extra,
        }),
      ).rejects.toThrow(TypeError);
  });

  it("does not consult the fixed command plan for denied or incompatible profiles", async () => {
    const doctorPlan = vi.spyOn(doctorCommand, "plan");
    const policyPlan = vi.spyOn(policyEvaluateCommand, "plan");
    for (const input of [
      { policy: { decision: "denied", revisionSha256: policyRevisionSha256 } },
      { profile: profile({ schemaVersion: "2" }) },
    ]) {
      const result = await operation(input);
      expect(result.record.kind).toBe("refused");
    }
    expect(doctorPlan).not.toHaveBeenCalled();
    expect(policyPlan).not.toHaveBeenCalled();
    doctorPlan.mockRestore();
    policyPlan.mockRestore();
  });

  it("converts thrown, non-probe, rejected, and hostile probe results into a fixed evidence-gap outcome", async () => {
    for (const planResult of [
      () => {
        throw new Error(`${root} must not escape`);
      },
      () => ({ actions: [{ kind: "write" }] }),
      () => ({ actions: [{ kind: "probe", run: null }] }),
      () => ({
        actions: [
          {
            describe: "probe",
            kind: "probe",
            run: async () => ({ name: "probe", verdict: "pass" }),
          },
        ],
        capability: "policy evaluate",
      }),
      () => ({
        actions: [
          {
            describe: "probe",
            kind: "probe",
            run: async () => Promise.reject(new Error(`${root} hidden`)),
          },
        ],
        capability: "status",
      }),
      () => ({
        actions: [
          {
            describe: "probe",
            kind: "probe",
            run: async () => ({ name: "hostile", raw: `${root} hidden`, verdict: "pass" }),
          },
        ],
        capability: "status",
      }),
      () => ({
        actions: Array.from({ length: 65 }, () => ({
          describe: "too-many",
          kind: "probe",
          run: async () => ({ name: "too-many", verdict: "pass" }),
        })),
        capability: "status",
      }),
    ]) {
      const plan = vi.spyOn(doctorCommand, "plan").mockImplementation(planResult as never);
      const result = await operation({ profile: profile({ diagnosticIds: [DOCTOR] }) });
      if (result.audit.kind !== "audited") throw new Error("expected audited result");
      expect(result.audit.refusals).toEqual([{ diagnosticId: DOCTOR, state: "evidence-gap" }]);
      expect(JSON.stringify(result)).not.toContain(root);
      plan.mockRestore();
    }
  });

  it("converts a valid non-pass probe into the fixed evidence-gap outcome without retaining detail", async () => {
    const plan = vi.spyOn(policyEvaluateCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "skip",
          kind: "probe",
          run: async () => ({ detail: `${root} unavailable`, name: "skip", verdict: "skip" }),
        },
      ],
      capability: "policy evaluate",
    });
    const result = await operation({ profile: profile({ diagnosticIds: [POLICY] }) });
    if (result.audit.kind !== "audited") throw new Error("expected audited result");
    expect(result.audit.refusals).toEqual([{ diagnosticId: POLICY, state: "evidence-gap" }]);
    expect(JSON.stringify(result)).not.toContain(root);
    plan.mockRestore();
  });

  it("accepts the closed runMany, structured-legacy, and structured probe variants in executor order", async () => {
    const structured = legacyChecksToVerificationRun([
      { name: "structured", verdict: "pass" as const },
    ]);
    if (structured === undefined) throw new Error("expected structured fixture");
    structured.results[0]?.evidence.push({
      id: "fixture",
      snippet: undefined,
      source: "test",
      type: "fixture",
    });
    const calls: string[] = [];
    const plan = vi.spyOn(doctorCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "many",
          kind: "probe",
          run: async () => ({ name: "unused-many", verdict: "skip" as const }),
          runMany: async () => {
            calls.push("many");
            return [{ name: "many", verdict: "pass" as const }];
          },
        },
        {
          describe: "legacy",
          kind: "probe",
          run: async () => ({ name: "unused-legacy", verdict: "skip" as const }),
          runMany: async () => [{ name: "legacy", verdict: "pass" as const }],
          runStructuredLegacy: async () => {
            calls.push("legacy");
            return {
              reportChecks: [{ name: "legacy", verdict: "pass" as const }],
              verification: structured,
            };
          },
        },
        {
          describe: "structured",
          kind: "probe",
          run: async () => ({ name: "unused-structured", verdict: "skip" as const }),
          runStructured: async () => {
            calls.push("structured");
            return structured;
          },
          structured: {},
        },
      ],
      capability: "doctor",
    });
    const result = await operation({ profile: profile({ diagnosticIds: [DOCTOR] }) });
    if (result.audit.kind !== "audited") throw new Error("expected audited result");
    expect(calls).toEqual(["many", "legacy", "structured"]);
    expect(result.audit.refusals).toEqual([]);
    plan.mockRestore();
  });

  it("maps oversized canonical check output to evidence-gap without retaining nested detail", async () => {
    const plan = vi.spyOn(doctorCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "oversized",
          kind: "probe",
          run: async () => ({
            detail: "x".repeat(9 * 1024),
            location: { uri: "nested".repeat(1024) },
            name: "oversized",
            verdict: "pass" as const,
          }),
        },
      ],
      capability: "doctor",
    });
    const result = await operation({ profile: profile({ diagnosticIds: [DOCTOR] }) });
    if (result.audit.kind !== "audited") throw new Error("expected audited result");
    expect(result.audit.refusals).toEqual([{ diagnosticId: DOCTOR, state: "evidence-gap" }]);
    expect(JSON.stringify(result)).not.toContain("nested");
    plan.mockRestore();
  });

  it("runs the unmocked Doctor plan shape without silently downgrading its code-owned variants", async () => {
    const original = doctorCommand.plan;
    let actionKeys: readonly string[][] = [];
    let runManyCalls = 0;
    let structuredLegacyCalls = 0;
    const plan = vi.spyOn(doctorCommand, "plan").mockImplementation(async (context) => {
      const planned = await original(context);
      actionKeys = planned.actions.map((action) => Object.keys(action).sort());
      for (const action of planned.actions) {
        if (action.kind !== "probe") continue;
        if (action.runMany !== undefined && action.runStructuredLegacy === undefined) {
          const runMany = action.runMany;
          action.runMany = async (probeContext) => {
            runManyCalls += 1;
            return await runMany(probeContext);
          };
        }
        if (action.runStructuredLegacy !== undefined) {
          const runStructuredLegacy = action.runStructuredLegacy;
          action.runStructuredLegacy = async (probeContext) => {
            structuredLegacyCalls += 1;
            return await runStructuredLegacy(probeContext);
          };
        }
      }
      return planned;
    });
    const result = await operation({ profile: profile({ diagnosticIds: [DOCTOR] }) });
    if (result.audit.kind !== "audited") throw new Error("expected audited result");
    expect(actionKeys.some((keys) => keys.includes("runMany"))).toBe(true);
    expect(actionKeys.some((keys) => keys.includes("runStructuredLegacy"))).toBe(true);
    expect(runManyCalls).toBeGreaterThan(0);
    expect(structuredLegacyCalls).toBeGreaterThan(0);
    expect(result.audit.refusals).not.toContainEqual({
      diagnosticId: DOCTOR,
      state: "missing-adapter",
    });
    plan.mockRestore();
  });

  it("binds a safe evaluation-context digest while discarding options and targets", async () => {
    const plan = vi.spyOn(doctorCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "doctor",
          kind: "probe",
          run: async () => ({ name: "doctor", verdict: "pass" as const }),
        },
      ],
      capability: "doctor",
    });
    const execute = async (context: PlanContext) =>
      (
        await runGovernanceDoctorOperationV1({
          context: createGovernanceDoctorOperationalContextV1(context),
          policy: { decision: "allowed", revisionSha256: policyRevisionSha256 },
          profile: profile({ diagnosticIds: [DOCTOR] }),
        })
      ).record;
    const base = planContext({ posture: "vibe", postureSource: "default", targets: ["claude"] });
    const sameContext = planContext({
      options: { "attest-mcp-pins": true },
      posture: "vibe",
      postureSource: "default",
      targets: ["kiro"],
    });
    const differentPosture = planContext({ posture: "enterprise", postureSource: "marker" });
    const differentPlatform = planContext({ posture: "vibe", postureSource: "default" });
    differentPlatform.host = makeHostAdapter({
      env: {},
      platform: "darwin",
      run: differentPlatform.run,
    });
    const [first, second, third, fourth] = await Promise.all([
      execute(base),
      execute(sameContext),
      execute(differentPosture),
      execute(differentPlatform),
    ]);
    expect(first.contextSha256).toBe(second.contextSha256);
    expect(first.operationSha256).toBe(second.operationSha256);
    expect(first.contextSha256).not.toBe(third.contextSha256);
    expect(first.operationSha256).not.toBe(third.operationSha256);
    expect(first.contextSha256).not.toBe(fourth.contextSha256);
    expect(first.surfaceRevisionSha256).toBe(GOVERNANCE_DOCTOR_READ_ONLY_SURFACE_REVISION_V1);
    expect(first).not.toHaveProperty("root");
    plan.mockRestore();
  });

  it("pins readOnly semantics into the frozen command-surface identity", () => {
    expect(GOVERNANCE_DOCTOR_READ_ONLY_SURFACE_REVISION_V1).toBe(
      governanceDoctorSha256V1("aih.governance-doctor-read-only-surface-v1", {
        surfaces: GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES.map((surface) => ({
          commandPath: [...surface.commandPath],
          diagnosticId: surface.diagnosticId,
          readOnly: true,
        })),
      }),
    );
  });

  it("keeps the minted record branded and capability-free", async () => {
    const record = (await operation()).record;
    const bytes = canonicalGovernanceDoctorOperationV1Bytes(record);
    expect(() =>
      canonicalGovernanceDoctorOperationV1Bytes(JSON.parse(bytes.toString("utf8"))),
    ).toThrow(TypeError);
    expect(JSON.stringify(record)).not.toMatch(/callback|command|path|function/);
    expect(source).not.toMatch(/from "node:(?:fs|child_process|net|http|https)"/);
    expect(source).not.toMatch(/\b(?:execFile|spawn)\s*\(/);
  });
});

/**
 * The one code-owned diagnostic tuple whose non-pass verdict survives as a
 * finding. Everything else -- a different code, a different check, a different
 * diagnostic, an accompanying unmapped verdict -- keeps the pre-existing
 * `evidence-gap` refusal.
 */
describe("GovernanceDoctor mechanical diagnostic findings", () => {
  const CONTEXT_DIR_MISSING = {
    code: "canon.context-dir-missing",
    detail: "ai-coding not scaffolded - run: aih scaffold --apply",
    name: "context-dir",
    verdict: "skip" as const,
  };
  const MAPPED_FINDING_CODE = "AIH_CANON_CONTEXT_DIR_MISSING";

  function stubDoctor(...outputs: readonly Record<string, unknown>[]) {
    return vi.spyOn(doctorCommand, "plan").mockReturnValue({
      actions: outputs.map((output, index) => ({
        describe: `check-${index}`,
        kind: "probe" as const,
        run: async () => output as never,
      })),
      capability: "doctor",
    });
  }

  async function auditFor(...outputs: readonly Record<string, unknown>[]) {
    const plan = stubDoctor(...outputs);
    try {
      const result = await operation({ profile: profile({ diagnosticIds: [DOCTOR] }) });
      if (result.audit.kind !== "audited") throw new Error("expected audited result");
      return result.audit;
    } finally {
      plan.mockRestore();
    }
  }

  it("maps the exact doctor tuple to one fixed low finding and forwards no diagnostic code", async () => {
    const audit = await auditFor(CONTEXT_DIR_MISSING);
    expect(audit.refusals).toEqual([]);
    expect(audit.findings).toEqual([
      expect.objectContaining({
        code: MAPPED_FINDING_CODE,
        diagnosticId: DOCTOR,
        severity: "low",
      }),
    ]);
    // The diagnostic's own code is compared, never carried: nothing a probe
    // authors reaches the audit as data.
    expect(JSON.stringify(audit)).not.toContain("canon.context-dir-missing");
    expect(JSON.stringify(audit)).not.toContain("aih scaffold");
  });

  it("keeps evidence-gap for the same check under a different code, verdict, or name", async () => {
    for (const output of [
      { ...CONTEXT_DIR_MISSING, code: "canon.context-dir-other" },
      { ...CONTEXT_DIR_MISSING, code: undefined },
      { ...CONTEXT_DIR_MISSING, verdict: "fail" as const },
      { ...CONTEXT_DIR_MISSING, name: "context-directory" },
    ]) {
      const audit = await auditFor(output);
      expect(audit.refusals, JSON.stringify(output)).toEqual([
        { diagnosticId: DOCTOR, state: "evidence-gap" },
      ]);
      expect(audit.findings).toEqual([]);
    }
  });

  it("keeps evidence-gap when an unmapped non-pass verdict accompanies the mapped one", async () => {
    const audit = await auditFor(CONTEXT_DIR_MISSING, {
      code: "env.git-missing",
      name: "git",
      verdict: "skip",
    });
    expect(audit.refusals).toEqual([{ diagnosticId: DOCTOR, state: "evidence-gap" }]);
    expect(audit.findings).toEqual([]);
  });

  it("still reports the completion finding when every verdict passes", async () => {
    const audit = await auditFor({ name: "context-dir", verdict: "pass" });
    expect(audit.findings).toEqual([
      expect.objectContaining({ code: "AIH_READ_ONLY_PROBES_COMPLETED", diagnosticId: DOCTOR }),
    ]);
  });

  it("refuses the same tuple reported by a different diagnostic", async () => {
    const doctorPlan = stubDoctor({ name: "doctor", verdict: "pass" });
    const policyPlan = vi.spyOn(policyEvaluateCommand, "plan").mockReturnValue({
      actions: [
        {
          describe: "policy",
          kind: "probe",
          run: async () => CONTEXT_DIR_MISSING as never,
        },
      ],
      capability: "policy evaluate",
    });
    try {
      const result = await operation();
      if (result.audit.kind !== "audited") throw new Error("expected audited result");
      expect(result.audit.refusals).toEqual([{ diagnosticId: POLICY, state: "evidence-gap" }]);
      expect(result.audit.findings.map((finding) => finding.code)).not.toContain(
        MAPPED_FINDING_CODE,
      );
    } finally {
      doctorPlan.mockRestore();
      policyPlan.mockRestore();
    }
  });
});
