import { describe, expect, it } from "vitest";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import { type DigestAction, digest } from "../../src/internals/plan.js";
import { buildAihDataV4, reportHtmlV4 } from "../../src/report/v4.js";

/** A scorecard digest shaped like {@link scorecardDigest}'s output. */
function scorecard(): DigestAction {
  return digest("Harness maturity — 93/100 (mature)", "body", {
    overall: 93,
    grade: "mature",
    dimensions: [
      { name: "layering", score: 100 },
      { name: "sharing", score: 100 },
      { name: "harnessWiring", score: 100 },
      { name: "guardrails", score: 67 },
      { name: "discoverability", score: 100 },
    ],
  });
}

function tools(): DigestAction {
  return digest("Tools installed — 3/3 core on PATH", "body", {
    present: ["rg", "fd", "jq", "gh"],
    absent: ["comby"],
    core: ["rg", "fd", "jq"],
    optional: ["sg", "comby", "tree", "gh", "code-review-graph"],
    coreMissing: [],
    total: 8,
  });
}

function config(): DigestAction {
  return digest("Configuration — 3 of 4 config files present", "body", {
    present: ["context-dir", "gitleaks", "pre-commit"],
    absent: ["devcontainer"],
    files: {},
    total: 4,
  });
}

function repo(): DigestAction {
  return digest("Repo status — on feat/x", "body", {
    isRepo: true,
    current: "feat/x",
    main: "main",
    dirty: true,
    branches: [
      { name: "main", age: "2h ago", ahead: 0, behind: 0 },
      { name: "feat/x", age: "5m ago", ahead: 14, behind: 2 },
    ],
  });
}

function coverage(): DigestAction {
  return digest("AI CLI wiring — 1 of 2 configured", "body", {
    rows: [
      { cli: "claude", mcp: { state: "wired", detail: "3 server(s) under `mcpServers`" } },
      { cli: "cursor", mcp: { state: "missing" } },
    ],
    targeted: ["claude", "cursor"],
  });
}

function daily(): DigestAction {
  return digest("Daily commits — 5 in 7d", "body", {
    commits: { d7: 5, d30: 7, total: 42 },
    daily90: [
      { date: "2026-06-24", count: 1 },
      { date: "2026-06-25", count: 0 },
      { date: "2026-06-26", count: 2 },
      { date: "2026-06-27", count: 3 },
      { date: "2026-06-28", count: 1 },
    ],
  });
}

function events(): DigestAction {
  return digest("AI events — 3 recorded", "body", {
    rows: [
      { ts: "2026-06-28 09:32", tool: "cursor", kind: "mcp", detail: "search-canon" },
      { ts: "2026-06-28 08:52", tool: "git", kind: "commit", detail: "main" },
    ],
    shown: 2,
    total: 3,
  });
}

const ADOPTION = [scorecard(), tools(), config(), repo(), coverage()];

describe("buildAihDataV4 — hero", () => {
  it("maps the scorecard's 5 dimensions to the radar, in display order", () => {
    expect(buildAihDataV4([scorecard()]).radar).toEqual({
      labels: ["Layering", "Sharing", "Wiring", "Guardrails", "Discover"],
      values: [100, 100, 100, 67, 100],
    });
  });

  it("carries the overall score + tier", () => {
    expect(buildAihDataV4([scorecard()]).maturity).toEqual({ overall: 93, grade: "mature" });
  });

  it("leaves radar + maturity undefined when no scorecard ran (off-canon)", () => {
    const data = buildAihDataV4([config()]);
    expect(data.radar).toBeUndefined();
    expect(data.maturity).toBeUndefined();
  });
});

describe("buildAihDataV4 — adoption", () => {
  it("binds the adoption section and gates it on", () => {
    const data = buildAihDataV4(ADOPTION);
    expect(data.gates["sec-adoption"]).toBe(true);
    const grid = data.sections["sec-adoption"]?.grid ?? "";
    expect(grid).toContain(">rg<"); // a present tool
    expect(grid).toContain("context-dir"); // a passing check
    expect(grid).toContain("devcontainer"); // a failing check
    expect(grid).toContain("feat/x"); // current branch
  });

  it("lights MCP-wired CLIs and counts them against the full registry", () => {
    const grid = buildAihDataV4(ADOPTION).sections["sec-adoption"]?.grid ?? "";
    expect(grid).toContain('<span class="tool on mcp">claude</span>');
    expect(grid).toContain(`1/${SUPPORTED_CLIS.length} MCP-enabled`);
  });

  it("names the adoption gap in the section insight", () => {
    const s = buildAihDataV4(ADOPTION).sections["sec-adoption"];
    expect(s?.title).toContain("3 of 4 adoption checks");
    expect(s?.insight).toContain("devcontainer");
  });

  it("escapes quotes in tool-name title attributes so a value can't break out (v4)", () => {
    const data = buildAihDataV4([
      digest("Tools installed — x", "body", {
        present: [],
        absent: ['a" onmouseover="x'],
        total: 1,
      }),
    ]);
    const grid = data.sections["sec-adoption"]?.grid ?? "";
    expect(grid).toContain('title="a&quot; onmouseover=&quot;x"'); // quote entity-escaped
    expect(grid).not.toContain('title="a" onmouseover="x"'); // no raw attribute breakout
  });
});

