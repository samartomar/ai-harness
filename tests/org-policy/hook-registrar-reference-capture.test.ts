import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  hookRegistrarReport,
  hookRegistrarRevocationActions,
  hookRegistrarState,
} from "../../src/org-policy/hook-registrar.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/**
 * The journey this projector is measured against, run on the concrete example
 * it was built for: `docs/reference/claude-hook-settings.snapshot.json`, a
 * verbatim capture of one real client configuration written by a third-party
 * runtime — 22 entries across 7 events, every group scoped by a `matcher` and
 * carrying `description` and `id`, several hooks carrying `async`.
 *
 * The capture is READ-ONLY INPUT here and is never written back to: the test
 * copies it into a temporary fixture root and drives the product against that.
 * It is used because a shape invented in a fixture would be a shape nobody has
 * ever seen, and every earlier defect in this module came from exactly that.
 *
 * Report every entry as unowned, offer adoption for all of them, adopt them,
 * re-project them, and get the same configuration back — matcher and all.
 */

const CAPTURE_PATH = join("docs", "reference", "claude-hook-settings.snapshot.json");

interface NativeGroup {
  matcher?: string;
  hooks: { type?: string; command: string; timeout?: number; async?: boolean }[];
  [field: string]: unknown;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-hook-registrar-capture-"));
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

async function run(actions: ReturnType<typeof hookRegistrarProjectionActions>): Promise<void> {
  await executePlan(plan("hook registrar", ...actions), ctx(true), { skipWorktreeGate: true });
}

function capturedSettings(): { hooks: Record<string, NativeGroup[]>; [key: string]: unknown } {
  return JSON.parse(readFileSync(CAPTURE_PATH, "utf8"));
}

function seedFixtureRootFromCapture(): Record<string, NativeGroup[]> {
  const captured = capturedSettings();
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, HOOK_REGISTRAR_DESTINATION),
    `${JSON.stringify(captured, null, 2)}\n`,
    "utf8",
  );
  return captured.hooks;
}

function destinationSettings(): { hooks: Record<string, NativeGroup[]>; [key: string]: unknown } {
  return JSON.parse(readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8"));
}

describe("the reference capture — the shape this projector is measured against", () => {
  it("carries native fields AIH does not author, which is the whole point of the case", () => {
    const hooks = capturedSettings().hooks;
    const groups = Object.values(hooks).flat();
    expect(groups.length).toBeGreaterThan(0);
    // Every group is scoped. A projector that cannot carry a matcher cannot
    // touch this file at all.
    expect(groups.every((group) => typeof group.matcher === "string")).toBe(true);
    expect(groups.some((group) => group.hooks.some((hook) => hook.async !== undefined))).toBe(true);
    expect(groups.some((group) => group.hooks.some((hook) => hook.timeout !== undefined))).toBe(
      true,
    );
  });

  it("reports every entry as unowned and offers adoption for all of them", () => {
    const hooks = seedFixtureRootFromCapture();
    const entryCount = Object.values(hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks),
    ).length;

    const state = hookRegistrarState(dir);
    expect(state.state).toBe("unowned");
    const report = hookRegistrarReport(dir);
    expect(report.unowned).toHaveLength(entryCount);
    expect(report.adoption).toHaveLength(entryCount);
    // Nothing is attributable: no policy pin claims any of these launchers.
    expect(new Set(report.unowned.map((entry) => entry.owner))).toEqual(new Set(["unknown"]));
  });

  it("adopts every entry and re-projects the configuration byte-faithfully", async () => {
    const hooks = seedFixtureRootFromCapture();
    const before = destinationSettings();

    const declarations: HookAdoptionDeclaration[] = hookRegistrarReport(dir).adoption.map(
      (offer, index) => ({
        event: offer.event,
        commandSha256: offer.commandSha256,
        id: `captured-entry-${index}`,
        functionTags: [`captured-${index}`],
        spawns: 1,
        owner: { kind: "unknown" },
      }),
    );
    const adopted = adoptedHookRegistrations(dir, declarations);
    expect(adopted).toHaveLength(declarations.length);
    // Adoption captured the scope, not just the launcher.
    expect(adopted.every((registration) => registration.nativeGroup?.matcher !== undefined)).toBe(
      true,
    );

    await run(hookRegistrarProjectionActions(ctx(false), adopted));

    const after = destinationSettings();
    // Every entry, every matcher, every per-hook field: the same configuration.
    expect(after.hooks).toEqual(hooks);
    // And nothing else in the operator's file moved.
    expect(after.env).toEqual(before.env);
    expect(after.$schema).toEqual(before.$schema);

    // AIH now owns what it re-emitted, and the ownership is stable.
    expect(hookRegistrarState(dir).state).toBe("active");
    expect(hookRegistrarReport(dir).unowned).toEqual([]);
  });

  it("revokes every adopted entry and leaves the operator's own keys intact", async () => {
    seedFixtureRootFromCapture();
    const before = destinationSettings();
    const declarations: HookAdoptionDeclaration[] = hookRegistrarReport(dir).adoption.map(
      (offer, index) => ({
        event: offer.event,
        commandSha256: offer.commandSha256,
        id: `captured-entry-${index}`,
        functionTags: [`captured-${index}`],
        spawns: 1,
        owner: { kind: "unknown" },
      }),
    );
    await run(
      hookRegistrarProjectionActions(ctx(false), adoptedHookRegistrations(dir, declarations)),
    );

    await run(hookRegistrarRevocationActions(ctx(false)));

    const after = destinationSettings();
    // A2: the entries a third party shipped no removal path for are gone, and
    // they are NOT replayed from the recorded prior bytes.
    expect(after.hooks).toBeUndefined();
    expect(after.env).toEqual(before.env);
    expect(after.$schema).toEqual(before.$schema);
  });
});
