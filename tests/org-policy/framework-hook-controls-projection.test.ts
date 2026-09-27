import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FrameworkHookEnvironmentPatchV1 } from "../../src/framework-plugin/contract-v1.js";
import { executePlan } from "../../src/internals/execute.js";
import { type Action, type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH,
  type FrameworkHookEnvironmentPlans,
  planFrameworkHookControlsProjection,
  readFrameworkHookControlsReceipt,
} from "../../src/org-policy/framework-hook-controls-projection.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_RECEIPT_PATH,
  hookRegistrarProjectionActions,
} from "../../src/org-policy/hook-registrar.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { eccStopRegistrations } from "./hook-registrar-fixtures.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-framework-hook-controls-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(apply = false): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    targets: ["claude"],
  };
}

const SUPERPOWERS_KEYS = ["SUPERPOWERS_HOOK_PROFILE", "SUPERPOWERS_DISABLED_HOOKS"] as const;

function superpowers(set: Record<string, string>): FrameworkHookEnvironmentPlans {
  const patch: FrameworkHookEnvironmentPatchV1 = { host: "claude", keys: SUPERPOWERS_KEYS, set };
  return new Map([["superpowers", patch]]);
}

const NONE: FrameworkHookEnvironmentPlans = new Map();

function settings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
}

function plannerActions(plans: FrameworkHookEnvironmentPlans): Action[] {
  const result = planFrameworkHookControlsProjection(ctx(), plans);
  return [
    ...(result.standaloneSettingsAction === undefined ? [] : [result.standaloneSettingsAction]),
    ...result.receiptActions,
  ];
}

async function apply(actions: readonly Action[]): Promise<void> {
  await executePlan(plan("framework hook controls", ...actions), ctx(true), {
    skipWorktreeGate: true,
  });
}

