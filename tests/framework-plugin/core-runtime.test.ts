import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bindFrameworkCoreRuntimeV1 } from "../../src/framework-plugin/core-runtime.js";
import { doc, type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(root: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

it("records only its own plan result and refuses a different root or a revoked invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-core-runtime-"));
  const other = mkdtempSync(join(tmpdir(), "aih-core-runtime-other-"));
  roots.push(root, other);
  const ctx = context(root);
  const produced = new WeakSet<object>();
  const bound = bindFrameworkCoreRuntimeV1({
    frameworkId: "ecc",
    ctx,
    transactionPins: {},
    produced,
  });
  const guidance = plan("ECC guidance", doc("ECC", "Read the pinned guidance."));
  await expect(bound.runtime.executePlan(guidance, context(other))).rejects.toThrow(
    "another root than its invocation",
  );
  const result = await bound.runtime.executePlan(guidance, ctx);
  expect(produced.has(result)).toBe(true);
  expect(result.docs.map((entry) => entry.text)).toContain("Read the pinned guidance.");
  bound.revoke();
  await expect(bound.runtime.executePlan(guidance, ctx)).rejects.toThrow(
    "after its invocation ended",
  );
});
