import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { type DigestAction, digest } from "../../src/internals/plan.js";
import { buildAihDataV4, HYDRATE_FN, reportHtmlV4 } from "../../src/report/v4.js";

/**
 * Verifies the hydration in a real DOM: the generated page is parsed by happy-dom
 * (script execution disabled — we don't want the prototype's clock interval), then
 * the SAME hydrate source the page ships ({@link HYDRATE_FN}) is run against it.
 * Assertions key on signals only the hydrate produces (lowercase tier, the banner,
 * hidden sections), so they fail if the hydrate logic regresses.
 */

function digests(): DigestAction[] {
  return [
    digest("Harness maturity — 93/100 (mature)", "", {
      overall: 93,
      grade: "mature",
      dimensions: [
        { name: "layering", score: 100 },
        { name: "sharing", score: 100 },
        { name: "harnessWiring", score: 100 },
        { name: "guardrails", score: 67 },
        { name: "discoverability", score: 100 },
      ],
    }),
    digest("Tools installed — 3/3 core", "", {
      present: ["rg", "fd", "jq"],
      absent: ["comby"],
      core: ["rg", "fd", "jq"],
      optional: ["comby"],
      coreMissing: [],
      total: 4,
    }),
    digest("Configuration — 3 of 4", "", {
      present: ["context-dir", "gitleaks", "pre-commit"],
      absent: ["devcontainer"],
      total: 4,
    }),
    digest("Repo status — on feat/x", "", {
      isRepo: true,
      current: "feat/x",
      main: "main",
      dirty: true,
      branches: [{ name: "feat/x", age: "5m", ahead: 3, behind: 1 }],
    }),
    digest("AI CLI wiring — 1 of 1", "", {
      rows: [{ cli: "claude", mcp: { state: "wired", detail: "3 server(s) under x" } }],
      targeted: ["claude"],
    }),
    digest("AI events — 3 recorded", "", {
      rows: [{ ts: "2026-06-28 09:32", tool: "cursor", kind: "mcp", detail: "search-canon" }],
      shown: 1,
      total: 3,
    }),
    digest("Daily commits — 5 in 7d", "", {
      commits: { d7: 5, d30: 7, total: 42 },
      daily90: [
        { date: "2026-06-26", count: 2 },
        { date: "2026-06-27", count: 3 },
        { date: "2026-06-28", count: 1 },
      ],
    }),
  ];
}

type HydrateFn = (doc: unknown, data: unknown) => void;

function newWindow(): Window {
  return new Window({ url: "http://localhost/", settings: { disableJavaScriptEvaluation: true } });
}

describe("reportHtmlV4 — DOM hydration", () => {
  it("binds the hero + bound sections and hides the unwired ones", () => {
    const d = digests();
    const window = newWindow();
    window.document.write(reportHtmlV4("aih report — local developer console", d));
    const fn = new Function(`return (${HYDRATE_FN})`)() as HydrateFn;
    fn(window.document, buildAihDataV4(d));

    const doc = window.document;
    expect(doc.querySelector("#aih-live .hero-score-tier")?.textContent).toBe("mature");
    expect(doc.querySelector("#aih-live .hero-sub")?.textContent).toContain("bound to your repo");
    const adoption = doc.getElementById("sec-adoption");
    expect(adoption?.getAttribute("style") ?? "").not.toContain("display: none");
    expect(adoption?.textContent).toContain("MCP-enabled");
    expect(doc.getElementById("sec-activity")?.textContent).toContain("current streak");
    expect(doc.getElementById("sec-sankey")?.getAttribute("style") ?? "").toContain(
      "display: none",
    );
    expect(doc.querySelector("#aih-live .whatsnew")).not.toBeNull();
    window.happyDOM.close();
  });

  it("keeps the demo subtree available and marked under --demo", () => {
    const window = newWindow();
    window.document.write(reportHtmlV4("t", digests(), { demo: true }));
    expect(window.document.body.getAttribute("data-demo")).toBe("on");
    expect(window.document.getElementById("aih-demo")).not.toBeNull();
    window.happyDOM.close();
  });
});