describe("receipt-owned framework hook controls", () => {
  it("refuses an ECC environment write", () => {
    const plans: FrameworkHookEnvironmentPlans = new Map([
      ["ecc", { host: "claude", keys: ["ECC_HOOK_PROFILE"], set: { ECC_HOOK_PROFILE: "strict" } }],
    ]);
    expect(() => plannerActions(plans)).toThrowError(/ECC hook setting/);
  });
  it("adds, updates, re-enables and revokes only the keys each framework's plan owns", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify({ permissions: { allow: ["Read"] }, env: { OPERATOR: "kept" } }, null, 2)}\n`,
    );

    await apply(
      plannerActions(
        superpowers({
          SUPERPOWERS_HOOK_PROFILE: "standard",
          SUPERPOWERS_DISABLED_HOOKS: "pre:observe,post:quality-gate",
        }),
      ),
    );
    expect(settings()).toMatchObject({
      permissions: { allow: ["Read"] },
      env: {
        OPERATOR: "kept",
        SUPERPOWERS_HOOK_PROFILE: "standard",
        SUPERPOWERS_DISABLED_HOOKS: "pre:observe,post:quality-gate",
      },
    });
    expect(readFrameworkHookControlsReceipt(root)?.receipt.frameworks).toEqual({
      superpowers: {
        keys: [...SUPERPOWERS_KEYS],
        set: {
          SUPERPOWERS_HOOK_PROFILE: "standard",
          SUPERPOWERS_DISABLED_HOOKS: "pre:observe,post:quality-gate",
        },
      },
    });

    await apply(plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" })));
    expect(settings()).toMatchObject({
      env: { OPERATOR: "kept", SUPERPOWERS_HOOK_PROFILE: "minimal" },
    });
    expect((settings().env as Record<string, unknown>).SUPERPOWERS_DISABLED_HOOKS).toBeUndefined();

    await apply(plannerActions(NONE));
    expect(settings()).toEqual({ permissions: { allow: ["Read"] }, env: { OPERATOR: "kept" } });
    expect(existsSync(join(root, FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH))).toBe(false);
  });

  it("refuses unreceipted collisions and drift without mutating settings", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const collision = `${JSON.stringify({ env: { SUPERPOWERS_DISABLED_HOOKS: "x" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), collision);
    expect(() => plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" }))).toThrowError(
      /env.SUPERPOWERS_DISABLED_HOOKS already exists without an AIH receipt/,
    );
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(collision);

    writeFileSync(
      join(root, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify({ env: { OPERATOR: "kept" } }, null, 2)}\n`,
    );
    await apply(plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "standard" })));
    const drifted = `${JSON.stringify({ env: { OPERATOR: "kept", SUPERPOWERS_HOOK_PROFILE: "strict" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), drifted);
    expect(() => plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" }))).toThrowError(
      /no longer matches/,
    );
    expect(() => plannerActions(NONE)).toThrowError(/no longer matches/);
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(drifted);
  });

  it("ignores unrelated settings when no plan or receipt exists", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "{not-json");
    expect(plannerActions(NONE)).toEqual([]);
  });

  it("is idempotent and never deletes the settings file on revocation", async () => {
    await apply(plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "standard" })));
    expect(plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "standard" }))).toEqual([]);

    await apply(plannerActions(NONE));
    expect(existsSync(join(root, HOOK_REGISTRAR_DESTINATION))).toBe(true);
    expect(settings()).toEqual({ env: {} });
  });

  it("refuses a plan key outside the framework's own prefix", () => {
    const plans: FrameworkHookEnvironmentPlans = new Map([
      ["superpowers", { host: "claude", keys: ["NODE_OPTIONS"], set: { NODE_OPTIONS: "--x" } }],
    ]);
    expect(() => plannerActions(plans)).toThrowError(/NODE_OPTIONS is not an SUPERPOWERS_ key/);
  });

  it("refuses malformed settings, non-object env, and symlinked settings or receipt parents", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "{not-json");
    expect(() => plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" }))).toThrowError(
      /malformed JSON/i,
    );

    writeFileSync(
      join(root, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify({ env: [] }, null, 2)}\n`,
    );
    expect(() => plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" }))).toThrowError(
      /env is not an object/,
    );

    rmSync(join(root, ".claude"), { recursive: true, force: true });
    mkdirSync(join(root, "real-claude"));
    symlinkSync("real-claude", join(root, ".claude"), "dir");
    expect(() => plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" }))).toThrowError(
      /symlinked parent/,
    );

    rmSync(join(root, ".claude"));
    mkdirSync(join(root, "real-aih"));
    symlinkSync("real-aih", join(root, ".aih"), "dir");
    expect(() => plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" }))).toThrowError(
      /symlinked parent/,
    );
  });

  it("pins the validated settings preimage and preserves a racing operator write", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const before = `${JSON.stringify({ env: { OPERATOR: "before" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), before);
    const actions = plannerActions(superpowers({ SUPERPOWERS_HOOK_PROFILE: "strict" }));

    const raced = `${JSON.stringify({ env: { OPERATOR: "after" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), raced);
    await expect(apply(actions)).rejects.toThrow(/changed after the plan was computed/);
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(raced);
    expect(existsSync(join(root, FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH))).toBe(false);
  });

  it("passes the controls-validated snapshot into the registrar write", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const before = `${JSON.stringify({ env: { OPERATOR: "before" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), before);
    const controls = planFrameworkHookControlsProjection(
      ctx(),
      superpowers({ SUPERPOWERS_HOOK_PROFILE: "minimal" }),
    );
    if (controls.destinationRead === undefined) {
      throw new Error("expected a controls-validated destination snapshot");
    }

    const raced = `${JSON.stringify({ env: { OPERATOR: "after", SUPERPOWERS_HOOK_PROFILE: "strict" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), raced);
    const registrar = hookRegistrarProjectionActions(ctx(), eccStopRegistrations(), {
      policyVersion: "2026-08-09.1",
      envPatch: controls.envPatch,
      destinationRead: controls.destinationRead,
    });
    expect(
      registrar.filter((action) => "path" in action && action.path === HOOK_REGISTRAR_DESTINATION),
    ).toHaveLength(1);

    await expect(apply([...registrar, ...controls.receiptActions])).rejects.toThrow(
      /changed after the plan was computed/,
    );
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(raced);
    expect(existsSync(join(root, FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH))).toBe(false);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
  });
});
