import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import { type Action, type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  hookRegistrarProjectionActions,
  hookRegistrarRevocationActions,
} from "../../src/org-policy/hook-registrar.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { eccStopRegistrations } from "./hook-registrar-fixtures.js";

/**
 * Revocation proves ownership and then pins the write it emits. Both have to
 * come from the SAME bytes: a write landing between two reads would be baked
 * into the pin, pass at apply, and the whole-key subtraction would then delete
 * the entry that arrived — the deletion the single-registrar contract forbids.
 *
 * The reads are captured by wrapping the one filesystem helper the projector
 * reads through, which is also how a write is injected between them.
 */
const destinationReads: (string | undefined)[] = [];
let onDestinationRead: (() => void) | undefined;

vi.mock("../../src/internals/fsxn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/internals/fsxn.js")>();
  return {
    ...actual,
    readRegularFile: (abs: string, options: { maxBytes?: number } = {}) => {
      const bytes = actual.readRegularFile(abs, options);
      if (abs.endsWith(join(".claude", "settings.json"))) {
        destinationReads.push(bytes?.toString("utf8"));
        const hook = onDestinationRead;
        onDestinationRead = undefined;
        hook?.();
      }
      return bytes;
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-hook-registrar-single-read-"));
  destinationReads.length = 0;
  onDestinationRead = undefined;
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

function readDestination(): string {
  return readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8");
}

async function run(actions: Action[]): Promise<void> {
  await executePlan(plan("hook registrar", ...actions), ctx(true), { skipWorktreeGate: true });
}

/** Operator content in the file keeps revocation on the subtract path. */
async function project(): Promise<void> {
  writeDestination(`${JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`);
  await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
  destinationReads.length = 0;
}

/** A third party reinstalling into a file AIH already owns. */
function reinstallUnownedEntry(): void {
  const current = JSON.parse(readDestination());
  current.hooks.PreToolUse = [
    { hooks: [{ type: "command", command: "node -e \"require('reinstalled.js').run()\"" }] },
  ];
  writeDestination(`${JSON.stringify(current, null, 2)}\n`);
}

describe("revocation proves ownership and pins its write over one read", () => {
  it("reads the destination exactly once and pins that read's bytes", async () => {
    await project();

    const [restore] = hookRegistrarRevocationActions(ctx(false));
    expect(destinationReads).toHaveLength(1);
    const [seen] = destinationReads;
    if (seen === undefined) throw new Error("expected the destination read to return bytes");
    if (restore === undefined || !("expect" in restore)) {
      throw new Error("expected a content-pinned destination action");
    }
    expect(restore.expect).toEqual({
      sha256: createHash("sha256").update(seen, "utf8").digest("hex"),
    });
  });

  it("never deletes an entry that arrived after the ownership verdict", async () => {
    await project();
    // A write landing in the window the second read used to open.
    onDestinationRead = reinstallUnownedEntry;

    const actions = hookRegistrarRevocationActions(ctx(false));
    await run(actions).catch(() => undefined);

    // The pin belongs to the bytes the verdict saw, so the subtraction cannot
    // land on top of the newly-arrived entry: it is still there.
    expect(readDestination()).toContain("reinstalled.js");
  });
});
