import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { ECC_DECLARATION_RIDERS } from "../../src/ecc/components.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
if (ecc === undefined) throw new Error("expected an ecc framework in the catalog");
const eccAssets = ecc.assets;
const present = new Set(ecc.assets.map((asset) => asset.id));
const declarer = ecc.assets.find((asset) => (asset.riders?.length ?? 0) > 0);
if (declarer === undefined) throw new Error("expected at least one asset that declares riders");
const blockedRelation = ecc.assets
  .filter((asset) => ["lang", "framework", "capability", "module"].includes(asset.kind))
  .flatMap((asset) =>
    (asset.riders ?? []).map((rider) => ({
      asset,
      rider: ecc.assets.find((candidate) => candidate.id === rider),
    })),
  )
  .find((relation) => relation.rider?.curationKind !== undefined);
const curatedRider = blockedRelation?.rider;
if (blockedRelation === undefined || curatedRider?.curationKind === undefined)
  throw new Error("expected a rail declaration with a curatable rider");
const curatedDeclarer = blockedRelation.asset;
const curatedRiderKind = curatedRider.curationKind;
const sharedRiderPair = ecc.assets.flatMap((asset) =>
  (asset.riders ?? []).flatMap((rider) =>
    ecc.assets
      .filter((other) => other.id !== asset.id && other.riders?.includes(rider))
      .map((other) => ({ asset, other, rider })),
  ),
)[0];
if (sharedRiderPair === undefined) throw new Error("expected declarations with a shared rider");

function studio(studioModel = model): Window {
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

function selectedIds(window: Window): string[] {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value).governance.externalSelections.flatMap(
    (group: { items: { id: string }[] }) => group.items.map((item) => item.id),
  );
}

function selectionRoots(window: Window): string[] {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value).governance.externalSelections[0]?.roots ?? [];
}

function assetClosure(rootIds: readonly string[]): string[] {
  const selected = new Set<string>();
  const expanded = new Set<string>();
  const pending = rootIds.map((id) => ({ id, includeMembers: true }));
  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) break;
    const expansionKey = `${next.id}|${next.includeMembers ? "members" : "structural"}`;
    if (expanded.has(expansionKey)) continue;
    expanded.add(expansionKey);
    selected.add(next.id);
    const asset = eccAssets.find((candidate) => candidate.id === next.id);
    if (asset === undefined) throw new Error(`expected ECC asset ${next.id}`);
    for (const required of [
      ...(asset.dependencies ?? []),
      ...(next.includeMembers ? (asset.members ?? []) : []),
      ...(asset.riders ?? []),
    ]) {
      selected.add(required);
      pending.push({ id: required, includeMembers: false });
    }
  }
  return [...selected];
}

