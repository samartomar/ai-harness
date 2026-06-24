import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import {
  doc,
  type PlanContext,
  plan,
  probe,
  writeJson,
  writeText,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-exec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

describe("executePlan", () => {
  it("dry-run reports planned writes but writes nothing", async () => {
    const res = await executePlan(
      plan("t", writeText("a.txt", "hi", "write a")),
      ctx({ apply: false }),
    );
    expect(res.applied).toBe(false);
    expect(res.writes[0]?.effect).toBe("create");
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("apply writes files with a trailing newline", async () => {
    await executePlan(plan("t", writeText("a.txt", "hi", "write a")), ctx({ apply: true }));
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi\n");
  });

  it("merge writes preserve existing user JSON keys", async () => {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ user: 1 }));
    const res = await executePlan(
      plan("t", writeJson("c.json", { aih: 2 }, "merge", { merge: true })),
      ctx({ apply: true }),
    );
    expect(res.writes[0]?.effect).toBe("merge");
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8"))).toEqual({ user: 1, aih: 2 });
  });

  it("runs probe actions only under verify", async () => {
    const p = plan(
      "t",
      probe("check", () => ({ name: "x", verdict: "pass" })),
    );
    expect((await executePlan(p, ctx({ verify: false }))).report).toBeUndefined();
    expect((await executePlan(p, ctx({ verify: true }))).report?.ok).toBe(true);
  });

  it("writes doc actions that carry a path", async () => {
    await executePlan(plan("t", doc("guidance", "do X", "docs/guide.md")), ctx({ apply: true }));
    expect(readFileSync(join(dir, "docs/guide.md"), "utf8")).toBe("do X\n");
  });
});
