import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { usagePanel } from "../../src/report/usage.js";
import { aggregateUsage } from "../../src/usage/aggregate.js";
import { gitPostCommitHook, usageRecorderScript } from "../../src/usage/capture.js";
import { readUsage, type UsageEvent } from "../../src/usage/events.js";
import { command } from "../../src/usage/index.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-usage-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(
  options: Record<string, unknown> = {},
  run: Runner = fakeRunner(() => undefined),
): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

function writeUsage(...lines: string[]): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(join(root, ".aih", "usage.jsonl"), `${lines.join("\n")}\n`);
}

const EVENTS: UsageEvent[] = [
  { tool: "git", kind: "commit", added: 10, removed: 3, files: 2 },
  { tool: "git", kind: "commit", added: 5, removed: 0, files: 1 },
  { tool: "claude", kind: "skill", name: "tdd", source: "ecc" },
  { tool: "claude", kind: "skill", name: "tdd", source: "ecc" },
  { tool: "claude", kind: "skill", name: "crispy", source: "canon" },
  { tool: "cursor", kind: "mcp", name: "search", server: "context7" },
];

describe("readUsage", () => {
  it("parses valid events, skips malformed lines and unknown kinds", () => {
    writeUsage(
      JSON.stringify({ tool: "git", kind: "commit", added: 1 }),
      "{ not json",
      JSON.stringify({ tool: "x", kind: "bogus" }), // invalid kind → dropped
      JSON.stringify({ kind: "skill" }), // missing tool → dropped
      JSON.stringify({ tool: "claude", kind: "skill", name: "tdd" }),
    );
    const ev = readUsage(makeCtx());
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.kind)).toEqual(["commit", "skill"]);
  });

  it("returns [] when there is no log", () => {
    expect(readUsage(makeCtx())).toEqual([]);
  });
});

describe("aggregateUsage", () => {
  it("folds events into tool / commit / skills-by-source / mcp summaries", () => {
    const s = aggregateUsage(EVENTS);
    expect(s.total).toBe(6);
    expect(s.tools).toEqual([
      { name: "claude", count: 3 },
      { name: "git", count: 2 },
      { name: "cursor", count: 1 },
    ]);
    expect(s.commits).toEqual({ count: 2, added: 15, removed: 3, files: 3 });
    expect(s.skills.top).toEqual([
      { name: "tdd", count: 2 },
      { name: "crispy", count: 1 },
    ]);
    expect(s.skills.bySource.ecc).toEqual([{ name: "tdd", count: 2 }]);
    expect(s.skills.bySource.canon).toEqual([{ name: "crispy", count: 1 }]);
    expect(s.mcp.servers).toEqual([{ name: "context7", count: 1 }]);
    expect(s.mcp.tools).toEqual([{ name: "search", count: 1 }]);
  });
});

describe("capture artifacts", () => {
  it("the recorder appends to .aih/usage.jsonl and derives commit LOC", () => {
    const src = usageRecorderScript();
    expect(src).toContain(".aih/usage.jsonl");
    expect(src).toContain("appendFileSync");
    expect(src).toContain("--numstat"); // derives LOC for commit events
    expect(src).not.toMatch(/sk-ant-/); // no secrets
  });

  it("the git hook is best-effort and can never block a commit", () => {
    const hook = gitPostCommitHook();
    expect(hook).toContain("#!/bin/sh");
    expect(hook).toContain("usage-record.mjs"); // invokes the recorder
    expect(hook).toContain("exit 0"); // never blocks the commit
    expect(hook).toContain("|| true"); // best-effort
  });
});

describe("aih usage command", () => {
  it("installs the recorder + universal git hook + gitignore + coverage doc", async () => {
    const actions = (await command.plan(makeCtx({ cli: "claude,cursor" }))).actions;
    const writes = actions.filter((a) => a.kind === "write");
    const rec = writes.find((w) => w.path.replace(/\\/g, "/") === ".aih/usage-record.mjs");
    expect(rec?.kind === "write" && rec.mode).toBe(0o755);
    const hook = writes.find((w) => w.path.replace(/\\/g, "/") === ".git/hooks/post-commit");
    expect(hook?.kind === "write" && hook.once).toBe(true); // never clobber an existing hook
    expect(hook?.kind === "write" && hook.mode).toBe(0o755);
    expect(writes.some((w) => w.path === ".gitignore")).toBe(true);
    const docText = actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");
    expect(docText).toContain("usage-record.mjs"); // shows the recorder one-liner
    expect(docText).toContain("cursor"); // tailored to the selected CLIs
  });

  it("is read-only/local — only write/doc/probe actions, never exec or call out", async () => {
    const actions = (await command.plan(makeCtx())).actions;
    for (const a of actions) expect(["write", "doc", "probe"]).toContain(a.kind);
  });

  it("chains capture into a PRE-EXISTING post-commit hook instead of skipping it (AIH-USAGE-001)", async () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "post-commit"), "#!/bin/sh\n./team-hook.sh\n");
    const actions = (await command.plan(makeCtx())).actions;
    // The user's hook is preserved (write-once), and a chain snippet is offered.
    const hook = actions.find(
      (a) => a.kind === "write" && a.path.replace(/\\/g, "/") === ".git/hooks/post-commit",
    );
    expect(hook?.kind === "write" && hook.once).toBe(true);
    const chainDoc = actions.find(
      (a) => a.kind === "doc" && a.describe.includes("existing post-commit"),
    );
    expect(chainDoc?.kind === "doc" && chainDoc.text).toContain("usage-record.mjs");
  });
});

describe("usagePanel", () => {
  it("shows a stub pointing at `aih usage` when nothing is captured", () => {
    const d = usagePanel(makeCtx());
    expect(d.describe).toContain("no events captured");
    expect(d.text).toContain("aih usage --apply");
  });

  it("renders activity, skills-by-source, and MCP once events exist", () => {
    writeUsage(...EVENTS.map((e) => JSON.stringify(e)));
    const d = usagePanel(makeCtx());
    expect(d.describe).toContain("6 events");
    expect(d.text).toContain("claude (3)");
    expect(d.text).toContain("ECC:");
    expect(d.text).toContain("tdd");
    expect(d.text).toContain("context7");
    expect(d.data).toMatchObject({ total: 6 });
  });
});
