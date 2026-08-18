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
import {
  canonicalGovernanceDoctorRepairConsentV1Bytes,
  createGovernanceDoctorRepairConsentContextV1,
  createGovernanceDoctorRepairConsentV1,
  parseGovernanceDoctorRepairConsentV1Json,
} from "../../src/governance-doctor/repair-consent-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
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

const cp = (...points: readonly number[]): string => String.fromCodePoint(...points);

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
const SIGNER = "operator:jane.doe";
const TARGET = "target:aih.governance-doctor";

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
    targetId: TARGET,
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
    ],
    evidence: { findings: [{ code: PROBE_CODE, diagnosticId: DOCTOR }], refusals: [] },
    expiresAtEpochMs: EXPIRES_AT,
    operation: await operation(),
    planNonce: NONCE,
    profile: profile(),
    recipeId: "restore-repository-canon",
    registry: registry(),
    scope: { paths: ["ai-coding/rules"] },
    ...overrides,
  });
}

function contextInput(overrides: Record<string, unknown> = {}) {
  return {
    channel: "out-of-band",
    signerId: SIGNER,
    subjectId: TARGET,
    trustAnchorSha256: TRUST_ANCHOR,
    ...overrides,
  };
}

function consentInput(
  built: GovernanceDoctorRepairPlanV1,
  overrides: Record<string, unknown> = {},
) {
  return {
    consentNonce: CONSENT_NONCE,
    consentedAtEpochMs: CONSENTED_AT,
    context: createGovernanceDoctorRepairConsentContextV1(contextInput()),
    decision: "granted",
    plan: built,
    summary: governanceDoctorRepairEffectSummaryV1(built),
    ...overrides,
  };
}

