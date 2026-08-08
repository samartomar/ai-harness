import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  adoptedHookRegistrations,
  HOOK_REGISTRAR_DESTINATION,
  type HookAdoptionDeclaration,
  hookRegistrarProjectionActions,
} from "../../src/org-policy/hook-registrar.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { eccStopRegistrations, sha256 } from "./hook-registrar-fixtures.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-hook-adoption-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(apply: boolean): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ run, env: process.env }),
    env: process.env,
    options: {},
    targets: ["claude"],
  };
}

/** The measured defect: a third party wrote entries it ships no removal for. */
function seedDestination(hooks: Record<string, readonly string[]>): void {
  const settings = {
    hooks: Object.fromEntries(
      Object.entries(hooks).map(([event, commands]) => [
        event,
        [{ hooks: commands.map((command) => ({ type: "command", command })) }],
      ]),
    ),
  };
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, HOOK_REGISTRAR_DESTINATION),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

const ECC_LAUNCHER =
  "node -e \"require('~/.claude/scripts/hooks/run-with-flags.js').run('session-summary.js')\"";
const ROGUE_LAUNCHER = "node ~/.mystery/legacy-hook.js";

function eccDeclaration(overrides: Partial<HookAdoptionDeclaration> = {}): HookAdoptionDeclaration {
  return {
    event: "Stop",
    commandSha256: sha256(ECC_LAUNCHER),
    id: "ecc-stop-session-summary",
    functionTags: ["session-summary"],
    spawns: 3,
    owner: {
      kind: "third-party",
      framework: "ecc",
      declaredControls: ["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"],
      pin: {
        repository: "affaan-m/ECC",
        commit: "623f2c020f052319657674e4e6c29ab5d0ad566b",
        path: "scripts/hooks/session-summary.js",
        runtimeVersion: "3.7.1",
      },
    },
    ...overrides,
  };
}

describe("A1 — adoption captures the destination's own bytes and emits the policy entry", () => {
  it("captures the launcher byte-for-byte and hashes those exact bytes", () => {
    seedDestination({ Stop: [ECC_LAUNCHER] });
    const [adopted] = adoptedHookRegistrations(dir, [eccDeclaration()]);
    if (adopted === undefined) throw new Error("expected an adopted registration");
    expect(adopted.command).toBe(ECC_LAUNCHER);
    if (adopted.owner.kind !== "third-party") throw new Error("expected declared provenance");
    expect(adopted.owner.pin.launcherSha256).toBe(sha256(ECC_LAUNCHER));
    expect(adopted.owner.pin.repository).toBe("affaan-m/ECC");
  });

  it("never accepts a hand-typed launcher: declarations carry only the entry's hash", () => {
    // Ruling 2: an administrator never hand-types a launcher — a hand-typed
    // launcher means adoption was not run. The declaration shape has no
    // command field at all; the bytes can only come from the destination.
    const declaration = eccDeclaration();
    expect(Object.keys(declaration)).not.toContain("command");
  });

  it("leaves an unattributable entry owner unknown, hash still pinned", () => {
    seedDestination({ Stop: [ROGUE_LAUNCHER] });
    const [adopted] = adoptedHookRegistrations(dir, [
      {
        event: "Stop",
        commandSha256: sha256(ROGUE_LAUNCHER),
        id: "legacy-stop-hook",
        functionTags: ["legacy-stop-hook"],
        spawns: 1,
        owner: { kind: "unknown" },
      },
    ]);
    if (adopted === undefined) throw new Error("expected an adopted registration");
    expect(adopted.command).toBe(ROGUE_LAUNCHER);
    expect(adopted.owner).toEqual({ kind: "unknown", launcherSha256: sha256(ROGUE_LAUNCHER) });
  });

  it("emits entries the policy grammar accepts", () => {
    seedDestination({ Stop: [ECC_LAUNCHER, ROGUE_LAUNCHER] });
    const adopted = adoptedHookRegistrations(dir, [
      eccDeclaration(),
      {
        event: "Stop",
        commandSha256: sha256(ROGUE_LAUNCHER),
        id: "legacy-stop-hook",
        functionTags: ["legacy-stop-hook"],
        spawns: 1,
        owner: { kind: "unknown" },
      },
    ]);
    const policy = parseOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026-08-06.1",
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        hookRegistrations: adopted,
      },
    });
    expect(policy.governance?.hookRegistrations).toHaveLength(2);
  });

  it("refuses to adopt an entry the destination does not carry", () => {
    seedDestination({ Stop: [ECC_LAUNCHER] });
    expect(() =>
      adoptedHookRegistrations(dir, [
        eccDeclaration({ commandSha256: sha256("some launcher that is not on disk") }),
      ]),
    ).toThrowError(/no unowned Stop entry/);
  });

  it("refuses to adopt when the destination is absent", () => {
    expect(() => adoptedHookRegistrations(dir, [eccDeclaration()])).toThrowError(/absent/);
  });

  it("refuses to adopt an entry the receipt already owns", async () => {
    seedDestination({ Stop: eccStopRegistrations().map((registration) => registration.command) });
    await executePlan(
      plan("hook registrar", ...hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())),
      ctx(true),
      { skipWorktreeGate: true },
    );
    expect(() => adoptedHookRegistrations(dir, [eccDeclaration()])).toThrowError(/already own/i);
  });

  it("refuses two declarations for the same destination entry", () => {
    seedDestination({ Stop: [ECC_LAUNCHER] });
    expect(() =>
      adoptedHookRegistrations(dir, [
        eccDeclaration(),
        eccDeclaration({ id: "ecc-stop-session-summary-again" }),
      ]),
    ).toThrowError(/declared twice/);
  });
});

describe("A3 — refusal beats absorption, unowned entries named by owner and event", () => {
  it("names each unowned entry by owner and event when projection refuses", () => {
    // The selected registration pins the ECC launcher on Stop; the destination
    // carries the same launcher on PreToolUse (attributable to ecc by its pin
    // hash) plus a rogue entry nothing attributes (unknown).
    const [selected] = eccStopRegistrations();
    if (selected === undefined) throw new Error("expected a registration");
    seedDestination({
      Stop: [selected.command],
      PreToolUse: [selected.command],
      SessionStart: [ROGUE_LAUNCHER],
    });
    let message = "";
    try {
      hookRegistrarProjectionActions(ctx(false), [selected]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("did not emit");
    expect(message).toContain("ecc/PreToolUse");
    expect(message).toContain("unknown/SessionStart");
    expect(message).toContain("adopt or remove them before projecting");
  });
});
