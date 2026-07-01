import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/commands/index.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

// #35 — plan() purity guardrail.
//
// The dry-run trust story is that computing a plan performs NO arbitrary or
// attacker-controlled execution. A few commands legitimately run READ-ONLY tools during
// plan() to DECIDE what to emit — heal's node/npm/npx + TLS checks pick the repair ladder,
// certs reads the OS trust store, report shells git for stats. Those results shape the plan
// and so cannot be deferred into a `probe` (the plan can't be built without them); they are
// documented, allowlisted exceptions below.
//
// This test PINS that exception set: only these read-only binaries, on fixed targets, may be
// exec'd during plan() — never anything else. If a future change shells out an arbitrary or
// interpolated command at plan time (the #1 `AIH_GRAPH_CMD` class of bug), it fails HERE, in
// CI, instead of in production.
const ALLOWED_PLAN_READS = new Set<string>([
  "git", // report / workspace — read-only repo stats
  "node", // heal — `node --version` runtime presence
  "npm", // heal — `npm --version` runtime health
  "npx", // heal / mcp — pre-flight
  "curl", // heal / certs — TLS reachability to fixed hosts
  "uv", // mcp — pinned code-review-graph launcher
  "uvx", // mcp — pinned code-review-graph launcher
  "openssl", // certs — inspect the corporate CA (no key material)
  "which", // ecc / superpowers / mcp / report — presence detection (fixed CLI/tool names)
  "nproc", // hardware — CPU count
  "nvidia-smi", // hardware — GPU query (--query-gpu, read-only)
]);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-plan-purity-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctxWithRecorder(recorded: string[][]): PlanContext {
  const run = fakeRunner((argv) => {
    recorded.push([...argv]);
    return undefined; // default RunResult (code 0, empty stdout) — read succeeds, empty
  });
  return {
    root: tmp,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: tmp },
    options: {},
  };
}

describe("plan() purity — no arbitrary exec during dry-run (#35)", () => {
  it("every command's plan(ctx) only execs read-only, allowlisted binaries", async () => {
    const violations: string[] = [];
    for (const spec of ALL_COMMANDS) {
      const recorded: string[][] = [];
      const ctx = ctxWithRecorder(recorded);
      try {
        await spec.plan(ctx);
      } catch {
        // A command may need fixtures to finish planning; any reads it made before
        // throwing are already recorded and still checked.
      }
      for (const argv of recorded) {
        const bin = argv[0] ?? "";
        if (!ALLOWED_PLAN_READS.has(bin)) violations.push(`${spec.name}: ${JSON.stringify(argv)}`);
      }
    }
    expect(
      violations,
      `un-allowlisted exec during plan() — either it's an arbitrary-exec regression, or a new read-only tool to document + allowlist:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
