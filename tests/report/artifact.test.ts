import { describe, expect, it } from "vitest";
import { digest } from "../../src/internals/plan.js";
import { reportHtml, reportMarkdown } from "../../src/report/artifact.js";

/**
 * The LIVE region of the report (everything before the always-embedded demo block),
 * so assertions about *absence* aren't polluted by the demo showcase content.
 */
const liveOf = (html: string): string => html.split('<div id="aih-demo">')[0] ?? html;

/** A full set of local-report digests with the structured `data` the HTML reads. */
const RICH = [
  digest("Context footprint — ~56k tokens — OVER budget", "x", {
    totalTokens: 55983,
    budgetTokens: 40000,
    overBudget: true,
    files: [
      { path: "ai-coding/big.md", tokens: 4465 },
      { path: "ai-coding/small.md", tokens: 100 },
    ],
  }),
  digest("Repo status — on develop", "x", {
    current: "develop",
    main: "develop",
    dirty: true,
    branches: [
      { name: "develop", age: "20h", ahead: 0, behind: 0 },
      { name: "feature/x", age: "1h", ahead: 5, behind: 2 },
    ],
  }),
  digest("Trends — 2 samples", "x", {
    samples: 2,
    rows: [
      { commits7d: 1, loc: { net: 5 }, adoptionScore: 40, branches: 1, sourceFiles: 10 },
      { commits7d: 3, loc: { net: 12 }, adoptionScore: 60, branches: 2, sourceFiles: 12 },
    ],
  }),
  digest("Configuration — 2 of 3 artifacts present", "x", {
    present: ["CLAUDE.md", "AGENTS.md"],
    absent: ["mcp"],
    total: 3,
  }),
  digest("Tooling — 1 of 11", "x", { present: ["claude"], absent: ["codex", "kiro"], total: 11 }),
  digest("Local cache & skill economy — none", "no local data source yet", { available: false }),
];

