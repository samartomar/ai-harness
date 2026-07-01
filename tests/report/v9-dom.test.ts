import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { type DigestAction, digest } from "../../src/internals/plan.js";
import { assembleViewV9, buildAihDataV9, HYDRATE_FN, reportHtmlV9 } from "../../src/report/v9.js";
import { V9_DEMO } from "../../src/report/v9-demo.js";

/**
 * Verifies hydration in a real DOM: the generated page is parsed by happy-dom (script
 * execution disabled — we don't want the template's clock/radar IIFE), then the SAME
 * hydrate source the page ships ({@link HYDRATE_FN}) runs against it with the assembled
 * view. Assertions key on signals only hydration produces (real values swapped in,
 * PREVIEW markers, the off-canon stub).
 */

function onCanon(): DigestAction[] {
  return [
    digest("Harness maturity — 82/100 (solid)", "", {
      overall: 82,
      grade: "solid",
      dimensions: [
        { name: "layering", score: 100, checks: [] },
        { name: "sharing", score: 100, checks: [] },
        { name: "harnessWiring", score: 88, checks: [] },
        {
          name: "guardrails",
          score: 40,
          checks: [{ id: "pre-commit-installed", passed: false }],
        },
        { name: "discoverability", score: 82, checks: [] },
      ],
    }),
    digest("Context footprint — ~18400", "", {
      files: [{ path: "CLAUDE.md", tokens: 1810 }],
      totalTokens: 18400,
      budgetTokens: 32000,
      overBudget: false,
    }),
    digest("Per-turn context — ~12200", "", {
      worst: { clis: ["claude"] },
      worstTokens: 12200,
      budgetTokens: 32000,
      overBudget: false,
    }),
    digest("Daily commits — 23 in 7d", "", {
      commits: { d7: 23, d30: 87, total: 312 },
      daily90: [{ date: "2026-06-28", count: 3 }],
    }),
    digest("AI CLI wiring — 1 of 1", "", {
      rows: [
        {
          cli: "claude",
          targeted: true,
          bootloader: { state: "wired" },
          mcp: { state: "wired" },
          load: { verdict: "loads" },
        },
      ],
      targeted: ["claude"],
    }),
    digest("Configuration — 1 of 2", "", {
      present: ["context-dir"],
      absent: ["AGENTS.md"],
      total: 2,
    }),
    digest("Canon drift — 1 of 2 drifted", "", {
      drifted: [
        { file: "ai-coding/RULE_ROUTER.md", delta: "+42 tok", status: "drifted", when: "" },
      ],
      synced: ["CLAUDE.md"],
      tracked: 2,
    }),
    digest("Developer readiness — 42/100 (at-risk)", "", {
      banner: "NOT READY",
      score: 42,
      rawScore: 42,
      grade: "at-risk",
      blockers: [
        {
          id: "tls-ca-trust",
          title: "Corporate TLS/CA trust intact",
          cmd: "aih heal --scope certs",
        },
      ],
      warns: [],
      firstCommand: null,
    }),
  ];
}

type HydrateFn = (doc: unknown, view: unknown) => void;

function hydrate(): HydrateFn {
  return new Function(`return (${HYDRATE_FN})`)() as HydrateFn;
}

function newWindow(): Window {
  return new Window({ url: "http://localhost/", settings: { disableJavaScriptEvaluation: true } });
}

describe("reportHtmlV9 — DOM hydration", () => {
  it("binds LIVE panels with real values and marks PREVIEW cards", () => {
    const d = onCanon();
    const window = newWindow();
    window.document.write(reportHtmlV9("aih report — local developer console", d));
    const fn = hydrate();
    const view = assembleViewV9(buildAihDataV9(d), V9_DEMO);
    expect(() => fn(window.document, view)).not.toThrow();

    const doc = window.document;
    // Hero: real wiring score swapped into the narrative.
    expect(doc.querySelector("#sec-hero .hero-score-big")?.textContent).toContain("82");
    // Readiness: the NOT READY verdict + its blocker row swapped in from the digest.
    const ready = doc.getElementById("sec-ready");
    expect(ready?.textContent).toContain("NOT READY");
    expect(ready?.textContent).toContain("Corporate TLS/CA trust intact");
    expect(ready?.querySelector(".sec-title")?.textContent).toContain("1 blocker");
    // Action board: ranked anomaly cards from real signals.
    const actions = doc.getElementById("sec-actions");
    expect(actions?.querySelectorAll(".anom-card").length ?? 0).toBeGreaterThan(0);
    expect(actions?.textContent).toContain("Wire guardrails");
    // PREVIEW: the skill ledger carries the desaturated preview marker.
    expect(doc.querySelector("#sec-skills .preview")).not.toBeNull();
    // The coherence card (sec-drift, 2nd card) is previewed too.
    expect(doc.querySelector("#sec-drift .preview")).not.toBeNull();
    window.happyDOM.close();
  });

  it("renders the honest stub (not demo) for an empty panel off-canon", () => {
    const d = [
      digest("Configuration — 0 of 1", "", { present: [], absent: ["AGENTS.md"], total: 1 }),
    ];
    const window = newWindow();
    window.document.write(reportHtmlV9("t", d));
    const view = assembleViewV9(buildAihDataV9(d), V9_DEMO);
    hydrate()(window.document, view);

    const hero = window.document.getElementById("sec-hero");
    expect(hero?.textContent).toContain("No harness here yet");
    // The demo score must NOT survive into the live, off-canon hero.
    expect(window.document.querySelector("#sec-hero .hero-score-big")).toBeNull();
    window.happyDOM.close();
  });

  it("keeps the demo view available under --demo", () => {
    const window = newWindow();
    window.document.write(reportHtmlV9("t", [], { demo: true }));
    expect(window.document.body.getAttribute("data-demo")).toBe("on");
    window.happyDOM.close();
  });
});
