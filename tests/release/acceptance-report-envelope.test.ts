import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { executePlan } from "../../src/internals/execute.js";
import { plan, probe } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Verdict } from "../../src/internals/verify.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const names = ["release npm signatures", "release cosign bundle", "release tarball hash"];

async function envelope(verdicts: Verdict[] = ["pass", "pass", "pass"]) {
  const run = fakeRunner(() => undefined);
  const root = mkdtempSync(join(tmpdir(), "aih-acceptance-plan-"));
  roots.push(root);
  const context = {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
  const result = await executePlan(
    plan(
      "verify-release",
      ...names.map((name, index) =>
        probe(name, () => Promise.resolve({ name, verdict: verdicts[index] ?? "skip" })),
      ),
    ),
    context,
  );
  return JSON.parse(JSON.stringify(result));
}

function installedCheck(value: unknown) {
  const workflow = parse(readFileSync(".github/workflows/installed-acceptance.yml", "utf8"));
  const step = workflow.jobs["exact-installed"].steps.find(
    (row: { name?: string }) =>
      row.name === "Install and verify exact public packages in a disposable root",
  );
  const scripts = [...step.run.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/gu)];
  const script = scripts.find((row) => row[1]?.includes('readFileSync("verify-release.json"'))?.[1];
  expect(script).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), "aih-acceptance-envelope-"));
  roots.push(root);
  writeFileSync(join(root, "verify-release.json"), JSON.stringify(value));
  return spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: root,
    input: script,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      MATRIX_OS: "ubuntu-latest",
      MATRIX_NODE: "24",
      CORE_VERSION: "0.6.1",
      SCANNER_VERSION: "0.3.0",
      CATALOG_VERSION: "0.1.3",
    },
  });
}

describe("public acceptance consumes the actual CLI execution envelope", () => {
  it("accepts the production serializer's three passing release checks", async () => {
    const value = await envelope();
    expect(value.counts).toBeUndefined();
    expect(value.report.counts).toEqual({ pass: 3, fail: 0, skip: 0 });
    const result = installedCheck(value);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("rejects failed, skipped, incomplete and unrelated verification reports", async () => {
    const values = [
      await envelope(["pass", "fail", "pass"]),
      await envelope(["pass", "skip", "pass"]),
      { report: { ok: true, counts: { pass: 0, fail: 0, skip: 0 }, checks: [] } },
      { ...(await envelope()), capability: "doctor" },
      (await envelope()).report,
    ];
    for (const value of values) expect(installedCheck(value).status).not.toBe(0);
  });

  it("applies the same strict contract to hosted policy authority", async () => {
    const { assertReleaseVerification } = await import(
      pathToFileURL(resolve(".github/public-policy-acceptance/release-verification.mjs")).href
    );
    const value = await envelope();
    expect(assertReleaseVerification(value)).toBe(value.report);
    for (const invalid of [
      await envelope(["pass", "fail", "pass"]),
      await envelope(["pass", "skip", "pass"]),
      { ...value, capability: "doctor" },
      value.report,
      { ...value, report: { ...value.report, checks: [] } },
      {
        ...value,
        report: {
          ...value.report,
          checks: [value.report.checks[0], value.report.checks[0], value.report.checks[2]],
        },
      },
    ]) {
      expect(() => assertReleaseVerification(invalid)).toThrow();
    }
  });
});
