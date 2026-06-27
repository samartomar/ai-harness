import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digest, type PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { reportHtml } from "../../src/report/artifact.js";
import { demoDigests } from "../../src/report/demo.js";
import { aiEventsDigest } from "../../src/report/events.js";
import { graphDigests } from "../../src/report/graph.js";
import { guardrailDigest } from "../../src/report/guardrail.js";
import { qualityDigest } from "../../src/report/quality.js";
import { repoInfoDigest } from "../../src/report/repoinfo.js";
import { toolsInstalledDigest } from "../../src/report/tools.js";
import { velocityDigests } from "../../src/report/velocity.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-dash-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Answer `git -C <root> <args>` by longest-prefix match on the args. */
function gitFake(map: Record<string, string>): Runner {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  return fakeRunner((argv) => {
    if (argv[0] !== "git") return undefined;
    const joined = argv.slice(3).join(" ");
    for (const k of keys) if (joined.startsWith(k)) return { stdout: map[k] };
    return undefined;
  });
}

function ctx(run: Runner): PlanContext {
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

function writeUsage(...rows: object[]): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, ".aih", "usage.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

describe("aiEventsDigest", () => {
  it("is undefined when no events are recorded", () => {
    expect(aiEventsDigest(ctx(fakeRunner(() => undefined)))).toBeUndefined();
  });

  it("renders newest-first rows, the commit branch as detail, and ±LOC", () => {
    writeUsage(
      { ts: "2026-06-25T09:18:00Z", tool: "claude", kind: "skill", name: "tdd", source: "ecc" },
      {
        ts: "2026-06-25T09:21:00Z",
        tool: "git",
        kind: "commit",
        branch: "main",
        added: 4520,
        removed: 1890,
      },
    );
    const d = aiEventsDigest(ctx(fakeRunner(() => undefined)));
    const data = d?.data as { rows: { ts: string; detail: string }[]; total: number };
    expect(data.total).toBe(2);
    expect(data.rows[0]?.ts).toBe("2026-06-25 09:21"); // newest first (commit)
    expect(data.rows[0]?.detail).toBe("main"); // branch as detail
    expect(d?.text).toContain("+4520 -1890");
  });
});

describe("velocityDigests", () => {
  it("emits daily-commits + LOC-30d from git, empty array off-repo", async () => {
    expect(await velocityDigests(ctx(fakeRunner(() => undefined)))).toEqual([]);
    const run = gitFake({
      "rev-parse --is-inside-work-tree": "true",
      "rev-list --count --since=7.days.ago HEAD": "23",
      "rev-list --count --since=30.days.ago HEAD": "87",
      "rev-list --count HEAD": "1420",
      "log --since=14.days.ago --date=short --pretty=%cd": "2026-06-24\n2026-06-24\n2026-06-22",
      "log --since=30.days.ago --numstat": "4520\t1890\tsrc/a.ts\n10\t0\tsrc/b.ts",
    });
    const [commits, loc] = await velocityDigests(ctx(run));
    expect(commits?.describe).toContain("23 in 7d");
    expect((commits?.data as { commits: { total: number } }).commits.total).toBe(1420);
    // gap-filled daily series spans 2026-06-22..24 (3 buckets: 1,0,2)
    expect((commits?.data as { daily: unknown[] }).daily).toHaveLength(3);
    expect((loc?.data as { loc: { net: number } }).loc.net).toBe(4530 - 1890);
  });
});

describe("qualityDigest", () => {
  it("computes the test/source file ratio from ls-files", async () => {
    const run = gitFake({
      "ls-files": ["src/a.ts", "src/b.ts", "src/c.ts", "tests/a.test.ts", "src/d.spec.ts"].join(
        "\n",
      ),
    });
    const d = await qualityDigest(ctx(run));
    // 2 test files (a.test.ts, d.spec.ts) / 3 non-test source (a,b,c) = 66.7%
    expect(d?.data).toMatchObject({ testFiles: 2, sourceFiles: 3 });
    expect(d?.describe).toContain("66.7%");
  });

  it("is undefined when there is no source", async () => {
    expect(await qualityDigest(ctx(gitFake({ "ls-files": "README.md\nLICENSE" })))).toBeUndefined();
  });
});

describe("repoInfoDigest", () => {
  it("counts files + builds a file-type breakdown", async () => {
    const run = gitFake({
      "ls-files": "a.ts\nb.ts\nc.py\nd.md\nMakefile",
      "count-objects -vH": "count: 10\nsize: 1.20 KiB\nsize-pack: 3.40 MiB",
    });
    const d = await repoInfoDigest(ctx(run));
    expect(d?.data).toMatchObject({ files: 5, size: "3.40 MiB" });
    const types = (d?.data as { types: { name: string; count: number }[] }).types;
    expect(types[0]).toEqual({ name: "ts", count: 2 }); // most common ext first
  });
});

describe("toolsInstalledDigest", () => {
  it("marks tools present/absent by PATH probe", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "which" && (argv[1] === "rg" || argv[1] === "jq")
        ? { code: 0, stdout: `/usr/bin/${argv[1]}` }
        : { code: 1, spawnError: true },
    );
    const d = await toolsInstalledDigest(ctx(run));
    expect((d.data as { present: string[] }).present).toEqual(expect.arrayContaining(["rg", "jq"]));
    expect((d.data as { absent: string[] }).absent).toContain("comby");
  });
});

