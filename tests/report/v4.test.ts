import { describe, expect, it } from "vitest";
import { digest } from "../../src/internals/plan.js";
import { buildAihDataV4, reportHtmlV4 } from "../../src/report/v4.js";

/** A scorecard digest shaped like {@link scorecardDigest}'s output. */
function scorecard() {
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

describe("buildAihDataV4", () => {
  it("maps the scorecard's 5 dimensions to the radar, in display order", () => {
    const data = buildAihDataV4([scorecard()]);
    expect(data.radar).toEqual({
      labels: ["Layering", "Sharing", "Wiring", "Guardrails", "Discover"],
      values: [100, 100, 100, 67, 100],
    });
  });

  it("carries the overall score + tier", () => {
    const data = buildAihDataV4([scorecard()]);
    expect(data.maturity).toEqual({ overall: 93, grade: "mature" });
  });

  it("leaves radar + maturity undefined when no scorecard ran (off-canon)", () => {
    const data = buildAihDataV4([digest("Configuration — 4 of 4", "body", { present: [] })]);
    expect(data.radar).toBeUndefined();
    expect(data.maturity).toBeUndefined();
  });

  it("gates every live data section (commit 1 binds only the hero)", () => {
    const data = buildAihDataV4([scorecard()]);
    for (const id of ["sec-anomalies", "sec-sankey", "sec-cost", "sec-guardrails", "sec-events"]) {
      expect(data.gates[id]).toBe(false);
    }
  });
});

describe("reportHtmlV4", () => {
  const title = "aih report — local developer console";

  it("is a self-contained document with the real title", () => {
    const html = reportHtmlV4(title, [scorecard()]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<title>${title}</title>`);
  });

  it("injects the real radar values into AIH_DATA", () => {
    const html = reportHtmlV4(title, [scorecard()]);
    expect(html).toContain('"values":[100,100,100,67,100]');
    expect(html).not.toContain("window.AIH_DATA = null;");
  });

  it("does not auto-refresh by default but honors --refresh", () => {
    expect(reportHtmlV4(title, [scorecard()])).not.toContain('http-equiv="refresh"');
    expect(reportHtmlV4(title, [scorecard()], { refresh: 5 })).toContain(
      '<meta http-equiv="refresh" content="5">',
    );
  });

  it("defaults to demo data only under --demo", () => {
    expect(reportHtmlV4(title, [scorecard()])).toContain("<body>");
    expect(reportHtmlV4(title, [scorecard()], { demo: true })).toContain('<body data-demo="on">');
  });

  it("keeps the demo subtree as the full showcase and gates live panels honestly", () => {
    const html = reportHtmlV4(title, [scorecard()]);
    expect(html).toContain('id="aih-demo"');
    expect(html).toContain('id="radar-demo"');
    expect(html).toContain("Not yet wired to local data");
  });
});
