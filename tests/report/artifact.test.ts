import { describe, expect, it } from "vitest";
import { digest } from "../../src/internals/plan.js";
import { reportHtml, reportMarkdown } from "../../src/report/artifact.js";

const DIGESTS = [
  digest("Context footprint — ~100 tokens", "  Files:  1\n  Tokens: ~100", { totalTokens: 100 }),
  digest("Tooling — 1 of 11", "  ✓ claude", { present: ["claude"] }),
];

describe("reportMarkdown", () => {
  it("renders a heading per digest with fenced verbatim bodies", () => {
    const md = reportMarkdown("aih report", DIGESTS);
    expect(md).toContain("# aih report");
    expect(md).toContain("## Context footprint — ~100 tokens");
    expect(md).toContain("## Tooling — 1 of 11");
    expect(md).toContain("```text");
    expect(md).toContain("  Files:  1");
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("reportHtml", () => {
  it("renders a self-contained page with a section per digest", () => {
    const html = reportHtml("aih report", DIGESTS);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>aih report</title>");
    expect(html).toContain("<h2>Context footprint — ~100 tokens</h2>");
    expect(html).toContain("<pre>  Files:  1");
    expect(html).toContain("</html>");
  });

  it("escapes HTML-special characters in titles and bodies", () => {
    const html = reportHtml("t<i>", [digest("a <b> & c", "x < y & z", {})]);
    expect(html).toContain("a &lt;b&gt; &amp; c");
    expect(html).toContain("x &lt; y &amp; z");
    expect(html).not.toContain("<b>");
  });

  it("builds the dashboard head — adoption ring, KPIs, and trend charts — from data", () => {
    const html = reportHtml("aih report", [
      digest("Context footprint — ~100 tokens", "x", { totalTokens: 100, files: [] }),
      digest("Repo status — on main", "x", {
        current: "main",
        branches: [{ name: "main" }, { name: "f" }],
      }),
      digest("Trends — 2 samples", "x", {
        samples: 2,
        rows: [
          { commits7d: 1, loc: { net: 5 }, adoptionScore: 40, branches: 1, sourceFiles: 10 },
          { commits7d: 3, loc: { net: 12 }, adoptionScore: 60, branches: 2, sourceFiles: 12 },
        ],
      }),
      digest("Configuration — 2 of 4 artifacts present", "x", {
        present: ["a", "b"],
        absent: ["c", "d"],
        total: 4,
      }),
      digest("Tooling — 1 of 11", "x", { present: ["claude"], total: 11 }),
    ]);
    expect(html).toContain('class="ring'); // adoption donut
    expect(html).toContain(">50</text>"); // 2/4 present = 50%
    expect(html).toContain('class="kpi"'); // KPI cards
    expect(html).toContain("context tokens");
    expect(html).toContain("local branches");
    expect(html).toContain('class="trends"'); // trend section present (≥2 samples)
    expect(html).toContain('class="bars"'); // SVG bar charts
  });

  it("omits the trend section with fewer than two samples", () => {
    const html = reportHtml("aih report", [
      digest("Trends — not enough", "x", { samples: 1, rows: [] }),
    ]);
    expect(html).not.toContain('class="trends"');
  });
});
