import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/status.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-status-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir: ".ai-context",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function put(rel: string, contents = ""): void {
  const full = join(tmp, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

describe("status — enforcement read-back (P1-F sliver)", () => {
  it("always exits 0 — every check is pass/skip", async () => {
    const res = await executePlan(await command.plan(makeCtx()), makeCtx());
    expect(res.report?.exitCode()).toBe(0);
  });

  it("flags a pre-commit config whose git hook is NOT installed as generated-not-enforced", async () => {
    put(".pre-commit-config.yaml", "repos: []\n");
    const res = await executePlan(await command.plan(makeCtx()), makeCtx());
    const check = res.report?.checks.find((c) => c.name === "pre-commit");
    // present → pass (exit stays 0), but the detail tells the truth about enforcement
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("no active git pre-commit hook");
    expect(check?.detail).toContain("git config core.hooksPath .githooks");
  });

  it("reports the pre-commit control active once the managed hooks path is enabled", async () => {
    put(".pre-commit-config.yaml", "repos: []\n");
    put(".githooks/pre-commit", "#!/bin/sh\n");
    put(".git/config", "[core]\n\thooksPath = .githooks\n");
    const res = await executePlan(await command.plan(makeCtx()), makeCtx());
    const check = res.report?.checks.find((c) => c.name === "pre-commit");
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("hook installed — active");
  });

  it("reports the pre-commit control active once the git hook is installed", async () => {
    put(".pre-commit-config.yaml", "repos: []\n");
    put(".git/hooks/pre-commit", "#!/bin/sh\n");
    const res = await executePlan(await command.plan(makeCtx()), makeCtx());
    const check = res.report?.checks.find((c) => c.name === "pre-commit");
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("hook installed — active");
  });

  it("does not mark a regular file as the context directory", async () => {
    put(".ai-context", "not a directory\n");

    const res = await executePlan(await command.plan(makeCtx()), makeCtx());
    const check = res.report?.checks.find((c) => c.name === "context-dir");

    expect(check?.verdict).toBe("skip");
    expect(check?.detail).toContain("not a contained directory");
  });

  it("does not mark a directory as a generated config file", async () => {
    mkdirSync(join(tmp, ".gitleaks.toml"));

    const res = await executePlan(await command.plan(makeCtx()), makeCtx());
    const check = res.report?.checks.find((c) => c.name === "gitleaks");

    expect(check?.verdict).toBe("skip");
    expect(check?.detail).toContain("not a contained file");
  });
});
