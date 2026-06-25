import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan, summarizeResult } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { DEFAULT_CONTEXT_BUDGET_TOKENS, scanContextBloat } from "../../src/report/bloat.js";
import { command } from "../../src/report/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-report-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    // HOME → temp dir so the tooling panel's config-dir probe stays hermetic.
    env: { HOME: dir, USERPROFILE: dir },
    options: {},
    ...over,
  };
}

describe("scanContextBloat", () => {
  it("estimates tokens at ceil(bytes / 4) for a root bootloader", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(400));
    const claude = scanContextBloat(dir, "ai-coding").files.find((f) => f.path === "CLAUDE.md");
    expect(claude?.bytes).toBe(400);
    expect(claude?.tokens).toBe(100);
  });

  it("walks the context-dir tree and Cursor rule files", () => {
    mkdirSync(join(dir, "ai-coding"), { recursive: true });
    writeFileSync(join(dir, "ai-coding", "INDEX.md"), "hello");
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "stack.mdc"), "rules");
    const paths = scanContextBloat(dir, "ai-coding").files.map((f) => f.path);
    expect(paths).toContain("ai-coding/INDEX.md");
    expect(paths).toContain(".cursor/rules/stack.mdc");
  });

  it("scans a custom context-dir name", () => {
    mkdirSync(join(dir, "my-canon"), { recursive: true });
    writeFileSync(join(dir, "my-canon", "RULE_ROUTER.md"), "x");
    const paths = scanContextBloat(dir, "my-canon").files.map((f) => f.path);
    expect(paths).toContain("my-canon/RULE_ROUTER.md");
  });

  it("returns no files and is under budget for a clean repo", () => {
    const b = scanContextBloat(dir, "ai-coding");
    expect(b.files).toEqual([]);
    expect(b.totalTokens).toBe(0);
    expect(b.overBudget).toBe(false);
    expect(b.budgetTokens).toBe(DEFAULT_CONTEXT_BUDGET_TOKENS);
  });

  it("flags overBudget when the footprint exceeds the budget", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(400)); // 100 tokens
    expect(scanContextBloat(dir, "ai-coding", 50).overBudget).toBe(true);
    expect(scanContextBloat(dir, "ai-coding", 200).overBudget).toBe(false);
  });

  it("is deterministic — files sorted by path", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "a");
    writeFileSync(join(dir, "AGENTS.md"), "b");
    const paths = scanContextBloat(dir, "ai-coding").files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths.indexOf("AGENTS.md")).toBeLessThan(paths.indexOf("CLAUDE.md"));
  });
});

describe("report command", () => {
  it("exposes the report command name", () => {
    expect(command.name).toBe("report");
  });

  it("dry-run emits a context-footprint digest with totals and a file path", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(400));
    const d = (await command.plan(ctx())).actions.find((a) => a.kind === "digest");
    expect(d?.kind).toBe("digest");
    if (d?.kind !== "digest") throw new Error("expected a digest action");
    expect(d.describe).toContain("Context footprint");
    expect(d.text).toContain("CLAUDE.md");
    expect(d.text).toContain("~100"); // 400 bytes / 4
  });

  it("carries the structured ContextBloat as machine-readable data", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(400));
    const d = (await command.plan(ctx())).actions.find((a) => a.kind === "digest");
    if (d?.kind !== "digest") throw new Error("expected a digest action");
    expect(d.data).toMatchObject({ totalTokens: 100, overBudget: false });
  });

  it("trips the OVER-budget warning under a low --budget", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(400)); // 100 tokens
    const d = (await command.plan(ctx({ options: { budget: "50" } }))).actions.find(
      (a) => a.kind === "digest",
    );
    if (d?.kind !== "digest") throw new Error("expected a digest action");
    expect(d.describe).toContain("OVER budget");
    expect(d.text).toContain("OVER budget");
  });

  it("falls back to the default budget for invalid --budget input", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(400));
    const d = (await command.plan(ctx({ options: { budget: "not-a-number" } }))).actions.find(
      (a) => a.kind === "digest",
    );
    if (d?.kind !== "digest") throw new Error("expected a digest action");
    // 100 tokens is far under the 40k default, so no warning.
    expect(d.text).not.toContain("OVER budget");
  });

  it("is a read-only digest — only digest actions, never calls out", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(40));
    const p = await command.plan(ctx());
    expect(p.actions.every((a) => a.kind === "digest")).toBe(true);
    expect(
      p.actions.some((a) => a.kind === "write" || a.kind === "exec" || a.kind === "probe"),
    ).toBe(false);
  });

  it("surfaces the digest body + structured data through the executor and summary (R2)", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(400));
    const c = ctx();
    const result = await executePlan(await command.plan(c), c);
    // Local report composes several digests; the context footprint is the first.
    expect(result.digests.length).toBeGreaterThanOrEqual(1);
    expect(result.digests[0]?.data).toMatchObject({ totalTokens: 100 });
    const summary = summarizeResult(result);
    expect(summary).toContain("[digest]");
    expect(summary).toContain("CLAUDE.md");
  });
});

