import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { AihError } from "../../src/errors.js";
import { type CommandSpec, plan, probe } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { VerificationReport } from "../../src/internals/verify.js";
import {
  appendRunLog,
  buildRunEntry,
  isLoggingEnabled,
  monthFile,
  type RunLogEntry,
  statusFor,
} from "../../src/logging/run-log.js";

describe("statusFor", () => {
  it("maps the exit signals to a status", () => {
    expect(statusFor(true, false)).toBe("failed");
    expect(statusFor(false, true)).toBe("partial");
    expect(statusFor(false, false)).toBe("success");
    expect(statusFor(true, true)).toBe("failed"); // a failed probe outranks a failed exec
  });
});

describe("buildRunEntry", () => {
  it("tallies write effects, verification, and duration", () => {
    const entry = buildRunEntry({
      runId: "run_x",
      startedAt: "2026-06-26T12:00:00.000Z",
      finishedAt: "2026-06-26T12:00:01.500Z",
      capability: "heal",
      argv: ["heal", "--verify"],
      status: "failed",
      exitCode: 1,
      mode: { apply: false, verify: true, json: false, sarif: false },
      platform: "linux",
      node: "20.0.0",
      result: {
        capability: "heal",
        applied: false,
        writes: [
          { path: "a", describe: "", merged: false, effect: "create" },
          { path: "b", describe: "", merged: false, effect: "unchanged" },
          { path: "c", describe: "", merged: false, effect: "create" },
        ],
        docs: [{ describe: "d", text: "body" }],
        probes: [],
        execs: [],
        digests: [{ describe: "x", text: "t" }],
        backups: ["a.aih.bak"],
        removed: [],
        report: new VerificationReport().pass("p").fail("f", "boom").skip("s"),
      },
    });
    expect(entry.writes).toEqual({ create: 2, overwrite: 0, merge: 0, unchanged: 1, kept: 0 });
    expect(entry.docs).toBe(1);
    expect(entry.digests).toBe(1);
    expect(entry.backups).toBe(1);
    expect(entry.verification).toEqual({ pass: 1, fail: 1, skip: 1 });
    expect(entry.durationMs).toBe(1500);
    expect(entry.schemaVersion).toBe(2);
    expect(entry.host).toMatchObject({ platform: "linux", hostnameHash: expect.any(String) });
    expect(entry.repo).toMatchObject({ remoteHash: expect.any(String) });
  });

  it("handles a thrown run with no result", () => {
    const entry = buildRunEntry({
      runId: "run_x",
      startedAt: "2026-06-26T12:00:00.000Z",
      finishedAt: "2026-06-26T12:00:00.000Z",
      capability: "heal",
      argv: [],
      status: "error",
      exitCode: 1,
      mode: { apply: false, verify: false, json: false, sarif: false },
      platform: "linux",
      node: "20.0.0",
    });
    expect(entry.writes).toEqual({ create: 0, overwrite: 0, merge: 0, unchanged: 0, kept: 0 });
    expect(entry.verification).toBeUndefined();
    expect(entry.durationMs).toBe(0);
  });
});

describe("monthFile", () => {
  it("shards by UTC year-month", () => {
    expect(monthFile(new Date("2026-06-26T12:00:00Z"))).toBe("2026-06.jsonl");
    expect(monthFile(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01.jsonl");
  });
});

describe("isLoggingEnabled", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-log-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeMarker(): void {
    writeFileSync(
      join(dir, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: [] }),
    );
  }

  it("requires an initialised repo (committed marker)", () => {
    expect(isLoggingEnabled(dir, {}, {})).toBe(false);
    writeMarker();
    expect(isLoggingEnabled(dir, {}, {})).toBe(true);
  });

  it("honors --no-log and AIH_LOG=0", () => {
    writeMarker();
    expect(isLoggingEnabled(dir, {}, { noLog: true })).toBe(false);
    expect(isLoggingEnabled(dir, { AIH_LOG: "0" }, {})).toBe(false);
  });
});

