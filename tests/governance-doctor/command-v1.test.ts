import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_COMMAND_SPEC_PATHS, READONLY } from "../../src/commands/index.js";
import { runCapability } from "../../src/commands/run.js";
import { command as doctorCommand } from "../../src/doctor.js";
import { GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES } from "../../src/governance-doctor/capability-v1.js";
import {
  command as governanceDoctorCommand,
  loadShippedGovernanceDoctorProfileV1,
  presentGovernanceDoctorOperationV1,
  presentGovernanceDoctorUnavailableV1,
  resolveGovernanceDoctorPolicyStateV1,
  SHIPPED_GOVERNANCE_DOCTOR_PROFILE_RELATIVE_PATH_V1,
} from "../../src/governance-doctor/command-v1.js";
import {
  createGovernanceDoctorOperationalContextV1,
  runGovernanceDoctorOperationV1,
} from "../../src/governance-doctor/operational-v1.js";
import {
  canonicalGovernanceDoctorProfileV1Bytes,
  createGovernanceDoctorProfileV1,
  governanceDoctorProfileV1Sha256,
  parseGovernanceDoctorProfileV1Json,
} from "../../src/governance-doctor/profile-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyEvaluateCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";

const repoRoot = resolve(__dirname, "..", "..");
const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
const STATUS = "aih.status.root";
const commandSource = readFileSync(
  resolve(repoRoot, "src/governance-doctor/command-v1.ts"),
  "utf8",
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-governance-doctor-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** The exact zero-write flag surface the shared registry gives this spec. */
function zeroWriteCommand(argv: readonly string[]): Command {
  const cmd = new Command("governance-doctor");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--json")
    .option("--posture <posture>", "", "vibe")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding");
  cmd.parse([...argv], { from: "user" });
  return cmd;
}

async function runCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCapability(governanceDoctorCommand, zeroWriteCommand(argv), {
    env,
    run: fakeRunner(() => undefined),
    write: (text) => {
      out += text;
    },
  });
  return { code, out };
}

function jsonPayload(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

function report(out: string): Record<string, unknown> {
  const payload = jsonPayload(out) as { digests?: Array<{ data?: Record<string, unknown> }> };
  const data = payload.digests?.[0]?.data;
  if (data === undefined) throw new Error("expected a governance doctor digest payload");
  return data;
}

function passingProbePlan(capability: string, name: string) {
  return {
    actions: [
      {
        describe: name,
        kind: "probe" as const,
        run: async () => ({ name, verdict: "pass" as const }),
      },
    ],
    capability,
  };
}

/** Force both code-owned diagnostics to pass so the completed path is deterministic. */
function stubPassingDiagnostics(): void {
  vi.spyOn(doctorCommand, "plan").mockImplementation(() => passingProbePlan("doctor", "doctor"));
  vi.spyOn(policyEvaluateCommand, "plan").mockImplementation(() =>
    passingProbePlan("policy evaluate", "policy"),
  );
}

function planContext(overrides: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    apply: false,
    contextDir: "ai-coding",
    env: {},
    host: makeHostAdapter({ env: {}, platform: "linux", run }),
    json: false,
    options: {},
    root: dir,
    run,
    verify: true,
    ...overrides,
  };
}

/** A schema-valid org policy in the temp fixture root; never this checkout. */
function writePolicy(overrides: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "aih-org-policy.json"),
    JSON.stringify({
      references: { repoContract: "ai-coding/project.json" },
      schemaVersion: 2,
      ...overrides,
    }),
  );
}

function prose(text = "Read the bounded result.") {
  return { attribution: "aih:governance-doctor", text };
}

function localProfile(overrides: Record<string, unknown> = {}) {
  return createGovernanceDoctorProfileV1({
    conflicts: [
      { conflictId: "other", conflictsWithSurfaceId: "surface:aih.other", note: prose() },
    ],
    diagnosticIds: [DOCTOR, POLICY],
    effectVersion: "1",
    guidance: prose(),
    nextActionId: STATUS,
    prerequisites: [
      { note: prose(), prerequisiteId: "policy", satisfiedBy: "org-policy" as const },
    ],
    profileVersion: "1",
    protocol: "GovernanceDoctorProfileV1" as const,
    repairPosture: "guided-only" as const,
    roles: [{ owner: "aih" as const, roleId: "owner", summary: prose() }],
    schemaVersion: "1",
    surfaceId: "surface:aih.governance-doctor",
    targetId: "target:aih.workstation",
    ...overrides,
  });
}

