import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { ECC_DECLARATION_RIDERS } from "../../src/ecc/components.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
if (ecc === undefined) throw new Error("expected an ecc framework in the catalog");
const present = new Set(ecc.assets.map((asset) => asset.id));
const declarer = ecc.assets.find((asset) => (asset.riders?.length ?? 0) > 0);
if (declarer === undefined) throw new Error("expected at least one asset that declares riders");

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

function selectedIds(window: Window): string[] {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value).governance.externalSelections.flatMap(
    (group: { items: { id: string }[] }) => group.items.map((item) => item.id),
  );
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

describe("policy studio component relations", () => {
  // ECC declares that picking a language brings agents with it. That relation
  // existed only inside a non-exported constant, so the surface could not state
  // it and an administrator met the extra components after the fact.
  it("carries ECC's declaration riders into the authoring catalog", () => {
    for (const [id, riders] of Object.entries(ECC_DECLARATION_RIDERS)) {
      const asset = ecc.assets.find((item) => item.id === id);
      if (asset === undefined) continue;
      const usable = riders.filter((rider) => present.has(rider));
      expect(asset.riders ?? [], id).toEqual(usable.length ? usable : (asset.riders ?? []));
    }
    const typescript = ecc.assets.find((asset) => asset.id === "lang:typescript");
    expect(typescript?.riders).toContain("agent:typescript-reviewer");
  });

  // A relation pointing at a component the pinned catalog does not carry is a
  // claim the inventory denies.
  it("never names a rider the pinned catalog does not contain", () => {
    for (const asset of ecc.assets)
      for (const rider of asset.riders ?? [])
        expect(present.has(rider), `${asset.id} -> ${rider}`).toBe(true);
  });

  it("authors and reverses a rail declaration with its exact declared riders", () => {
    const window = studio();
    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);
    expect(selectedIds(window).sort()).toEqual([declarer.id, ...(declarer.riders ?? [])].sort());
    expect(
      window.document.querySelector(`[data-row="ecc / ${declarer.kind}: ${declarer.id}"]`),
    ).toBeNull();
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `${declarer.riders?.length ?? 0} declared rider`,
    );

    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);
    expect(selectedIds(window)).toEqual([]);
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "General ECC skills and modules are independent and unchanged",
    );
  });

  it("makes a broken preset visibly custom and warns when ECC Core is incomplete", () => {
    const window = studio();
    click(window, '[data-preset="enterprise"]');
    const core = model.catalog.enterpriseComposition.parts
      .filter((part) => part.selection === "composed")
      .flatMap((part) => part.componentIds);
    const removed = core[0];
    if (removed === undefined) throw new Error("expected an ECC Core component");
    const asset = ecc.assets.find((item) => item.id === removed);
    if (asset === undefined) throw new Error(`expected catalog asset ${removed}`);

    click(window, `[data-framework-select="ecc|${asset.kind}|${asset.id}"]`);

    expect(
      window.document.querySelector('[data-preset="custom"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(window.document.getElementById("rail-composition-note")?.textContent).toContain(
      "ECC Core incomplete",
    );
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "no longer matches the Enterprise preset",
    );
  });

  it("shows rail-owned rider facts through search without exposing mutation", () => {
    const window = studio();
    click(window, "#seek");
    const query = window.document.getElementById("spot-q") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    } | null;
    if (query === null) throw new Error("expected search input");
    query.value = declarer.id;
    query.dispatchEvent(new window.Event("input", { bubbles: true }));
    click(window, "#hits .hit");
    const detail = window.document.getElementById("drawer-detail")?.textContent ?? "";
    for (const rider of declarer.riders ?? []) expect(detail).toContain(rider);
    expect(window.document.querySelector("#drawer-detail [data-add-riders]")).toBeNull();
    expect(window.document.querySelector("#drawer-detail [data-framework-select]")).toBeNull();
  });

  // AIH knows eleven CLIs and a policy can target two. Showing only the two
  // leaves an administrator unable to tell unknown from unprojectable.
  it("lists every host AIH knows and marks the policy-targetable ones", () => {
    expect(model.catalog.hosts.length).toBeGreaterThanOrEqual(11);
    const ids = model.catalog.hosts.map((host) => host.id);
    for (const cli of ["claude", "codex", "cursor", "kimi", "kiro", "opencode"])
      expect(ids, cli).toContain(cli);
    expect(
      model.catalog.hosts
        .filter((host) => host.policyTarget)
        .map((host) => host.id)
        .sort(),
    ).toEqual(["claude", "codex", "kiro"]);
    const window = studio();
    const rail = window.document.getElementById("rail-hosts")?.textContent ?? "";
    for (const cli of ids) expect(rail, cli).toContain(cli);
    const note = window.document.getElementById("rail-host-note")?.textContent ?? "";
    expect(note).toContain("claude and codex");
  });

  it("authors sanctioned CLIs independently of policy activation targets", () => {
    const window = studio();
    click(window, `[data-sanctioned-cli="kiro"]`);
    click(window, `[data-sanctioned-cli="codex"]`);
    const preview = window.document.getElementById("config-preview") as unknown as {
      value: string;
    } | null;
    if (preview === null) throw new Error("expected authored policy preview");
    const policy = JSON.parse(preview.value);
    expect(policy.governance.supportedClis.sort()).toEqual(["codex", "kiro"]);
    expect(policy.governance.activations).toEqual([]);
    expect(window.document.getElementById("rail-host-note")?.textContent).toContain("2 sanctioned");
    click(window, `[data-sanctioned-cli="kiro"]`);
    expect(JSON.parse(preview.value).governance.supportedClis).toEqual(["codex"]);
    expect(
      window.document.querySelector('[data-sanctioned-cli="kiro"]')?.getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("makes the Enterprise preset write an explicit all-registry allow-list", () => {
    const window = studio();
    click(window, '[data-preset="enterprise"]');
    const preview = window.document.getElementById("config-preview") as unknown as {
      value: string;
    } | null;
    if (preview === null) throw new Error("expected authored policy preview");
    const policy = JSON.parse(preview.value);
    expect(policy.minimumPosture).toBe("enterprise");
    expect(policy.governance.supportedClis).toEqual(model.catalog.hosts.map((host) => host.id));
  });

  it("gives every inventory row a hover description", () => {
    const window = studio();
    const rows = [...window.document.querySelectorAll("#framework-rows .row .rid")];
    expect(rows.length).toBeGreaterThan(0);
    for (const rid of rows) {
      const title = rid.getAttribute("title") ?? "";
      expect(title.length, rid.getAttribute("aria-label") ?? "").toBeGreaterThan(20);
    }
  });
});
