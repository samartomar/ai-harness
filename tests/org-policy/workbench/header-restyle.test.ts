import { afterEach, describe, expect, it } from "vitest";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { closeStudios, studio } from "./shell-parity-harness.js";

afterEach(closeStudios);

/**
 * P2a: the header must keep every contract id from
 * prototype/policy-workbench/id-contract.md's "Toolbar / global chrome"
 * section. It does not assert markup or classes (those are free to change);
 * it only asserts each id is still present exactly once. The new shell builds
 * its header in the browser, so the rendered page is read (slice B).
 */
describe("workbench header keeps its DOM hook contract (P2a)", () => {
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
    const { window } = studio(tinyStudioModel());
    expect(window.document.querySelectorAll(`#${id}`)).toHaveLength(1);
  });

  it("keeps the GitHub link in the header", () => {
    const { window } = studio(tinyStudioModel());
    const link = window.document.querySelector(
      '[data-wb-header] a[href="https://github.com/samartomar/ai-harness"]',
    );
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps clear-policy positioned after export (danger-zone ordering)", () => {
    const { window } = studio(tinyStudioModel());
    const exportPolicy = window.document.getElementById("export");
    const clear = window.document.getElementById("clear-policy");
    if (exportPolicy === null || clear === null) throw new Error("expected export and clear");
    expect(
      exportPolicy.compareDocumentPosition(clear) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("uses no opacity modifiers, which Tailwind cannot apply to var() colours", () => {
    const { window } = studio(tinyStudioModel());
    const header = window.document.querySelector("[data-wb-header]");
    expect(header).not.toBeNull();
    for (const node of [header, ...(header?.querySelectorAll("*") ?? [])])
      expect(node?.getAttribute("class") ?? "").not.toMatch(/(?:bg|border|text)-[a-z-]+\/\d+/);
  });
});
