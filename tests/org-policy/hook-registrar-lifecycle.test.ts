import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_RECEIPT_PATH,
  hookRegistrarProjectionActions,
  hookRegistrarReport,
  hookRegistrarRevocationActions,
  hookRegistrarState,
  readHookRegistrarReceipt,
} from "../../src/org-policy/hook-registrar.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { aihDispatcher, eccStopRegistrations } from "./hook-registrar-fixtures.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-hook-registrar-"));
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

/**
 * Seed the destination the way a third-party installer leaves it: entries the
 * source wrote into a file it ships no removal path for, so nothing but the
 * receipt can revoke them.
 */
function seedThirdPartyEntries(extra: Record<string, unknown> = {}): string {
  const settings = {
    ...extra,
    hooks: {
      Stop: [
        {
          hooks: eccStopRegistrations().map((registration) => ({
            type: "command",
            command: registration.command,
          })),
        },
      ],
    },
  };
  const contents = `${JSON.stringify(settings, null, 2)}\n`;
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), contents, "utf8");
  return contents;
}

function readDestination(): string | undefined {
  try {
    return readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8");
  } catch {
    return undefined;
  }
}

async function run(actions: ReturnType<typeof hookRegistrarProjectionActions>): Promise<void> {
  await executePlan(plan("hook registrar", ...actions), ctx(true), { skipWorktreeGate: true });
}

describe("H6 — revocation is mandatory", () => {
  it("records the prior bytes of a destination the third party already wrote", async () => {
    const prior = seedThirdPartyEntries({ permissions: { allow: ["Bash(ls:*)"] } });
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const receipt = readHookRegistrarReceipt(dir);
    expect(receipt?.prior.state).toBe("present");
    if (receipt?.prior.state !== "present") throw new Error("expected recorded prior bytes");
    expect(receipt.prior.contents).toBe(prior);
  });

  it("removes third-party entries the third party ships no uninstall path for", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    expect(readDestination()).toContain("run-with-flags.js");

    await run(hookRegistrarRevocationActions(ctx(false)));
    const after = readDestination();
    expect(after ?? "").not.toContain("run-with-flags.js");
    expect(readHookRegistrarReceipt(dir)).toBeUndefined();
  });

  // Adoption is a transfer of ownership, so adopted third-party entries do not
  // come back. Everything the operator owns in the same file survives untouched
  // — that is what restoring the prior destination means for this projector.
  it("restores every operator-owned byte and reinstates no adopted entry", async () => {
    seedThirdPartyEntries({ permissions: { allow: ["Bash(ls:*)"] } });
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    await run(hookRegistrarRevocationActions(ctx(false)));
    const after = JSON.parse(readDestination() ?? "{}");
    expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(after.hooks).toBeUndefined();
  });

  it("removes a destination AIH created, when none existed before", async () => {
    await run(hookRegistrarProjectionActions(ctx(false), [aihDispatcher("Stop", ["continuity"])]));
    expect(readDestination()).toBeDefined();
    await run(hookRegistrarRevocationActions(ctx(false)));
    expect(readDestination()).toBeUndefined();
  });

  it("needs no hand editing: revocation is a planned action set", () => {
    seedThirdPartyEntries();
    const actions = hookRegistrarProjectionActions(ctx(false), eccStopRegistrations());
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(["write", "remove"]).toContain(action.kind);
    }
  });

  it("refuses to revoke a destination that drifted since projection", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    writeFileSync(
      join(dir, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`,
      "utf8",
    );
    expect(() => hookRegistrarRevocationActions(ctx(false))).toThrowError(/drift|changed/i);
  });

  it("reports its ownership state without mutating anything", async () => {
    expect(hookRegistrarState(dir).state).toBe("absent");
    seedThirdPartyEntries();
    expect(hookRegistrarState(dir).state).toBe("unowned");
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    expect(hookRegistrarState(dir).state).toBe("active");
  });

  // Decision review, hole 1. hookRegistrarState compares only `hooks`, so an
  // operator who adds their own key to an AIH-created destination still reads
  // `active` — and revocation then removes the whole file. v3.4 R8 requires
  // user-owned config be preserved.
  it("never deletes operator content added to a destination AIH created", async () => {
    await run(hookRegistrarProjectionActions(ctx(false), [aihDispatcher("Stop", ["continuity"])]));
    const withOperatorKey = JSON.parse(readDestination() ?? "{}");
    withOperatorKey.permissions = { allow: ["Bash(ls:*)"] };
    writeFileSync(
      join(dir, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify(withOperatorKey, null, 2)}
`,
      "utf8",
    );

    await run(hookRegistrarRevocationActions(ctx(false)));
    const after = readDestination();
    expect(after, "operator content must survive revocation").toBeDefined();
    expect(JSON.parse(after ?? "{}").permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(JSON.parse(after ?? "{}").hooks).toBeUndefined();
  });

  // Decision review, hole 2. The unowned-entry refusal is gated on there being
  // no receipt. With one present, a whole-key replace silently destroys entries
  // a third party reinstalled. H1 forbids silently absorbing an unowned entry;
  // silently deleting one is worse.
  it("refuses to silently delete entries a third party wrote after the receipt", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));

    const reinstalled = JSON.parse(readDestination() ?? "{}");
    reinstalled.hooks.PreToolUse = [
      { hooks: [{ type: "command", command: "node -e \"require('reinstalled.js').run()\"" }] },
    ];
    writeFileSync(
      join(dir, HOOK_REGISTRAR_DESTINATION),
      `${JSON.stringify(reinstalled, null, 2)}
`,
      "utf8",
    );

    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
      /did not emit|PreToolUse/,
    );
  });

  // H1: repair lists the unowned entries by owner and event, and offers
  // adoption. It never absorbs one silently.
  it("lists unowned entries by owner and event, and offers adoption", () => {
    seedThirdPartyEntries();
    const report = hookRegistrarReport(dir);
    expect(report.state).toBe("unowned");
    expect(report.unowned).toHaveLength(6);
    for (const entry of report.unowned) {
      expect(entry.event).toBe("Stop");
      expect(entry.owner).toBe("unknown");
    }
    expect(report.detail).toContain("unknown/Stop");
    expect(report.adoption).toHaveLength(6);
  });

  it("reports no unowned entry once AIH owns the destination", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const report = hookRegistrarReport(dir);
    expect(report.state).toBe("active");
    expect(report.unowned).toEqual([]);
  });

  it("writes a receipt pinning every entry's owner and provenance", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const receipt = readHookRegistrarReceipt(dir);
    expect(receipt?.destination).toBe(HOOK_REGISTRAR_DESTINATION);
    expect(receipt?.entries).toHaveLength(6);
    for (const entry of receipt?.entries ?? []) {
      expect(entry.owner).toBe("third-party");
      expect(entry.ownerId).toBe("ecc");
      expect(entry.event).toBe("Stop");
      expect(entry.commandSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.pin?.repository).toBe("affaan-m/ECC");
      expect(entry.pin?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.pin?.runtimeVersion).toBeTruthy();
    }
    expect(readFileSync(join(dir, HOOK_REGISTRAR_RECEIPT_PATH), "utf8")).toContain(
      "run-with-flags",
    );
  });
});
