import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import {
  createGovernanceDoctorOperationalContextV1,
  type GovernanceDoctorOperationV1,
  runGovernanceDoctorOperationV1,
} from "../../src/governance-doctor/operational-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";
import { createGovernanceDoctorRepairBrokerRegistryV1 } from "../../src/governance-doctor/repair-broker-v1.js";
import { GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS } from "../../src/governance-doctor/repair-capability-v1.js";
import {
  createGovernanceDoctorRepairConsentContextV1,
  createGovernanceDoctorRepairConsentV1,
  type GovernanceDoctorRepairConsentV1,
} from "../../src/governance-doctor/repair-consent-v1.js";
import {
  canonicalGovernanceDoctorRepairReceiptV1Bytes,
  canonicalGovernanceDoctorRepairStateV1Bytes,
  canonicalGovernanceDoctorRepairVerificationV1Bytes,
  createGovernanceDoctorRepairExecutionContextV1,
  createGovernanceDoctorRepairReceiptV1,
  createGovernanceDoctorRepairVerificationContextV1,
  createGovernanceDoctorRepairVerificationV1,
  type GovernanceDoctorRepairReceiptV1,
  parseGovernanceDoctorRepairReceiptV1Json,
  parseGovernanceDoctorRepairVerificationV1Json,
  resolveGovernanceDoctorRepairStateV1,
} from "../../src/governance-doctor/repair-outcome-v1.js";
import {
  createGovernanceDoctorRepairPlanV1,
  type GovernanceDoctorRepairPlanV1,
  governanceDoctorRepairEffectSummaryV1,
} from "../../src/governance-doctor/repair-plan-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { policyEvaluateCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/** Independent, test-owned JCS serializer and digest; never the production canonicalizer. */
const jcs = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
    .join(",")}}`;
};
const domainDigest = (domain: string, record: unknown): string =>
  createHash("sha256").update(jcs({ domain, record }), "utf8").digest("hex");

const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
const PROBE_CODE = "AIH_READ_ONLY_PROBES_COMPLETED";
const FIXTURE_ROOT = "/tmp/aih-governance-doctor-repair-fixture";
const policyRevisionSha256 = createHash("sha256").update("policy revision").digest("hex");
const TRUST_ANCHOR = createHash("sha256").update("trust anchor").digest("hex");
const NONCE = "7f".repeat(32);
const CONSENT_NONCE = "3c".repeat(32);
const CREATED_AT = 1_777_000_000_000;
const EXPIRES_AT = CREATED_AT + 3_600_000;
const CONSENTED_AT = CREATED_AT + 60_000;
const ATTEMPTED_AT = CONSENTED_AT + 60_000;
const VERIFIED_AT = ATTEMPTED_AT + 60_000;
const EVALUATED_AT = VERIFIED_AT + 60_000;
const TARGET = "target:aih.governance-doctor";
const VERIFIER = "aih:governance-doctor.mechanical-verifier";
const CONTENT_SHA256 = "c".repeat(64);

function prose(text = "Read the bounded result.") {
  return { attribution: "aih:governance-doctor", text };
}

function profile() {
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
    targetId: TARGET,
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

/** Both code-owned planners are stubbed, so no diagnostic ever inspects this checkout. */
async function operation(): Promise<GovernanceDoctorOperationV1> {
  const probe = {
    actions: [
      {
        describe: "diagnostic",
        kind: "probe" as const,
        run: async () => ({ name: "diagnostic", verdict: "pass" as const }),
      },
    ],
  };
  const doctorPlan = vi
    .spyOn(doctorCommand, "plan")
    .mockReturnValue({ ...probe, capability: "doctor" });
  const policyPlan = vi
    .spyOn(policyEvaluateCommand, "plan")
    .mockReturnValue({ ...probe, capability: "policy evaluate" });
  try {
    return await runGovernanceDoctorOperationV1({
      context: createGovernanceDoctorOperationalContextV1(planContext()),
      policy: { decision: "allowed", revisionSha256: policyRevisionSha256 },
      profile: profile(),
    });
  } finally {
    doctorPlan.mockRestore();
    policyPlan.mockRestore();
  }
}

function registry() {
  return createGovernanceDoctorRepairBrokerRegistryV1({
    brokerId: "aih:governance-doctor.mechanical",
    owner: "aih",
    recipes: [
      {
        effectVersion: "1",
        effects: [
          {
            argumentSchema: [{ name: "path", type: "managed-relative-path" }],
            effectKind: "create-managed-directory",
            templateId: "ensure-canon-directory",
          },
          {
            argumentSchema: [
              { name: "contentSha256", type: "sha256" },
              { name: "path", type: "managed-relative-path" },
            ],
            effectKind: "restore-managed-file-content",
            templateId: "restore-canon-router",
          },
        ],
        recipeId: "restore-repository-canon",
        schemaVersion: "1",
      },
    ],
  });
}

async function plan(
  overrides: Record<string, unknown> = {},
): Promise<GovernanceDoctorRepairPlanV1> {
  return createGovernanceDoctorRepairPlanV1({
    createdAtEpochMs: CREATED_AT,
    effects: [
      {
        arguments: { path: "ai-coding/rules" },
        effectId: "ensure-rules-directory",
        templateId: "ensure-canon-directory",
      },
      {
        arguments: { contentSha256: CONTENT_SHA256, path: "ai-coding/RULE_ROUTER.md" },
        effectId: "restore-router",
        templateId: "restore-canon-router",
      },
    ],
    evidence: { findings: [{ code: PROBE_CODE, diagnosticId: DOCTOR }], refusals: [] },
    expiresAtEpochMs: EXPIRES_AT,
    operation: await operation(),
    planNonce: NONCE,
    profile: profile(),
    recipeId: "restore-repository-canon",
    registry: registry(),
    scope: { paths: ["ai-coding/RULE_ROUTER.md", "ai-coding/rules"] },
    ...overrides,
  });
}

function consent(
  built: GovernanceDoctorRepairPlanV1,
  overrides: Record<string, unknown> = {},
): GovernanceDoctorRepairConsentV1 {
  return createGovernanceDoctorRepairConsentV1({
    consentNonce: CONSENT_NONCE,
    consentedAtEpochMs: CONSENTED_AT,
    context: createGovernanceDoctorRepairConsentContextV1({
      channel: "out-of-band",
      signerId: "operator:jane.doe",
      subjectId: TARGET,
      trustAnchorSha256: TRUST_ANCHOR,
    }),
    decision: "granted",
    plan: built,
    summary: governanceDoctorRepairEffectSummaryV1(built),
    ...overrides,
  });
}

function receipt(
  built: GovernanceDoctorRepairPlanV1,
  results: readonly ("applied" | "failed" | "skipped")[] = ["applied", "applied"],
  overrides: Record<string, unknown> = {},
): GovernanceDoctorRepairReceiptV1 {
  return createGovernanceDoctorRepairReceiptV1({
    attemptedAtEpochMs: ATTEMPTED_AT,
    consent: consent(built),
    context: createGovernanceDoctorRepairExecutionContextV1({
      brokerId: built.brokerId,
      executorId: "aih:governance-doctor.mechanical-executor",
      owner: "aih",
      recipeSha256: built.recipeSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
    }),
    effects: built.effects.map((effect, index) => ({
      effectId: effect.effectId,
      result: results[index] ?? "applied",
    })),
    plan: built,
    ...overrides,
  });
}

function verification(
  built: GovernanceDoctorRepairPlanV1,
  applied: GovernanceDoctorRepairReceiptV1,
  outcomes: readonly ("failed" | "unavailable" | "verified")[] = ["verified", "verified"],
  overrides: Record<string, unknown> = {},
) {
  return createGovernanceDoctorRepairVerificationV1({
    checks: built.effects.map((effect, index) => ({
      effectId: effect.effectId,
      outcome: outcomes[index] ?? "verified",
    })),
    context: createGovernanceDoctorRepairVerificationContextV1({
      brokerId: built.brokerId,
      recipeSha256: built.recipeSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
      trustAnchorSha256: TRUST_ANCHOR,
      verifierId: VERIFIER,
    }),
    plan: built,
    receipt: applied,
    verifiedAtEpochMs: VERIFIED_AT,
    ...overrides,
  });
}

function resolve(overrides: Record<string, unknown>) {
  return resolveGovernanceDoctorRepairStateV1({
    consent: null,
    consumedPlanSha256: [],
    evaluatedAtEpochMs: EVALUATED_AT,
    receipt: null,
    verification: null,
    ...overrides,
  });
}

describe("createGovernanceDoctorRepairReceiptV1", () => {
  it("owns the exact attempted effects in plan order and matches an independent vector", async () => {
    const built = await plan();
    const granted = consent(built);
    const applied = createGovernanceDoctorRepairReceiptV1({
      attemptedAtEpochMs: ATTEMPTED_AT,
      consent: granted,
      context: createGovernanceDoctorRepairExecutionContextV1({
        brokerId: built.brokerId,
        executorId: "aih:governance-doctor.mechanical-executor",
        owner: "aih",
        recipeSha256: built.recipeSha256,
        registrySha256: built.registrySha256,
        rootSha256: built.rootSha256,
      }),
      effects: built.effects.map((effect) => ({ effectId: effect.effectId, result: "applied" })),
      plan: built,
    });

    const body = {
      attemptedAtEpochMs: ATTEMPTED_AT,
      brokerId: built.brokerId,
      consentSha256: granted.consentSha256,
      effects: built.effects.map((effect) => ({
        effectId: effect.effectId,
        effectSha256: effect.effectSha256,
        result: "applied",
      })),
      executorId: "aih:governance-doctor.mechanical-executor",
      owner: "aih",
      planSha256: built.planSha256,
      protocol: "GovernanceDoctorRepairReceiptV1",
      recipeSha256: built.recipeSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
      state: "applied-unverified",
    };
    const receiptSha256 = domainDigest("aih.governance-doctor-repair-receipt-v1", body);

    expect(applied.state).toBe("applied-unverified");
    expect(applied.receiptSha256).toBe(receiptSha256);
    expect(canonicalGovernanceDoctorRepairReceiptV1Bytes(applied).toString("utf8")).toBe(
      jcs({ ...body, receiptSha256 }),
    );
    expect(Object.isFrozen(applied)).toBe(true);
    expect(Object.isFrozen(applied.effects)).toBe(true);
  });

  it("never fabricates success: any non-applied result is a failed receipt", async () => {
    const built = await plan();
    expect(receipt(built, ["applied", "failed"]).state).toBe("failed");
    expect(receipt(built, ["skipped", "applied"]).state).toBe("failed");
    expect(receipt(built, ["failed", "failed"]).state).toBe("failed");
    expect(receipt(built, ["skipped", "skipped"]).state).toBe("failed");
    expect(receipt(built, ["applied", "applied"]).state).toBe("applied-unverified");
    expect(receipt(built, ["applied", "failed"]).effects.map((item) => item.result)).toEqual([
      "applied",
      "failed",
    ]);
  });

  it("refuses partial, reordered, duplicated, extra, and unknown-result coverage", async () => {
    const built = await plan();
    const ids = built.effects.map((effect) => effect.effectId);
    for (const effects of [
      [],
      [{ effectId: ids[0], result: "applied" }],
      [
        { effectId: ids[1], result: "applied" },
        { effectId: ids[0], result: "applied" },
      ],
      [
        { effectId: ids[0], result: "applied" },
        { effectId: ids[0], result: "applied" },
      ],
      [
        { effectId: ids[0], result: "applied" },
        { effectId: ids[1], result: "applied" },
        { effectId: "extra", result: "applied" },
      ],
      [
        { effectId: ids[0], result: "applied" },
        { effectId: ids[1], result: "succeeded" },
      ],
      [
        { effectId: ids[0], result: "applied" },
        { effectId: ids[1], extra: 1, result: "applied" },
      ],
      [
        { effectId: ids[0], result: "applied" },
        { effectSha256: built.effects[1]?.effectSha256, result: "applied" },
      ],
    ])
      expect(
        () => receipt(built, ["applied", "applied"], { effects }),
        JSON.stringify(effects).slice(0, 48),
      ).toThrow(TypeError);
  });

  it("requires a granted consent that binds this exact plan", async () => {
    const built = await plan();
    const other = await plan({ planNonce: "aa".repeat(32) });
    expect(() => receipt(built, ["applied", "applied"], { consent: consent(other) })).toThrow(
      TypeError,
    );
    expect(() =>
      receipt(built, ["applied", "applied"], { consent: consent(built, { decision: "denied" }) }),
    ).toThrow(TypeError);
    for (const consentValue of [undefined, null, {}, { ...consent(built) }])
      expect(
        () => receipt(built, ["applied", "applied"], { consent: consentValue }),
        JSON.stringify(consentValue ?? null).slice(0, 20),
      ).toThrow(TypeError);
    for (const planValue of [undefined, null, {}, { ...built }])
      expect(
        () => receipt(built, ["applied", "applied"], { plan: planValue }),
        JSON.stringify(planValue ?? null).slice(0, 20),
      ).toThrow(TypeError);
  });

  it("refuses an attempt outside the consented validity window", async () => {
    const built = await plan();
    for (const attemptedAtEpochMs of [
      CONSENTED_AT - 1,
      EXPIRES_AT,
      EXPIRES_AT + 1,
      0,
      ATTEMPTED_AT + 0.5,
      Number.NaN,
      "1777000120000",
      null,
    ])
      expect(
        () => receipt(built, ["applied", "applied"], { attemptedAtEpochMs }),
        String(attemptedAtEpochMs),
      ).toThrow(TypeError);
    expect(receipt(built, ["applied", "applied"], { attemptedAtEpochMs: CONSENTED_AT }).state).toBe(
      "applied-unverified",
    );
  });

  it("refuses hostile, unknown-field, and forged receipt requests", async () => {
    const built = await plan();
    expect(() => receipt(built, ["applied", "applied"], { unexpected: true })).toThrow(TypeError);
    const applied = receipt(built);
    expect(() => canonicalGovernanceDoctorRepairReceiptV1Bytes({ ...applied })).toThrow(TypeError);
    expect(() =>
      canonicalGovernanceDoctorRepairReceiptV1Bytes(
        JSON.parse(canonicalGovernanceDoctorRepairReceiptV1Bytes(applied).toString("utf8")),
      ),
    ).toThrow(TypeError);
    const first = canonicalGovernanceDoctorRepairReceiptV1Bytes(applied);
    first.fill(0);
    expect(canonicalGovernanceDoctorRepairReceiptV1Bytes(applied).equals(first)).toBe(false);
  });

  it("rejects hostile and valid-shape-swapped execution trust contexts before they can own a receipt", async () => {
    const built = await plan();
    const base = {
      brokerId: built.brokerId,
      executorId: "aih:governance-doctor.mechanical-executor",
      owner: "aih",
      recipeSha256: built.recipeSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
    };
    for (const override of [
      { brokerId: "aih:governance-doctor.other" },
      { owner: "operator" },
      { recipeSha256: "a".repeat(64) },
      { registrySha256: "b".repeat(64) },
      { rootSha256: "c".repeat(64) },
    ]) {
      expect(() =>
        createGovernanceDoctorRepairReceiptV1({
          attemptedAtEpochMs: ATTEMPTED_AT,
          consent: consent(built),
          context: createGovernanceDoctorRepairExecutionContextV1({ ...base, ...override }),
          effects: built.effects.map((effect) => ({
            effectId: effect.effectId,
            result: "applied",
          })),
          plan: built,
        }),
      ).toThrow(TypeError);
    }
    const differentExecutor = createGovernanceDoctorRepairExecutionContextV1({
      ...base,
      executorId: "aih:governance-doctor.other-executor",
    });
    const applied = receipt(built);
    expect(() =>
      parseGovernanceDoctorRepairReceiptV1Json({
        bytes: canonicalGovernanceDoctorRepairReceiptV1Bytes(applied),
        consent: consent(built),
        context: differentExecutor,
        plan: built,
      }),
    ).toThrow(TypeError);
    let observed = false;
    const hostile = new Proxy(base, {
      get(target, key, receiver) {
        observed = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createGovernanceDoctorRepairExecutionContextV1(hostile)).toThrow(TypeError);
    expect(observed).toBe(false);
    let accessorRead = false;
    const accessor = { ...base };
    Object.defineProperty(accessor, "brokerId", {
      enumerable: true,
      get() {
        accessorRead = true;
        return base.brokerId;
      },
    });
    expect(() => createGovernanceDoctorRepairExecutionContextV1(accessor)).toThrow(TypeError);
    expect(accessorRead).toBe(false);
  });

  it("reconstructs receipt bytes only under their exact trusted plan and consent", async () => {
    const built = await plan();
    const granted = consent(built);
    const applied = createGovernanceDoctorRepairReceiptV1({
      attemptedAtEpochMs: ATTEMPTED_AT,
      consent: granted,
      context: createGovernanceDoctorRepairExecutionContextV1({
        brokerId: built.brokerId,
        executorId: "aih:governance-doctor.mechanical-executor",
        owner: "aih",
        recipeSha256: built.recipeSha256,
        registrySha256: built.registrySha256,
        rootSha256: built.rootSha256,
      }),
      effects: built.effects.map((effect) => ({ effectId: effect.effectId, result: "applied" })),
      plan: built,
    });
    const bytes = canonicalGovernanceDoctorRepairReceiptV1Bytes(applied);
    const context = createGovernanceDoctorRepairExecutionContextV1({
      brokerId: built.brokerId,
      executorId: "aih:governance-doctor.mechanical-executor",
      owner: "aih",
      recipeSha256: built.recipeSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
    });
    const parsed = parseGovernanceDoctorRepairReceiptV1Json({
      bytes,
      consent: granted,
      context,
      plan: built,
    });
    expect(parsed.receiptSha256).toBe(applied.receiptSha256);
    expect(parsed).not.toBe(applied);
    expect(Object.isFrozen(parsed)).toBe(true);
    const text = bytes.toString("utf8");
    for (const hostile of [
      Buffer.alloc(0),
      Buffer.from([0xff]),
      Buffer.from(` ${bytes.toString("utf8")}`),
      Buffer.from([0xef, 0xbb, 0xbf, ...bytes]),
      Buffer.from(`${text} `),
      Buffer.from(text.replace(/^\{/, '{"protocol":"GovernanceDoctorRepairReceiptV1",')),
      Buffer.alloc(GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxTransportBytes + 1, 0x20),
    ])
      expect(() =>
        parseGovernanceDoctorRepairReceiptV1Json({
          bytes: hostile,
          consent: granted,
          context,
          plan: built,
        }),
      ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorRepairReceiptV1Json({
        bytes,
        consent: granted,
        context,
        plan: { ...built },
      }),
    ).toThrow(TypeError);
    const other = await plan({ planNonce: "01".repeat(32) });
    expect(() =>
      parseGovernanceDoctorRepairReceiptV1Json({
        bytes,
        consent: consent(other),
        context,
        plan: other,
      }),
    ).toThrow(TypeError);
    for (const nonBuffer of [text, null, {}])
      expect(() =>
        parseGovernanceDoctorRepairReceiptV1Json({
          bytes: nonBuffer,
          consent: granted,
          context,
          plan: built,
        }),
      ).toThrow(TypeError);
    let observed = false;
    const hostileRequest = new Proxy(
      { bytes, consent: granted, context, plan: built },
      {
        get(target, key, receiver) {
          observed = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => parseGovernanceDoctorRepairReceiptV1Json(hostileRequest)).toThrow(TypeError);
    expect(observed).toBe(false);
  });
});

describe("createGovernanceDoctorRepairVerificationV1", () => {
  it("covers the exact plan effects, binds the receipt, and matches an independent vector", async () => {
    const built = await plan();
    const applied = receipt(built);
    const verified = verification(built, applied);

    const body = {
      brokerId: built.brokerId,
      checks: built.effects.map((effect) => ({
        effectId: effect.effectId,
        effectSha256: effect.effectSha256,
        outcome: "verified",
      })),
      outcome: "verified",
      planSha256: built.planSha256,
      protocol: "GovernanceDoctorRepairVerificationV1",
      recipeSha256: built.recipeSha256,
      receiptSha256: applied.receiptSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
      trustAnchorSha256: TRUST_ANCHOR,
      verifiedAtEpochMs: VERIFIED_AT,
      verifierId: VERIFIER,
    };
    const verificationSha256 = domainDigest("aih.governance-doctor-repair-verification-v1", body);
    expect(verified.verificationSha256).toBe(verificationSha256);
    expect(canonicalGovernanceDoctorRepairVerificationV1Bytes(verified).toString("utf8")).toBe(
      jcs({ ...body, verificationSha256 }),
    );
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it("reconstructs verification bytes only under their exact trusted plan and receipt", async () => {
    const built = await plan();
    const applied = receipt(built);
    const verified = verification(built, applied);
    const bytes = canonicalGovernanceDoctorRepairVerificationV1Bytes(verified);
    const context = createGovernanceDoctorRepairVerificationContextV1({
      brokerId: built.brokerId,
      recipeSha256: built.recipeSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
      trustAnchorSha256: TRUST_ANCHOR,
      verifierId: VERIFIER,
    });
    const parsed = parseGovernanceDoctorRepairVerificationV1Json({
      bytes,
      context,
      plan: built,
      receipt: applied,
    });
    expect(parsed.verificationSha256).toBe(verified.verificationSha256);
    expect(parsed).not.toBe(verified);
    expect(Object.isFrozen(parsed)).toBe(true);
    const text = bytes.toString("utf8");
    for (const hostile of [
      Buffer.alloc(0),
      Buffer.from([0xff]),
      Buffer.from([0xef, 0xbb, 0xbf, ...bytes]),
      Buffer.from(` ${text}`),
      Buffer.from(`${text} `),
      Buffer.from(text.replace(/^\{/, '{"protocol":"GovernanceDoctorRepairVerificationV1",')),
      Buffer.alloc(GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxTransportBytes + 1, 0x20),
    ])
      expect(() =>
        parseGovernanceDoctorRepairVerificationV1Json({
          bytes: hostile,
          context,
          plan: built,
          receipt: applied,
        }),
      ).toThrow(TypeError);
    for (const nonBuffer of [text, null, {}])
      expect(() =>
        parseGovernanceDoctorRepairVerificationV1Json({
          bytes: nonBuffer,
          context,
          plan: built,
          receipt: applied,
        }),
      ).toThrow(TypeError);
    const other = await plan({ planNonce: "02".repeat(32) });
    const otherReceipt = receipt(other);
    expect(() =>
      parseGovernanceDoctorRepairVerificationV1Json({
        bytes,
        context,
        plan: other,
        receipt: otherReceipt,
      }),
    ).toThrow(TypeError);
    let observed = false;
    const hostileRequest = new Proxy(
      { bytes, context, plan: built, receipt: applied },
      {
        get(target, key, receiver) {
          observed = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => parseGovernanceDoctorRepairVerificationV1Json(hostileRequest)).toThrow(TypeError);
    expect(observed).toBe(false);
    expect(() =>
      parseGovernanceDoctorRepairVerificationV1Json({
        bytes,
        context,
        plan: { ...built },
        receipt: applied,
      }),
    ).toThrow(TypeError);
  });

  it("derives failed over unavailable over verified and never relabels a failure as success", async () => {
    const built = await plan();
    const applied = receipt(built);
    expect(verification(built, applied, ["verified", "verified"]).outcome).toBe("verified");
    expect(verification(built, applied, ["unavailable", "verified"]).outcome).toBe("unavailable");
    expect(verification(built, applied, ["failed", "unavailable"]).outcome).toBe("failed");
    expect(verification(built, applied, ["verified", "failed"]).outcome).toBe("failed");
  });

  it("refuses claiming a verified check for an effect the receipt did not apply", async () => {
    const built = await plan();
    const partial = receipt(built, ["applied", "failed"]);
    expect(() => verification(built, partial, ["verified", "verified"])).toThrow(TypeError);
    expect(() => verification(built, partial, ["verified", "unavailable"])).not.toThrow();
    expect(verification(built, partial, ["verified", "failed"]).outcome).toBe("failed");
    const skipped = receipt(built, ["skipped", "applied"]);
    expect(() => verification(built, skipped, ["verified", "verified"])).toThrow(TypeError);
  });

  it("rejects hostile and valid-shape-swapped verification trust contexts", async () => {
    const built = await plan();
    const applied = receipt(built);
    const base = {
      brokerId: built.brokerId,
      recipeSha256: built.recipeSha256,
      registrySha256: built.registrySha256,
      rootSha256: built.rootSha256,
      trustAnchorSha256: TRUST_ANCHOR,
      verifierId: VERIFIER,
    };
    for (const override of [
      { brokerId: "aih:governance-doctor.other" },
      { recipeSha256: "a".repeat(64) },
      { registrySha256: "b".repeat(64) },
      { rootSha256: "c".repeat(64) },
    ])
      expect(() =>
        createGovernanceDoctorRepairVerificationV1({
          checks: built.effects.map((effect) => ({
            effectId: effect.effectId,
            outcome: "verified",
          })),
          context: createGovernanceDoctorRepairVerificationContextV1({ ...base, ...override }),
          plan: built,
          receipt: applied,
          verifiedAtEpochMs: VERIFIED_AT,
        }),
      ).toThrow(TypeError);
    const alternateTrust = createGovernanceDoctorRepairVerificationContextV1({
      ...base,
      trustAnchorSha256: "d".repeat(64),
      verifierId: "aih:governance-doctor.other-verifier",
    });
    expect(() =>
      parseGovernanceDoctorRepairVerificationV1Json({
        bytes: canonicalGovernanceDoctorRepairVerificationV1Bytes(verification(built, applied)),
        context: alternateTrust,
        plan: built,
        receipt: applied,
      }),
    ).toThrow(TypeError);
    let observed = false;
    const hostile = new Proxy(base, {
      get(target, key, receiver) {
        observed = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createGovernanceDoctorRepairVerificationContextV1(hostile)).toThrow(TypeError);
    expect(observed).toBe(false);
    let accessorRead = false;
    const accessor = { ...base };
    Object.defineProperty(accessor, "verifierId", {
      enumerable: true,
      get() {
        accessorRead = true;
        return base.verifierId;
      },
    });
    expect(() => createGovernanceDoctorRepairVerificationContextV1(accessor)).toThrow(TypeError);
    expect(accessorRead).toBe(false);
  });

  it("refuses partial, reordered, extra, and unknown-outcome coverage", async () => {
    const built = await plan();
    const applied = receipt(built);
    const ids = built.effects.map((effect) => effect.effectId);
    for (const checks of [
      [],
      [{ effectId: ids[0], outcome: "verified" }],
      [
        { effectId: ids[1], outcome: "verified" },
        { effectId: ids[0], outcome: "verified" },
      ],
      [
        { effectId: ids[0], outcome: "verified" },
        { effectId: ids[0], outcome: "verified" },
      ],
      [
        { effectId: ids[0], outcome: "verified" },
        { effectId: ids[1], outcome: "verified" },
        { effectId: "extra", outcome: "verified" },
      ],
      [
        { effectId: ids[0], outcome: "verified" },
        { effectId: ids[1], outcome: "passed" },
      ],
      [
        { effectId: ids[0], outcome: "verified" },
        { effectId: ids[1], extra: 1, outcome: "verified" },
      ],
    ])
      expect(
        () => verification(built, applied, ["verified", "verified"], { checks }),
        JSON.stringify(checks).slice(0, 48),
      ).toThrow(TypeError);
  });

  it("refuses a receipt, plan, verifier, or timestamp that does not bind this verification", async () => {
    const built = await plan();
    const other = await plan({ planNonce: "aa".repeat(32) });
    const applied = receipt(built);
    expect(() => verification(built, receipt(other), ["verified", "verified"])).toThrow(TypeError);
    for (const receiptValue of [undefined, null, {}, { ...applied }])
      expect(
        () => verification(built, applied, ["verified", "verified"], { receipt: receiptValue }),
        JSON.stringify(receiptValue ?? null).slice(0, 20),
      ).toThrow(TypeError);
    for (const verifierId of ["", "aih", "verifier", "AIH:x", 1, null])
      expect(
        () => verification(built, applied, ["verified", "verified"], { verifierId }),
        String(verifierId),
      ).toThrow(TypeError);
    for (const verifiedAtEpochMs of [
      ATTEMPTED_AT - 1,
      0,
      VERIFIED_AT + 0.5,
      Number.NaN,
      "1777000180000",
      null,
      Number.MAX_SAFE_INTEGER,
    ])
      expect(
        () => verification(built, applied, ["verified", "verified"], { verifiedAtEpochMs }),
        String(verifiedAtEpochMs),
      ).toThrow(TypeError);
    expect(() =>
      verification(built, applied, ["verified", "verified"], { unexpected: true }),
    ).toThrow(TypeError);
  });
});

describe("resolveGovernanceDoctorRepairStateV1", () => {
  it("resolves planned, consented, applied-unverified, and verified in order", async () => {
    const built = await plan();
    const granted = consent(built);
    const applied = receipt(built);

    expect(resolve({ plan: built })).toMatchObject({
      applied: false,
      reason: null,
      state: "planned",
    });
    expect(resolve({ consent: granted, plan: built })).toMatchObject({
      applied: false,
      reason: null,
      state: "consented",
    });
    expect(resolve({ consent: granted, plan: built, receipt: applied })).toMatchObject({
      applied: true,
      reason: null,
      state: "applied-unverified",
    });
    expect(
      resolve({
        consent: granted,
        plan: built,
        receipt: applied,
        verification: verification(built, applied),
      }),
    ).toMatchObject({ applied: true, reason: null, state: "verified" });
  });

  it("keeps an exactly unavailable verification at applied-unverified", async () => {
    const built = await plan();
    const applied = receipt(built);
    expect(
      resolve({
        consent: consent(built),
        plan: built,
        receipt: applied,
        verification: verification(built, applied, ["unavailable", "unavailable"]),
      }),
    ).toMatchObject({ applied: true, reason: null, state: "applied-unverified" });
  });

  it("is terminal and fail-closed for replay, expiry, denial, mismatch, and failure", async () => {
    const built = await plan();
    const other = await plan({ planNonce: "aa".repeat(32) });
    const granted = consent(built);
    const applied = receipt(built);

    expect(resolve({ consumedPlanSha256: [built.planSha256], plan: built })).toMatchObject({
      reason: "replayed",
      state: "refused",
    });
    expect(
      resolve({
        consent: granted,
        consumedPlanSha256: [built.planSha256],
        plan: built,
        receipt: applied,
        verification: verification(built, applied),
      }),
    ).toMatchObject({ reason: "replayed", state: "refused" });

    expect(resolve({ evaluatedAtEpochMs: EXPIRES_AT + 1, plan: built })).toMatchObject({
      reason: "expired",
      state: "refused",
    });
    expect(
      resolve({ consent: granted, evaluatedAtEpochMs: EXPIRES_AT + 1, plan: built }),
    ).toMatchObject({ reason: "expired", state: "refused" });

    expect(resolve({ consent: consent(built, { decision: "denied" }), plan: built })).toMatchObject(
      {
        applied: false,
        reason: "consent-denied",
        state: "refused",
      },
    );

    expect(resolve({ consent: consent(other), plan: built })).toMatchObject({
      reason: "consent-mismatch",
      state: "refused",
    });
    expect(resolve({ plan: built, receipt: applied })).toMatchObject({
      reason: "receipt-mismatch",
      state: "refused",
    });
    expect(resolve({ consent: granted, plan: built, receipt: receipt(other) })).toMatchObject({
      reason: "receipt-mismatch",
      state: "refused",
    });
    expect(
      resolve({ consent: granted, plan: built, verification: verification(built, applied) }),
    ).toMatchObject({ reason: "receipt-mismatch", state: "refused" });

    expect(
      resolve({ consent: granted, plan: built, receipt: receipt(built, ["applied", "failed"]) }),
    ).toMatchObject({ applied: true, reason: "effect-failed", state: "refused" });
    expect(
      resolve({ consent: granted, plan: built, receipt: receipt(built, ["skipped", "skipped"]) }),
    ).toMatchObject({ applied: false, reason: "effect-failed", state: "refused" });

    expect(
      resolve({
        consent: granted,
        plan: built,
        receipt: applied,
        verification: verification(built, applied, ["failed", "verified"]),
      }),
    ).toMatchObject({ applied: true, reason: "verification-failed", state: "refused" });
    expect(
      resolve({
        consent: granted,
        plan: built,
        receipt: applied,
        verification: verification(other, receipt(other)),
      }),
    ).toMatchObject({ reason: "verification-mismatch", state: "refused" });
  });

  it("treats expiry as exclusive and preserves applied truth on replay", async () => {
    const built = await plan();
    const granted = consent(built);
    const applied = receipt(built);
    expect(resolve({ plan: built, evaluatedAtEpochMs: EXPIRES_AT })).toMatchObject({
      applied: false,
      reason: "expired",
      state: "refused",
    });
    expect(
      resolve({ consent: granted, plan: built, evaluatedAtEpochMs: EXPIRES_AT }),
    ).toMatchObject({
      applied: false,
      reason: "expired",
      state: "refused",
    });
    expect(
      resolve({
        consent: granted,
        consumedPlanSha256: [built.planSha256],
        plan: built,
        receipt: applied,
      }),
    ).toMatchObject({ applied: true, reason: "replayed", state: "refused" });
    expect(resolve({ consumedPlanSha256: [built.planSha256], plan: built })).toMatchObject({
      applied: false,
      reason: "replayed",
      state: "refused",
    });
    const other = await plan({ planNonce: "01".repeat(32) });
    const otherApplied = receipt(other);
    for (const evidence of [
      { receipt: otherApplied },
      { consent: granted, receipt: otherApplied },
      { consent: granted, receipt: otherApplied, verification: verification(other, otherApplied) },
    ])
      expect(
        resolve({ consumedPlanSha256: [built.planSha256], plan: built, ...evidence }),
      ).toMatchObject({ applied: false, reason: "replayed", state: "refused" });
  });

  it("matches an independent resolution vector and stays frozen and branded", async () => {
    const built = await plan();
    const applied = receipt(built);
    const resolution = resolve({
      consent: consent(built),
      plan: built,
      receipt: applied,
      verification: verification(built, applied),
    });
    const body = {
      applied: true,
      planSha256: built.planSha256,
      protocol: "GovernanceDoctorRepairStateV1",
      reason: null,
      state: "verified",
    };
    const resolutionSha256 = domainDigest("aih.governance-doctor-repair-state-v1", body);
    expect(resolution.resolutionSha256).toBe(resolutionSha256);
    expect(canonicalGovernanceDoctorRepairStateV1Bytes(resolution).toString("utf8")).toBe(
      jcs({ ...body, resolutionSha256 }),
    );
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(() => canonicalGovernanceDoctorRepairStateV1Bytes({ ...resolution })).toThrow(TypeError);
  });

  it("refuses unbranded, hostile, unknown-field, and unbounded resolver requests", async () => {
    const built = await plan();
    for (const planValue of [undefined, null, {}, { ...built }])
      expect(
        () => resolve({ plan: planValue }),
        JSON.stringify(planValue ?? null).slice(0, 20),
      ).toThrow(TypeError);
    for (const consentValue of [{}, { consentSha256: "a".repeat(64) }, 0, ""])
      expect(
        () => resolve({ consent: consentValue, plan: built }),
        JSON.stringify(consentValue),
      ).toThrow(TypeError);
    for (const consumedPlanSha256 of [
      undefined,
      "a".repeat(64),
      [1],
      ["nope"],
      [built.planSha256, built.planSha256],
      Array.from(
        { length: GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxConsumedPlanIdentities + 1 },
        (_, index) => createHash("sha256").update(String(index)).digest("hex"),
      ),
    ])
      expect(
        () => resolve({ consumedPlanSha256, plan: built }),
        String(JSON.stringify(consumedPlanSha256)).slice(0, 24),
      ).toThrow(TypeError);
    for (const evaluatedAtEpochMs of [0, EVALUATED_AT + 0.5, Number.NaN, "now", null, undefined])
      expect(
        () => resolve({ evaluatedAtEpochMs, plan: built }),
        String(evaluatedAtEpochMs),
      ).toThrow(TypeError);
    expect(() => resolve({ plan: built, unexpected: true })).toThrow(TypeError);

    let observed = false;
    const proxied = new Proxy(
      {
        consent: null,
        consumedPlanSha256: [],
        evaluatedAtEpochMs: EVALUATED_AT,
        plan: built,
        receipt: null,
        verification: null,
      },
      {
        get(target, key, receiver) {
          observed = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => resolveGovernanceDoctorRepairStateV1(proxied)).toThrow(TypeError);
    expect(observed).toBe(false);
    for (const notARecord of [null, undefined, 0, "state", [], true])
      expect(() => resolveGovernanceDoctorRepairStateV1(notARecord), String(notARecord)).toThrow(
        TypeError,
      );
  });
});
