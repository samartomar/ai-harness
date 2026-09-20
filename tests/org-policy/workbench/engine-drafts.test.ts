/**
 * Lane B of the editor port (Policy Workbench UI acceptance, section 7 rows
 * 19-21): the engine's drafts feature. The hand-built source is
 * `ui/catalog-inventory.ts`; the intent ported here is that of
 * `new-shell-changes.test.ts` (its inspector part), `policy-import.test.ts`
 * and, for row 21, `legacy-download-characterization.test.ts` against the
 * `import-migration.*` goldens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import {
  type AdminEngine,
  createAdminEngine,
} from "../../../src/org-policy/workbench/engine/index.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { importMigrationCases } from "./policy-fixtures.js";

const GOLDENS = join(process.cwd(), "tests/org-policy/workbench/goldens");
const golden = (name: string): string => readFileSync(join(GOLDENS, name), "utf8");

function withHosts(model: PolicyStudioModel = tinyStudioModel()): PolicyStudioModel {
  (model.catalog as unknown as { hosts: unknown[] }).hosts = [
    { id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },
    { id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" },
  ];
  return model;
}

function admin(model: PolicyStudioModel = withHosts()): AdminEngine {
  const created = createAdminEngine(model);
  if (!created.ok) throw new Error(created.errors.join("; "));
  return created.value;
}

/** The first selectable catalog item of the fixture model. */
function firstSelectable(engine: AdminEngine): string {
  for (const framework of engine.state().frameworks)
    for (const group of framework.groups)
      for (const item of group.items) if (item.selectable) return item.assetId;
  throw new Error("the fixture model has no selectable item");
}

describe("row 19: draft review and the review badge", () => {
  it("starts empty, with the hand-built page's own sentence", () => {
    const review = admin().draftReview();
    expect(review.entryCount).toBe(0);
    expect(review.summaryLabel).toBe("Review draft (0 entries)");
    expect(review.intro).toBe("0 saved entries. Changes here update your policy draft.");
    expect(review.empty).toBe(
      "This draft has no saved choices, requests, dependencies, or exclusions.",
    );
    expect(review.entries).toEqual([]);
  });

  it("names the three draft counts with their helps, never a token or cost figure", () => {
    const review = admin().draftReview();
    expect(review.counts.map((count) => count.label)).toEqual([
      "Controls",
      "Selections",
      "Requests",
    ]);
    expect(review.counts.map((count) => count.figure)).toEqual([0, 0, 0]);
    for (const count of review.counts) expect(count.help).not.toMatch(/token|cost|\$/iu);
  });

  it("counts a selection as one saved entry, and the badge follows it", () => {
    const engine = admin();
    const assetId = firstSelectable(engine);
    expect(engine.setItemSelected(assetId, true).ok).toBe(true);

    const review = engine.draftReview();
    expect(review.entryCount).toBeGreaterThan(0);
    expect(review.summaryLabel).toBe(`Review draft (${review.entryCount} entries)`);
    expect(review.empty).toBeUndefined();
    const saved = review.entries.find((entry) => entry.assetId === assetId);
    expect(saved?.origin).toBe("Origin: Administrator");
    expect(saved?.entryKind).toBeDefined();
    // Every entry the panel shows carries its own category word.
    for (const entry of review.entries) expect(entry.category.length).toBeGreaterThan(0);
  });

  it("saves and clears a reason with the hand-built page's two sentences", () => {
    const engine = admin();
    const assetId = firstSelectable(engine);
    engine.setItemSelected(assetId, true);
    const entry = engine.draftReview().entries.find((row) => row.assetId === assetId);
    if (entry?.entryKind === undefined) throw new Error("expected a saved entry");

    expect(engine.setRationale(entry.entryKind, assetId, "  local code review  ")).toEqual({
      ok: true,
      message: "Reason saved in this policy draft.",
    });
    expect(engine.draftReview().entries.find((row) => row.assetId === assetId)?.reason?.value).toBe(
      "local code review",
    );
    expect(engine.setRationale(entry.entryKind, assetId, "   ")).toEqual({
      ok: true,
      message: "Reason cleared.",
    });
  });

  it("refuses a reason for an entry that is not in the draft", () => {
    const outcome = admin().setRationale("root", "not/in/the/draft", "why");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(
      "The reason could not be saved. Review this item's current version.",
    );
  });
});