describe("buildAihDataV4 — events", () => {
  it("binds the event timeline from the usage feed", () => {
    const data = buildAihDataV4([events()]);
    expect(data.gates["sec-events"]).toBe(true);
    const s = data.sections["sec-events"];
    expect(s?.title).toContain("3 events recorded");
    expect(s?.count).toBe("3 events");
    expect(s?.grid).toContain("search-canon");
    expect(s?.grid).toContain("+1 older events");
  });

  it("gates the event section off when no events are recorded", () => {
    expect(buildAihDataV4([scorecard()]).gates["sec-events"]).toBe(false);
  });
});

describe("buildAihDataV4 — activity", () => {
  it("binds the heatmap with real streak + active-day stats", () => {
    const data = buildAihDataV4([daily()]);
    expect(data.gates["sec-activity"]).toBe(true);
    const s = data.sections["sec-activity"];
    expect(s?.title).toContain("4 active days");
    expect(s?.title).toContain("3-day streak");
    expect(s?.count).toBe("5 days");
    expect(s?.grid).toContain("heatmap-grid");
    expect(s?.grid).toContain("longest streak · 3 days");
  });

  it("gates activity off when there is no commit history", () => {
    expect(buildAihDataV4([scorecard()]).gates["sec-activity"]).toBe(false);
  });
});

describe("buildAihDataV4 — mcp", () => {
  it("binds the MCP wiring panel with server count + consumers", () => {
    const data = buildAihDataV4([coverage()]);
    expect(data.gates["sec-mcp"]).toBe(true);
    const s = data.sections["sec-mcp"];
    expect(s?.title).toContain("3 servers");
    expect(s?.title).toContain("1 CLI");
    expect(s?.grid).toContain("claude");
    expect(s?.grid).toContain("3 servers");
  });

  it("gates MCP off when nothing is wired", () => {
    const none = digest("AI CLI wiring — 0 configured", "body", {
      rows: [{ cli: "claude", mcp: { state: "missing" } }],
      targeted: ["claude"],
    });
    expect(buildAihDataV4([none]).gates["sec-mcp"]).toBe(false);
  });
});

describe("reportHtmlV4", () => {
  const title = "aih report — local developer console";

  it("is a self-contained document with the real title", () => {
    const html = reportHtmlV4(title, ADOPTION);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<title>${title}</title>`);
  });

  it("injects the real radar values into AIH_DATA", () => {
    const html = reportHtmlV4(title, ADOPTION);
    expect(html).toContain('"values":[100,100,100,67,100]');
    expect(html).not.toContain("window.AIH_DATA = null;");
  });

  it("does not auto-refresh by default but honors --refresh", () => {
    expect(reportHtmlV4(title, ADOPTION)).not.toContain('http-equiv="refresh"');
    expect(reportHtmlV4(title, ADOPTION, { refresh: 5 })).toContain(
      '<meta http-equiv="refresh" content="5">',
    );
  });

  it("defaults to demo data only under --demo", () => {
    expect(reportHtmlV4(title, ADOPTION)).toContain("<body>");
    expect(reportHtmlV4(title, ADOPTION, { demo: true })).toContain('<body data-demo="on">');
  });

  it("carries bound section content and the honest gating banner", () => {
    const html = reportHtmlV4(title, [...ADOPTION, events()]);
    expect(html).toContain("context-dir"); // adoption, bound
    expect(html).toContain("search-canon"); // events, bound
    expect(html).toContain("not yet wired to local data"); // banner for the rest
  });

  it("keeps the demo subtree as the full showcase", () => {
    const html = reportHtmlV4(title, ADOPTION);
    expect(html).toContain('id="aih-demo"');
    expect(html).toContain('id="radar-demo"');
  });
});