describe("reportHtml — single bento + new panels", () => {
  it("renders all new panel types in one curated-order bento (no band headers)", () => {
    const html = reportHtml("t", [
      digest("Daily commits — 5 in 7d", "x", {
        commits: { d7: 5, d30: 10, total: 99 },
        daily: [{ date: "2026-06-01", count: 2 }],
      }),
      digest("Lines of code (30d) — +100 / −20", "x", {
        loc: { added: 100, removed: 20, net: 80 },
        windowDays: 30,
      }),
      digest("Test coverage — 22.5% test/source file ratio", "x", {
        ratio: 22.5,
        testFiles: 35,
        sourceFiles: 156,
      }),
      digest("AI events — 1 recorded", "x", {
        rows: [
          {
            ts: "2026-06-25 09:21",
            tool: "git",
            kind: "commit",
            detail: "main",
            added: 10,
            removed: 2,
          },
        ],
        shown: 1,
        total: 1,
      }),
    ]);
    // single flowing bento (no loud section-band headers), panels in curated order:
    // velocity (daily commits) sits ahead of quality (test coverage)
    expect(html).not.toContain('class="band"');
    expect(html.indexOf("Daily commits")).toBeLessThan(html.indexOf("Test coverage"));
    // new panels rendered
    expect(html).toContain('class="events"');
    expect(html).toContain(">main<"); // branch in the events row
    expect(html).toContain("22.5%");
    expect(html).toContain("Net: +80 lines");
    expect(html).toContain('class="daybars"');
  });

  it("covers event-kind variants, no-LOC rows, +older, empty chart, negative net, repo-info, tools + hero", () => {
    const html = reportHtml("t", [
      digest("AI events — 60 recorded", "x", {
        rows: [
          { ts: "t1", tool: "claude", kind: "skill", detail: "tdd (ecc)" },
          { ts: "t2", tool: "cursor", kind: "mcp", detail: "search · context7" },
          { ts: "t3", tool: "x", kind: "session", detail: "—" },
        ],
        shown: 3,
        total: 60, // total > shown → "+57 older"
      }),
      digest("Daily commits — 0 in 7d", "x", { commits: { d7: 0, d30: 0, total: 0 }, daily: [] }),
      digest("Lines of code (30d) — +1 / −9", "x", {
        loc: { added: 1, removed: 9, net: -8 },
        windowDays: 30,
      }),
      digest("Test coverage — 10% test/source file ratio", "x", {
        ratio: 10,
        testFiles: 1,
        sourceFiles: 10,
      }),
      digest("Repository information — 5 files", "x", {
        files: 5,
        size: "3 MiB",
        types: [
          { name: "ts", count: 3 },
          { name: "md", count: 2 },
        ],
      }),
      digest("Tools installed — 2 of 8 on PATH", "x", {
        present: ["rg", "jq"],
        absent: ["sg", "fd"],
        total: 8,
      }),
      digest("Machine tooling — 1 of 11 AI CLIs installed here", "x", {
        present: ["claude"],
        absent: [],
        total: 11,
      }),
      digest("AI CLI wiring — 1 of 2 configured, 1 loadable", "x", {
        targeted: ["claude", "kiro"],
        targetSource: "marker",
        score: 50,
        structurallyConfigured: 1,
        provenLoadable: 1,
        totalTargeted: 2,
        rows: [
          {
            cli: "claude",
            label: "Claude Code",
            targeted: true,
            bootloader: { state: "wired", path: "CLAUDE.md", detail: "in sync" },
            mcp: { state: "wired", path: ".mcp.json", detail: "1 server(s)" },
            settings: { state: "wired", path: ".claude/settings.json", detail: "present" },
            load: { verdict: "loads", checks: [{ name: "router-chain", ok: true, detail: "ok" }] },
          },
          {
            cli: "kiro",
            label: "Kiro",
            targeted: true,
            bootloader: {
              state: "missing",
              path: ".kiro/steering/00-canon.md",
              detail: "not found",
              fix: "aih bootstrap-ai --apply --cli kiro",
            },
            mcp: { state: "wired", path: ".kiro/settings/mcp.json", detail: "1 server(s)" },
            settings: { state: "na", detail: "no settings file" },
            load: {
              verdict: "unverified",
              checks: [{ name: "activation", detail: "no bootloader on disk" }],
            },
          },
        ],
      }),
    ]);
    expect(html).toContain("k-skill");
    expect(html).toContain("k-mcp");
    expect(html).toContain("k-other");
    expect(html).toContain("+57 older");
    expect(html).toContain("no commits in range"); // empty daily chart
    expect(html).toContain("Net: -8 lines"); // negative net branch
    expect(html).toContain("Repository information");
    expect(html).toContain('class="tool on">rg'); // tools-installed present pill
    expect(html).toContain("source files"); // hero tile from quality
    expect(html).toContain("test ratio");
    expect(html).toContain("CLIs installed"); // machine-detection KPI (renamed)
    // per-CLI wiring matrix: a row per tool, four-state cells, dual KPI
    expect(html).toContain('class="cli-matrix"');
    expect(html).toContain("tools wired"); // structural-config KPI tile
    expect(html).toContain('class="cli-cell ok"'); // wired cell (green)
    expect(html).toContain(">✓ CLAUDE.md</span>"); // claude bootloader wired (plain, no fix)
    expect(html).toContain('class="cli-cell bad act"'); // missing cell is actionable
    expect(html).toContain(">— n/a</span>"); // kiro settings n/a (plain)
    // actionable cells surface the fix command, keyboard/SR-reachable (WCAG-AA)
    expect(html).toContain('data-fix="1"'); // focusable hint marker
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="cli-fix"'); // visible ? affordance
    expect(html).toContain("aih bootstrap-ai --apply --cli kiro"); // exact remediation in the cell
    // loadability column: proven-loadable KPI + per-row load verdict
    expect(html).toContain("proven loadable"); // third KPI tile
    expect(html).toContain("<th>Loads?</th>"); // matrix loads column
    expect(html).toContain(">✓ loads</span>"); // claude proven to load (plain)
    expect(html).toContain(">— unverified</span>"); // kiro load unverified (no bootloader)
  });
});

