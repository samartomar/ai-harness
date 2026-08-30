import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { POLICY_AUTHORING_ASSET_KINDS } from "../../src/org-policy/catalog.js";
import { resolveEffectiveOrgPolicy } from "../../src/org-policy/effective.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import {
  defaultStudioPolicy,
  parseStudioPolicyImport,
  policyStudioModel,
} from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const assets = model.catalog.frameworks.flatMap((framework) =>
  framework.assets.map((asset) => ({ framework, asset })),
);
const mainAssets = assets;
type InventoryEntry = (typeof assets)[number];

/**
 * A component with no external-curation grammar. Selecting one is the whole
 * point of the corrected model: the acceptance contract says absence of AIH
 * enforcement is a label, not a disabled authoring experience, and these are
 * the 79 the surface previously called `No next action`.
 */
const uncuratable = mainAssets.find(({ asset }) => asset.curationKind === undefined);
const curatable = mainAssets.find(({ asset }) => asset.curationKind !== undefined);
if (uncuratable === undefined || curatable === undefined)
  throw new Error("expected the pinned catalogs to carry both curatable and uncuratable assets");

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(model);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

interface SelectionGroup {
  framework: string;
  roots?: string[];
  items: Array<{ kind: string; id: string; source: Record<string, string> }>;
}

/** The authored policy exactly as the surface shows it, not internal state. */
function authoredPolicy(window: Window): {
  governance: { externalSelections: SelectionGroup[]; externalCuration: unknown[] };
} {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value);
}

