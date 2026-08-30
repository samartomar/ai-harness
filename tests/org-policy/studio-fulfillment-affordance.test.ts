import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import type { OrgPolicy } from "../../src/org-policy/schema.js";
import type { PolicyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const assets = model.catalog.frameworks.flatMap((framework) =>
  framework.assets.map((asset) => ({ framework, asset })),
);
const mainAssets = assets;

// Real, shipped fixtures for the two vet verdicts the vendor lock actually
// carries at this pin. A second, distinct pass example lets the fulfillment
// summary test select an asymmetric count (2 pass, 1 blocked) - with equal
// counts a swapped counter reads identically and the assertion cannot fail
// for the reason it claims (this program's own recurring defect class).
const passExample = mainAssets.find(({ asset }) => asset.vet?.verdict === "pass");
const blockedExample = mainAssets.find(({ asset }) => asset.vet?.verdict === "blocked");
const passExample2 = mainAssets.find(
  ({ asset }) => asset.vet?.verdict === "pass" && asset.id !== passExample?.asset.id,
);
if (passExample === undefined || blockedExample === undefined || passExample2 === undefined) {
  throw new Error(
    "expected the pinned catalog to carry at least two pass and one blocked component",
  );
}

type Entry = { framework: { id: string }; asset: { kind: string; id: string } };

function studioWindow(studioModel: PolicyStudioModel): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(studioModel);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function selectSelector(entry: Entry): string {
  return `[data-framework-select="${entry.framework.id}|${entry.asset.kind}|${entry.asset.id}"]`;
}

function detailSelector(entry: Entry): string {
  return `[data-detail="${entry.framework.id} / ${entry.asset.kind}: ${entry.asset.id}"]`;
}

/** Read exactly the one row the annotation belongs to, never the whole plane. */
function rowFor(window: Window, entry: Entry) {
  const row = window.document.querySelector(
    `[data-row="${entry.framework.id} / ${entry.asset.kind}: ${entry.asset.id}"]`,
  );
  if (row === null) throw new Error(`expected a row for ${entry.asset.id}`);
  return row;
}

function reportPreview(window: Window): string {
  const node = window.document.getElementById("report-preview") as unknown as {
    value: string;
  } | null;
  if (node === null) throw new Error("expected #report-preview");
  return node.value;
}

function fulfillmentCounts(window: Window): {
  materializing: number;
  blocked: number;
  owed: number;
  missing: number;
} {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected policy preview");
  const policy = JSON.parse(preview.value) as {
    governance: {
      externalSelections: Array<{ framework: string; items: Array<{ id: string }> }>;
    };
  };
  const counts = { materializing: 0, blocked: 0, owed: 0, missing: 0 };
  for (const group of policy.governance.externalSelections) {
    const framework = model.catalog.frameworks.find((item) => item.id === group.framework);
    for (const item of group.items) {
      const asset = framework?.assets.find((candidate) => candidate.id === item.id);
      if (asset === undefined) counts.missing += 1;
      else if (asset.vet?.verdict === "pass") counts.materializing += 1;
      else if (asset.vet?.verdict === "blocked") counts.blocked += 1;
      else counts.owed += 1;
    }
  }
  return counts;
}

/**
 * The vendor lock vets every pinned component today — studio-vet-verdicts.test.ts
 * pins that coverage ("carries the vetted verdict for every component"), so
 * "selected with no vet record at the pin" cannot be produced from the real,
 * unmodified catalog: there is no row to select. It is nonetheless a
 * legitimate, typed state (`vet?` is optional on `PolicyAuthoringAsset`, and
 * the catalog constructor already omits the field when a pin's evidence is
 * missing) that the annotation layer must still render correctly. Rather than
 * write a loop over a collection that can never hold a member (the vacuous
 * pattern this program's own H5 overlap test warns against), this constructs
 * one honest fixture — the real model with exactly one asset's `vet` removed —
 * and exercises the real render pipeline against it.
 */
const noVetFixture = (): { model: PolicyStudioModel; entry: Entry } => {
  const target = passExample;
  const cloned = structuredClone(model) as PolicyStudioModel;
  const framework = cloned.catalog.frameworks.find((item) => item.id === target.framework.id);
  if (framework === undefined) throw new Error("expected the pass example's framework");
  const asset = framework.assets.find((item) => item.id === target.asset.id);
  if (asset === undefined) throw new Error("expected the pass example's asset");
  delete asset.vet;
  return { model: cloned, entry: { framework, asset } };
};

type Governance = NonNullable<OrgPolicy["governance"]>;
type RawSelectionGroup = Governance["externalSelections"][number];
type RawSelectionItem = RawSelectionGroup["items"][number];

/**
 * A model whose initial policy carries exactly the given externalSelections,
 * bypassing schema.ts's parseOrgPolicy the same way the workbench's OWN
 * client-side import path already does: its inline schemaErrors() reads only
 * the JSON-Schema conversion of OrgPolicySchema, which cannot express a
 * Zod superRefine (so the "no duplicate framework" rule is invisible to it),
 * and its hand-written policySemantics() has no externalSelections branch at
 * all — confirmed by reading both. Only the server-side Zod schema rejects a
 * duplicate framework group; nothing anywhere (client or server) cross-checks
 * an item's kind against its own id, or checks the id against the catalog.
 * This constructs the exact policy shape such an import would leave behind,
 * directly, so the render pipeline's reaction to it is what gets tested.
 */
const modelWithSelections = (externalSelections: RawSelectionGroup[]): PolicyStudioModel => {
  const cloned = structuredClone(model) as PolicyStudioModel;
  const governance = cloned.initialPolicy.governance;
  if (governance === undefined) throw new Error("expected default studio governance");
  governance.externalSelections = externalSelections;
  return cloned;
};

function rawItem(
  entry: Entry & { asset: { source: unknown } },
  kindOverride?: string,
): RawSelectionItem {
  return {
    kind: kindOverride ?? entry.asset.kind,
    id: entry.asset.id,
    source: entry.asset.source,
  } as RawSelectionItem;
}

describe("selection to fulfillment affordance", () => {
  describe("selected and vetted-at-pin", () => {
    it("states on the row that AIH materializes the component directly, conditional on engine evaluation", () => {
      const window = studioWindow(model);
      click(window, selectSelector(passExample));
      const text = rowFor(window, passExample).textContent ?? "";
      expect(text).toContain("Fulfillment: on aih policy project in a governed repository");
      expect(text).toContain(
        "AIH materializes this component directly, per-component and receipt-bound",
      );
      expect(text).toContain(`${passExample.framework.id} runs no installer for it`);
      expect(text).toContain("conditional on the target repository's own engine evaluation");
      // Never the other two branches' language, on this exact row.
      expect(text).not.toContain("vet-blocked");
      expect(text).not.toContain("evidence is still owed at this pin");
    });

    it("states the same consequence in the drawer detail", () => {
      const window = studioWindow(model);
      click(window, selectSelector(passExample));
      click(window, detailSelector(passExample));
      const detail = window.document.getElementById("drawer-detail");
      const text = detail?.textContent ?? "";
      expect(text).toContain(
        "AIH materializes this component directly, per-component and receipt-bound",
      );
      // Styled as a positive note, distinct from the plain ownership note above it.
      expect(detail?.querySelector(".note.ok")?.textContent).toContain("Fulfillment:");
    });

    it("keeps the shipped Selectable copy truthful when nothing is selected yet", () => {
      const window = studioWindow(model);
      const text = rowFor(window, passExample).textContent ?? "";
      expect(text).toContain(`Selectable - ${passExample.framework.id} installs and runs it`);
      expect(text).not.toContain("Fulfillment:");
    });

    it("qualifies the neighbouring ownership copy so it no longer contradicts the fulfillment claim", () => {
      // The row's own detail text and the drawer's ownership paragraph both
      // say "<framework> installs and runs it" right next to this row's
      // "<framework> runs no installer for it" - read together that is a
      // direct contradiction unless the neighbour is hedged as the default,
      // non-governed behaviour rather than an unconditional fact.
      const window = studioWindow(model);
      click(window, selectSelector(passExample));
      const rowText = rowFor(window, passExample).textContent ?? "";
      expect(rowText).toContain(`By default, ${passExample.framework.id} installs and runs it`);
      click(window, detailSelector(passExample));
      const drawerText = window.document.getElementById("drawer-detail")?.textContent ?? "";
      expect(drawerText).toContain(
        `${passExample.framework.id} owns this component; by default it installs and runs it`,
      );
    });
  });

  describe("selected and vet-blocked", () => {
    it("states it is blocked at this pin and defers the actual outcome to the target repository's engine evaluation", () => {
      const window = studioWindow(model);
      click(window, selectSelector(blockedExample));
      const row = rowFor(window, blockedExample);
      const text = row.textContent ?? "";
      expect(text).toContain("Selected - requested intent recorded");
      expect(text).toContain(
        "Fulfillment: blocked at this pin - whether it materializes depends on the target repository's own engine evaluation of its evidence; accepting the finding is the path that can change it.",
      );
      expect(text).not.toContain("materializes this component directly");
      // Never a fixed "will not materialize" outcome: the engine authorizes
      // an accepted-with-conditions component from THIS pin's blocked
      // verdict exactly like a plain pass (src/ecc/materialization-selection.ts).
      expect(text).not.toContain("does not materialize while blocked");
      // A label on a selectable row, never a disabled experience (H4).
      const tickButton = row.querySelector("[data-framework-select]");
      expect(tickButton).not.toBeNull();
      expect(tickButton?.hasAttribute("disabled")).toBe(false);
    });

    it("states the same consequence in the drawer detail, styled as a warning note", () => {
      const window = studioWindow(model);
      click(window, selectSelector(blockedExample));
      click(window, detailSelector(blockedExample));
      const detail = window.document.getElementById("drawer-detail");
      expect(detail?.querySelector(".note.bad")?.textContent).toContain(
        "accepting the finding is the path that can change it",
      );
    });

    it("never claims a vet-blocked component is unsupported or unable to become effective", () => {
      // "Vet-blocked" is the one AIH-owned gate this vocabulary reserves the
      // word "blocked" for — it must never read as third-party non-support.
      const window = studioWindow(model);
      click(window, selectSelector(blockedExample));
      const text = rowFor(window, blockedExample).textContent ?? "";
      expect(text).not.toContain("unsupported");
      expect(text).not.toContain("unable to become effective");
    });
  });

  describe("selected with no vet record at the pin", () => {
    it("states evidence is still owed and defers the outcome to the target repository's engine evaluation", () => {
      const { model: fixtureModel, entry } = noVetFixture();
      const window = studioWindow(fixtureModel);
      click(window, selectSelector(entry));
      const text = rowFor(window, entry).textContent ?? "";
      expect(text).toContain(
        "Fulfillment: evidence is still owed at this pin - whether it materializes depends on the target repository's own engine evaluation of its evidence, once evidence exists to evaluate.",
      );
      expect(text).not.toContain("materializes this component directly");
      expect(text).not.toContain("vet-blocked");
    });

    it("states the same consequence in the drawer detail with no ok/bad styling", () => {
      const { model: fixtureModel, entry } = noVetFixture();
      const window = studioWindow(fixtureModel);
      click(window, selectSelector(entry));
      click(window, detailSelector(entry));
      const detail = window.document.getElementById("drawer-detail");
      const notes = [...(detail?.querySelectorAll(".note") ?? [])];
      const fulfillmentNote = notes.find((node) =>
        (node.textContent ?? "").includes("Fulfillment:"),
      );
      expect(fulfillmentNote?.textContent).toContain("evidence is still owed at this pin");
      expect(fulfillmentNote?.className).toBe("note");
    });
  });

  describe("a selection whose kind disagrees with its own id is never annotated as materializing", () => {
    // src/ecc/materialization-selection.ts refuses exactly this shape as
    // "malformed-selection" ("selection kind ... does not match component
    // id ..."). isFrameworkSelected() matches on id alone (pre-existing,
    // widely-used, out of this row's scope to change), so the row still
    // shows "Selected" via the existing tick/badge - but this layer must
    // name none of the three fulfillment claims for it, since all three
    // would overstate what the engine actually does with it.
    it("renders no fulfillment claim on the row", () => {
      const mismatchedKind = passExample.asset.kind === "runtime" ? "module" : "runtime";
      const fixtureModel = modelWithSelections([
        {
          framework: passExample.framework.id as "ecc" | "superpowers",
          items: [rawItem(passExample, mismatchedKind)],
        },
      ]);
      const window = studioWindow(fixtureModel);
      const text = rowFor(window, passExample).textContent ?? "";
      expect(text).toContain("Selected - requested intent recorded");
      expect(text).not.toContain("Fulfillment:");
    });

    it("is not counted in any of the three fulfillment buckets, nor silently dropped", () => {
      const mismatchedKind = passExample.asset.kind === "runtime" ? "module" : "runtime";
      const fixtureModel = modelWithSelections([
        {
          framework: passExample.framework.id as "ecc" | "superpowers",
          items: [rawItem(passExample, mismatchedKind)],
        },
      ]);
      const window = studioWindow(fixtureModel);
      const preview = reportPreview(window);
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          "0 would materialize directly, 0 vet-blocked and recorded as intent only, " +
          "0 with evidence still owed, 1 selected but not shown as a row at this pin.",
      );
    });
  });

  describe("the counts and the rows derive from one source, so they cannot disagree", () => {
    it("does not count a selection shadowed by a duplicate framework group as an annotated row", () => {
      // Two groups for the same framework: the second is invisible to
      // isFrameworkSelected() (selectedItems() takes the FIRST group for a
      // framework), so its row renders unselected/unannotated - the tally
      // must agree, not count it as if the row had shown it.
      const fixtureModel = modelWithSelections([
        { framework: "ecc", items: [rawItem(passExample)] },
        { framework: "ecc", items: [rawItem(blockedExample)] },
      ]);
      const window = studioWindow(fixtureModel);
      const shadowedRowText = rowFor(window, blockedExample).textContent ?? "";
      expect(shadowedRowText).toContain(
        `Selectable - ${blockedExample.framework.id} installs and runs it`,
      );
      expect(shadowedRowText).not.toContain("Fulfillment:");
      const primaryRowText = rowFor(window, passExample).textContent ?? "";
      expect(primaryRowText).toContain("Selected - requested intent recorded");
      const preview = reportPreview(window);
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          "1 would materialize directly, 0 vet-blocked and recorded as intent only, " +
          "0 with evidence still owed, 1 selected but not shown as a row at this pin.",
      );
    });

    it("reports an id the pin does not carry as not shown as a row, never as evidence owed", () => {
      // Collapsing this into "evidence owed" would read as though the pin
      // carries the component and merely lacks a verdict for it - the engine
      // keeps a malformed selection and missing evidence as distinct
      // exclusion reasons, and this surface must not erase that distinction.
      const fixtureModel = modelWithSelections([
        {
          framework: "ecc",
          items: [
            {
              kind: "module",
              id: "module:this-id-is-not-in-the-pinned-catalog",
              source: { ...passExample.asset.source },
            } as RawSelectionItem,
          ],
        },
      ]);
      const window = studioWindow(fixtureModel);
      const preview = reportPreview(window);
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          "0 would materialize directly, 0 vet-blocked and recorded as intent only, " +
          "0 with evidence still owed, 1 selected but not shown as a row at this pin.",
      );
    });
  });

  describe("the report preview extends the same three counts as a fulfillment summary", () => {
    it("counts a materializing selection and a vet-blocked selection separately", () => {
      // Asymmetric on purpose (2 pass, 1 blocked): with equal counts a
      // materializes/vetBlocked swap in the counting logic would read
      // identically and this assertion could not catch it.
      const window = studioWindow(model);
      click(window, selectSelector(passExample));
      click(window, selectSelector(passExample2));
      click(window, selectSelector(blockedExample));
      const preview = reportPreview(window);
      const counts = fulfillmentCounts(window);
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          `${counts.materializing} would materialize directly, ` +
          `${counts.blocked} vet-blocked and recorded as intent only, ` +
          `${counts.owed} with evidence still owed, ` +
          `${counts.missing} selected but not shown as a row at this pin.`,
      );
    });

    it("counts a selected component with no vet record as evidence still owed", () => {
      const { model: fixtureModel, entry } = noVetFixture();
      const window = studioWindow(fixtureModel);
      click(window, selectSelector(entry));
      const preview = reportPreview(window);
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          "0 would materialize directly, 0 vet-blocked and recorded as intent only, " +
          "1 with evidence still owed, 0 selected but not shown as a row at this pin.",
      );
    });

    it("counts nothing when nothing is selected", () => {
      const window = studioWindow(model);
      const preview = reportPreview(window);
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          "0 would materialize directly, 0 vet-blocked and recorded as intent only, " +
          "0 with evidence still owed, 0 selected but not shown as a row at this pin.",
      );
    });
  });

  it("adds no new row when a selection gains a fulfillment annotation (S1)", () => {
    // Queries plain ".row", not ".row[data-state]": every row row() builds
    // carries data-state, so that attribute filter is blind to exactly the
    // kind of stray row this test exists to forbid - one appended outside
    // the shared row() builder. Both fixtures live in the same (ecc)
    // framework, so this stays inside one stable one-framework-at-a-time
    // view (F3, unrelated to this row) rather than crossing the point where
    // selecting a first component hides the other framework's groups
    // entirely - a real but orthogonal dynamic that must not be mistaken for
    // a row this change added.
    const window = studioWindow(model);
    click(window, selectSelector(passExample));
    const rowCountAfterFirstSelection = window.document.querySelectorAll(
      "#framework-rows .row, #ecc-mcp-declaration-rows .row",
    ).length;
    expect(rowCountAfterFirstSelection).toBe(
      mainAssets.filter(
        ({ framework, asset }) =>
          framework.id === passExample.framework.id && asset.kind !== "skill",
      ).length,
    );
    click(window, selectSelector(blockedExample));
    const rowCountAfterSecondSelection = window.document.querySelectorAll(
      "#framework-rows .row, #ecc-mcp-declaration-rows .row",
    ).length;
    expect(rowCountAfterSecondSelection).toBe(rowCountAfterFirstSelection);
  });

  it("leaves the ticker's per-owner totals matching the catalog's own counts (S2)", () => {
    // Asserts against numbers the MODEL supplies independently, never
    // against the identical three DOM operations (querySelectorAll +
    // filter + reduce) the production ticker code itself runs to produce
    // the number - recomputing the production formula as the expectation
    // is tautological: a stray row moves both sides together and the
    // assertion passes regardless. studio-owner-ticker.test.ts's "counts
    // every owner's rows" test is the biting sibling this mirrors.
    const window = studioWindow(model);
    click(window, selectSelector(passExample));
    click(window, selectSelector(blockedExample));
    const document = window.document;
    const chip = (owner: string): string | null | undefined =>
      document.querySelector(`#owner-ticker [data-owner-focus="${owner}"] b`)?.textContent;
    const aihControls =
      model.catalog.mcp.length +
      model.catalog.hooks.length +
      model.catalog.aihSkills.length +
      model.catalog.aihAgents.length;
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    if (ecc === undefined) throw new Error("expected the ecc framework in the catalog");
    // Selecting an ecc component makes ecc the active framework, which hides
    // superpowers' groups from the plane entirely (pre-existing exclusivity,
    // unrelated to this row) - the ticker must agree with that, not with 15.
    expect(chip("AIH")).toBe(String(aihControls));
    const governedSkills = ecc.assets.filter((asset) => asset.kind === "skill").length;
    const visibleEccInventory =
      ecc.assets.length -
      governedSkills +
      model.catalog.eccSkills.length +
      model.catalog.externalMcp.length;
    expect(chip("ECC")).toBe(String(visibleEccInventory));
    expect(chip("Superpowers")).toBe("0");
    expect(chip("You")).toBe("0");
    expect(chip("all")).toBe(String(aihControls + visibleEccInventory));
  });
});