describe("appendRunLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-log-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry: RunLogEntry = {
    schemaVersion: 2,
    runId: "run_x",
    startedAt: "2026-06-26T12:00:00.000Z",
    finishedAt: "2026-06-26T12:00:00.000Z",
    durationMs: 0,
    capability: "heal",
    argv: [],
    status: "success",
    exitCode: 0,
    mode: { apply: false, verify: true, json: false, sarif: false },
    platform: "linux",
    node: "20.0.0",
    host: { platform: "linux", hostnameHash: "host_abc12345" },
    repo: { remoteHash: "repo_def67890" },
    writes: { create: 0, overwrite: 0, merge: 0, unchanged: 0, kept: 0 },
    docs: 0,
    execs: 0,
    digests: 0,
    backups: 0,
  };

  it("appends one JSON line per call, never rewriting", () => {
    appendRunLog(dir, entry, new Date("2026-06-26T12:00:00Z"));
    appendRunLog(dir, { ...entry, runId: "run_y" }, new Date("2026-06-26T12:00:00Z"));
    const file = join(dir, ".aih", "runs", "2026-06.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] ?? "{}") as RunLogEntry).runId).toBe("run_x");
    expect((JSON.parse(lines[1] ?? "{}") as RunLogEntry).runId).toBe("run_y");
  });
});

// --- runCapability wiring -------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-ledger-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeMarker(): void {
  writeFileSync(
    join(dir, ".aih-config.json"),
    JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: [] }),
  );
}

const failSpec: CommandSpec = {
  name: "diag",
  summary: "test diag",
  alwaysVerify: true,
  plan: () =>
    plan(
      "diag",
      probe("drift", () => ({ name: "drift", verdict: "fail", detail: "drifted" })),
    ),
};

const throwSpec: CommandSpec = {
  name: "boom",
  summary: "test boom",
  plan: () => {
    throw new AihError("AIH_TEST", "kaboom");
  },
};

function command(argv: string[]): Command {
  const cmd = new Command("c");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--no-log");
  cmd.parse(argv, { from: "user" });
  return cmd;
}

async function run(spec: CommandSpec, argv: string[]): Promise<void> {
  await runCapability(spec, command(argv), {
    run: fakeRunner(() => undefined),
    env: {},
    now: () => new Date("2026-06-26T12:00:00Z"),
    newRunId: () => "run_test01",
    argv: argv.filter((a) => a !== "--root" && a !== dir),
    write: () => {},
  });
}

function ledger(): RunLogEntry[] {
  const file = join(dir, ".aih", "runs", "2026-06.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunLogEntry);
}

describe("runCapability — run ledger", () => {
  it("appends one row for a verifying run once the repo is initialised", async () => {
    writeMarker();
    await run(failSpec, ["--verify", "--root", dir]);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run_test01",
      capability: "diag",
      schemaVersion: 2,
      status: "failed",
      exitCode: 1,
      host: {
        platform: expect.any(String),
        hostnameHash: expect.stringMatching(/^host_[a-f0-9]{16}$/),
      },
      repo: { remoteHash: expect.stringMatching(/^repo_[a-f0-9]{16}$/) },
      mode: { verify: true },
      verification: { pass: 0, fail: 1, skip: 0 },
    });
  });

  it("does not log before the repo is initialised (no marker)", async () => {
    await run(failSpec, ["--verify", "--root", dir]);
    expect(ledger()).toHaveLength(0);
  });

  it("suppresses logging with --no-log", async () => {
    writeMarker();
    await run(failSpec, ["--verify", "--no-log", "--root", dir]);
    expect(ledger()).toHaveLength(0);
  });

  it("logs an error row when the command throws", async () => {
    writeMarker();
    await run(throwSpec, ["--root", dir]);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ capability: "boom", status: "error", exitCode: 1 });
  });

  it("masks secrets and scrubs the home path from the logged argv", async () => {
    writeMarker();
    await runCapability(failSpec, command(["--verify", "--root", dir]), {
      run: fakeRunner(() => undefined),
      env: { HOME: "/home/sam" },
      now: () => new Date("2026-06-26T12:00:00Z"),
      newRunId: () => "run_test01",
      argv: ["diag", "--token", "sk-ant-ABCDEFGH12345678", "--root", "/home/sam/proj"],
      write: () => {},
    });
    expect(ledger()[0]?.argv).toEqual(["diag", "--token", "[REDACTED]", "--root", "<home>/proj"]);
  });
});
