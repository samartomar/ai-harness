/**
 * v1.0.0 exit-code contract (slice 1, issue #123).
 *
 * Pins the process exit codes a CI consumer can gate on under
 * `@aihq/harness@^1`, as implemented by runCapability (src/commands/run.ts):
 *
 *   0 — success: dry-run plan computed, apply committed, and (when
 *       verification ran) every check passed or was SKIPPED — skip never
 *       fails a run (tool-absent probes must not break CI);
 *   1 — any FAILING verification check, a failed non-allowFailure exec under
 *       --apply, or a refusal/crash (AihError and everything else).
 *
 * There are no other exit codes on this path. Changing any pinned mapping is
 * a breaking change: majors only — see STABILITY.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { AihError } from "../../src/errors.js";
import { type CommandSpec, exec, plan, probe, writeText } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { command as statusCommand } from "../../src/status.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-exit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a standalone commander Command for a spec, populated from `argv`. */
function command(argv: string[]): Command {
  const cmd = new Command("exit");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--posture <posture>", "", "vibe");
  cmd.parse(argv, { from: "user" });
  return cmd;
}

/** Run a spec through the real pipeline; returns the contract-relevant exit code. */
async function exitCodeOf(
  spec: CommandSpec,
  argv: string[],
  run: Runner = fakeRunner(() => undefined),
): Promise<number> {
  return runCapability(spec, command(argv), { run, env: {}, write: () => {} });
}

/** A mutating capability whose single probe PASSES. */
const cleanSpec: CommandSpec = {
  name: "clean",
  summary: "plans one write; verification passes",
  plan: () =>
    plan(
      "clean",
      writeText("demo.txt", "hello\n", "a demo file"),
      probe("ok", () => ({ name: "ok", verdict: "pass" })),
    ),
};

/** A capability with one passing and one FAILING probe. */
const failingSpec: CommandSpec = {
  name: "failing",
  summary: "verification fails",
  plan: () =>
    plan(
      "failing",
      probe("ok", () => ({ name: "ok", verdict: "pass" })),
      probe("drift", () => ({ name: "drift", verdict: "fail", detail: "drifted" })),
    ),
};

/** The failing capability, but diagnosing by default (doctor/heal convention). */
const alwaysVerifyFailingSpec: CommandSpec = { ...failingSpec, alwaysVerify: true };

/** A capability whose plan REFUSES with a coded AihError. */
const refusingSpec: CommandSpec = {
  name: "refusing",
  summary: "always refuses",
  plan: () => {
    throw new AihError("simulated refusal", "AIH_TRUST");
  },
};

/** A capability whose local helper exec exits non-zero under --apply. */
const failingExecSpec: CommandSpec = {
  name: "failing-exec",
  summary: "exec fails under apply",
  plan: () => plan("failing-exec", exec("broken helper", ["broken-tool", "--flag"])),
};

describe("v1 contract — exit codes", () => {
  it("0: clean dry-run (plan computed, nothing verified, nothing written)", async () => {
    expect(await exitCodeOf(cleanSpec, ["--root", dir])).toBe(0);
  });

  it("0: passing verification under --verify", async () => {
    expect(await exitCodeOf(cleanSpec, ["--verify", "--root", dir])).toBe(0);
  });

  it("0: skipped checks never fail — real `status` on an empty root exits 0", async () => {
    expect(await exitCodeOf(statusCommand, ["--root", dir])).toBe(0);
  });

  it("1: a failing verification check under --verify", async () => {
    expect(await exitCodeOf(failingSpec, ["--verify", "--root", dir])).toBe(1);
  });

  it("1: an alwaysVerify capability fails on a BARE run (doctor/heal CI-gate convention)", async () => {
    expect(await exitCodeOf(alwaysVerifyFailingSpec, ["--root", dir])).toBe(1);
  });

  it("1: an AihError refusal (thrown from plan)", async () => {
    expect(await exitCodeOf(refusingSpec, ["--root", dir])).toBe(1);
  });

  it("1: a failed non-allowFailure exec under --apply", async () => {
    const run = fakeRunner((argv) => (argv[0] === "broken-tool" ? { code: 1 } : undefined));
    expect(await exitCodeOf(failingExecSpec, ["--apply", "--root", dir], run)).toBe(1);
  });

  it("0: the same exec failure stays 0 in dry-run — execs do not run without --apply", async () => {
    const run = fakeRunner((argv) => (argv[0] === "broken-tool" ? { code: 1 } : undefined));
    expect(await exitCodeOf(failingExecSpec, ["--root", dir], run)).toBe(0);
  });
});
