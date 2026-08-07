import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_RECEIPT_PATH,
  hookCommandDigest,
  readHookRegistrarReceipt,
} from "../../src/org-policy/hook-registrar.js";
import { verifiedOrgPolicyProjectionActions } from "../../src/org-policy/project.js";
import { type HookRegistration, parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { usageRecorderScript } from "../../src/usage/capture.js";
import { claudeUsageHookCommand } from "../../src/usage/hooks.js";
import { eccStopRegistrations } from "./hook-registrar-fixtures.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-governed-hook-wiring-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    targets: ["claude"],
    ...overrides,
  };
}

function governedPolicy(registrations: readonly HookRegistration[] | undefined) {
  return parseOrgPolicy({
    schemaVersion: 1,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026-08-06.1",
      catalog: { reviewed: [], custom: [] },
      ...(registrations === undefined ? {} : { hookRegistrations: registrations }),
    },
  });
}

/**
 * The adoption offer an operator accepts for the usage projector's own entry.
 * The registrar reports that entry unowned and offers it; capturing it produces
 * a policy registration whose command is the destination's exact bytes, and an
 * unattributable launcher stays `owner: unknown` (A1).
 */
function adoptedUsageRegistration(): HookRegistration {
  const command = claudeUsageHookCommand();
  return {
    id: "adopted-usage-post-tool-use",
    event: "PostToolUse",
    command,
    functionTags: ["usage-metering"],
    spawns: 1,
    owner: { kind: "unknown", launcherSha256: hookCommandDigest(command) },
  };
}

function usageAndRegistrationsPolicy(
  registrations: readonly HookRegistration[] = eccStopRegistrations(),
) {
  const scriptDigest = `sha256:${createHash("sha256").update(usageRecorderScript(), "utf8").digest("hex")}`;
  return parseOrgPolicy({
    schemaVersion: 1,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026-08-06.1",
      catalog: {
        reviewed: [
          {
            id: "usage-metering",
            kind: "hook",
            description: "AIH owned hook",
            source: { type: "hook", handler: "usage-metering", scriptDigest },
            targets: ["claude", "codex"],
            projector: "usage-hook",
            lifecycle: "supported",
            evidence: { record: "ignored-self-assertion" },
          },
        ],
        custom: [],
      },
      activations: [{ candidate: "usage-metering", state: "active", targets: ["claude"] }],
      hookRegistrations: [...registrations],
    },
  });
}

async function project(policy: ReturnType<typeof governedPolicy>): Promise<void> {
  const actions = await verifiedOrgPolicyProjectionActions(ctx(), policy);
  await executePlan(plan("policy project", ...actions), ctx({ apply: true }), {
    skipWorktreeGate: true,
  });
}

describe("G4 — the registrar is reachable end to end through the verified projector", () => {
  it("emits the registrar's actions for a policy that declares registrations", async () => {
    const registrations = eccStopRegistrations();
    const actions = await verifiedOrgPolicyProjectionActions(ctx(), governedPolicy(registrations));
    const paths = actions.map((action) => ("path" in action ? action.path : undefined));
    expect(paths).toContain(HOOK_REGISTRAR_DESTINATION);
    expect(paths).toContain(HOOK_REGISTRAR_RECEIPT_PATH);

    await executePlan(plan("policy project", ...actions), ctx({ apply: true }), {
      skipWorktreeGate: true,
    });
    const destination = readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8");
    for (const registration of registrations) {
      // Byte-for-byte: the destination carries the third party's own launcher.
      expect(JSON.parse(destination).hooks.Stop).toContainEqual({
        hooks: [{ type: "command", command: registration.command }],
      });
    }
    const receipt = readHookRegistrarReceipt(dir);
    expect(receipt?.policyVersion).toBe("2026-08-06.1");
    expect(receipt?.entries).toHaveLength(registrations.length);
  });

  it("emits revocation actions for a policy that declares none", async () => {
    await project(governedPolicy(eccStopRegistrations()));
    expect(existsSync(join(dir, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(true);

    await project(governedPolicy(undefined));
    const destination = existsSync(join(dir, HOOK_REGISTRAR_DESTINATION))
      ? readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8")
      : "";
    expect(destination).not.toContain("run-with-flags.js");
    expect(existsSync(join(dir, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
  });

  it("emits no registrar action for a target set without claude", async () => {
    const actions = await verifiedOrgPolicyProjectionActions(
      ctx({ targets: ["codex"] }),
      governedPolicy(eccStopRegistrations()),
    );
    const paths = actions.map((action) => ("path" in action ? action.path : undefined));
    expect(paths).not.toContain(HOOK_REGISTRAR_DESTINATION);
    expect(paths).not.toContain(HOOK_REGISTRAR_RECEIPT_PATH);
  });

  it("refuses two hook writers into the client destination rather than dropping one", async () => {
    // The usage-hook projector and the hook registrar both write
    // .claude/settings.json; the plan executor collapses repeated writes to
    // one path, so letting both through would silently drop one owner's
    // entries — the exact two-writers defect this program exists to remove.
    await expect(
      verifiedOrgPolicyProjectionActions(ctx(), usageAndRegistrationsPolicy()),
    ).rejects.toThrow(/usage-hook projector and the hook registrar/);
  });

  it("refuses a registrar projection onto a destination the usage-hook receipt already owns", async () => {
    // The refusal is an OWNERSHIP gate, not a plan-shape one. Once its receipt
    // is active the usage projector skips its own write, so a check that only
    // asks what each projector emits THIS run sees a single writer while the
    // usage receipt still owns the destination. Adopting the entry the registrar
    // itself offers is the operator path into exactly that state, and the
    // registrar's whole-key write would then silently rewrite the usage
    // projector's own entry — one entry claimed by two receipts.
    await project(usageAndRegistrationsPolicy([]));
    const owned = JSON.parse(readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8"));
    expect(owned.hooks.PostToolUse[0].matcher).toBe("*");

    await expect(
      project(usageAndRegistrationsPolicy([adoptedUsageRegistration()])),
    ).rejects.toThrow(/usage-hook projector and the hook registrar/);

    // Fail closed: refusing left the usage projector's own entry byte-intact,
    // and no registrar receipt claims an entry the usage receipt already owns.
    expect(JSON.parse(readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8"))).toEqual(owned);
    expect(existsSync(join(dir, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
  });
});
