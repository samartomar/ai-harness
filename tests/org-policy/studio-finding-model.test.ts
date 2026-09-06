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
    const html = policyStudioHtml(tinyStudioModel());
    expect(html).not.toContain("14 non-waivable blockers");
    expect(html).toContain("8 administrator-dispositionable, 6 hard blockers");
  });

  it("renders each finding partition into its matching list", () => {
    const window = studio();
    expect(window.document.getElementById("dispositionable-findings")?.textContent).toBe(
      DISPOSITIONABLE_POLICY_FINDING_CODES.join(" | "),
    );
    expect(window.document.getElementById("hard-blockers")?.textContent).toBe(
      FENCED_POLICY_PREREQUISITE_CODES.join(" | "),
    );
  });
});
