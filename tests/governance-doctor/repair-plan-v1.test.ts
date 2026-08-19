import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import {
  canonicalGovernanceDoctorOperationV1Bytes,
  createGovernanceDoctorOperationV1Record,
} from "../../src/governance-doctor/operation-record-v1.js";
import {
  createGovernanceDoctorOperationalContextV1,
  type GovernanceDoctorOperationV1,
  runGovernanceDoctorOperationV1,
} from "../../src/governance-doctor/operational-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";
import { createGovernanceDoctorRepairBrokerRegistryV1 } from "../../src/governance-doctor/repair-broker-v1.js";
import { GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS } from "../../src/governance-doctor/repair-capability-v1.js";
import {
  canonicalGovernanceDoctorRepairEffectSummaryV1Bytes,
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  createGovernanceDoctorRepairPlanV1,
  governanceDoctorRepairEffectSummaryV1,
  parseGovernanceDoctorRepairPlanV1Json,
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
/** A synthetic root: no diagnostic is executed, so nothing inspects this checkout. */
const FIXTURE_ROOT = "/tmp/aih-governance-doctor-repair-fixture";
const policyRevisionSha256 = createHash("sha256").update("policy revision").digest("hex");
const NONCE = "7f".repeat(32);
const CREATED_AT = 1_777_000_000_000;
const EXPIRES_AT = CREATED_AT + 3_600_000;
const CONTENT_SHA256 = "c".repeat(64);
const ROUTER_PATH = "ai-coding/RULE_ROUTER.md";
const RULES_PATH = "ai-coding/rules";
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/governance-doctor");

function localImportClosure(entry: string, visited = new Set<string>()): readonly string[] {
  const source = resolve(sourceRoot, entry);
  if (visited.has(source)) return [];
  visited.add(source);
  const text = readFileSync(source, "utf8");
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
  return [
    source,
    ...imports.flatMap((specifier) => {
      if (!specifier.startsWith(".")) return [specifier];
      const next = resolve(dirname(source), `${specifier.replace(/\.js$/, "")}.ts`);
      return localImportClosure(next, visited);
    }),
  ];
}

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

function planContext(overrides: Partial<PlanContext> = {}): PlanContext {
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
    ...overrides,
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
  verdicts: { readonly doctor?: "pass" | "fail"; readonly policy?: "pass" | "fail" } = {},
): Promise<GovernanceDoctorOperationV1> {
  const doctorPlan = vi
    .spyOn(doctorCommand, "plan")
    .mockReturnValue({ ...stubbedProbe(verdicts.doctor ?? "pass"), capability: "doctor" });
  const policyPlan = vi.spyOn(policyEvaluateCommand, "plan").mockReturnValue({
    ...stubbedProbe(verdicts.policy ?? "pass"),
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

function effects(): Record<string, unknown>[] {
  return [
    {
      arguments: { path: RULES_PATH },
      effectId: "ensure-rules-directory",
      templateId: "ensure-canon-directory",
    },
    {
      arguments: { contentSha256: CONTENT_SHA256, path: ROUTER_PATH },
      effectId: "restore-router",
      templateId: "restore-canon-router",
    },
  ];
}

async function planInput(overrides: Record<string, unknown> = {}) {
  return {
    createdAtEpochMs: CREATED_AT,
    effects: effects(),
    evidence: { findings: [{ code: PROBE_CODE, diagnosticId: DOCTOR }], refusals: [] },
    expiresAtEpochMs: EXPIRES_AT,
    operation: await operation(),
    planNonce: NONCE,
    profile: profile(),
    recipeId: "restore-repository-canon",
    registry: registry(),
    scope: { paths: [RULES_PATH, ROUTER_PATH] },
    ...overrides,
  };
}

async function plan(overrides: Record<string, unknown> = {}) {
  return createGovernanceDoctorRepairPlanV1(await planInput(overrides));
}

describe("createGovernanceDoctorRepairPlanV1", () => {
  it("does not let an arbitrary record body earn an operation brand", async () => {
    const built = await operation();
    expect(() =>
      createGovernanceDoctorOperationV1Record({
        audit: {},
        guide: {},
        record: built.record,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorOperationV1Record({
        audit: built.audit,
        guide: built.guide,
        record: { ...built.record, profileSha256: "a".repeat(64) },
      }),
    ).toThrow(TypeError);
    expect(() => canonicalGovernanceDoctorOperationV1Bytes({ ...built.record })).toThrow(TypeError);
  });
  it("keeps the complete repair-contract import closure capability-free", () => {
    const entries = [
      "repair-capability-v1.ts",
      "repair-broker-v1.ts",
      "repair-plan-v1.ts",
      "repair-consent-v1.ts",
      "repair-outcome-v1.ts",
    ];
    const closure = entries.flatMap((entry) => localImportClosure(entry));
    // Canonical identity needs `node:crypto` and proxy rejection needs
    // `node:util/types`; neither supplies an effectful adapter. The closure
    // must otherwise remain free of ambient/process or operational surfaces.
    expect(closure.join("\n")).not.toMatch(
      /node:(?:fs|path|child_process|net|http|https|dns|os|process)|operational-v1|(?:^|[\\/])doctor(?:\.ts|\.js)?$|org-policy[\\/]validate|provider|scanner|signer/,
    );
  });
  it("binds the operation, profile, root, context, policy, authority, broker, scope, and window", async () => {
    const built = await operation();
    if (built.record.kind !== "completed") throw new Error("expected a completed operation");
    const result = createGovernanceDoctorRepairPlanV1(await planInput({ operation: built }));

    expect(result.protocol).toBe("GovernanceDoctorRepairPlanV1");
    expect(result.operationSha256).toBe(built.record.operationSha256);
    expect(result.auditSha256).toBe(built.record.auditSha256);
    expect(result.guideSha256).toBe(built.record.guideSha256);
    expect(result.profileSha256).toBe(built.record.profileSha256);
    expect(result.rootSha256).toBe(built.record.rootSha256);
    expect(result.contextSha256).toBe(built.record.contextSha256);
    expect(result.policyRevisionSha256).toBe(built.record.policyRevisionSha256);
    expect(result.surfaceRevisionSha256).toBe(built.record.surfaceRevisionSha256);
    expect(result.targetId).toBe(built.record.targetId);
    expect(result.brokerId).toBe("aih:governance-doctor.mechanical");
    expect(result.recipeId).toBe("restore-repository-canon");
    expect(result.registrySha256).toBe(registry().registrySha256);
    expect(result.recipeSha256).toBe(registry().recipes[0]?.recipeSha256);
    expect(result.createdAtEpochMs).toBe(CREATED_AT);
    expect(result.expiresAtEpochMs).toBe(EXPIRES_AT);
    expect(result.planNonce).toBe(NONCE);
    expect(result.scope.paths).toEqual([ROUTER_PATH, RULES_PATH]);
    expect(result.authority).toEqual({
      authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      grantedTo: "aih",
      policyRevisionSha256,
      requires: "explicit-out-of-band-consent",
      surfaceRevisionSha256: built.record.surfaceRevisionSha256,
    });
    expect(result.effects.map((effect) => [effect.effectId, effect.effectKind])).toEqual([
      ["ensure-rules-directory", "create-managed-directory"],
      ["restore-router", "restore-managed-file-content"],
    ]);
  });

  it("matches an independently canonicalized body, identity, and byte vector", async () => {
    const built = await operation();
    if (built.record.kind !== "completed") throw new Error("expected a completed operation");
    const result = createGovernanceDoctorRepairPlanV1(await planInput({ operation: built }));

    const expectedEffects = [
      {
        arguments: { path: RULES_PATH },
        effectId: "ensure-rules-directory",
        effectKind: "create-managed-directory",
        templateId: "ensure-canon-directory",
      },
      {
        arguments: { contentSha256: CONTENT_SHA256, path: ROUTER_PATH },
        effectId: "restore-router",
        effectKind: "restore-managed-file-content",
        templateId: "restore-canon-router",
      },
    ].map((effect, index) => ({
      ...effect,
      effectSha256: domainDigest("aih.governance-doctor-repair-effect-v1", {
        ...effect,
        index,
        planNonce: NONCE,
      }),
    }));
    const findings = [{ code: PROBE_CODE, diagnosticId: DOCTOR }];
    const evidence = {
      evidenceSha256: domainDigest("aih.governance-doctor-repair-evidence-v1", {
        auditSha256: built.record.auditSha256,
        findings,
        refusals: [],
      }),
      findings,
      refusals: [],
    };
    const authorityBody = {
      grantedTo: "aih",
      policyRevisionSha256,
      requires: "explicit-out-of-band-consent",
      surfaceRevisionSha256: built.record.surfaceRevisionSha256,
    };
    const body = {
      auditSha256: built.record.auditSha256,
      authority: {
        ...authorityBody,
        authoritySha256: domainDigest("aih.governance-doctor-repair-authority-v1", authorityBody),
      },
      brokerId: "aih:governance-doctor.mechanical",
      contextSha256: built.record.contextSha256,
      createdAtEpochMs: CREATED_AT,
      effects: expectedEffects,
      evidence,
      expiresAtEpochMs: EXPIRES_AT,
      guideSha256: built.record.guideSha256,
      operationSha256: built.record.operationSha256,
      planNonce: NONCE,
      policyRevisionSha256,
      profileSha256: built.record.profileSha256,
      protocol: "GovernanceDoctorRepairPlanV1",
      recipeId: "restore-repository-canon",
      recipeSha256: registry().recipes[0]?.recipeSha256,
      registrySha256: registry().registrySha256,
      rootSha256: built.record.rootSha256,
      scope: {
        paths: [ROUTER_PATH, RULES_PATH],
        scopeSha256: domainDigest("aih.governance-doctor-repair-scope-v1", {
          paths: [ROUTER_PATH, RULES_PATH],
        }),
      },
      surfaceRevisionSha256: built.record.surfaceRevisionSha256,
      targetId: built.record.targetId,
    };
    const planSha256 = domainDigest("aih.governance-doctor-repair-plan-v1", body);

    expect(result.planSha256).toBe(planSha256);
    expect(result.evidence.evidenceSha256).toBe(evidence.evidenceSha256);
    expect(result.scope.scopeSha256).toBe(body.scope.scopeSha256);
    expect(result.effects.map((effect) => effect.effectSha256)).toEqual(
      expectedEffects.map((effect) => effect.effectSha256),
    );
    expect(canonicalGovernanceDoctorRepairPlanV1Bytes(result).toString("utf8")).toBe(
      jcs({ ...body, planSha256 }),
    );
  });

  it("gives every identity-bearing field a distinct plan identity", async () => {
    const identities = new Set<string>([(await plan()).planSha256]);
    const variants: Record<string, unknown>[] = [
      { createdAtEpochMs: CREATED_AT + 1 },
      { expiresAtEpochMs: EXPIRES_AT + 1 },
      { planNonce: "01".repeat(32) },
      { scope: { paths: [RULES_PATH, ROUTER_PATH, "ai-coding/adapters"] } },
      { effects: [{ ...effects()[0], effectId: "ensure-other-directory" }, effects()[1]] },
      { effects: [...effects()].reverse() },
      // An argument value alone must move the identity; the path stays put
      // because one managed path may never be declared twice in a plan.
      {
        effects: [
          effects()[0],
          { ...effects()[1], arguments: { contentSha256: "e".repeat(64), path: ROUTER_PATH } },
        ],
      },
      {
        evidence: {
          findings: [
            { code: PROBE_CODE, diagnosticId: DOCTOR },
            { code: PROBE_CODE, diagnosticId: POLICY },
          ],
          refusals: [],
        },
      },
    ];
    for (const overrides of variants)
      identities.add(createGovernanceDoctorRepairPlanV1(await planInput(overrides)).planSha256);
    expect(identities.size).toBe(variants.length + 1);
  });

  it("derives a bounded human-visible effect summary bound to the exact plan", async () => {
    const operationValue = await operation();
    const built = createGovernanceDoctorRepairPlanV1(
      await planInput({ operation: operationValue }),
    );
    const summary = governanceDoctorRepairEffectSummaryV1(built);
    const body = {
      effects: [
        {
          arguments: { path: RULES_PATH },
          effectId: "ensure-rules-directory",
          effectKind: "create-managed-directory",
        },
        {
          arguments: { contentSha256: CONTENT_SHA256, path: ROUTER_PATH },
          effectId: "restore-router",
          effectKind: "restore-managed-file-content",
        },
      ],
      planSha256: built.planSha256,
      protocol: "GovernanceDoctorRepairEffectSummaryV1",
      targetId: built.targetId,
    };
    const summarySha256 = domainDigest("aih.governance-doctor-repair-effect-summary-v1", body);
    expect(summary.summarySha256).toBe(summarySha256);
    expect(canonicalGovernanceDoctorRepairEffectSummaryV1Bytes(summary).toString("utf8")).toBe(
      jcs({ ...body, summarySha256 }),
    );
    expect(Object.isFrozen(summary)).toBe(true);
    expect(() => governanceDoctorRepairEffectSummaryV1({ ...built })).toThrow(TypeError);
  });

  it("round-trips only through its exact canonical bytes", async () => {
    const operationValue = await operation();
    const built = createGovernanceDoctorRepairPlanV1(
      await planInput({ operation: operationValue }),
    );
    const bytes = canonicalGovernanceDoctorRepairPlanV1Bytes(built);
    const trusted = await planInput({
      operation: operationValue,
      profile: profile(),
      registry: registry(),
    });
    const parse = (transport: unknown) =>
      parseGovernanceDoctorRepairPlanV1Json({
        bytes: transport,
        operation: trusted.operation,
        profile: trusted.profile,
        registry: trusted.registry,
      });
    const parsed = parse(bytes);
    expect(parsed.planSha256).toBe(built.planSha256);
    expect(canonicalGovernanceDoctorRepairPlanV1Bytes(parsed).equals(bytes)).toBe(true);

    const text = bytes.toString("utf8");
    for (const hostile of [
      ` ${text}`,
      `${cp(0xfeff)}${text}`,
      `${text} `,
      `${text.slice(0, -1)},}`,
      text.replace('{"', '{"protocol":"GovernanceDoctorRepairPlanV1","'),
      text.replace(/^\{/, "{\n  "),
    ])
      expect(() => parse(Buffer.from(hostile, "utf8")), hostile.slice(0, 24)).toThrow(TypeError);
    expect(() => parse(text)).toThrow(TypeError);
    expect(() => parse(Buffer.alloc(0))).toThrow(TypeError);
    expect(() =>
      parse(Buffer.alloc(GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxTransportBytes + 1, 0x20)),
    ).toThrow(TypeError);
    expect(() =>
      parse(
        Buffer.from(
          text.replace(/"planSha256":"[a-f0-9]{64}"/, `"planSha256":"${"0".repeat(64)}"`),
          "utf8",
        ),
      ),
    ).toThrow(TypeError);
  });

  it("never rehydrates an authorization from plan bytes without matching trusted joins", async () => {
    const operationValue = await operation();
    const built = createGovernanceDoctorRepairPlanV1(
      await planInput({ operation: operationValue }),
    );
    const bytes = canonicalGovernanceDoctorRepairPlanV1Bytes(built);
    expect(() => parseGovernanceDoctorRepairPlanV1Json(bytes)).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorRepairPlanV1Json({
        bytes,
        operation: operationValue,
        profile: profile(),
        registry: createGovernanceDoctorRepairBrokerRegistryV1({
          brokerId: "aih:governance-doctor.other",
          owner: "aih",
          recipes: [],
        }),
      }),
    ).toThrow(TypeError);
  });

  it("rejects every independently rehashed trusted-join swap", async () => {
    const operationValue = await operation();
    const built = createGovernanceDoctorRepairPlanV1(
      await planInput({ operation: operationValue }),
    );
    const trusted = await planInput({
      operation: operationValue,
      profile: profile(),
      registry: registry(),
    });
    const rehash = (mutate: (record: Record<string, unknown>) => void) => {
      const record = JSON.parse(
        canonicalGovernanceDoctorRepairPlanV1Bytes(built).toString("utf8"),
      ) as Record<string, unknown>;
      mutate(record);
      const authority = record.authority as Record<string, unknown>;
      authority.authoritySha256 = domainDigest("aih.governance-doctor-repair-authority-v1", {
        grantedTo: authority.grantedTo,
        policyRevisionSha256: authority.policyRevisionSha256,
        requires: authority.requires,
        surfaceRevisionSha256: authority.surfaceRevisionSha256,
      });
      const effects = record.effects as Record<string, unknown>[];
      for (const [index, effect] of effects.entries())
        effect.effectSha256 = domainDigest("aih.governance-doctor-repair-effect-v1", {
          arguments: effect.arguments,
          effectId: effect.effectId,
          effectKind: effect.effectKind,
          index,
          planNonce: record.planNonce,
          templateId: effect.templateId,
        });
      const evidence = record.evidence as Record<string, unknown>;
      evidence.evidenceSha256 = domainDigest("aih.governance-doctor-repair-evidence-v1", {
        auditSha256: record.auditSha256,
        findings: evidence.findings,
        refusals: evidence.refusals,
      });
      const { planSha256: _ignored, ...body } = record;
      record.planSha256 = domainDigest("aih.governance-doctor-repair-plan-v1", body);
      return Buffer.from(jcs(record), "utf8");
    };
    const parse = (bytes: Buffer) =>
      parseGovernanceDoctorRepairPlanV1Json({
        bytes,
        operation: trusted.operation,
        profile: trusted.profile,
        registry: trusted.registry,
      });
    for (const mutate of [
      (record: Record<string, unknown>) => {
        const authority = record.authority as Record<string, unknown>;
        authority.policyRevisionSha256 = "a".repeat(64);
        record.policyRevisionSha256 = "a".repeat(64);
      },
      (record: Record<string, unknown>) => {
        const authority = record.authority as Record<string, unknown>;
        authority.surfaceRevisionSha256 = "b".repeat(64);
        record.surfaceRevisionSha256 = "b".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.rootSha256 = "c".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.auditSha256 = "d".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.guideSha256 = "e".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.operationSha256 = "f".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.profileSha256 = "1".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.contextSha256 = "2".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.targetId = "target:aih.other";
      },
      (record: Record<string, unknown>) => {
        record.registrySha256 = "3".repeat(64);
      },
      (record: Record<string, unknown>) => {
        record.recipeSha256 = "4".repeat(64);
      },
      (record: Record<string, unknown>) => {
        const first = (record.effects as Record<string, unknown>[])[0];
        if (first === undefined) throw new Error("fixture must have an effect");
        first.templateId = "restore-canon-router";
      },
      (record: Record<string, unknown>) => {
        record.brokerId = "aih:governance-doctor.other";
      },
      (record: Record<string, unknown>) => {
        const evidence = record.evidence as Record<string, unknown>;
        evidence.findings = [{ code: "OTHER_CODE", diagnosticId: DOCTOR }];
      },
    ])
      expect(() => parse(rehash(mutate))).toThrow(TypeError);
  });

  it("deep freezes the plan and hands back defensive canonical bytes", async () => {
    const built = await plan();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.effects)).toBe(true);
    expect(Object.isFrozen(built.effects[0])).toBe(true);
    expect(Object.isFrozen(built.effects[0]?.arguments)).toBe(true);
    expect(Object.isFrozen(built.scope)).toBe(true);
    expect(Object.isFrozen(built.scope.paths)).toBe(true);
    expect(Object.isFrozen(built.evidence)).toBe(true);
    expect(Object.isFrozen(built.authority)).toBe(true);

    const first = canonicalGovernanceDoctorRepairPlanV1Bytes(built);
    first.fill(0);
    expect(canonicalGovernanceDoctorRepairPlanV1Bytes(built).equals(first)).toBe(false);

    const forged = JSON.parse(
      canonicalGovernanceDoctorRepairPlanV1Bytes(built).toString("utf8"),
    ) as unknown;
    expect(() => canonicalGovernanceDoctorRepairPlanV1Bytes(forged)).toThrow(TypeError);
    expect(() => canonicalGovernanceDoctorRepairPlanV1Bytes({ ...built })).toThrow(TypeError);
  });

  it("deep copies its input so post-return mutation cannot alter the plan", async () => {
    const input = await planInput();
    const built = createGovernanceDoctorRepairPlanV1(input);
    const before = canonicalGovernanceDoctorRepairPlanV1Bytes(built);
    (input.effects[0] as Record<string, unknown>).effectId = "mutated";
    (input.scope as { paths: string[] }).paths.push("ai-coding/other");
    expect(canonicalGovernanceDoctorRepairPlanV1Bytes(built).equals(before)).toBe(true);
  });
});

describe("createGovernanceDoctorRepairPlanV1 cross-record joins", () => {
  it("requires branded, mutually consistent operation, audit, guide, and profile", async () => {
    const built = await operation();
    const gapped = await operation({}, { policy: "fail" });
    const scaffold = planScaffold(built);
    // The brand lives on the audit, the guide, and the record -- not on the
    // container -- so an equivalent container over the same branded members is
    // the same operation, while any unbranded or swapped member is refused.
    expect(
      createGovernanceDoctorRepairPlanV1({ ...scaffold, operation: { ...built } }).planSha256,
    ).toBe(createGovernanceDoctorRepairPlanV1(scaffold).planSha256);
    for (const operationValue of [
      undefined,
      null,
      {},
      { audit: built.audit, guide: built.guide, record: { ...built.record } },
      { audit: {}, guide: built.guide, record: built.record },
      { audit: built.audit, guide: {}, record: built.record },
      { audit: gapped.audit, guide: built.guide, record: built.record },
      { audit: built.audit, guide: gapped.guide, record: built.record },
      { audit: built.audit, guide: built.guide, extra: 1, record: built.record },
    ])
      expect(() =>
        createGovernanceDoctorRepairPlanV1({ ...scaffold, operation: operationValue }),
      ).toThrow(TypeError);
  });

  it("refuses a refused operation and an incompatible profile", async () => {
    const denied = await operation({
      policy: { decision: "denied", revisionSha256: policyRevisionSha256 },
    });
    expect(denied.record.kind).toBe("refused");
    await expect(
      (async () =>
        createGovernanceDoctorRepairPlanV1(
          await planInput({ evidence: { findings: [], refusals: [] }, operation: denied }),
        ))(),
    ).rejects.toThrow(TypeError);

    const incompatible = await operation({ profile: profile({ schemaVersion: "2" }) });
    await expect(
      (async () =>
        createGovernanceDoctorRepairPlanV1(
          await planInput({ operation: incompatible, profile: profile({ schemaVersion: "2" }) }),
        ))(),
    ).rejects.toThrow(TypeError);
  });

  it("refuses a profile that is not the one the operation ran against", async () => {
    await expect(
      (async () =>
        createGovernanceDoctorRepairPlanV1(
          await planInput({ profile: profile({ targetId: "target:aih.other" }) }),
        ))(),
    ).rejects.toThrow(TypeError);
    await expect(
      (async () => createGovernanceDoctorRepairPlanV1(await planInput({ profile: undefined })))(),
    ).rejects.toThrow(TypeError);
  });

  it("refuses evidence the audit never reported", async () => {
    const scaffold = planScaffold(await operation());
    for (const evidence of [
      { findings: [], refusals: [] },
      { findings: [{ code: "OTHER_CODE", diagnosticId: DOCTOR }], refusals: [] },
      { findings: [{ code: PROBE_CODE, diagnosticId: "aih.status.root" }], refusals: [] },
      {
        findings: [{ code: PROBE_CODE, diagnosticId: DOCTOR }],
        refusals: [{ diagnosticId: DOCTOR, state: "evidence-gap" }],
      },
      {
        findings: [
          { code: PROBE_CODE, diagnosticId: DOCTOR },
          { code: PROBE_CODE, diagnosticId: DOCTOR },
        ],
        refusals: [],
      },
      { findings: [{ code: PROBE_CODE, diagnosticId: DOCTOR }] },
      { extra: 1, findings: [{ code: PROBE_CODE, diagnosticId: DOCTOR }], refusals: [] },
    ])
      expect(
        () => createGovernanceDoctorRepairPlanV1({ ...scaffold, evidence }),
        JSON.stringify(evidence),
      ).toThrow(TypeError);
  });

  it("accepts a refusal the audit actually reported", async () => {
    const gapped = await operation({}, { policy: "fail" });
    if (gapped.audit.kind !== "audited") throw new Error("expected an audited operation");
    expect(gapped.audit.refusals).toEqual([{ diagnosticId: POLICY, state: "evidence-gap" }]);
    const scaffold = planScaffold(gapped);
    const built = createGovernanceDoctorRepairPlanV1({
      ...scaffold,
      evidence: { findings: [], refusals: [{ diagnosticId: POLICY, state: "evidence-gap" }] },
    });
    expect(built.evidence.refusals).toEqual([{ diagnosticId: POLICY, state: "evidence-gap" }]);
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        evidence: { findings: [], refusals: [{ diagnosticId: POLICY, state: "unmanaged-drift" }] },
      }),
    ).toThrow(TypeError);
  });

  it("refuses a broker registry, recipe, or template the plan does not actually name", async () => {
    const scaffold = planScaffold(await operation());
    expect(() => createGovernanceDoctorRepairPlanV1({ ...scaffold, registry: undefined })).toThrow(
      TypeError,
    );
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        registry: JSON.parse(JSON.stringify(registry())) as unknown,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairPlanV1({ ...scaffold, recipeId: "absent-recipe" }),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        effects: [{ ...effects()[0], templateId: "absent-template" }],
        scope: { paths: [RULES_PATH] },
      }),
    ).toThrow(TypeError);
  });
});