async function localOperation(
  policy: ReturnType<typeof ownedPolicy>,
  profileValue: ReturnType<typeof localProfile>,
) {
  return await runGovernanceDoctorOperationV1({
    context: createGovernanceDoctorOperationalContextV1(planContext()),
    policy: { decision: policy.decision, revisionSha256: policy.revisionSha256 },
    profile: profileValue,
  });
}

function ownedPolicy(context: PlanContext = planContext()) {
  return resolveGovernanceDoctorPolicyStateV1(createGovernanceDoctorOperationalContextV1(context));
}

describe("aih governance-doctor — command registration", () => {
  it("registers exactly one non-recursive top-level read-only zero-write route", () => {
    expect(governanceDoctorCommand.name).toBe("governance-doctor");
    expect(governanceDoctorCommand.readOnly).toBe(true);
    expect(governanceDoctorCommand.zeroWrite).toBe(true);
    expect(governanceDoctorCommand.honorReadOnlyPostureFlag).toBe(true);
    expect(governanceDoctorCommand.options ?? []).toEqual([]);
    expect(governanceDoctorCommand.aliases).toBeUndefined();
    expect(governanceDoctorCommand.deprecatedAliases).toBeUndefined();
    expect(READONLY.map((spec) => spec.name)).toContain("governance-doctor");
    expect(ALL_COMMAND_SPEC_PATHS).toContainEqual(["governance-doctor"]);
  });

  it("exposes only the shared zero-write flag surface and never extends aih doctor", () => {
    const program = buildProgram();
    const node = program.commands.find((command) => command.name() === "governance-doctor");
    expect(node?.description().length).toBeGreaterThan(0);
    expect(node?.options.map((option) => option.flags).sort()).toEqual([
      "--context-dir <dir>",
      "--json",
      "--posture <posture>",
      "--root <dir>",
    ]);
    const doctor = program.commands.find((command) => command.name() === "doctor");
    expect(doctor?.commands.map((command) => command.name())).toEqual([]);
    expect(commandSource).not.toMatch(/--apply|--support-out|--no-log|--sarif|--profile/);
  });

  it("rejects apply, force, verify, support-output, logging, and profile-selecting inputs", () => {
    for (const flag of [
      "--apply",
      "--force",
      "--verify",
      "--support-out",
      "--no-log",
      "--sarif",
      "--profile",
      "--profile-path",
    ]) {
      const node = buildProgram().commands.find(
        (command) => command.name() === "governance-doctor",
      );
      if (node === undefined) throw new Error("governance-doctor is not registered");
      node.exitOverride();
      node.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      expect(() => node.parse([flag, "value"], { from: "user" }), flag).toThrow();
    }
  });
});

