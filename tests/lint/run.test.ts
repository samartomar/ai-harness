import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext, ProbeAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { canonLintCheck, lintProbes } from "../../src/lint/run.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-lint-run-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(relPath: string, contents: string): void {
  const full = join(tmp, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function planCtx(): PlanContext {
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
    options: {},
  };
}

describe("lintProbes (bootstrap-ai surface)", () => {
  it("passes a clean doc whose refs are all planned", async () => {
    const planned = new Set(["ai-coding/RULE_ROUTER.md", "ai-coding/rules/agent-behavior-core.md"]);
    const generated = [
      {
        path: "ai-coding/RULE_ROUTER.md",
        source: "Read `ai-coding/rules/agent-behavior-core.md`.\n",
      },
    ];
    const [probe] = lintProbes(generated, planned, tmp) as ProbeAction[];
    const res = await probe?.run(planCtx());
    expect(res?.verdict).toBe("pass");
  });

  it("fails a doc that references a file the plan never writes", async () => {
    const generated = [
      { path: "ai-coding/RULE_ROUTER.md", source: "Load #[[file:ai-coding/GHOST.md]].\n" },
    ];
    const [probe] = lintProbes(
      generated,
      new Set(["ai-coding/RULE_ROUTER.md"]),
      tmp,
    ) as ProbeAction[];
    const res = await probe?.run(planCtx());
    expect(res?.verdict).toBe("fail");
    expect(res?.detail).toContain("GHOST.md");
  });

  it("emits one probe per generated doc", () => {
    const generated = [
      { path: "ai-coding/RULE_ROUTER.md", source: "ok\n" },
      { path: "CLAUDE.md", source: "ok\n" },
    ];
    expect(lintProbes(generated, new Set(), tmp)).toHaveLength(2);
  });
});

describe("canonLintCheck (doctor surface)", () => {
  it("skips when the context dir is not scaffolded", () => {
    const res = canonLintCheck(tmp, "ai-coding");
    expect(res.verdict).toBe("skip");
    expect(res.detail).toContain("not scaffolded");
  });

  it("passes when the on-disk canon's references all resolve", () => {
    put("ai-coding/RULE_ROUTER.md", "Read `ai-coding/rules/agent-behavior-core.md` first.\n");
    put("ai-coding/rules/agent-behavior-core.md", "Validate against repo evidence.\n");
    const res = canonLintCheck(tmp, "ai-coding");
    expect(res.verdict).toBe("pass");
  });

  it("resolves a BARE basename reference against the on-disk dir-prefixed canon", () => {
    // An adapter note says "read `RULE_ROUTER.md`" while the file lives at
    // ai-coding/RULE_ROUTER.md — must resolve by basename, not false-fail.
    put("ai-coding/RULE_ROUTER.md", "Routing entry point.\n");
    put("ai-coding/adapters/claude.md", "Claude: read `RULE_ROUTER.md` before non-trivial work.\n");
    const res = canonLintCheck(tmp, "ai-coding");
    expect(res.verdict).toBe("pass");
  });

  it("fails when an on-disk canon file has a dangling reference", () => {
    put("ai-coding/RULE_ROUTER.md", "Load #[[file:ai-coding/MISSING.md]].\n");
    const res = canonLintCheck(tmp, "ai-coding");
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("MISSING.md");
  });

  it("reports skeleton-unfilled as a non-failing skip (advisory)", () => {
    put("ai-coding/RULE_ROUTER.md", "All good.\n");
    put("ai-coding/architecture.md", "# Architecture\n\n_Expand: what this system does_\n");
    const res = canonLintCheck(tmp, "ai-coding");
    expect(res.verdict).toBe("skip");
    expect(res.detail).toContain("skeleton");
  });

  it("does not follow linked canon directories outside the repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-lint-run-outside-"));
    try {
      put(
        "ai-coding/RULE_ROUTER.md",
        "# Router\n\nRead `ai-coding/rules/agent-behavior-core.md`.\n",
      );
      put("ai-coding/rules/agent-behavior-core.md", "# Core\n\nValidate repo evidence.\n");
      writeFileSync(join(outside, "claude.md"), "Load #[[file:GHOST.md]].\n", "utf8");
      symlinkSync(outside, join(tmp, "ai-coding", "adapters"), "junction");

      const res = canonLintCheck(tmp, "ai-coding");

      expect(res.verdict).toBe("pass");
      expect(res.detail).not.toContain("GHOST.md");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("canonLintCheck — scope: only aih-authored files", () => {
  it("ignores a dangling ref in USER content but catches one in an aih-authored doc", () => {
    // aih-authored router with a clean ref → fine.
    put("ai-coding/RULE_ROUTER.md", "# Router\n\nRead `ai-coding/rules/agent-behavior-core.md`.\n");
    put("ai-coding/rules/agent-behavior-core.md", "# Core\n\nMUST verify.\n");
    // USER content citing real repo files / tool-native paths → NOT policed.
    put(
      "ai-coding/agents/security.md",
      "Honor `.claude/rules/x.mdc` and `apps/web/package.json` and `tsconfig.app.json`.\n",
    );
    put("ai-coding/playbooks/p.md", "See `RULE_INDEX.md` and `graphify-out/graph.json`.\n");
    expect(canonLintCheck(tmp, "ai-coding").verdict).toBe("pass");
  });

  it("still fails when an aih-authored doc has a broken canon link", () => {
    put("ai-coding/RULE_ROUTER.md", "# Router\n\nRead `ai-coding/rules/MISSING.md`.\n");
    const check = canonLintCheck(tmp, "ai-coding");
    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("canon.lint-failed");
  });
});
