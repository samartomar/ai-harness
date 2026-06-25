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
});