describe("reportMarkdown", () => {
  it("renders a heading per digest with fenced verbatim bodies", () => {
    const md = reportMarkdown("aih report", [digest("Tooling — 1 of 11", "  ✓ claude", {})]);
    expect(md).toContain("# aih report");
    expect(md).toContain("## Tooling — 1 of 11");
    expect(md).toContain("```text");
    expect(md).toContain("✓ claude");
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("reportHtml dashboard", () => {
  it("is a self-contained page: passed title in <title>, brand in <h1>, no external assets", () => {
    const html = reportHtml("aih report", RICH);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>aih report</title>");
    expect(html).toContain("<h1>Enterprise AI Bootstrapping Harness Report</h1>");
    expect(html).toContain("</html>");
    expect(html).toContain("font-family:'Geist'"); // embedded display font (headings)
    expect(html).toContain("font-family:'Inter'"); // embedded body font
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("renders the adoption ring + thousands-formatted KPI tiles", () => {
    const html = reportHtml("aih report", RICH);
    expect(html).toContain('class="ring'); // donut
    expect(html).toContain(">67</text>"); // 2/3 present = 67%
    expect(html).toContain('class="kpi"');
    expect(html).toContain("context tokens");
    expect(html).toContain("~55,983"); // thousands separators, not 55983
  });

  it("renders a budget bar + contributor bars (data viz, not a <pre> dump)", () => {
    const html = reportHtml("aih report", RICH);
    expect(html).toContain('class="budget-fill over"'); // over-budget gradient
    expect(html).toContain('class="bar-fill"');
    // the fill must be a block, else the span's width/height is ignored and it
    // paints nothing (the bars show only the empty gray track).
    expect(html).toContain(".bar-fill{display:block");
    expect(html).toContain("ai-coding/big.md");
    expect(html).toContain("4,465");
    // the recognized panels are NOT dumped as raw <pre>
    expect(html).not.toContain("<pre>");
  });

  it("renders branch rows with ahead/behind pills + a dirty hint", () => {
    const html = reportHtml("aih report", RICH);
    expect(html).toContain('class="branches"');
    expect(html).toContain('class="pill up">+5');
    expect(html).toContain('class="pill down"'); // behind pill present
    expect(html).toContain("uncommitted changes");
  });

  it("renders trend charts, checklist chips, and tool badges", () => {
    const html = reportHtml("aih report", RICH);
    expect(html).toContain('class="mini"'); // a trend chart per metric
    expect(html).toContain('class="chip ok"'); // present artifact
    expect(html).toContain('class="chip bad"'); // absent artifact
    expect(html).toContain('class="tool on">claude'); // present CLI
    // absent CLI carries an install hint that is keyboard/SR reachable (not hover-only)
    expect(html).toContain('class="tool off" tabindex="0" data-hint="1"');
    expect(html).toContain('aria-label="codex — not installed.'); // hint surfaced to AT
    expect(html).toContain("npm i -g @openai/codex"); // ...the actionable command for codex
  });

  it("is accessible: skip link, section nav, chart titles, no false aria-sort", () => {
    const html = reportHtml("aih report", RICH);
    // skip-to-main bypass block + focusable main target (WCAG 2.4.1)
    expect(html).toContain('<a class="skip" href="#main">Skip to report</a>');
    expect(html).toContain('<main id="main" tabindex="-1">');
    // topbar jump-nav, anchored to id'd category sections (orientation on a long page)
    expect(html).toContain('<nav class="tb-nav" aria-label="Report sections">');
    expect(liveOf(html)).toContain('<section class="cat" id="cat-harness-adoption">');
    // the embedded demo tree uses a prefixed id so anchors never collide with live
    expect(html).toContain('id="demo-cat-');
    // sparklines expose values: per-bar <title> + an accessible name on the svg
    expect(html).toContain('role="img" aria-label="commits (7d): 2 samples');
    expect(html).toMatch(/<rect[^>]*><title>commits \(7d\) #1: 1<\/title><\/rect>/);
    // the events table must NOT claim a sort affordance it doesn't have (WCAG 4.1.2)
    expect(html).not.toContain("aria-sort");
    // the glow filter is defined once globally, not duplicated per adoption ring
    expect((html.match(/<filter id="glow"/g) ?? []).length).toBe(1);
  });

  it("uses AA-contrast --dim tokens in both themes", () => {
    const html = reportHtml("aih report", RICH);
    expect(html).toContain("--dim:#7e899e"); // dark: clears 4.5:1, stays below --mut
    expect(html).toContain("--dim:#646f83"); // light: clears 4.5:1, stays below --mut
    expect(html).not.toContain("#737e93"); // old failing dark token gone
    expect(html).not.toContain("#737d90"); // old failing light token gone
  });

  it("escapes HTML and renders unrecognized digests as a styled note", () => {
    const html = liveOf(reportHtml("t<i>", [digest("a <b> & c", "x < y & z", {})]));
    expect(html).toContain("a &lt;b&gt; &amp; c");
    expect(html).toContain("x &lt; y &amp; z");
    expect(html).toContain('class="prose"');
    expect(html).not.toContain("<b>");
  });

  it("shows a note (not charts) for trends with fewer than two samples", () => {
    const html = liveOf(
      reportHtml("aih report", [
        digest("Trends — not enough history yet", "accruing", { samples: 1, rows: [] }),
      ]),
    );
    expect(html).not.toContain('class="mini"');
    expect(html).toContain('class="prose"');
  });

  it("Context footprint shows ALL files (scrollable) + each file's share, not a top slice", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `ai-coding/file-${i}.md`,
      tokens: (20 - i) * 100,
    }));
    const html = liveOf(
      reportHtml("aih report", [
        digest("Context footprint — big", "x", { totalTokens: 21000, budgetTokens: 40000, files }),
      ]),
    );
    expect((html.match(/class="bar-fill"/g) ?? []).length).toBe(20); // every file, not 8
    expect(html).toContain('class="bars scroll"'); // scrollable so it doesn't dominate
    expect(html).toContain("file-0.md"); // heaviest first
    expect(html).toMatch(/<i>\d+%<\/i>/); // per-file share of total
  });

  it("embeds a meta-refresh only when a refresh interval is given (live mode)", () => {
    expect(reportHtml("aih report", RICH, { refresh: 10 })).toContain(
      '<meta http-equiv="refresh" content="10">',
    );
    expect(reportHtml("aih report", RICH)).not.toContain("http-equiv");
  });
});
