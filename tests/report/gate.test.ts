import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan, summarizeResult } from "../../src/internals/execute.js";
import type { PlanContext, ProbeAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/report/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-report-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A report ctx. `alwaysVerify` on the real command forces verify; tests mirror that. */
function ctx(options: Record<string, unknown>, verify = true): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: dir, USERPROFILE: dir },
    options,
  };
}

function gateProbe(actions: { kind: string; describe: string }[]): ProbeAction | undefined {
  return actions.find(
    (a): a is ProbeAction => a.kind === "probe" && a.describe === "per-turn token budget",
  );
}

describe("aih report --gate", () => {
  it("over budget with --gate → fail probe → non-zero exit", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(1600)); // 400 tok
    const c = ctx({ gate: true, tokenBudget: "100" });
    const plan = await command.plan(c);
    const probe = gateProbe(plan.actions);
    expect(probe).toBeDefined();
    expect((await probe?.run(c))?.verdict).toBe("fail");
    const result = await executePlan(plan, c);
    expect(result.report?.exitCode()).toBe(1);
  });

  it("within budget with --gate → pass probe → exit 0", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(1600)); // 400 tok
    const c = ctx({ gate: true, tokenBudget: "5000" });
    const result = await executePlan(await command.plan(c), c);
    expect(result.report?.exitCode()).toBe(0);
  });

  it("no --gate → no token-budget probe, and over-budget still exits 0", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(1600)); // 400 tok
    const c = ctx({ tokenBudget: "100" }); // over, but no --gate
    const plan = await command.plan(c);
    expect(gateProbe(plan.actions)).toBeUndefined();
    const result = await executePlan(plan, c);
    expect(result.report?.exitCode() ?? 0).toBe(0);
  });

  it("a bare report (always-verify, no probes) prints no empty Verification section", async () => {
    const c = ctx({}); // verify true (mirrors alwaysVerify), no gate
    const result = await executePlan(await command.plan(c), c);
    expect(summarizeResult(result)).not.toContain("Verification:");
  });

  it("--budget is a back-compat alias for --token-budget", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(1600)); // 400 tok
    const c = ctx({ gate: true, budget: "100" }); // legacy flag name
    expect((await gateProbe((await command.plan(c)).actions)?.run(c))?.verdict).toBe("fail");
  });
});
