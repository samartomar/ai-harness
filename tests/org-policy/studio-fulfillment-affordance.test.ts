import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const assets = model.catalog.frameworks.flatMap((framework) =>
  framework.assets.map((asset) => ({ framework, asset })),
);

// Real, shipped fixtures for the two vet verdicts the vendor lock actually
// carries at this pin. A second, distinct pass example lets the fulfillment
// summary test select an asymmetric count (2 pass, 1 blocked) - with equal
// counts a swapped counter reads identically and the assertion cannot fail
// for the reason it claims (this program's own recurring defect class).
const passExample = assets.find(({ asset }) => asset.vet?.verdict === "pass");
const blockedExample = assets.find(({ asset }) => asset.vet?.verdict === "blocked");
const passExample2 = assets.find(
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

describe("delegated ruling 2 — selection to fulfillment affordance", () => {
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
  });

  describe("selected and vet-blocked", () => {
    it("keeps the visible-selectable treatment and states it does not materialize while blocked", () => {
      const window = studioWindow(model);
      click(window, selectSelector(blockedExample));
      const row = rowFor(window, blockedExample);
      const text = row.textContent ?? "";
      expect(text).toContain("Selected - requested intent recorded");
      expect(text).toContain(
        "Fulfillment: vet-blocked, so this stays recorded as intent only and does not materialize while blocked.",
      );
      expect(text).not.toContain("materializes this component directly");
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
        "does not materialize while blocked",
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
    it("states evidence is still owed and nothing materializes until it passes", () => {
      const { model: fixtureModel, entry } = noVetFixture();
      const window = studioWindow(fixtureModel);
      click(window, selectSelector(entry));
      const text = rowFor(window, entry).textContent ?? "";
      expect(text).toContain(
        "Fulfillment: evidence is still owed at this pin; nothing materializes until it passes.",
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
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          "2 would materialize directly, 1 vet-blocked and recorded as intent only, " +
          "0 with evidence still owed.",
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
          "1 with evidence still owed.",
      );
    });

    it("counts nothing when nothing is selected", () => {
      const window = studioWindow(model);
      const preview = reportPreview(window);
      expect(preview).toContain(
        "Fulfillment summary (governed projection, engine-evaluated): " +
          "0 would materialize directly, 0 vet-blocked and recorded as intent only, " +
          "0 with evidence still owed.",
      );
    });
  });

  it("never says cost anywhere on the surface, including the new fulfillment copy", () => {
    const html = policyStudioHtml(model);
    expect(html.toLowerCase()).not.toContain("cost");
    const window = studioWindow(model);
    click(window, selectSelector(passExample));
    click(window, selectSelector(blockedExample));
    const text = window.document.body?.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("cost");
  });

  it("adds no new row when a selection gains a fulfillment annotation (S1)", () => {
    // Both fixtures live in the same (ecc) framework, so this stays inside one
    // stable one-framework-at-a-time view (ruling 7 / F3, unrelated to this
    // row) rather than crossing the point where selecting a first component
    // hides the other framework's groups entirely - a real but orthogonal
    // dynamic that must not be mistaken for a row this change added.
    const window = studioWindow(model);
    click(window, selectSelector(passExample));
    const rowCountAfterFirstSelection = window.document.querySelectorAll(
      "#framework-rows .row[data-state]",
    ).length;
    expect(rowCountAfterFirstSelection).toBe(passExample.framework.assets.length);
    click(window, selectSelector(blockedExample));
    const rowCountAfterSecondSelection = window.document.querySelectorAll(
      "#framework-rows .row[data-state]",
    ).length;
    expect(rowCountAfterSecondSelection).toBe(rowCountAfterFirstSelection);
  });

  it("leaves the ticker's per-owner totals matching the DOM rows they count, unchanged by annotating (S2)", () => {
    // studio-hook-registrar.test.ts already pins that the ticker counts
    // exactly the DOM rows under each owner in general; this pins that the
    // invariant still holds once rows carry the new fulfillment note, so an
    // annotation is never miscounted as a second row under a different owner.
    const window = studioWindow(model);
    click(window, selectSelector(passExample));
    click(window, selectSelector(blockedExample));
    const document = window.document;
    for (const owner of ["AIH", "ECC", "Superpowers", "You"]) {
      const domRows = [...document.querySelectorAll(".grp[data-owner]")]
        .filter((group) => String(group.getAttribute("data-owner")).split(" ").includes(owner))
        .reduce((total, group) => total + group.querySelectorAll(".row[data-state]").length, 0);
      const button = document.querySelector(`#owner-ticker [data-owner-focus="${owner}"] b`);
      expect(Number(button?.textContent), `${owner} tally`).toBe(domRows);
    }
  });
});
