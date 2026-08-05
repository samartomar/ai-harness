import { describe, expect, it } from "vitest";
import {
  DISPOSITIONABLE_POLICY_FINDING_CODES,
  FENCED_POLICY_PREREQUISITE_CODES,
} from "../../src/org-policy/effective.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

describe("policy studio finding model", () => {
  it("carries both halves of the partition in the embedded model", () => {
    const model = policyStudioModel();
    expect(model.findings.dispositionable).toStrictEqual(DISPOSITIONABLE_POLICY_FINDING_CODES);
    expect(model.findings.fenced).toStrictEqual(FENCED_POLICY_PREREQUISITE_CODES);
    // The union stays available so existing consumers are unaffected.
    expect(model.unwaivable).toStrictEqual([
      ...DISPOSITIONABLE_POLICY_FINDING_CODES,
      ...FENCED_POLICY_PREREQUISITE_CODES,
    ]);
  });

  it("stops claiming a dispositionable finding cannot be waived", () => {
    const html = policyStudioHtml(policyStudioModel());
    expect(html).not.toContain("14 non-waivable blockers");
    expect(html).toContain("8 administrator-dispositionable, 6 hard blockers");
  });

  // The template's script is a string, so the compiler never checks that a
  // byId() target exists in the markup. Without this, renaming an element or
  // mistyping an id fails only in a browser nobody opens during a test run.
  it("resolves every element the template script looks up", () => {
    const html = policyStudioHtml(policyStudioModel());
    const looked = [...html.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(looked).toContain("dispositionable-findings");
    expect(looked).toContain("hard-blockers");
    for (const id of new Set(looked)) {
      expect(html, `template looks up #${id} but no element declares it`).toContain(`id="${id}"`);
    }
  });

  it("reads the partition, not the union, for the two rendered lists", () => {
    const html = policyStudioHtml(policyStudioModel());
    expect(html).toContain(
      'byId("dispositionable-findings").textContent=model.findings.dispositionable.join(" | ")',
    );
    expect(html).toContain('byId("hard-blockers").textContent=model.findings.fenced.join(" | ")');
  });
});