describe("createGovernanceDoctorRepairPlanV1 effect, scope, and window bounds", () => {
  it("refuses duplicate effect identities and duplicate mechanical effects", async () => {
    const scaffold = planScaffold(await operation());
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        effects: [effects()[0], { ...effects()[1], effectId: "ensure-rules-directory" }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        effects: [effects()[0], { ...effects()[0], effectId: "duplicate-effect" }],
      }),
    ).toThrow(TypeError);
  });

  it("refuses two effects that declare the same managed path", async () => {
    const scaffold = planScaffold(await operation());
    // Distinct kinds on one path: the verifier's per-effect provenance evidence
    // makes every earlier same-path goal stale by construction, so the shape has
    // no verifiable reading and is refused when the plan is built.
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        effects: [
          effects()[0],
          {
            ...effects()[1],
            arguments: { contentSha256: CONTENT_SHA256, path: RULES_PATH },
          },
        ],
      }),
    ).toThrow(TypeError);
    // Distinct content digests on one path: same refusal, same reason.
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        effects: [
          effects()[1],
          {
            ...effects()[1],
            arguments: { contentSha256: "d".repeat(64), path: ROUTER_PATH },
            effectId: "restore-router-again",
          },
        ],
      }),
    ).toThrow(TypeError);
  });

  it("refuses an empty, oversized, or unknown-field effect list", async () => {
    const scaffold = planScaffold(await operation());
    expect(() => createGovernanceDoctorRepairPlanV1({ ...scaffold, effects: [] })).toThrow(
      TypeError,
    );
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        effects: Array.from(
          { length: GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects + 1 },
          (_, index) => ({
            ...effects()[0],
            arguments: { path: `ai-coding/path-${String(index).padStart(3, "0")}` },
            effectId: `effect-${String(index).padStart(3, "0")}`,
          }),
        ),
        scope: {
          paths: Array.from(
            { length: GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects + 1 },
            (_, index) => `ai-coding/path-${String(index).padStart(3, "0")}`,
          ),
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        effects: [{ ...effects()[0], extra: 1 }],
        scope: { paths: [RULES_PATH] },
      }),
    ).toThrow(TypeError);
  });

  it("refuses any effect path outside the declared scope", async () => {
    const scaffold = planScaffold(await operation());
    expect(() =>
      createGovernanceDoctorRepairPlanV1({ ...scaffold, scope: { paths: [RULES_PATH] } }),
    ).toThrow(TypeError);
    expect(
      createGovernanceDoctorRepairPlanV1({
        ...scaffold,
        scope: { paths: [RULES_PATH, ROUTER_PATH, "ai-coding"] },
      }).scope.paths,
    ).toEqual(["ai-coding", ROUTER_PATH, RULES_PATH]);
    for (const scope of [
      { paths: [] },
      { paths: [RULES_PATH, RULES_PATH, ROUTER_PATH] },
      { extra: 1, paths: [RULES_PATH, ROUTER_PATH] },
      {
        paths: Array.from(
          { length: GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxScopePaths + 1 },
          (_, index) => `ai-coding/path-${String(index).padStart(3, "0")}`,
        ),
      },
    ])
      expect(
        () => createGovernanceDoctorRepairPlanV1({ ...scaffold, scope }),
        JSON.stringify(scope).slice(0, 40),
      ).toThrow(TypeError);
  });

  it("refuses a malformed nonce and an invalid or unbounded validity window", async () => {
    const scaffold = planScaffold(await operation());
    for (const planNonce of ["", "a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`, 1, null])
      expect(
        () => createGovernanceDoctorRepairPlanV1({ ...scaffold, planNonce }),
        String(planNonce),
      ).toThrow(TypeError);

    for (const window of [
      { createdAtEpochMs: EXPIRES_AT, expiresAtEpochMs: CREATED_AT },
      { createdAtEpochMs: CREATED_AT, expiresAtEpochMs: CREATED_AT },
      {
        createdAtEpochMs: CREATED_AT,
        expiresAtEpochMs: CREATED_AT + GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxPlanLifetimeMs + 1,
      },
      { createdAtEpochMs: 0, expiresAtEpochMs: EXPIRES_AT },
      { createdAtEpochMs: CREATED_AT + 0.5, expiresAtEpochMs: EXPIRES_AT },
      { createdAtEpochMs: Number.NaN, expiresAtEpochMs: EXPIRES_AT },
      { createdAtEpochMs: CREATED_AT, expiresAtEpochMs: Number.MAX_SAFE_INTEGER },
      { createdAtEpochMs: "1777000000000", expiresAtEpochMs: EXPIRES_AT },
    ])
      expect(
        () => createGovernanceDoctorRepairPlanV1({ ...scaffold, ...window }),
        JSON.stringify(window),
      ).toThrow(TypeError);
  });

  it("refuses proxied, accessor-backed, sparse, and unknown-field requests", async () => {
    let observed = false;
    const proxied = new Proxy(await planInput(), {
      get(target, key, receiver) {
        observed = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createGovernanceDoctorRepairPlanV1(proxied)).toThrow(TypeError);
    expect(observed).toBe(false);

    let read = false;
    const accessor = await planInput();
    Object.defineProperty(accessor, "effects", {
      configurable: true,
      enumerable: true,
      get() {
        read = true;
        return effects();
      },
    });
    expect(() => createGovernanceDoctorRepairPlanV1(accessor)).toThrow(TypeError);
    expect(read).toBe(false);

    const sparse = await planInput();
    // A hole, not a missing key: the exact hostile array shape under test.
    delete (sparse.effects as unknown[])[0];
    expect(() => createGovernanceDoctorRepairPlanV1(sparse)).toThrow(TypeError);

    const scaffold = planScaffold(await operation());
    expect(() => createGovernanceDoctorRepairPlanV1({ ...scaffold, unexpected: true })).toThrow(
      TypeError,
    );
    for (const notARecord of [null, undefined, 0, "plan", [], true])
      expect(() => createGovernanceDoctorRepairPlanV1(notARecord), String(notARecord)).toThrow(
        TypeError,
      );
  });
});

/** A synchronous plan request over one already-built operation. */
function planScaffold(built: GovernanceDoctorOperationV1): Record<string, unknown> {
  return {
    createdAtEpochMs: CREATED_AT,
    effects: effects(),
    evidence: { findings: [{ code: PROBE_CODE, diagnosticId: DOCTOR }], refusals: [] },
    expiresAtEpochMs: EXPIRES_AT,
    operation: built,
    planNonce: NONCE,
    profile: profile(),
    recipeId: "restore-repository-canon",
    registry: registry(),
    scope: { paths: [RULES_PATH, ROUTER_PATH] },
  };
}
