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
import { executePlan } from "../../src/internals/execute.js";
import { type Action, type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { planEccHookControlsProjection } from "../../src/org-policy/ecc-hook-controls-projection.js";
import {
  ECC_HOOK_CONTROLS_RECEIPT_PATH,
  readEccHookControlsReceipt,
} from "../../src/org-policy/ecc-hook-controls-receipt.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_RECEIPT_PATH,
  hookRegistrarProjectionActions,
} from "../../src/org-policy/hook-registrar.js";
import { verifiedOrgPolicyProjectionActions } from "../../src/org-policy/project.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { eccStopRegistrations } from "./hook-registrar-fixtures.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-hook-controls-"));
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

function settings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
}

function plannerActions(
  selection: { profile: "minimal" | "standard" | "strict"; disabledIds?: string[] } | undefined,
): Action[] {
  const result = planEccHookControlsProjection(ctx(), selection);
  return [
    ...(result.standaloneSettingsAction === undefined ? [] : [result.standaloneSettingsAction]),
    ...result.receiptActions,
  ];
}

async function apply(actions: readonly Action[]): Promise<void> {
  await executePlan(plan("ECC hook controls", ...actions), ctx(true), {
    skipWorktreeGate: true,
  });
}

function governedPolicy(
  controls: { profile: "minimal" | "standard" | "strict"; disabledIds?: string[] } | undefined,
) {
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      supportedClis: ["claude"],
      policyVersion: "2026-08-09.1",
      catalog: { reviewed: [], custom: [] },
      hookRegistrations: eccStopRegistrations(),
      ...(controls === undefined ? {} : { eccHookControls: controls }),
    },
  });
}

describe("receipt-owned ECC hook controls", () => {
  it("adds, updates, re-enables, and revokes only the two owned env keys", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify({ permissions: { allow: ["Read"] }, env: { OPERATOR: "kept" } }, null, 2)}\n`,
    );

    await apply(
      plannerActions({
        profile: "standard",
        disabledIds: ["post:quality-gate", "pre:observe"],
      }),
    );
    expect(settings()).toMatchObject({
      permissions: { allow: ["Read"] },
      env: {
        OPERATOR: "kept",
        ECC_HOOK_PROFILE: "standard",
        ECC_DISABLED_HOOKS: "pre:observe,post:quality-gate",
      },
    });
    expect(readEccHookControlsReceipt(root)?.receipt.disabledIds).toEqual([
      "pre:observe",
      "post:quality-gate",
    ]);

    await apply(plannerActions({ profile: "minimal" }));
    expect(settings()).toMatchObject({
      env: { OPERATOR: "kept", ECC_HOOK_PROFILE: "minimal" },
    });
    expect((settings().env as Record<string, unknown>).ECC_DISABLED_HOOKS).toBeUndefined();

    await apply(plannerActions(undefined));
    expect(settings()).toEqual({
      permissions: { allow: ["Read"] },
      env: { OPERATOR: "kept" },
    });
    expect(existsSync(join(root, ECC_HOOK_CONTROLS_RECEIPT_PATH))).toBe(false);
  });

  it("refuses unreceipted collisions and drift without mutating settings", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const collision = `${JSON.stringify({ env: { ECC_HOOK_PROFILE: "strict" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), collision);
    expect(() => plannerActions({ profile: "minimal" })).toThrowError(
      /already exists without an AIH receipt/,
    );
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(collision);

    writeFileSync(
      join(root, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify({ env: { OPERATOR: "kept" } }, null, 2)}\n`,
    );
    await apply(plannerActions({ profile: "standard" }));
    const drifted = `${JSON.stringify({ env: { OPERATOR: "kept", ECC_HOOK_PROFILE: "strict" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), drifted);
    expect(() => plannerActions({ profile: "minimal" })).toThrowError(/no longer matches/);
    expect(() => plannerActions(undefined)).toThrowError(/no longer matches/);
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(drifted);
  });

  it("ignores unrelated settings when no policy selection or receipt exists", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "{not-json");
    expect(plannerActions(undefined)).toEqual([]);
  });

  it("is idempotent and never deletes the settings file on revocation", async () => {
    await apply(plannerActions({ profile: "standard" }));
    expect(plannerActions({ profile: "standard" })).toEqual([]);

    await apply(plannerActions(undefined));
    expect(existsSync(join(root, HOOK_REGISTRAR_DESTINATION))).toBe(true);
    expect(settings()).toEqual({ env: {} });
  });

  it("refuses malformed settings, non-object env, and symlinked settings or receipt parents", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "{not-json");
    expect(() => plannerActions({ profile: "minimal" })).toThrowError(/malformed JSON/i);

    writeFileSync(
      join(root, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify({ env: [] }, null, 2)}\n`,
    );
    expect(() => plannerActions({ profile: "minimal" })).toThrowError(/env is not an object/);

    rmSync(join(root, ".claude"), { recursive: true, force: true });
    mkdirSync(join(root, "real-claude"));
    symlinkSync("real-claude", join(root, ".claude"), "dir");
    expect(() => plannerActions({ profile: "minimal" })).toThrowError(/symlinked parent/);

    rmSync(join(root, ".claude"));
    mkdirSync(join(root, "real-aih"));
    symlinkSync("real-aih", join(root, ".aih"), "dir");
    expect(() => plannerActions({ profile: "minimal" })).toThrowError(/symlinked parent/);
  });

  it("pins the validated settings preimage and preserves a racing operator write", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const before = `${JSON.stringify({ env: { OPERATOR: "before" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), before);
    const actions = plannerActions({ profile: "strict" });

    const raced = `${JSON.stringify({ env: { OPERATOR: "after" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), raced);
    await expect(apply(actions)).rejects.toThrow(/changed after the plan was computed/);
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(raced);
    expect(existsSync(join(root, ECC_HOOK_CONTROLS_RECEIPT_PATH))).toBe(false);
  });

  it("passes the controls-validated snapshot into the registrar write", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const before = `${JSON.stringify({ env: { OPERATOR: "before" } }, null, 2)}\n`;
    writeFileSync(join(root, HOOK_REGISTRAR_DESTINATION), before);
    const controls = planEccHookControlsProjection(ctx(), { profile: "minimal" });
    if (controls.destinationRead === undefined) {
      throw new Error("expected a controls-validated destination snapshot");
    }

    const raced = `${JSON.stringify(
      { env: { OPERATOR: "after", ECC_HOOK_PROFILE: "strict" } },
      null,
      2,
    )}\n`;
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
    expect(existsSync(join(root, ECC_HOOK_CONTROLS_RECEIPT_PATH))).toBe(false);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
  });

  it("composes hook registrations and controls into one guarded destination write", async () => {
    const actions = await verifiedOrgPolicyProjectionActions(
      ctx(),
      governedPolicy({
        profile: "strict",
        disabledIds: ["pre:bash:tmux-reminder"],
      }),
    );
    const destinationActions = actions.filter(
      (action) => "path" in action && action.path === HOOK_REGISTRAR_DESTINATION,
    );
    expect(destinationActions).toHaveLength(1);

    await apply(actions);
    const projected = settings();
    expect(projected).toMatchObject({
      env: {
        ECC_HOOK_PROFILE: "strict",
        ECC_DISABLED_HOOKS: "pre:bash:tmux-reminder",
      },
    });
    expect(JSON.stringify(projected)).toContain("run-with-flags.js");
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(true);
    expect(existsSync(join(root, ECC_HOOK_CONTROLS_RECEIPT_PATH))).toBe(true);
  });
});