describe("report --format (file artifact)", () => {
  it("terminal scope (default) writes no file — digests only", async () => {
    const p = await command.plan(ctx());
    expect(p.actions.some((a) => a.kind === "write")).toBe(false);
  });

  it("--format md adds a markdown write under .aih/reports (outside the context dir)", async () => {
    const w = (await command.plan(ctx({ options: { format: "md" } }))).actions.find(
      (a) => a.kind === "write",
    );
    if (w?.kind !== "write") throw new Error("expected a write action");
    expect(w.path.replace(/\\/g, "/")).toBe(".aih/reports/local-report.md");
    expect(w.contents).toContain("# aih report");
    expect(w.contents).toContain("## Context footprint");
  });

  it("--format html writes a self-contained html artifact", async () => {
    const w = (await command.plan(ctx({ options: { format: "html" } }))).actions.find(
      (a) => a.kind === "write",
    );
    if (w?.kind !== "write") throw new Error("expected a write action");
    expect(w.path.replace(/\\/g, "/")).toBe(".aih/reports/local-report.html");
    expect(w.contents).toContain("<!doctype html>");
  });

  it("--out overrides the artifact path", async () => {
    const w = (
      await command.plan(ctx({ options: { format: "md", out: "REPORT.md" } }))
    ).actions.find((a) => a.kind === "write");
    expect(w?.kind === "write" && w.path).toBe("REPORT.md");
  });

  it("org scope writes .aih/reports/org-report.md", async () => {
    writeFileSync(
      join(dir, "org.json"),
      JSON.stringify({ usage_report: { data: [] }, skills: { data: [] } }),
    );
    const w = (
      await command.plan(ctx({ options: { org: "org.json", format: "md" } }))
    ).actions.find((a) => a.kind === "write");
    expect(w?.kind === "write" && w.path.replace(/\\/g, "/")).toBe(".aih/reports/org-report.md");
  });

  it("rejects an unknown --format (fail-closed)", async () => {
    await expect(command.plan(ctx({ options: { format: "pdf" } }))).rejects.toThrow(
      /unknown --format/,
    );
  });

  it("applies the artifact to disk and re-applies it as a byte-stable no-op", async () => {
    const apply = ctx({ apply: true, options: { format: "md" } });
    const first = await executePlan(await command.plan(apply), apply);
    const w1 = first.writes.find((w) => w.path.replace(/\\/g, "/").endsWith("local-report.md"));
    expect(w1?.effect).toBe("create");
    expect(existsSync(join(dir, ".aih", "reports", "local-report.md"))).toBe(true);
    // No timestamp + written outside the scanned set → re-applying is unchanged.
    const second = await executePlan(await command.plan(apply), apply);
    const w2 = second.writes.find((w) => w.path.replace(/\\/g, "/").endsWith("local-report.md"));
    expect(w2?.effect).toBe("unchanged");
  });

  it("a .aih/ artifact also writes the .gitignore rule so reports aren't committed", async () => {
    const actions = (await command.plan(ctx({ options: { format: "md" } }))).actions;
    const ignore = actions.find((a) => a.kind === "write" && a.path === ".gitignore");
    if (ignore?.kind !== "write") throw new Error("expected a .gitignore write");
    expect(ignore.contents).toContain(".aih/");
    // the first write is still the artifact (the ignore rule is appended after it)
    const firstWrite = actions.find((a) => a.kind === "write");
    expect(firstWrite?.kind === "write" && firstWrite.path.replace(/\\/g, "/")).toBe(
      ".aih/reports/local-report.md",
    );
  });

  it("a custom --out path does NOT add the .aih gitignore rule (operator owns it)", async () => {
    const actions = (await command.plan(ctx({ options: { format: "md", out: "REPORT.md" } })))
      .actions;
    expect(actions.some((a) => a.kind === "write" && a.path === ".gitignore")).toBe(false);
  });
});
