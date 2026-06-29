import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  collectSnapshot,
  historyWrite,
  type Snapshot,
  sparkline,
  trendsPanel,
} from "../../src/report/history.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-history-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A runner that answers git by longest-prefix match on the args after `git -C <root>`. */
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

const SAMPLE: Snapshot = {
  ts: "t1",
  sha: "aaa",
  branch: "main",
  branches: 1,
  commits7d: 1,
  loc: { added: 1, removed: 0, net: 1 },
  adoptionScore: 50,
  contextTokens: 100,
  sourceFiles: 5,
};

function writeHistory(rows: Snapshot[]): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, ".aih", "history.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

describe("collectSnapshot", () => {
  it("returns undefined outside a git repository", async () => {
    expect(await collectSnapshot(makeCtx(gitFake({})))).toBeUndefined();
  });

  it("collects commits, LOC, branches, and files from git + repo state", async () => {
    const snap = await collectSnapshot(
      makeCtx(
        gitFake({
          "rev-parse --is-inside-work-tree": "true",
          "log -1 --pretty=format:%cI%n%h": "2026-06-24T10:00:00Z\nabc123",
          "rev-parse --abbrev-ref HEAD": "main",
          "for-each-ref --format=%(refname:short) refs/heads": "main\nfeature/x",
          "rev-list --count --since=7 days ago HEAD": "5",
          "log --since=7 days ago --numstat": "10\t3\tfile.ts\n5\t0\tother.ts\n-\t-\timg.png",
          "ls-files": "a.ts\nb.ts\nc.ts",
        }),
      ),
    );
    expect(snap).toMatchObject({
      ts: "2026-06-24T10:00:00Z",
      sha: "abc123",
      branch: "main",
      branches: 2,
      commits7d: 5,
      sourceFiles: 3,
      loc: { added: 15, removed: 3, net: 12 }, // binary "-\t-" counts as 0
    });
    expect(snap?.adoptionScore).toBeGreaterThanOrEqual(0);
    expect(snap?.adoptionScore).toBeLessThanOrEqual(100);
  });

  it("records the v9 trend metrics so report trends can go live (§2a)", async () => {
    // Off-canon temp repo (no RULE_ROUTER.md): drift is 0 and the metrics are
    // well-formed numbers — enough to prove `aih track` captures the trend seam.
    const snap = await collectSnapshot(
      makeCtx(
        gitFake({
          "rev-parse --is-inside-work-tree": "true",
          "log -1 --pretty=format:%cI%n%h": "2026-06-24T10:00:00Z\nabc123",
          "rev-parse --abbrev-ref HEAD": "main",
          "for-each-ref --format=%(refname:short) refs/heads": "main",
          "rev-list --count --since=7 days ago HEAD": "0",
          "log --since=7 days ago --numstat": "",
          "ls-files": "a.ts",
        }),
      ),
    );
    expect(snap?.driftCount).toBe(0); // off-canon → nothing to drift from
    expect(typeof snap?.perTurnPct).toBe("number");
    expect(typeof snap?.openActions).toBe("number");
    expect(snap?.openActions).toBeGreaterThanOrEqual(0);
    // wiringScore is the scorecard overall (number) or undefined when unscored.
    expect(snap?.wiringScore === undefined || typeof snap?.wiringScore === "number").toBe(true);
  });
});

describe("historyWrite — append, idempotent per commit", () => {
  it("appends a sample for a new commit and is a no-op for the same commit", () => {
    const ctx = makeCtx(gitFake({}));
    writeHistory([SAMPLE]);
    // Same sha → byte-stable (no new line).
    const same = historyWrite(ctx, { ...SAMPLE });
    expect(same.contents).toBe(`${JSON.stringify(SAMPLE)}\n`);
    // New sha → appended.
    const next = historyWrite(ctx, { ...SAMPLE, sha: "bbb", ts: "t2" });
    expect(next.contents).toContain('"sha":"aaa"');
    expect(next.contents).toContain('"sha":"bbb"');
    expect((next.contents ?? "").trim().split("\n")).toHaveLength(2);
  });

  it("seeds the file when no history exists", () => {
    const w = historyWrite(makeCtx(gitFake({})), SAMPLE);
    expect(w.path.replace(/\\/g, "/")).toBe(".aih/history.jsonl");
    expect(readHistoryFrom(w.contents ?? "")).toHaveLength(1);
  });

  it("de-dupes by SHA across the WHOLE window, not just the last row (AIH-TRACK-001)", () => {
    const ctx = makeCtx(gitFake({}));
    // 'aaa' is NOT the last row, yet re-tracking it must not append a duplicate.
    writeHistory([SAMPLE, { ...SAMPLE, sha: "bbb", ts: "t2" }]);
    const w = historyWrite(ctx, { ...SAMPLE, sha: "aaa" });
    const rows = readHistoryFrom(w.contents ?? "");
    expect(rows).toHaveLength(2); // unchanged — no duplicate 'aaa'
    expect(rows.filter((r) => r.sha === "aaa")).toHaveLength(1);
  });
});

/** Parse JSONL the way readHistory does, for asserting write contents. */
function readHistoryFrom(text: string): Snapshot[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Snapshot);
}

describe("sparkline", () => {
  it("is empty for no values and flat for constant values", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([5, 5, 5])).toBe("▁▁▁");
  });

  it("scales low→high across the value range", () => {
    const s = sparkline([0, 5, 10]);
    expect(s).toHaveLength(3);
    expect(s[0]).toBe("▁");
    expect(s[2]).toBe("█");
  });
});

describe("trendsPanel", () => {
  it("shows an honest stub with fewer than two samples", () => {
    const d = trendsPanel(makeCtx(gitFake({})));
    expect(d.describe).toContain("not enough history");
    expect(d.data).toMatchObject({ samples: 0 });
  });

  it("renders sparklines + deltas with two or more samples", () => {
    writeHistory([
      { ...SAMPLE, sha: "a", adoptionScore: 40, branches: 1 },
      { ...SAMPLE, sha: "b", adoptionScore: 60, branches: 2 },
    ]);
    const d = trendsPanel(makeCtx(gitFake({})));
    expect(d.describe).toContain("2 samples");
    expect(d.describe).toContain("adoption 60/100");
    expect(d.text).toContain("adoption");
    expect(d.text).toContain("(+20)"); // 40 → 60
    expect(d.data).toMatchObject({ samples: 2 });
  });
});