function selectionsFor(window: Window, framework: string): SelectionGroup["items"] {
  const group = authoredPolicy(window).governance.externalSelections.find(
    (item) => item.framework === framework,
  );
  return group?.items ?? [];
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function selector(entry: InventoryEntry): string {
  return `[data-framework-select="${entry.framework.id}|${entry.asset.kind}|${entry.asset.id}"]`;
}

function inventoryRows(window: Window): Array<{
  textContent: string | null;
  querySelector(selector: string): { textContent: string | null } | null;
}> {
  return [
    ...window.document.querySelectorAll(
      "#framework-rows .row, #ecc-skill-rows .row, #ecc-mcp-declaration-rows .row",
    ),
  ].filter((row) => row.querySelector("[data-framework-select]") !== null) as unknown as Array<{
    textContent: string | null;
    querySelector(selector: string): { textContent: string | null } | null;
  }>;
}

describe("policy studio framework selection", () => {
  // Acceptance contract item 5: selecting an item records requested intent, and
  // absence of AIH enforcement is a label, never a disabled authoring
  // experience. Every one of these rows was previously unselectable and
  // labelled `Unsupported`, which is a word reserved for a failing AIH gate.
  it("offers every framework-owned component as a selectable row", () => {
    const window = studio();
    const rows = inventoryRows(window);
    expect(rows.length).toBe(mainAssets.length);
    for (const row of rows) {
      const status = row.querySelector(".badge")?.textContent ?? "";
      expect(status, `status for ${row.textContent?.slice(0, 60)}`).not.toContain("Unsupported");
      expect(
        row.querySelector("[data-framework-select]"),
        `select control for ${row.textContent?.slice(0, 60)}`,
      ).not.toBeNull();
    }
  });

  it("leaves no row without a next action", () => {
    expect(
      inventoryRows(studio())
        .map((row) => row.textContent)
        .join(" "),
    ).not.toContain("No next action");
  });

  // The strongest case for the model: a kind the external-curation grammar
  // cannot express is still selectable, because recording intent and holding
  // evidence are separate axes.
  it("records requested intent with the component's pinned provenance", () => {
    const window = studio();
    click(window, selector(uncuratable));
    expect(selectionsFor(window, uncuratable.framework.id)).toContainEqual({
      kind: uncuratable.asset.kind,
      id: uncuratable.asset.id,
      source: { ...uncuratable.asset.source },
    });
  });

  it("shows the selected row as selected and keeps the policy schema-valid", () => {
    const window = studio();
    click(window, selector(curatable));
    const row = inventoryRows(window).find((item) =>
      (item.textContent ?? "").includes(curatable.asset.id),
    );
    expect(row?.querySelector(".badge")?.textContent ?? "").toContain("Selected");
    expect(() => parseOrgPolicy(authoredPolicy(window))).not.toThrow();
  });

  // Contract item 6: selection is stateful and reversible from the same mental
  // model, and the export round-trips both the addition and the removal.
  it("deselects from the same row and drops it from the export", () => {
    const window = studio();
    click(window, selector(uncuratable));
    expect(selectionsFor(window, uncuratable.framework.id)).toHaveLength(1);
    click(window, selector(uncuratable));
    expect(selectionsFor(window, uncuratable.framework.id)).toHaveLength(0);
  });

  it("round-trips selections through the product import grammar", () => {
    const window = studio();
    click(window, selector(uncuratable));
    click(window, selector(curatable));
    const exported = JSON.stringify(authoredPolicy(window));
    const reimported = parseStudioPolicyImport(exported);
    expect(reimported.governance?.externalSelections).toEqual(
      authoredPolicy(window).governance.externalSelections,
    );
  });

  // Row 16's ruling: a next action must be a command the product can actually
  // run. `aih evidence vet-baseline` takes an owner/repo source, a 40-character
  // pin, a catalog id and component ids — every argument comes off this row.
  it("derives an evidence command from the row's own source, pin and catalog", () => {
    const window = studio();
    const container = window.document.getElementById("framework-rows");
    const text = container?.textContent ?? "";
    for (const { framework, asset } of [uncuratable, curatable]) {
      expect(text).toContain(
        `aih evidence vet-baseline ${framework.repository} --pin ${framework.commit} --catalog ${framework.id} --components ${asset.id} --apply`,
      );
    }
  });

  it("surfaces selections to the engine as requested intent that is not effective", () => {
    const policy = defaultStudioPolicy();
    const governance = policy.governance;
    if (governance === undefined) throw new Error("expected default studio governance");
    const resolved = resolveEffectiveOrgPolicy(
      parseOrgPolicy({
        ...policy,
        governance: {
          supportedClis: ["claude"],
          ...governance,
          externalSelections: [
            {
              framework: uncuratable.framework.id,
              roots: [uncuratable.asset.id],
              items: [
                {
                  kind: uncuratable.asset.kind,
                  id: uncuratable.asset.id,
                  source: { ...uncuratable.asset.source },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(resolved.externalSelections).toEqual([
      {
        framework: uncuratable.framework.id,
        roots: [uncuratable.asset.id],
        items: [
          {
            kind: uncuratable.asset.kind,
            id: uncuratable.asset.id,
            source: { ...uncuratable.asset.source },
          },
        ],
        status: "requested-evidence-needed",
      },
    ]);
    expect(resolved.candidates).toHaveLength(0);
    expect(resolved.blocking).toBe(false);
  });

  it("rejects an explicit selection root that is absent from the dependency closure", () => {
    const policy = defaultStudioPolicy();
    const governance = policy.governance;
    if (governance === undefined) throw new Error("expected default studio governance");
    expect(() =>
      parseOrgPolicy({
        ...policy,
        governance: {
          supportedClis: ["claude"],
          ...governance,
          externalSelections: [
            {
              framework: uncuratable.framework.id,
              roots: ["lang:not-in-items"],
              items: [
                {
                  kind: uncuratable.asset.kind,
                  id: uncuratable.asset.id,
                  source: { ...uncuratable.asset.source },
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(/selection root lang:not-in-items is not present in items/i);
  });

  // The grammar defaults this array, so a policy document written before it
  // existed is still valid and must import as "no selections" rather than as a
  // missing field the surface then reads off undefined.
  it("treats a document that omits the array as having no selections", () => {
    const policy = defaultStudioPolicy();
    const governance = policy.governance;
    if (governance === undefined) throw new Error("expected default studio governance");
    const { externalSelections: _omitted, ...withoutSelections } = governance;
    const reimported = parseStudioPolicyImport(
      JSON.stringify({ ...policy, governance: withoutSelections }),
    );
    expect(reimported.governance?.externalSelections).toEqual([]);
  });

  // The persisted grammar duplicates the inventory's kinds, the way schema.ts
  // already duplicates the danger-code enum. Pin them together so the two
  // copies cannot drift apart.
  it("persists exactly the inventory's own kind vocabulary", () => {
    const policy = defaultStudioPolicy();
    const governance = policy.governance;
    if (governance === undefined) throw new Error("expected default studio governance");
    for (const kind of POLICY_AUTHORING_ASSET_KINDS) {
      const authored = {
        ...policy,
        governance: {
          supportedClis: ["claude"],
          ...governance,
          externalSelections: [
            {
              framework: "ecc",
              items: [{ kind, id: `${kind}:probe`, source: { ...uncuratable.asset.source } }],
            },
          ],
        },
      };
      expect(() => parseOrgPolicy(authored), `kind ${kind}`).not.toThrow();
    }
  });

  // Selection and curation are two stages of one thing. A component sitting in
  // both is ambiguous about whether its evidence exists, so the grammar fails
  // closed rather than letting a surface guess.
  it("rejects a component recorded as both a selection and a curation item", () => {
    const policy = defaultStudioPolicy();
    const governance = policy.governance;
    if (governance === undefined) throw new Error("expected default studio governance");
    expect(() =>
      parseOrgPolicy({
        ...policy,
        governance: {
          supportedClis: ["claude"],
          ...governance,
          externalSelections: [
            {
              framework: "ecc",
              items: [
                {
                  kind: curatable.asset.kind,
                  id: curatable.asset.id,
                  source: { ...curatable.asset.source },
                },
              ],
            },
          ],
          externalCuration: [
            {
              framework: "ecc",
              items: [
                {
                  kind: curatable.asset.curationKind,
                  id: curatable.asset.id,
                  source: { ...curatable.asset.source },
                  audit: { record: "audit-1", digest: `sha256:${"a".repeat(64)}` },
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(/both a selection and a curation item|selection and curation/i);
  });
});
