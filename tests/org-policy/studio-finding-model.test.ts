import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  DISPOSITIONABLE_POLICY_FINDING_CODES,
  FENCED_POLICY_PREREQUISITE_CODES,
} from "../../src/org-policy/effective.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

function studio() {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(tinyStudioModel());
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

describe("policy studio finding model", () => {
  it("carries both halves of the partition in the embedded model", () => {
    const model = tinyStudioModel();
    expect(model.findings.dispositionable).toStrictEqual(DISPOSITIONABLE_POLICY_FINDING_CODES);
    expect(model.findings.fenced).toStrictEqual(FENCED_POLICY_PREREQUISITE_CODES);
    // The union stays available so existing consumers are unaffected.
    expect(model.unwaivable).toStrictEqual([
      ...DISPOSITIONABLE_POLICY_FINDING_CODES,
      ...FENCED_POLICY_PREREQUISITE_CODES,
    ]);
  });

  it("stops claiming a dispositionable finding cannot be waived", () => {
    // Read from the rendered page (the new shell builds the copy in the browser).
    const text = studio().document.body.textContent ?? "";
    expect(text).not.toContain("14 non-waivable blockers");
    expect(text).toContain("8 administrator-dispositionable, 6 hard blockers");
  });

  // NEW-SHELL-PLAN.md: the finding model moved to the new shell's scan screen, assertion unchanged.
  it("renders each finding partition into its matching list", () => {
    const window = studio();
    expect(window.document.getElementById("dispositionable-findings")?.textContent).toBe(
      DISPOSITIONABLE_POLICY_FINDING_CODES.join(" | "),
    );
    expect(window.document.getElementById("hard-blockers")?.textContent).toBe(
      FENCED_POLICY_PREREQUISITE_CODES.join(" | "),
    );
  });

  it("states the partition counts on the new shell's scan screen", () => {
    const window = studio();
    const summary = window.document.querySelector("[data-wb-scan-finding-model] > summary");
    expect(summary?.textContent).toBe(
      `Finding model: ${DISPOSITIONABLE_POLICY_FINDING_CODES.length} administrator-dispositionable, ${FENCED_POLICY_PREREQUISITE_CODES.length} hard blockers`,
    );
    expect(summary?.closest('[data-wb-screen-panel="scan"]')).not.toBeNull();
  });
});