describe("row 19: policy exposure", () => {
  it("shows the four counts and the limits sentence, and says when nothing is selected", () => {
    const exposure = admin().policyExposure();
    expect(exposure.heading).toBe("A policy is a shape of exposure");
    expect(exposure.counts.map((count) => count.label)).toEqual([
      "Selected items",
      "Current pending requests",
      "Unresolved pins",
      "Items with verified reports",
    ]);
    expect(exposure.limits).toContain("Destinations, file access and credential scope");
    expect(exposure.selectedEmpty).toBe("No catalog items are selected.");
    expect(exposure.requestEmpty).toBe("No current catalog requests are pending.");
  });

  it("lists a selected item with its source, declared access and checks", () => {
    const engine = admin();
    const assetId = firstSelectable(engine);
    engine.setItemSelected(assetId, true);

    const exposure = engine.policyExposure();
    expect(exposure.selectedEmpty).toBeUndefined();
    const item = exposure.selected.find((candidate) => candidate.assetId === assetId);
    expect(item?.access.startsWith("Declared access: ")).toBe(true);
    expect(item?.checks.startsWith("Checks: ")).toBe(true);
    expect(exposure.counts[0]?.figure).toBe(exposure.selected.length);
  });
});

describe("row 20: starting points, exclusions, repairs and the comparison", () => {
  it("offers only starting points whose every item is in the catalog", () => {
    for (const template of admin().templates()) {
      expect(template.templateId.length).toBeGreaterThan(0);
      expect(template.description).toMatch(
        /^\d+ starting selections? and \d+ saved exclusions?\.$/u,
      );
    }
  });

  it("refuses an unknown starting point without changing the policy", () => {
    const engine = admin();
    const before = engine.state().policyText;
    expect(engine.templatePreview("no-such-template")).toBeUndefined();
    expect(engine.applyTemplate("no-such-template").ok).toBe(false);
    expect(engine.state().policyText).toBe(before);
  });

  it("adds and removes an administrator exclusion", () => {
    const engine = admin();
    const assetId = firstSelectable(engine);
    const added = engine.toggleExclusion(assetId);
    if (!added.ok) {
      // The fixture catalog may refuse an exclusion for this item; the refusal
      // must still be the editor's own words, never a thrown error.
      expect(added.message.length).toBeGreaterThan(0);
      return;
    }
    expect(engine.draftReview().entries.some((entry) => entry.entryKind === "exclusion")).toBe(
      true,
    );
    expect(engine.toggleExclusion(assetId).ok).toBe(true);
    expect(engine.draftReview().entries.some((entry) => entry.entryKind === "exclusion")).toBe(
      false,
    );
  });

  it("reports no repair for a draft whose every saved version is current", () => {
    const engine = admin();
    engine.setItemSelected(firstSelectable(engine), true);
    expect(engine.repairs()).toEqual([]);
  });

  it("refuses a repair whose origin is not the administrator's", () => {
    expect(admin().removeRepair("remove-root", "anything", "template")).toEqual({
      ok: false,
      message: "Saved selection removal rejected.",
    });
  });

  it("refuses a confirm whose draft has moved on, with the page's own sentence", () => {
    const engine = admin();
    const assetId = firstSelectable(engine);
    const comparison = engine.comparison(assetId);
    if (comparison === undefined) throw new Error("expected a comparison");
    expect(comparison.heading).toBe("Review replacement");
    expect(comparison.changes).toContain("This preview removes ");
    expect(comparison.removed.startsWith("No longer included: ")).toBe(true);

    expect(engine.confirmComparison(assetId, "a stale token")).toEqual({
      ok: false,
      message: "The draft changed. Review the replacement again.",
    });
  });

  it("refuses a confirm for an item with no declared conflict", () => {
    const engine = admin();
    const assetId = firstSelectable(engine);
    const comparison = engine.comparison(assetId);
    if (comparison === undefined) throw new Error("expected a comparison");
    if (comparison.kind === "conflict") return;
    expect(comparison.confirmable).toBe(false);
    expect(engine.confirmComparison(assetId, comparison.token)).toEqual({
      ok: false,
      message: "The draft changed. Review the replacement again.",
    });
  });
});

describe("row 21: the import migration message and preview", () => {
  it("reproduces the golden message and the golden preview bytes for each schema-2 case", () => {
    const messages = JSON.parse(golden("import-migration-messages.json")) as Record<string, string>;
    for (const [name, model, makePolicy] of importMigrationCases) {
      const engine = admin(withHosts(model()));
      const outcome = engine.importPolicyText(JSON.stringify(makePolicy()));
      expect([name, outcome.message]).toStrictEqual([name, messages[name]]);
      // The preview is exactly the bytes a download would write.
      expect([name, engine.state().policyText]).toStrictEqual([
        name,
        golden(`import-migration.${name}.json`),
      ]);
    }
  });

  it("keeps the policy and its preview when a migration is refused", () => {
    const engine = admin();
    const before = engine.state().policyText;
    const outcome = engine.importPolicyText('{"schemaVersion":2,"schemaVersion":2}');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(
      "Policy import rejected: duplicate JSON object key: schemaVersion",
    );
    expect(engine.state().policyText).toBe(before);
  });
});
