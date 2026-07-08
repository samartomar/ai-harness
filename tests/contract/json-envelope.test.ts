/**
 * v1.0.0 `--json` envelope contract (slice 1, issue #123).
 *
 * Pins the machine-readable output shape a `--json` consumer can rely on under
 * `@aihq/harness@^1`, exercised through the REAL pipeline (runCapability →
 * loadSettings → executePlan → probes) with a captured writer — the same
 * invocation idiom as tests/commands/run.test.ts:
 *
 *  - the real read-only `status` command: full envelope WITH report + support;
 *  - a minimal dry-run capability: envelope WITHOUT report (key absent);
 *  - runCapability's catch path: the `{ error: { code, message } }` envelope.
 *
 * Additions of unknown keys are ALLOWED (additive change, legal in a minor —
 * schemas are non-strict by design); removals/renames of pinned keys FAIL and
 * are majors-only — see STABILITY.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { DirtyWorktreeError } from "../../src/errors.js";
import {
  type CommandSpec,
  digest,
  doc,
  plan,
  probe,
  remove,
  writeText,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { command as statusCommand } from "../../src/status.js";
import { ErrorEnvelopeSchema, PlanResultEnvelopeSchema } from "./envelope-schema.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-envelope-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a standalone commander Command for a spec, populated from `argv`. */
function command(argv: string[]): Command {
  const cmd = new Command("envelope");
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

/** Run a spec through the real pipeline, capturing stdout and the exit code. */
async function run(
  spec: CommandSpec,
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCapability(spec, command(argv), {
    run: fakeRunner(() => undefined),
    env,
    write: (t) => {
      out += t;
    },
  });
  return { code, out };
}

/** A minimal mutating capability covering every PlanResult array in dry-run. */
const demoSpec: CommandSpec = {
  name: "demo",
  summary: "envelope demo capability",
  plan: () =>
    plan(
      "demo",
      writeText("demo.txt", "hello\n", "a demo file"),
      doc("cloud setup guidance", "run the setup steps"),
      digest("a computed roll-up", "1 item", { items: 1 }),
      probe("a verification", () => ({ name: "a verification", verdict: "pass" })),
      remove("ghost.txt", "an absent file"),
    ),
};

/** A capability whose plan refuses with a coded AihError (the refusal contract). */
const refusingSpec: CommandSpec = {
  name: "refusing",
  summary: "always refuses",
  plan: () => {
    throw new DirtyWorktreeError("refusing to overwrite uncommitted changes in: demo.txt");
  },
};

describe("v1 contract — --json success envelope (real read-only command: status)", () => {
  it("emits a schema-valid envelope with report + support", async () => {
    const { code, out } = await run(statusCommand, ["--json", "--root", dir]);
    expect(code).toBe(0); // status is pass/skip only — never fails
    const payload = PlanResultEnvelopeSchema.parse(JSON.parse(out));

    expect(payload.capability).toBe("status");
    expect(payload.applied).toBe(false); // read-only commands never apply
    // A read-only command plans ZERO mutations — pinned as part of the contract.
    expect(payload.writes).toEqual([]);
    expect(payload.execs).toEqual([]);
    expect(payload.backups).toEqual([]);
    expect(payload.removed).toEqual([]);
    expect(payload.probes.length).toBeGreaterThan(0);
    // readOnly ⇒ always verified: report present, counts add up, nothing failed.
    expect(payload.report).toBeDefined();
    expect(payload.report?.ok).toBe(true);
    const counts = payload.report?.counts;
    expect((counts?.pass ?? 0) + (counts?.fail ?? 0) + (counts?.skip ?? 0)).toBe(
      payload.report?.checks.length,
    );
    // A report with checks always carries the support block (findings + templates).
    expect(payload.support).toBeDefined();
  });

  it("omits the report key entirely when verification did not run (dry-run, no --verify)", async () => {
    const { code, out } = await run(demoSpec, ["--json", "--root", dir]);
    expect(code).toBe(0);
    const raw = JSON.parse(out) as Record<string, unknown>;
    expect("report" in raw).toBe(false); // absent key, not null — pinned
    expect("support" in raw).toBe(false);

    const payload = PlanResultEnvelopeSchema.parse(raw);
    expect(payload.applied).toBe(false);
    expect(payload.writes).toEqual([
      { path: "demo.txt", describe: "a demo file", merged: false, effect: "create" },
    ]);
    expect(payload.docs).toEqual([{ describe: "cloud setup guidance" }]);
    expect(payload.digests).toEqual([
      { describe: "a computed roll-up", text: "1 item", data: { items: 1 } },
    ]);
    expect(payload.removed).toEqual([
      { path: "ghost.txt", describe: "an absent file", effect: "absent" },
    ]);
    expect(payload.probes).toEqual([{ describe: "a verification" }]);
  });
});

describe("v1 contract — --json error envelope (refusal path)", () => {
  it("emits { error: { code, message } } with the AihError's stable code and exits 1", async () => {
    const { code, out } = await run(refusingSpec, ["--json", "--root", dir]);
    expect(code).toBe(1);
    const payload = ErrorEnvelopeSchema.parse(JSON.parse(out));
    expect(payload.error.code).toBe("AIH_DIRTY_WORKTREE");
    expect(payload.error.message).toContain("refusing to overwrite");
  });

  it("honors AIH_JSON for early settings failures before loadSettings completes", async () => {
    const { code, out } = await run(refusingSpec, ["--root", dir], {
      AIH_JSON: "1",
      AIH_POSTURE: "enterprsie",
    });
    expect(code).toBe(1);
    const payload = ErrorEnvelopeSchema.parse(JSON.parse(out));
    expect(payload.error.code).toBe("AIH_SETTINGS");
    expect(payload.error.message).toContain("invalid AIH_POSTURE");
  });
});

describe("v1 contract — additive stays legal, removals fail", () => {
  async function statusPayload(): Promise<Record<string, unknown>> {
    const { out } = await run(statusCommand, ["--json", "--root", dir]);
    return JSON.parse(out) as Record<string, unknown>;
  }

  it("ALLOWS unknown-key additions at the top level and inside report (minor-safe)", async () => {
    const payload = await statusPayload();
    expect(() =>
      PlanResultEnvelopeSchema.parse({ ...payload, vNextField: { anything: true } }),
    ).not.toThrow();
    const report = payload.report as Record<string, unknown>;
    expect(() =>
      PlanResultEnvelopeSchema.parse({ ...payload, report: { ...report, vNextStat: 42 } }),
    ).not.toThrow();
  });

  it("FAILS on removal or rename of a pinned key (majors only — see STABILITY.md)", async () => {
    const payload = await statusPayload();

    const { capability: _dropped, ...withoutCapability } = payload;
    expect(() => PlanResultEnvelopeSchema.parse(withoutCapability)).toThrow();

    const { applied, ...rest } = payload;
    expect(() => PlanResultEnvelopeSchema.parse({ ...rest, isApplied: applied })).toThrow();

    const report = payload.report as { counts: Record<string, number> } & Record<string, unknown>;
    const { skip: _skip, ...countsWithoutSkip } = report.counts;
    expect(() =>
      PlanResultEnvelopeSchema.parse({
        ...payload,
        report: { ...report, counts: countsWithoutSkip },
      }),
    ).toThrow();
  });
});