describe("aih governance-doctor — shipped profile", () => {
  it("loads only the shipped canonical profile with matching identity and bytes", () => {
    expect(SHIPPED_GOVERNANCE_DOCTOR_PROFILE_RELATIVE_PATH_V1).toBe(
      "packs/governance-quality/governance-doctor-audit-guide/profile.json",
    );
    const bytes = readFileSync(
      resolve(repoRoot, SHIPPED_GOVERNANCE_DOCTOR_PROFILE_RELATIVE_PATH_V1),
    );
    const shipped = loadShippedGovernanceDoctorProfileV1();
    expect(governanceDoctorProfileV1Sha256(shipped)).toBe(
      governanceDoctorProfileV1Sha256(parseGovernanceDoctorProfileV1Json(bytes)),
    );
    expect(canonicalGovernanceDoctorProfileV1Bytes(shipped).equals(bytes)).toBe(true);
    expect(shipped.surfaceId).toBe("surface:aih.governance-doctor");
    expect(shipped.targetId).toBe("target:aih.workstation");
    expect(shipped.nextActionId).toBe(STATUS);
    expect(shipped.diagnosticIds).toEqual([DOCTOR, POLICY]);
    expect(loadShippedGovernanceDoctorProfileV1.length).toBe(0);
  });

  it("loads the shipped profile through the fd-guarded bounded file boundary", () => {
    const loader = commandSource.slice(
      commandSource.indexOf("export function loadShippedGovernanceDoctorProfileV1"),
      commandSource.indexOf("export function resolveGovernanceDoctorPolicyStateV1"),
    );
    expect(loader).toContain("readRegularFile(target,");
    expect(loader).toContain("maxBytes: GOVERNANCE_DOCTOR_V1_LIMITS.maxTransportBytes");
    expect(loader).not.toMatch(/\blstatSync\b|\breadFileSync\(target/);
  });
});

describe("aih governance-doctor — code-owned policy state", () => {
  it("treats an absent optional repo policy as allowed with a deterministic revision", () => {
    const state = ownedPolicy();
    expect(state).toEqual({
      decision: "allowed",
      revisionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      source: "absent",
    });
    expect(ownedPolicy().revisionSha256).toBe(state.revisionSha256);
  });

  it("separates governed, ungoverned, and unreadable org-policy sources", () => {
    writePolicy({ minimumPosture: "vibe" });
    const ungoverned = ownedPolicy();
    expect(ungoverned.source).toBe("ungoverned");
    expect(ungoverned.decision).toBe("allowed");

    writePolicy({
      governance: { catalog: { custom: [], reviewed: [] }, policyVersion: "2026.08.0" },
      minimumPosture: "vibe",
    });
    const governed = ownedPolicy();
    expect(governed).toMatchObject({ decision: "allowed", source: "governed" });
    expect(governed.revisionSha256).not.toBe(ungoverned.revisionSha256);

    const unreadable = ownedPolicy(planContext({ env: { AIH_ORG_POLICY: "missing-policy.json" } }));
    expect(unreadable).toMatchObject({ decision: "denied", source: "unreadable" });
    expect(unreadable.revisionSha256).not.toBe(ungoverned.revisionSha256);
  });

  it("denies a run below the org policy posture floor and never reads a caller decision", () => {
    writePolicy({
      governance: {
        catalog: { custom: [], reviewed: [] },
        policyVersion: "2026.08.0",
        supportedClis: ["claude"],
      },
      minimumPosture: "enterprise",
    });
    expect(ownedPolicy(planContext({ posture: "vibe" }))).toMatchObject({
      decision: "denied",
    });
    expect(ownedPolicy(planContext({ posture: "enterprise" }))).toMatchObject({
      decision: "allowed",
    });
    expect(
      ownedPolicy(
        planContext({
          options: { decision: "allowed", policy: "allowed", revisionSha256: "0".repeat(64) },
          posture: "vibe",
        }),
      ),
    ).toMatchObject({ decision: "denied" });
  });

  it("binds the revision to the resolved posture context rather than a caller value", () => {
    const vibe = ownedPolicy(planContext({ posture: "vibe", postureSource: "default" }));
    const enterprise = ownedPolicy(
      planContext({ posture: "enterprise", postureSource: "org-floor" }),
    );
    expect(vibe.revisionSha256).not.toBe(enterprise.revisionSha256);
  });

  it("rejects hostile context descriptors before resolving policy state", () => {
    let reads = 0;
    const context = {
      ...planContext(),
      get root() {
        reads += 1;
        return dir;
      },
    };
    expect(() => resolveGovernanceDoctorPolicyStateV1(context)).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it("rejects hostile plan-context, host, and environment records before a command reads them", async () => {
    let reads = 0;
    const accessor = {
      ...planContext(),
      get root() {
        reads += 1;
        return dir;
      },
    };
    await expect(governanceDoctorCommand.plan(accessor as PlanContext)).rejects.toThrow(TypeError);
    expect(reads).toBe(0);

    const hostileHost = new Proxy(planContext().host, {
      get() {
        reads += 1;
        return undefined;
      },
    });
    await expect(
      governanceDoctorCommand.plan(planContext({ host: hostileHost as PlanContext["host"] })),
    ).rejects.toThrow(TypeError);
    expect(reads).toBe(0);

    const hostileEnv = new Proxy(
      {},
      {
        get() {
          reads += 1;
          return undefined;
        },
      },
    );
    await expect(
      governanceDoctorCommand.plan(planContext({ env: hostileEnv as NodeJS.ProcessEnv })),
    ).rejects.toThrow(TypeError);
    expect(reads).toBe(0);
  });
});

describe("aih governance-doctor — completed presentation", () => {
  it("emits stable human output and exits zero when the audit completes", async () => {
    stubPassingDiagnostics();
    const { code, out } = await runCommand([dir]);
    expect(code).toBe(0);
    expect(out).toContain("Governance Doctor audit and guide");
    expect(out).toContain("outcome: completed");
    expect(out).toContain("state: none");
    expect(out).toContain("policy decision: allowed (source: absent)");
    expect(out).toContain("surface: surface:aih.governance-doctor");
    expect(out).toContain("target: target:aih.workstation");
    expect(out).toContain("repair posture: guided-only");
    expect(out).toContain(`next action: ${STATUS} (owner: aih, executable: false)`);
    expect(out).toContain(`dispatched diagnostics: ${DOCTOR}, ${POLICY}`);
    expect(out).toContain(
      "Read-only presentation: no next action, Status, or Repair is executed, and nothing is written.",
    );
    expect(out).toContain('authority none]: "');
    expect(out).not.toContain("pass --apply");
  });

  it("emits a closed, stable JSON report and exits zero when the audit completes", async () => {
    stubPassingDiagnostics();
    const { code, out } = await runCommand([dir, "--json"]);
    expect(code).toBe(0);
    const data = report(out);
    expect(Object.keys(data).sort()).toEqual([
      "conflicts",
      "dispatchedDiagnosticIds",
      "findings",
      "guidance",
      "identity",
      "nextAction",
      "outcome",
      "policy",
      "prerequisites",
      "protocol",
      "refusals",
      "repairPosture",
      "roles",
      "state",
      "surfaceId",
      "targetId",
    ]);
    expect(data.protocol).toBe("GovernanceDoctorPresentationV1");
    expect(data.outcome).toBe("completed");
    expect(data.state).toBeNull();
    expect(data.refusals).toEqual([]);
    expect(data.dispatchedDiagnosticIds).toEqual([DOCTOR, POLICY]);
    expect(data.nextAction).toEqual({
      actionId: STATUS,
      executable: false,
      owner: "aih",
      unavailable: false,
    });
    expect(data.policy).toMatchObject({ decision: "allowed", source: "absent" });
    expect(Object.keys(data.identity as Record<string, unknown>).sort()).toEqual([
      "auditSha256",
      "contextSha256",
      "guideSha256",
      "operationSha256",
      "profileSha256",
      "rootSha256",
      "surfaceRevisionSha256",
    ]);
  });

  it("invokes the operational adapter exactly once and never re-enters a Doctor route", async () => {
    const doctor = vi
      .spyOn(doctorCommand, "plan")
      .mockImplementation(() => passingProbePlan("doctor", "doctor"));
    const policy = vi
      .spyOn(policyEvaluateCommand, "plan")
      .mockImplementation(() => passingProbePlan("policy evaluate", "policy"));
    const governance = vi.spyOn(governanceDoctorCommand, "plan");
    const { code } = await runCommand([dir, "--json"]);
    expect(code).toBe(0);
    expect(governance).toHaveBeenCalledTimes(1);
    expect(doctor).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it("never plans, runs, or repairs the guided next action", async () => {
    const statusSpec = READONLY.find((spec) => spec.name === "status");
    if (statusSpec === undefined) throw new Error("status command is missing");
    const status = vi.spyOn(statusSpec, "plan");
    stubPassingDiagnostics();
    const { out } = await runCommand([dir, "--json"]);
    expect(status).not.toHaveBeenCalled();
    const data = report(out);
    expect((data.nextAction as { executable: boolean }).executable).toBe(false);
    expect(data.repairPosture).toBe("guided-only");
    expect(JSON.stringify(data)).not.toMatch(/--[a-z]|[^a-z]exec[^a-z]|repair(?!Posture)/i);
  });
});

describe("aih governance-doctor — refused, incompatible, and evidence-gap outcomes", () => {
  it("reports a policy-denied refusal as a withheld guide", async () => {
    const policy = ownedPolicy(planContext({ env: { AIH_ORG_POLICY: "missing-policy.json" } }));
    const operation = await localOperation(policy, localProfile());
    const presentation = presentGovernanceDoctorOperationV1(operation, policy);
    expect(presentation.report.outcome).toBe("refused");
    expect(presentation.report.state).toBe("policy-denied");
    expect(presentation.report.nextAction).toEqual({
      actionId: null,
      executable: false,
      owner: "aih",
      unavailable: true,
    });
    expect(presentation.check.verdict).toBe("fail");
    expect(presentation.text).toContain("outcome: refused");
    expect(presentation.text).toContain("state: policy-denied");
  });

  it("reports an incompatible profile as compatibility-required", async () => {
    const policy = ownedPolicy();
    const operation = await localOperation(policy, localProfile({ schemaVersion: "2" }));
    const presentation = presentGovernanceDoctorOperationV1(operation, policy);
    expect(presentation.report.outcome).toBe("refused");
    expect(presentation.report.state).toBe("compatibility-required");
    expect(presentation.check.verdict).toBe("fail");
  });

  it("reports a declared diagnostic with no code-owned adapter as missing-adapter", async () => {
    vi.spyOn(doctorCommand, "plan").mockImplementation(() => passingProbePlan("doctor", "doctor"));
    const policy = ownedPolicy();
    const operation = await localOperation(
      policy,
      localProfile({ diagnosticIds: [DOCTOR, STATUS] }),
    );
    const presentation = presentGovernanceDoctorOperationV1(operation, policy);
    expect(presentation.report.outcome).toBe("evidence-gap");
    expect(presentation.report.refusals).toEqual([
      { diagnosticId: STATUS, state: "missing-adapter" },
    ]);
    expect(presentation.check.verdict).toBe("fail");
  });

  it("exits non-zero from the CLI when a dispatched diagnostic yields an evidence gap", async () => {
    vi.spyOn(doctorCommand, "plan").mockImplementation(() => ({
      actions: [
        {
          describe: "doctor",
          kind: "probe" as const,
          run: async () => ({ name: "doctor", verdict: "fail" as const }),
        },
      ],
      capability: "doctor",
    }));
    vi.spyOn(policyEvaluateCommand, "plan").mockImplementation(() =>
      passingProbePlan("policy evaluate", "policy"),
    );
    const { code, out } = await runCommand([dir, "--json"]);
    expect(code).toBe(1);
    const data = report(out);
    expect(data.outcome).toBe("evidence-gap");
    expect(data.refusals).toEqual([{ diagnosticId: DOCTOR, state: "evidence-gap" }]);
  });

  it("reports a bounded unavailable presentation when no run can be produced", () => {
    const presentation = presentGovernanceDoctorUnavailableV1("profile-unavailable", ownedPolicy());
    expect(presentation.report.outcome).toBe("unavailable");
    expect(presentation.report.state).toBe("profile-unavailable");
    expect(presentation.report.identity).toBeNull();
    expect(presentation.report.findings).toEqual([]);
    expect(presentation.check.verdict).toBe("fail");
  });
});

describe("aih governance-doctor — posture and org policy handling", () => {
  it("honors --posture for this posture-scoped read-only route", async () => {
    stubPassingDiagnostics();
    const enterprise = await runCommand([dir, "--json", "--posture", "enterprise"]);
    expect(enterprise.code).toBe(0);
    const vibe = await runCommand([dir, "--json"]);
    expect((report(enterprise.out).identity as { contextSha256: string }).contextSha256).not.toBe(
      (report(vibe.out).identity as { contextSha256: string }).contextSha256,
    );

    const invalid = await runCommand([dir, "--json", "--posture", "nonsense"]);
    expect(invalid.code).toBe(1);
    expect(jsonPayload(invalid.out)).toMatchObject({ error: { code: "AIH_SETTINGS" } });
    expect(invalid.out).not.toContain("GovernanceDoctorPresentationV1");
  });

  it("fails the run closed when an explicitly configured org policy cannot be read", async () => {
    stubPassingDiagnostics();
    const { code, out } = await runCommand([dir, "--json"], {
      AIH_ORG_POLICY: "missing-policy.json",
    });
    expect(code).toBe(1);
    expect(jsonPayload(out)).toMatchObject({ error: { code: "AIH_ORG_POLICY" } });
    expect(out).not.toContain("GovernanceDoctorPresentationV1");
  });
});

describe("aih governance-doctor — closed boundary and zero-write proof", () => {
  it("refuses proxied, accessor-bearing, and forged inputs without invoking a getter", async () => {
    const policy = ownedPolicy();
    const operation = await localOperation(policy, localProfile());

    let touched = false;
    const trap = new Proxy(
      { audit: operation.audit, guide: operation.guide, record: operation.record },
      {
        get(target, key, receiver) {
          touched = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => presentGovernanceDoctorOperationV1(trap, policy)).toThrow(TypeError);
    expect(touched).toBe(false);

    const accessor = {
      audit: operation.audit,
      guide: operation.guide,
      get record() {
        touched = true;
        return operation.record;
      },
    };
    expect(() => presentGovernanceDoctorOperationV1(accessor, policy)).toThrow(TypeError);
    expect(touched).toBe(false);

    const forged = JSON.parse(JSON.stringify(operation)) as unknown;
    expect(() => presentGovernanceDoctorOperationV1(forged, policy)).toThrow(TypeError);

    expect(() =>
      presentGovernanceDoctorOperationV1(operation, {
        decision: "allowed",
        revisionSha256: "f".repeat(64),
        source: "absent",
      }),
    ).toThrow(TypeError);
    expect(() =>
      presentGovernanceDoctorOperationV1(operation, {
        decision: "allowed",
        revisionSha256: policy.revisionSha256,
        source: "governed",
      }),
    ).toThrow(TypeError);
    expect(() =>
      presentGovernanceDoctorOperationV1(operation, {
        ...policy,
        extra: true,
      } as unknown as typeof policy),
    ).toThrow(TypeError);

    const policyTrap = new Proxy(policy, {
      get(target, key, receiver) {
        touched = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => presentGovernanceDoctorOperationV1(operation, policyTrap)).toThrow(TypeError);
    expect(touched).toBe(false);

    const policyAccessor = {
      decision: policy.decision,
      revisionSha256: policy.revisionSha256,
      get source() {
        touched = true;
        return policy.source;
      },
    };
    expect(() => presentGovernanceDoctorOperationV1(operation, policyAccessor)).toThrow(TypeError);
    expect(touched).toBe(false);
    expect(() =>
      presentGovernanceDoctorOperationV1(operation, JSON.parse(JSON.stringify(policy))),
    ).toThrow(TypeError);
  });

  it("writes nothing, leaks no path, argv, environment, or raw check detail", async () => {
    const before = readdirSync(dir);
    const { code, out } = await runCommand([dir, "--json"], {
      AIH_SECRET_TOKEN: "super-secret-value",
    });
    expect([0, 1]).toContain(code);
    expect(readdirSync(dir)).toEqual(before);
    expect(existsSync(join(dir, ".aih"))).toBe(false);
    const payload = jsonPayload(out) as {
      digests: Array<{ data: Record<string, unknown>; text: string }>;
      writes: unknown[];
      execs: unknown[];
      removed: unknown[];
      support?: { templates: unknown[] };
    };
    expect(payload.writes).toEqual([]);
    expect(payload.execs).toEqual([]);
    expect(payload.removed).toEqual([]);
    expect(payload.support?.templates ?? []).toEqual([]);
    const rendered = JSON.stringify(payload.digests);
    expect(rendered).not.toContain("super-secret-value");
    expect(rendered).not.toContain(dir);
    expect(rendered).not.toContain(repoRoot);
    expect(rendered).not.toMatch(/[A-Za-z]:\\\\/);
    expect(rendered).not.toMatch(/--json|--root|AIH_/);
  });

  it("does not present hostile raw diagnostic text from passing or failing probes", async () => {
    const marker = `secret=${dir} --argv-like raw-code`;
    vi.spyOn(doctorCommand, "plan").mockImplementation(() => ({
      actions: [
        {
          describe: "doctor",
          kind: "probe" as const,
          run: async () =>
            ({
              code: marker,
              detail: marker,
              location: { startLine: 7, uri: `file://${marker}` },
              name: "doctor",
              verdict: "pass" as const,
            }) as never,
        },
      ],
      capability: "doctor",
    }));
    vi.spyOn(policyEvaluateCommand, "plan").mockImplementation(() => ({
      actions: [
        {
          describe: "policy",
          kind: "probe" as const,
          run: async () =>
            ({
              code: marker,
              detail: marker,
              location: { startLine: 11, uri: `file://${marker}` },
              name: "policy",
              verdict: "fail" as const,
            }) as never,
        },
      ],
      capability: "policy evaluate",
    }));
    const human = await runCommand([dir]);
    const json = await runCommand([dir, "--json"]);
    expect(human.code).toBe(1);
    expect(json.code).toBe(1);
    expect(report(json.out).refusals).toEqual([{ diagnosticId: POLICY, state: "evidence-gap" }]);
    for (const output of [human.out, json.out, JSON.stringify(report(json.out))]) {
      expect(output).not.toContain(marker);
      expect(output).not.toContain(dir);
    }
  });

  it("adds no public library export and no process, network, or write capability", () => {
    const publicSurface = readFileSync(resolve(repoRoot, "src/index.ts"), "utf8");
    expect(publicSurface).not.toContain("governance-doctor");
    expect(commandSource).not.toMatch(/from "node:(?:child_process|net|http|https|dns)"/);
    expect(commandSource).not.toMatch(/\b(?:execFile|execSync|spawn|fetch)\s*\(/);
    expect(commandSource).not.toMatch(
      /\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|cpSync)\b/,
    );
    expect(commandSource).not.toMatch(/writeArtifact|appendRunLog|buildSupport/);
  });
});

describe("aih governance-doctor — non-recursive dispatch and bound identities", () => {
  it("keeps the frozen read-only surface and the shipped profile free of this route", () => {
    for (const surface of GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES) {
      expect(surface.commandPath).not.toContain("governance-doctor");
      expect(surface.diagnosticId).not.toContain("governance-doctor");
    }
    for (const diagnosticId of loadShippedGovernanceDoctorProfileV1().diagnosticIds)
      expect(diagnosticId).not.toContain("governance-doctor");
  });

  it("refuses a policy state whose decision or identity does not bind the minted run", async () => {
    const deniedPolicy = ownedPolicy(
      planContext({ env: { AIH_ORG_POLICY: "missing-policy.json" } }),
    );
    const denied = await localOperation(deniedPolicy, localProfile());
    expect(() =>
      presentGovernanceDoctorOperationV1(denied, {
        decision: "allowed",
        revisionSha256: deniedPolicy.revisionSha256,
        source: "absent",
      }),
    ).toThrow(TypeError);

    vi.spyOn(doctorCommand, "plan").mockImplementation(() => passingProbePlan("doctor", "doctor"));
    const other = await localOperation(deniedPolicy, localProfile({ profileVersion: "1.1" }));
    expect(() =>
      presentGovernanceDoctorOperationV1(
        { audit: denied.audit, guide: other.guide, record: other.record },
        deniedPolicy,
      ),
    ).toThrow(TypeError);
  });

  it("reports an unavailable adapter through the same closed shape and refuses an unknown reason", () => {
    const policy = ownedPolicy();
    const presented = presentGovernanceDoctorUnavailableV1("adapter-unavailable", policy);
    expect(presented.report.outcome).toBe("unavailable");
    expect(presented.report.state).toBe("adapter-unavailable");
    expect(presented.report.dispatchedDiagnosticIds).toEqual([]);
    expect(presented.check).toEqual({
      detail: "unavailable: adapter-unavailable",
      name: "governance-doctor-audit-guide",
      verdict: "fail",
    });
    expect(presented.text).toContain("next action: withheld (owner: aih, executable: false)");
    expect(presented.text).toContain(
      "Read-only presentation: no next action, Status, or Repair is executed, and nothing is written.",
    );
    expect(() => presentGovernanceDoctorUnavailableV1("repair-unavailable", policy)).toThrow(
      TypeError,
    );
    expect(() => presentGovernanceDoctorUnavailableV1("profile-unavailable", null)).toThrow(
      TypeError,
    );
  });
});