describe("graphDigests (Phase 2 — gated)", () => {
  it("reads .aih/graph.json → code-graph-health + build-times digests", async () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(
      join(root, ".aih", "graph.json"),
      JSON.stringify({ nodes: 342, edges: 891, files: 48, density: 2.6, buildMs: 4200 }),
    );
    const ds = await graphDigests(ctx(fakeRunner(() => undefined)));
    expect(ds[0]?.describe).toContain("342 nodes");
    expect((ds[0]?.data as { edges: number }).edges).toBe(891);
    expect(ds.some((d) => d.describe.startsWith("Build & analysis"))).toBe(true);
  });

  it("is empty when there is no graph file and never spawns a fallback CLI", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { code: 0, stdout: JSON.stringify({ nodes: 10, edges: 20 }) };
    });
    expect(await graphDigests(ctx(run))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("ignores AIH_GRAPH_CMD unless graph stats are supplied by the contract file", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) =>
      calls.push(argv) > 0 ? { code: 0, stdout: JSON.stringify({ nodes: 10, edges: 20 }) } : undefined,
    );
    const c = ctx(run);
    const ds = await graphDigests({ ...c, env: { ...c.env, AIH_GRAPH_CMD: "node mutate.js" } });
    expect(ds).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("ignores a malformed graph.json without falling back to process execution", async () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "graph.json"), "{ not json");
    const calls: string[][] = [];
    expect(
      await graphDigests(
        ctx(
          fakeRunner((argv) => {
            calls.push(argv);
            return { code: 0, stdout: JSON.stringify({ nodes: 10, edges: 20 }) };
          }),
        ),
      ),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("ignores a graph.json without nodes/edges (no real graph)", async () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "graph.json"), JSON.stringify({ files: 9 }));
    expect(await graphDigests(ctx(fakeRunner(() => undefined)))).toEqual([]);
  });

  it("maps alternate stat keys (filesIndexed / buildTimeMs)", async () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(
      join(root, ".aih", "graph.json"),
      JSON.stringify({ nodes: 8, edges: 16, filesIndexed: 4, buildTimeMs: 2500 }),
    );
    const ds = await graphDigests(ctx(fakeRunner(() => undefined)));
    expect((ds[0]?.data as { files: number }).files).toBe(4);
    const build = ds.find((d) => d.describe.startsWith("Build & analysis"));
    expect((build?.data as { buildMs: number }).buildMs).toBe(2500);
  });

  it("nodes-only graph → no derived density, no build panel", async () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "graph.json"), JSON.stringify({ nodes: 5 }));
    const ds = await graphDigests(ctx(fakeRunner(() => undefined)));
    expect(ds).toHaveLength(1); // health only — no edges/files/buildMs to show
    expect((ds[0]?.data as { density?: number }).density).toBeUndefined();
  });
});

