import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/bootstrap-ai/index.js";
import type { Action, PlanContext, ProbeAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-bootai-lint-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: tmp },
    options,
  };
}

function lintProbeActions(actions: Action[]): ProbeAction[] {
  return actions.filter(
    (a): a is ProbeAction => a.kind === "probe" && a.describe.startsWith("lint "),
  );
}

describe("bootstrap-ai — canon markdown lint", () => {
  it("REGRESSION LOCK: every generated canon doc passes the fail-tier lint today", async () => {
    // If a future edit adds a dangling `#[[file:]]` ref or leftover <insert> to the
    // generated canon, one of these probes goes red — exactly the guard we want.
    const ctx = makeCtx({ allTools: true });
    const probes = lintProbeActions((await command.plan(ctx)).actions);
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) {
      const res = await p.run(ctx);
      expect(res.verdict, `${res.name}: ${res.detail ?? ""}`).not.toBe("fail");
    }
  });

  it("emits a lint probe for the router, every adapter, and every bootloader", async () => {
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    const names = lintProbeActions(actions).map((p) => p.describe);
    expect(names).toContain("lint ai-coding/RULE_ROUTER.md");
    expect(names).toContain("lint ai-coding/adapters/claude.md");
    expect(names).toContain("lint CLAUDE.md");
    // The .gitignore write is not a canon doc and must not be linted.
    expect(names).not.toContain("lint .gitignore");
  });

  it("does not lint the user-merged bootloader file (only the generated block body)", async () => {
    // A bootloader's lint probe runs over preamble+block.body, never user prose
    // outside the markers — so a user's hand-edited 'should' can't fail the gate.
    const ctx = makeCtx();
    const probes = lintProbeActions((await command.plan(ctx)).actions);
    const claude = probes.find((p) => p.describe === "lint CLAUDE.md");
    expect(claude).toBeDefined();
    const res = await claude?.run(ctx);
    expect(res?.verdict).not.toBe("fail");
  });
});
