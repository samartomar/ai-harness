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

/** A hook group the operator wrote themselves. AIH never emitted it and never adopted it. */
const OPERATOR_GROUP = {
  matcher: "Edit|Write",
  hooks: [{ type: "command", command: "node ./tools/operator-guard.mjs" }],
};

/** Rewrite the destination's `hooks` key through `mutate`, leaving every other key alone. */
function rewriteHooks(mutate: (hooks: Record<string, unknown>) => void): string {
  const current = JSON.parse(readDestination() ?? "{}");
  mutate(current.hooks);
  const contents = `${JSON.stringify(current, null, 2)}\n`;
  writeFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), contents, "utf8");
  return contents;
}

/**
 * Delegated ruling 6. Ownership granularity is the projected GROUP, so an
 * operator hook group added anywhere else under the same `hooks` key is
 * COHABITATION — the normal configuration of a file the repository, ECC and AIH
 * all write — not drift. Revocation subtracts exactly the groups the receipt
 * proves AIH emitted; anything else stays where the operator put it.
 */
describe("H6 — per-entry subtraction: cohabitation is not drift", () => {
  it("reads cohabited when an operator group joins a different event", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    rewriteHooks((hooks) => {
      hooks.PreToolUse = [OPERATOR_GROUP];
    });
    const state = hookRegistrarState(dir);
    expect(state.state).toBe("cohabited");
    // The count is what uninstall promises to preserve, so it has to be real.
    expect(state.detail).toContain("1 hook entry");
  });

  it("reads cohabited when an operator group joins the same event", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    rewriteHooks((hooks) => {
      (hooks.Stop as unknown[]).push(OPERATOR_GROUP);
    });
    expect(hookRegistrarState(dir).state).toBe("cohabited");
  });

  it("keeps `active` for an exact match, so the two states never blur", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    expect(hookRegistrarState(dir).state).toBe("active");
  });

  it("subtracts exactly the owned groups and leaves the operator's groups value-exact", async () => {
    seedThirdPartyEntries({ permissions: { allow: ["Bash(ls:*)"] } });
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    rewriteHooks((hooks) => {
      (hooks.Stop as unknown[]).push(OPERATOR_GROUP);
      hooks.PreToolUse = [OPERATOR_GROUP];
    });

    await run(hookRegistrarRevocationActions(ctx(false)));

    const after = JSON.parse(readDestination() ?? "{}");
    // The whole parsed structure, not a substring: a subtraction that also
    // dropped the operator's group, reordered it, or rewrote one of its fields
    // fails here.
    expect(after.hooks).toEqual({ PreToolUse: [OPERATOR_GROUP], Stop: [OPERATOR_GROUP] });
    expect(JSON.stringify(after)).not.toContain("run-with-flags.js");
    expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(readHookRegistrarReceipt(dir)).toBeUndefined();
  });

  it("drops the `hooks` key only when subtraction leaves it empty", async () => {
    seedThirdPartyEntries({ permissions: { allow: ["Bash(ls:*)"] } });
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    await run(hookRegistrarRevocationActions(ctx(false)));
    expect(JSON.parse(readDestination() ?? "{}").hooks).toBeUndefined();
  });

  /**
   * The created-file removal clause keeps its sole-key partition AND now also
   * requires nothing foreign to remain: a file holding an operator's own hook
   * group is subtracted, never deleted.
   */
  it("never removes a destination AIH created once an operator group shares the key", async () => {
    await run(hookRegistrarProjectionActions(ctx(false), [aihDispatcher("Stop", ["continuity"])]));
    rewriteHooks((hooks) => {
      hooks.PreToolUse = [OPERATOR_GROUP];
    });

    await run(hookRegistrarRevocationActions(ctx(false)));

    const after = readDestination();
    expect(after, "the operator's own hook group must survive").toBeDefined();
    expect(JSON.parse(after ?? "{}").hooks).toEqual({ PreToolUse: [OPERATOR_GROUP] });
  });

  it("still removes a destination AIH created when nothing foreign remains", async () => {
    await run(hookRegistrarProjectionActions(ctx(false), [aihDispatcher("Stop", ["continuity"])]));
    await run(hookRegistrarRevocationActions(ctx(false)));
    expect(readDestination()).toBeUndefined();
  });

  it("reports the cohabited state with each foreign entry by owner and event", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    rewriteHooks((hooks) => {
      hooks.PreToolUse = [OPERATOR_GROUP];
    });

    const report = hookRegistrarReport(dir);
    expect(report.state).toBe("cohabited");
    expect(report.unowned).toEqual([
      { owner: "unknown", event: "PreToolUse", command: "node ./tools/operator-guard.mjs" },
    ]);
    expect(report.detail).toContain("unknown/PreToolUse");
    // H1 is unchanged: an entry AIH did not emit is still offered for adoption.
    expect(report.adoption).toHaveLength(1);
  });
});

/**
 * Delegated ruling 6, the other half. Subtracting from INSIDE a group AIH wrote
 * would delete content AIH cannot prove it emitted, so an unprovable owned group
 * fails closed exactly as before — drifted, advisory, nothing removed.
 */
describe("H6 — per-entry subtraction fails closed on an unprovable owned group", () => {
  it("refuses when an operator entry is inserted inside a group AIH owns", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const tampered = rewriteHooks((hooks) => {
      const stop = hooks.Stop as { hooks: unknown[] }[];
      stop[0]?.hooks.push({ type: "command", command: "node ./tools/operator-guard.mjs" });
    });

    expect(hookRegistrarState(dir).state).toBe("drifted");
    expect(() => hookRegistrarRevocationActions(ctx(false))).toThrowError(/drift|changed/i);
    expect(readDestination()).toBe(tampered);
  });

  it("refuses when an owned entry's command was modified", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const tampered = rewriteHooks((hooks) => {
      const stop = hooks.Stop as { hooks: { command: string }[] }[];
      const hook = stop[0]?.hooks[0];
      if (hook !== undefined) hook.command += " --tampered";
    });

    expect(hookRegistrarState(dir).state).toBe("drifted");
    expect(() => hookRegistrarRevocationActions(ctx(false))).toThrowError(/drift|changed/i);
    expect(readDestination()).toBe(tampered);
  });

  it("refuses when one owned group went missing", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const tampered = rewriteHooks((hooks) => {
      (hooks.Stop as unknown[]).splice(0, 1);
    });

    expect(hookRegistrarState(dir).state).toBe("drifted");
    expect(() => hookRegistrarRevocationActions(ctx(false))).toThrowError(/drift|changed/i);
    expect(readDestination()).toBe(tampered);
  });

  it("refuses when the group AIH owns lost a scoping field it never authored", async () => {
    seedThirdPartyEntries();
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    rewriteHooks((hooks) => {
      const stop = hooks.Stop as Record<string, unknown>[];
      if (stop[0] !== undefined) stop[0].matcher = "Edit|Write";
    });

    expect(hookRegistrarState(dir).state).toBe("drifted");
  });
});