describe("guardrailDigest (Phase 3 — gated)", () => {
  it("reads severities from .aih/guardrail-scan.json", () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(
      join(root, ".aih", "guardrail-scan.json"),
      JSON.stringify({ critical: 4, important: 3, style: 3 }),
    );
    const d = guardrailDigest(ctx(fakeRunner(() => undefined)));
    expect(d?.data).toMatchObject({ critical: 4, important: 3, style: 3, total: 10 });
  });

  it("is undefined when no scan results exist (never fabricated)", () => {
    expect(guardrailDigest(ctx(fakeRunner(() => undefined)))).toBeUndefined();
  });

  it("defaults missing severities to 0 (partial scan output)", () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "guardrail-scan.json"), JSON.stringify({ critical: 5 }));
    const d = guardrailDigest(ctx(fakeRunner(() => undefined)));
    expect(d?.data).toMatchObject({ critical: 5, important: 0, style: 0, total: 5 });
  });

  it("is undefined for a scan file with no severity keys", () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "guardrail-scan.json"), JSON.stringify({ scanned: true }));
    expect(guardrailDigest(ctx(fakeRunner(() => undefined)))).toBeUndefined();
  });

  it("is undefined for a malformed scan file", () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "guardrail-scan.json"), "{ broken");
    expect(guardrailDigest(ctx(fakeRunner(() => undefined)))).toBeUndefined();
  });
});

describe("demo mode", () => {
  it("demoDigests carries the showcase panels incl Phase 2/3", () => {
    const prefixes = demoDigests().map((d) => d.describe);
    expect(prefixes.some((s) => s.startsWith("Code graph health"))).toBe(true);
    expect(prefixes.some((s) => s.startsWith("Guardrail rules"))).toBe(true);
    expect(prefixes.some((s) => s.startsWith("Daily commits"))).toBe(true);
  });

  it("reportHtml always embeds demo content + toggle; --demo defaults it visible", () => {
    const html = reportHtml("t", [], { demo: true });
    expect(html).toContain("aihDemo()"); // the demo toggle button
    expect(html).toContain('<body data-demo="on">'); // demo is the default view
    expect(html).toContain("DEMO DATA");
    expect(html).toContain("Code graph health"); // demo renders Phase 2 panel
    expect(html).toContain('class="gr-fill crit"'); // demo renders Phase 3 bars
    // the live region (empty digests here) carries none of it
    const live = html.split('<div id="aih-demo">')[0] ?? "";
    expect(live).not.toContain("Code graph health");
  });

  it("without --demo the demo is embedded but not the default view", () => {
    const html = reportHtml("t", []);
    expect(html).toContain("<body>"); // live is the default view (no demo attr on body)
    expect(html).not.toContain('<body data-demo="on">');
    expect(html).toContain('id="aih-demo"'); // demo content is still embedded for the toggle
  });
});