function selectProfile(window: Window, value: string): void {
  const preset = window.document.getElementById("preset-select") as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (preset === null) throw new Error(`expected ${value} preset`);
  preset.value = value;
  preset.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function clickCanonical(window: Window, key: string): void {
  const node = [...window.document.querySelectorAll(`[data-framework-select="${key}"]`)].find(
    (candidate) => candidate.closest(".rail") === null,
  );
  if (node === undefined) throw new Error(`expected canonical ${key}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

async function settle(window: Window, done: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
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

  it("authors and reverses a rail declaration with its complete requirement closure", () => {
    const window = studio();
    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);
    expect(selectedIds(window).sort()).toEqual(assetClosure([declarer.id]).sort());
    expect(selectionRoots(window)).toEqual([declarer.id]);
    expect(
      window.document
        .querySelector(`[data-row="ecc / ${declarer.kind}: ${declarer.id}"]`)
        ?.getAttribute("data-state"),
    ).toBe("requested");
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `${assetClosure([declarer.id]).length - 1} required component`,
    );

    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);
    expect(selectedIds(window)).toEqual([]);
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `removed ${assetClosure([declarer.id]).length} dependency-closed component`,
    );
  });

  it("retains a rider while another selected declaration still requires it", () => {
    const window = studio();
    click(
      window,
      `[data-framework-select="ecc|${sharedRiderPair.asset.kind}|${sharedRiderPair.asset.id}"]`,
    );
    click(
      window,
      `[data-framework-select="ecc|${sharedRiderPair.other.kind}|${sharedRiderPair.other.id}"]`,
    );
    click(
      window,
      `[data-framework-select="ecc|${sharedRiderPair.asset.kind}|${sharedRiderPair.asset.id}"]`,
    );

    expect(selectedIds(window)).not.toContain(sharedRiderPair.asset.id);
    expect(selectedIds(window)).toContain(sharedRiderPair.other.id);
    expect(selectedIds(window)).toContain(sharedRiderPair.rider);
  });

  it("retains a rider that the administrator selected independently", () => {
    const window = studio();
    const rider = declarer.riders?.[0];
    if (rider === undefined) throw new Error("expected a declared rider");
    const riderAsset = ecc.assets.find((asset) => asset.id === rider);
    if (riderAsset === undefined) throw new Error(`expected rider asset ${rider}`);

    click(window, `[data-framework-select="ecc|${riderAsset.kind}|${riderAsset.id}"]`);
    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);
    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);

    expect(selectedIds(window)).toEqual([riderAsset.id]);
  });

  it("removes an independently selected rider and every dependent root from the center", () => {
    const window = studio();
    const rider = declarer.riders?.[0];
    if (rider === undefined) throw new Error("expected a declared rider");
    const riderAsset = ecc.assets.find((asset) => asset.id === rider);
    if (riderAsset === undefined) throw new Error(`expected rider asset ${rider}`);

    click(window, `[data-framework-select="ecc|${riderAsset.kind}|${riderAsset.id}"]`);
    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);
    clickCanonical(window, `ecc|${riderAsset.kind}|${riderAsset.id}`);

    expect(selectedIds(window)).toEqual([]);
    expect(selectionRoots(window)).toEqual([]);
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `Center deselected ${riderAsset.id}; removed 2 dependent root(s)`,
    );
  });

  it("lets the center remove a rider by pruning every declaration that requires it", () => {
    const window = studio();
    const rider = declarer.riders?.[0];
    if (rider === undefined) throw new Error("expected a declared rider");
    const riderAsset = ecc.assets.find((asset) => asset.id === rider);
    if (riderAsset === undefined) throw new Error(`expected rider asset ${rider}`);
    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);

    clickCanonical(window, `ecc|${riderAsset.kind}|${riderAsset.id}`);

    expect(selectedIds(window)).toEqual([]);
    expect(selectionRoots(window)).toEqual([]);
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `Center deselected ${riderAsset.id}; removed 1 dependent root(s) (${declarer.id})`,
    );
  });

  it("uses persisted roots to remove an imported declaration and its derived closure", async () => {
    const authored = studio();
    click(authored, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);
    const authoredPreview = authored.document.getElementById("config-preview") as unknown as {
      value: string;
    } | null;
    if (authoredPreview === null) throw new Error("expected authored policy preview");
    const importedPolicy = JSON.parse(authoredPreview.value);

    const window = studio();
    const policyFile = window.document.getElementById("policy-file");
    if (policyFile === null) throw new Error("expected policy file input");
    Object.defineProperty(policyFile, "files", {
      configurable: true,
      value: [
        new window.File([JSON.stringify(importedPolicy)], "policy.json", {
          type: "application/json",
        }),
      ],
    });
    policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle(window, () =>
      (window.document.getElementById("announcement")?.textContent ?? "").includes(
        "without transformation",
      ),
    );

    click(window, `[data-framework-select="ecc|${declarer.kind}|${declarer.id}"]`);

    expect(selectedIds(window)).toEqual([]);
  });

  it("rolls back a declaration and preset when a required rider carries curation", () => {
    const blockedModel = structuredClone(model);
    blockedModel.initialPolicy.governance?.externalCuration.push({
      framework: "ecc",
      items: [
        {
          kind: curatedRiderKind,
          id: curatedRider.id,
          source: { ...curatedRider.source },
          audit: { record: "audit-blocked-rider", digest: `sha256:${"a".repeat(64)}` },
        },
      ],
    });
    const window = studio(blockedModel);
    const before = selectedIds(window);

    click(window, `[data-framework-select="ecc|${curatedDeclarer.kind}|${curatedDeclarer.id}"]`);

    expect(selectedIds(window)).toEqual(before);
    expect(
      (window.document.getElementById("preset-select") as unknown as { value: string }).value,
    ).toBe("custom");
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `Selection blocked: required component ${curatedRider.id}`,
    );
  });

  it("makes a broken preset visibly custom and warns when ECC Core is incomplete", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    const core = model.catalog.enterpriseComposition.parts
      .filter((part) => part.selection === "composed")
      .flatMap((part) => part.componentIds);
    const removed = core[0];
    if (removed === undefined) throw new Error("expected an ECC Core component");
    const asset = ecc.assets.find((item) => item.id === removed);
    if (asset === undefined) throw new Error(`expected catalog asset ${removed}`);

    click(window, `[data-framework-select="ecc|${asset.kind}|${asset.id}"]`);

    expect(
      (window.document.getElementById("preset-select") as unknown as { value: string }).value,
    ).toBe("custom");
    expect(window.document.getElementById("rail-composition-note")?.textContent).toContain(
      "ECC Core incomplete",
    );
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "no longer matches the Enterprise preset",
    );
  });

  it("states when removing a Vibe root leaves its component required by another root", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const removed = "module:hooks-runtime";
    const asset = ecc.assets.find((item) => item.id === removed);
    if (asset === undefined) throw new Error(`expected catalog asset ${removed}`);

    click(window, `[data-framework-select="ecc|${asset.kind}|${asset.id}"]`);

    expect(selectedIds(window)).toContain(removed);
    expect(selectionRoots(window)).not.toContain(removed);
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "component remains selected because baseline:hooks requires it",
    );
  });

  it("describes Vibe as one-framework composition rather than every catalog component", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const copy = window.document.querySelector("#presets .tooltip")?.textContent ?? "";
    expect(copy).toContain("active framework");
    expect(copy).not.toContain("every catalog component");
  });

  it("keeps the live announcement from intercepting toolbar actions", () => {
    const style = policyStudioHtml(model).match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? "";
    expect(style).toMatch(/\.announce\{[^}]*pointer-events:none/);
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
    expect(detail).toContain("Selecting it authors these declared riders in the same change");
    expect(detail).not.toContain("does not pull them in on its own");
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
    selectProfile(window, "enterprise");
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