describe("createGovernanceDoctorRepairConsentContextV1", () => {
  it("brands only an explicit out-of-band context", () => {
    const context = createGovernanceDoctorRepairConsentContextV1(contextInput());
    expect(context.protocol).toBe("GovernanceDoctorRepairConsentContextV1");
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.keys(context)).toEqual(["protocol"]);
  });

  it("refuses an ambient, inferred, in-band, or unbranded consent context", async () => {
    const built = await plan();
    for (const channel of ["in-band", "ambient", "inferred", "implicit", "", null, undefined])
      expect(
        () => createGovernanceDoctorRepairConsentContextV1(contextInput({ channel })),
        String(channel),
      ).toThrow(TypeError);
    for (const context of [
      undefined,
      null,
      {},
      { protocol: "GovernanceDoctorRepairConsentContextV1" },
      contextInput(),
    ])
      expect(
        () => createGovernanceDoctorRepairConsentV1(consentInput(built, { context })),
        JSON.stringify(context ?? null),
      ).toThrow(TypeError);
  });

  it("refuses malformed signer, subject, trust anchor, and unknown fields", () => {
    for (const signerId of ["", "Jane", "operator:", "operator:Jane", 1, null])
      expect(
        () => createGovernanceDoctorRepairConsentContextV1(contextInput({ signerId })),
        String(signerId),
      ).toThrow(TypeError);
    for (const subjectId of ["", "aih", "target:", 1, null])
      expect(
        () => createGovernanceDoctorRepairConsentContextV1(contextInput({ subjectId })),
        String(subjectId),
      ).toThrow(TypeError);
    for (const trustAnchorSha256 of ["", "a".repeat(63), "A".repeat(64), 1, null])
      expect(
        () => createGovernanceDoctorRepairConsentContextV1(contextInput({ trustAnchorSha256 })),
        String(trustAnchorSha256),
      ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairConsentContextV1(contextInput({ extra: true })),
    ).toThrow(TypeError);

    let observed = false;
    const proxied = new Proxy(contextInput(), {
      get(target, key, receiver) {
        observed = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createGovernanceDoctorRepairConsentContextV1(proxied)).toThrow(TypeError);
    expect(observed).toBe(false);
  });
});

describe("createGovernanceDoctorRepairConsentV1", () => {
  it("binds one exact plan byte-for-byte, with its effect summary and trusted context", async () => {
    const built = await plan();
    const summary = governanceDoctorRepairEffectSummaryV1(built);
    const consent = createGovernanceDoctorRepairConsentV1(consentInput(built, { summary }));

    const planBytesSha256 = domainDigest("aih.governance-doctor-repair-plan-bytes-v1", {
      bytesBase64: canonicalGovernanceDoctorRepairPlanV1Bytes(built).toString("base64"),
    });
    const body = {
      channel: "out-of-band",
      consentNonce: CONSENT_NONCE,
      consentedAtEpochMs: CONSENTED_AT,
      decision: "granted",
      planBytesSha256,
      planSha256: built.planSha256,
      protocol: "GovernanceDoctorRepairConsentV1",
      signerId: SIGNER,
      subjectId: TARGET,
      summarySha256: summary.summarySha256,
      trustAnchorSha256: TRUST_ANCHOR,
    };
    const consentSha256 = domainDigest("aih.governance-doctor-repair-consent-v1", body);

    expect(consent.consentSha256).toBe(consentSha256);
    expect(consent.planBytesSha256).toBe(planBytesSha256);
    expect(consent.summarySha256).toBe(summary.summarySha256);
    expect(canonicalGovernanceDoctorRepairConsentV1Bytes(consent).toString("utf8")).toBe(
      jcs({ ...body, consentSha256 }),
    );
    expect(Object.isFrozen(consent)).toBe(true);
  });

  it("gives every identity-bearing consent field a distinct consent identity", async () => {
    const built = await plan();
    const base = createGovernanceDoctorRepairConsentV1(consentInput(built)).consentSha256;
    const identities = new Set<string>([base]);
    for (const overrides of [
      { consentNonce: "0a".repeat(32) },
      { consentedAtEpochMs: CONSENTED_AT + 1 },
      { decision: "denied" },
      {
        context: createGovernanceDoctorRepairConsentContextV1(
          contextInput({ signerId: "operator:other" }),
        ),
      },
      {
        context: createGovernanceDoctorRepairConsentContextV1(
          contextInput({ trustAnchorSha256: "b".repeat(64) }),
        ),
      },
    ])
      identities.add(
        createGovernanceDoctorRepairConsentV1(consentInput(built, overrides)).consentSha256,
      );
    expect(identities.size).toBe(6);

    const other = await plan({ planNonce: "aa".repeat(32) });
    expect(createGovernanceDoctorRepairConsentV1(consentInput(other)).consentSha256).not.toBe(base);
  });

  it("records an explicit denial rather than inferring one", async () => {
    const built = await plan();
    expect(
      createGovernanceDoctorRepairConsentV1(consentInput(built, { decision: "denied" })).decision,
    ).toBe("denied");
    for (const decision of [undefined, null, "", "grant", "GRANTED", "unknown", true])
      expect(
        () => createGovernanceDoctorRepairConsentV1(consentInput(built, { decision })),
        String(decision),
      ).toThrow(TypeError);
  });

  it("refuses a subject, summary, or plan that is not the one being consented to", async () => {
    const built = await plan();
    expect(() =>
      createGovernanceDoctorRepairConsentV1(
        consentInput(built, {
          context: createGovernanceDoctorRepairConsentContextV1(
            contextInput({ subjectId: "target:aih.other" }),
          ),
        }),
      ),
    ).toThrow(TypeError);

    const other = await plan({ planNonce: "aa".repeat(32) });
    expect(() =>
      createGovernanceDoctorRepairConsentV1(
        consentInput(built, { summary: governanceDoctorRepairEffectSummaryV1(other) }),
      ),
    ).toThrow(TypeError);
    for (const summary of [undefined, null, {}, { summarySha256: "a".repeat(64) }])
      expect(
        () => createGovernanceDoctorRepairConsentV1(consentInput(built, { summary })),
        JSON.stringify(summary ?? null),
      ).toThrow(TypeError);
    for (const planValue of [undefined, null, {}, { ...built }])
      expect(
        () => createGovernanceDoctorRepairConsentV1(consentInput(built, { plan: planValue })),
        JSON.stringify(planValue ?? null).slice(0, 20),
      ).toThrow(TypeError);
  });

  it("refuses consent outside the plan validity window", async () => {
    const built = await plan();
    for (const consentedAtEpochMs of [
      CREATED_AT - 1,
      EXPIRES_AT + 1,
      0,
      CONSENTED_AT + 0.5,
      Number.NaN,
      "1777000060000",
      null,
    ])
      expect(
        () => createGovernanceDoctorRepairConsentV1(consentInput(built, { consentedAtEpochMs })),
        String(consentedAtEpochMs),
      ).toThrow(TypeError);
    expect(
      createGovernanceDoctorRepairConsentV1(consentInput(built, { consentedAtEpochMs: CREATED_AT }))
        .consentedAtEpochMs,
    ).toBe(CREATED_AT);
    expect(() =>
      createGovernanceDoctorRepairConsentV1(
        consentInput(built, { consentedAtEpochMs: EXPIRES_AT }),
      ),
    ).toThrow(TypeError);
  });

  it("refuses a malformed nonce, unknown fields, and hostile request containers", async () => {
    const built = await plan();
    for (const consentNonce of ["", "a".repeat(63), "A".repeat(64), 1, null])
      expect(
        () => createGovernanceDoctorRepairConsentV1(consentInput(built, { consentNonce })),
        String(consentNonce),
      ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairConsentV1(consentInput(built, { unexpected: true })),
    ).toThrow(TypeError);

    let observed = false;
    const proxied = new Proxy(consentInput(built), {
      get(target, key, receiver) {
        observed = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createGovernanceDoctorRepairConsentV1(proxied)).toThrow(TypeError);
    expect(observed).toBe(false);

    let read = false;
    const accessor = consentInput(built) as Record<string, unknown>;
    Object.defineProperty(accessor, "decision", {
      configurable: true,
      enumerable: true,
      get() {
        read = true;
        return "granted";
      },
    });
    expect(() => createGovernanceDoctorRepairConsentV1(accessor)).toThrow(TypeError);
    expect(read).toBe(false);

    for (const notARecord of [null, undefined, 0, "consent", [], true])
      expect(() => createGovernanceDoctorRepairConsentV1(notARecord), String(notARecord)).toThrow(
        TypeError,
      );
  });

  it("returns defensive canonical bytes and refuses a forged consent", async () => {
    const built = await plan();
    const consent = createGovernanceDoctorRepairConsentV1(consentInput(built));
    const first = canonicalGovernanceDoctorRepairConsentV1Bytes(consent);
    first.fill(0);
    expect(canonicalGovernanceDoctorRepairConsentV1Bytes(consent).equals(first)).toBe(false);
    const forged = JSON.parse(
      canonicalGovernanceDoctorRepairConsentV1Bytes(consent).toString("utf8"),
    ) as unknown;
    expect(() => canonicalGovernanceDoctorRepairConsentV1Bytes(forged)).toThrow(TypeError);
    expect(() => canonicalGovernanceDoctorRepairConsentV1Bytes({ ...consent })).toThrow(TypeError);
  });
});

describe("parseGovernanceDoctorRepairConsentV1Json", () => {
  it("round-trips only through its exact canonical bytes and its exact bindings", async () => {
    const built = await plan();
    const summary = governanceDoctorRepairEffectSummaryV1(built);
    const context = createGovernanceDoctorRepairConsentContextV1(contextInput());
    const consent = createGovernanceDoctorRepairConsentV1(
      consentInput(built, { context, summary }),
    );
    const bytes = canonicalGovernanceDoctorRepairConsentV1Bytes(consent);
    const parsed = parseGovernanceDoctorRepairConsentV1Json({
      bytes,
      context,
      plan: built,
      summary,
    });
    expect(parsed.consentSha256).toBe(consent.consentSha256);
    expect(canonicalGovernanceDoctorRepairConsentV1Bytes(parsed).equals(bytes)).toBe(true);

    const text = bytes.toString("utf8");
    for (const hostile of [
      ` ${text}`,
      `${cp(0xfeff)}${text}`,
      `${text.slice(0, -1)},}`,
      text.replace('{"', '{"protocol":"GovernanceDoctorRepairConsentV1","'),
      text.replace(/"consentSha256":"[a-f0-9]{64}"/, `"consentSha256":"${"0".repeat(64)}"`),
      text.replace('"decision":"granted"', '"decision":"denied"'),
    ])
      expect(
        () =>
          parseGovernanceDoctorRepairConsentV1Json({
            bytes: Buffer.from(hostile, "utf8"),
            context,
            plan: built,
            summary,
          }),
        hostile.slice(0, 24),
      ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorRepairConsentV1Json({ bytes: text, context, plan: built, summary }),
    ).toThrow(TypeError);
  });

  it("refuses a replayed consent presented against a different plan, summary, or signer", async () => {
    const built = await plan();
    const other = await plan({ planNonce: "aa".repeat(32) });
    const summary = governanceDoctorRepairEffectSummaryV1(built);
    const context = createGovernanceDoctorRepairConsentContextV1(contextInput());
    const bytes = canonicalGovernanceDoctorRepairConsentV1Bytes(
      createGovernanceDoctorRepairConsentV1(consentInput(built, { context, summary })),
    );

    expect(() =>
      parseGovernanceDoctorRepairConsentV1Json({
        bytes,
        context,
        plan: other,
        summary: governanceDoctorRepairEffectSummaryV1(other),
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorRepairConsentV1Json({
        bytes,
        context,
        plan: built,
        summary: governanceDoctorRepairEffectSummaryV1(other),
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorRepairConsentV1Json({
        bytes,
        context: createGovernanceDoctorRepairConsentContextV1(
          contextInput({ signerId: "operator:other" }),
        ),
        plan: built,
        summary,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorRepairConsentV1Json({
        bytes,
        context: createGovernanceDoctorRepairConsentContextV1(
          contextInput({ trustAnchorSha256: "b".repeat(64) }),
        ),
        plan: built,
        summary,
      }),
    ).toThrow(TypeError);
    for (const request of [
      undefined,
      null,
      { bytes },
      { bytes, context, plan: built },
      { bytes, context, extra: 1, plan: built, summary },
    ])
      expect(
        () => parseGovernanceDoctorRepairConsentV1Json(request),
        JSON.stringify(request ?? null).slice(0, 24),
      ).toThrow(TypeError);
  });
});
