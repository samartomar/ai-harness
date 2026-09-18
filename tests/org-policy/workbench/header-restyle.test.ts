import { describe, expect, it } from "vitest";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

/**
 * P2a: restyling `<header class="bar">` must keep every contract id from
 * prototype/policy-workbench/id-contract.md's "Toolbar / global chrome"
 * section. This does not assert markup or classes (those are free to
 * change); it only asserts each id is still present exactly once.
 */
describe("workbench header restyle keeps its DOM hook contract (P2a)", () => {
  const html = policyStudioHtml(tinyStudioModel());

  const contractIds = [
    "theme-toggle",
    "import-policy",
    "import-evidence",
    "import-decision",
    "validate",
    "download",
    "export",
    "clear-policy",
    "policy-file",
    "evidence-file",
    "decision-file",
    "status",
    "posture",
  ];

  it.each(contractIds)('keeps id="%s" present exactly once', (id) => {
    const matches = html.match(new RegExp(`id="${id}"`, "g")) ?? [];
    expect(matches.length).toBe(1);
  });

  it("keeps the GitHub link in the header", () => {
    expect(html).toContain('href="https://github.com/samartomar/ai-harness"');
  });

  it("keeps clear-policy positioned after export (danger-zone ordering)", () => {
    const exportIndex = html.indexOf('id="export"');
    const clearIndex = html.indexOf('id="clear-policy"');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(exportIndex);
  });
  it("lets the header grow when its controls wrap on narrow screens", () => {
    const header = html.slice(html.indexOf('<header class="bar'), html.indexOf("</header>"));
    expect(header).not.toMatch(/\sh-14\s/);
    expect(header).toContain("min-h-14");
  });

  it("uses no opacity modifiers, which Tailwind cannot apply to var() colours", () => {
    const header = html.slice(html.indexOf('<header class="bar'), html.indexOf("</header>"));
    expect(header).not.toMatch(/(?:bg|border|text)-[a-z-]+\/\d+/);
  });
});
