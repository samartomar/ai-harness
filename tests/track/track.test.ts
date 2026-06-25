import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/track/index.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-track-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gitFake(map: Record<string, string>): Runner {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  return fakeRunner((argv) => {
    if (argv[0] !== "git") return undefined;
    const joined = argv.slice(3).join(" ");
    for (const k of keys) if (joined.startsWith(k)) return { stdout: map[k] };
    return undefined;
  });
}

function makeCtx(run: Runner): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

const REPO = gitFake({
  "rev-parse --is-inside-work-tree": "true",
  "log -1 --pretty=format:%cI%n%h": "2026-06-24T10:00:00Z\nabc123",
  "rev-parse --abbrev-ref HEAD": "main",
  "for-each-ref --format=%(refname:short) refs/heads": "main",
  "rev-list --count --since=7 days ago HEAD": "2",
  "log --since=7 days ago --numstat": "4\t1\tx.ts",
  "ls-files": "x.ts\ny.ts",
});

describe("aih track", () => {
  it("previews a snapshot and writes history + the .aih gitignore rule", async () => {
    const actions = (await command.plan(makeCtx(REPO))).actions;
    const preview = actions.find((a) => a.kind === "digest");
    expect(preview?.kind).toBe("digest");
    if (preview?.kind !== "digest") throw new Error("expected a digest");
    expect(preview.describe).toContain("sample for abc123");
    expect(preview.text).toContain("commits(7d) 2");
    expect(preview.text).toContain("LOC +4/-1 (net 3)");

    const hist = actions.find(
      (a) => a.kind === "write" && a.path.replace(/\\/g, "/") === ".aih/history.jsonl",
    );
    expect(hist?.kind).toBe("write");
    if (hist?.kind === "write") expect(hist.contents).toContain('"sha":"abc123"');

    expect(actions.some((a) => a.kind === "write" && a.path === ".gitignore")).toBe(true);
  });

  it("on a non-repo emits a notice and writes nothing", async () => {
    const actions = (await command.plan(makeCtx(gitFake({})))).actions;
    expect(actions.some((a) => a.kind === "write")).toBe(false);
    const d = actions.find((a) => a.kind === "digest");
    expect(d?.kind === "digest" && d.describe).toContain("not a git repository");
  });
});
