import { describe, expect, it } from "vitest";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

function allAssets() {
  return policyAuthoringCatalog().frameworks.flatMap((framework) => framework.assets);
}

function lockComponents(sourceId: string) {
  const source = readVendorBaselineLock().sources.find((entry) => entry.id === sourceId);
  if (source === undefined) throw new Error(`vendor lock is missing ${sourceId}`);
  return source;
}

describe("vet verdicts on the authoring surface", () => {
  // The vet produces a verdict for every pinned component. A surface that still
  // says "evidence needed" for all of them is telling an administrator to
  // generate evidence this build already ships.
  it("carries the vetted verdict for every component", () => {
    for (const framework of policyAuthoringCatalog().frameworks) {
      const byId = new Map(lockComponents(framework.id).components.map((c) => [c.id, c]));
      for (const asset of framework.assets) {
        expect(asset.vet, `${asset.id} has no vet verdict`).toBeDefined();
        expect(asset.vet?.verdict).toBe(byId.get(asset.id)?.verdict);
      }
    }
  });

  // Blocked is now populated by AIH's own analyzers, which is the one case the
  // corrected vocabulary reserves the word for.
  it("marks exactly the components the vet blocked", () => {
    const blocked = allAssets().filter((asset) => asset.vet?.verdict === "blocked");
    const expected = readVendorBaselineLock()
      .sources.flatMap((source) => source.components)
      .filter((component) => component.verdict === "blocked")
      .map((component) => component.id);
    expect(blocked.map((asset) => asset.id).sort()).toStrictEqual([...expected].sort());
    expect(blocked.length).toBeGreaterThan(0);
  });

  // The lock schema already guarantees a blocked component retains a finding,
  // so a blocked row can always say why rather than only that.
  it("gives every blocked component a reason to show", () => {
    for (const asset of allAssets()) {
      if (asset.vet?.verdict !== "blocked") continue;
      expect(asset.vet.findings.length, `${asset.id} is blocked with no finding`).toBeGreaterThan(
        0,
      );
      expect(asset.vet.findings[0]?.code).toMatch(/\S/);
    }
  });

  // Evidence is pin-bound. Showing a verdict recorded against a different commit
  // would launder a stale result into a current claim.
  it("binds the projected verdict to the pin the vet actually ran against", () => {
    for (const framework of policyAuthoringCatalog().frameworks) {
      expect(framework.commit).toBe(lockComponents(framework.id).pinnedSha);
    }
  });

  it("renders blocked components as visually distinct, not merely labelled", () => {
    const html = policyStudioHtml(policyStudioModel());
    // A governance decision needs the verdict, the analyzer that reached it and
    // the finding behind it — a bare word is not a reviewable disclosure.
    expect(html).toContain('data-vet="blocked"');
    expect(html).toContain('data-vet="pass"');
    expect(html).toContain("trust.permission-risk");
  });
});
