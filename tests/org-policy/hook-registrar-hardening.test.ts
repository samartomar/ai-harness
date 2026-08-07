import {
  lstatSync,
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
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_MAX_DESTINATION_BYTES,
  hookRegistrarProjectionActions,
  hookRegistrarRevocationActions,
  hookRegistrarState,
  readHookRegistrarReceipt,
} from "../../src/org-policy/hook-registrar.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { eccStopRegistrations } from "./hook-registrar-fixtures.js";

/**
 * Hardening pins for the hook registrar's read path: what it records, what it
 * refuses, and what it is allowed to display. Every case runs against a
 * temporary fixture root this file creates and removes.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-hook-registrar-hardening-"));
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

function writeDestination(contents: string): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), contents, "utf8");
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

describe("A4 — recorded prior evidence is always readable back", () => {
  /**
   * The receipt caps the prior bytes it can carry. A destination bigger than
   * that cap must never be projected onto and then recorded: the receipt would
   * refuse to parse for the rest of its life, so revocation could never run and
   * every projected third-party entry would be stuck on disk with no removal
   * path — the exact defect this projector exists to eliminate.
   */
  it("refuses a destination larger than the receipt can carry, and revokes once it is trimmed", async () => {
    const oversized = `${JSON.stringify({
      note: "z".repeat(HOOK_REGISTRAR_MAX_DESTINATION_BYTES),
    })}\n`;
    writeDestination(oversized);

    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
      /receipt/i,
    );
    // Refusal is fail-closed: nothing was written, nothing was recorded.
    expect(readDestination()).toBe(oversized);
    expect(readHookRegistrarReceipt(dir)).toBeUndefined();

    // Trimmed back under the cap, the whole lifecycle works again.
    writeDestination(`${JSON.stringify({ note: "z" })}\n`);
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const receipt = readHookRegistrarReceipt(dir);
    expect(receipt?.prior.state).toBe("present");
    await run(hookRegistrarRevocationActions(ctx(false)));
    expect(readHookRegistrarReceipt(dir)).toBeUndefined();
    expect(readDestination() ?? "").not.toContain("run-with-flags.js");
  });
});

describe("H1 — nothing under `hooks` is deleted without being owned or named", () => {
  /**
   * The projection writes with `replaceJsonKeys: ["hooks"]`, so everything the
   * flattening cannot see is destroyed without ever reaching the foreign-entry
   * refusal. H1 forbids silently absorbing an unowned entry and equally forbids
   * silently deleting one, so content AIH cannot re-emit verbatim has to refuse.
   */
  function selectedCommand(): string {
    const [selected] = eccStopRegistrations();
    if (selected === undefined) throw new Error("expected a registration");
    return selected.command;
  }

  function refusalFor(destination: unknown): string {
    writeDestination(`${JSON.stringify(destination, null, 2)}\n`);
    const before = readDestination();
    let message = "";
    try {
      hookRegistrarProjectionActions(ctx(false), eccStopRegistrations());
    } catch (error) {
      message = (error as Error).message;
    }
    // Refusal is not enough on its own: the content must still be on disk.
    expect(readDestination()).toBe(before);
    return message;
  }

  it("refuses a matcher-scoped entry rather than re-emit it unscoped", () => {
    // The command matches a selected registration, so the flattening called it
    // already-known and re-emitted it WITHOUT the matcher — silently widening a
    // hook scoped to one tool into one that fires on everything.
    const message = refusalFor({
      hooks: {
        Stop: [{ matcher: "Write", hooks: [{ type: "command", command: selectedCommand() }] }],
      },
    });
    expect(message).toMatch(/matcher/);
    expect(message).toMatch(/Stop/);
  });

  it("refuses a hook entry whose command is not a string", () => {
    const message = refusalFor({
      hooks: { Stop: [{ hooks: [{ type: "command", command: { $ref: "elsewhere" } }] }] },
    });
    expect(message).toMatch(/command/i);
    expect(message).toMatch(/Stop/);
  });

  it("refuses an empty hook group", () => {
    const message = refusalFor({ hooks: { Stop: [{ hooks: [] }] } });
    expect(message).toMatch(/Stop/);
    expect(message).toMatch(/empty/i);
  });

  it("refuses an event mapped to an empty array", () => {
    const message = refusalFor({ hooks: { SessionStart: [] } });
    expect(message).toMatch(/SessionStart/);
    expect(message).toMatch(/empty/i);
  });

  it("refuses a per-hook field it would drop, rather than drop it", () => {
    // `timeout` never reached the flattening, so a projected entry that matched
    // by command alone came back without the destination's timeout.
    const message = refusalFor({
      hooks: { Stop: [{ hooks: [{ type: "command", command: selectedCommand(), timeout: 45 }] }] },
    });
    expect(message).toMatch(/did not emit|timeout/i);
  });
});

describe("fail closed on ambiguity — unreadable is not absent", () => {
  /**
   * `absent` is not a neutral verdict here. It is the flag that authorizes
   * deleting the destination on revocation, and the flag that skips the
   * unowned-entry check entirely. A path AIH merely failed to read — a
   * directory, a symlink, a special file — must never be recorded as one.
   */
  it("refuses a destination path occupied by a directory", () => {
    mkdirSync(join(dir, HOOK_REGISTRAR_DESTINATION), { recursive: true });

    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
      /regular file/i,
    );
    const state = hookRegistrarState(dir);
    expect(state.state).toBe("invalid");
    expect(state.detail).toMatch(/regular file/i);
  });
});

describe("symlinked parents are refused, not followed off-root", () => {
  /**
   * The no-follow reads guard the LEAF only. Every sibling lifecycle also
   * guards the parents, and for the same reason: with `.claude` or `.aih`
   * redirected, ownership state is read from outside the root and reported as
   * if it were in it — and the executor refuses a symlinked parent outright, so
   * the removal the report promises would die inside the action loop instead of
   * degrading to an advisory.
   */
  function linkDirectory(target: string, linkPath: string): string | undefined {
    try {
      symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      return `this platform cannot create a directory link in a fixture root: ${(error as Error).message}`;
    }
    return lstatSync(linkPath).isSymbolicLink()
      ? undefined
      : "this platform does not report the created directory link as a symlink";
  }

  it("refuses a destination reached through a symlinked parent", (test) => {
    const outside = mkdtempSync(join(tmpdir(), "aih-hook-registrar-outside-"));
    try {
      writeFileSync(
        join(outside, "settings.json"),
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node outside.js" }] }] } })}\n`,
        "utf8",
      );
      const cannotLink = linkDirectory(outside, join(dir, ".claude"));
      if (cannotLink !== undefined) test.skip(cannotLink);

      const state = hookRegistrarState(dir);
      expect(state.state).toBe("invalid");
      expect(state.detail).toMatch(/symlink/i);
      expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
        /symlink/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a receipt reached through a symlinked parent", (test) => {
    const outside = mkdtempSync(join(tmpdir(), "aih-hook-registrar-outside-"));
    try {
      writeFileSync(join(outside, "org-policy-hook-registrar-receipt.json"), "{}\n", "utf8");
      const cannotLink = linkDirectory(outside, join(dir, ".aih"));
      if (cannotLink !== undefined) test.skip(cannotLink);

      expect(() => readHookRegistrarReceipt(dir)).toThrowError(/symlink/i);
      expect(hookRegistrarState(dir).state).toBe("invalid");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
