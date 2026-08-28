import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import { eccExternalMcpCatalog } from "../../src/org-policy/ecc-mcp-catalog.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

/** The three kinds `governance.externalCuration` accepts (schema.ts). */
const CURATION_KINDS = ["agent", "skill", "command"];

function allAssets() {
  return policyAuthoringCatalog().frameworks.flatMap((framework) => framework.assets);
}

function countByKind(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function loadStudio(window: Window, html: string): void {
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0 || scripts.some((script) => script === undefined)) {
    throw new Error("expected generated workbench script");
  }
  window.eval(scripts.join("\n"));
}

describe("policy authoring catalog inventory", () => {
  it("carries the source-locked ECC external MCP inventory outside AIH controls", () => {
    const model = policyStudioModel();
    expect(model.catalog.externalMcp).toEqual(eccExternalMcpCatalog);
    expect(model.catalog.externalMcp).toHaveLength(31);
    expect(
      model.catalog.externalMcp.every(
        (entry) => !("control" in entry) && !("server" in entry) && entry.owner === "ecc",
      ),
    ).toBe(true);
  });

  // The locked ownership boundary: an unrecognised item is annotated, never
  // removed. Dropping it hides inventory an administrator is accountable for.
  it("carries every pinned baseline component, dropping none", () => {
    for (const framework of policyAuthoringCatalog().frameworks) {
      const components = baselineCatalogById(framework.id).components.map((item) => item.id);
      expect(
        framework.assets.map((asset) => asset.id).sort(),
        `${framework.id} drops ${components.length - framework.assets.length} component(s)`,
      ).toStrictEqual([...components].sort());
    }
  });

  it("kinds the whole component-id namespace, not three prefixes", () => {
    const assets = allAssets();
    expect(assets.length).toBe(152);
    expect(countByKind(assets.map((asset) => asset.kind))).toStrictEqual({
      agent: 44,
      baseline: 6,
      capability: 15,
      framework: 11,
      lang: 15,
      mcp: 6,
      module: 26,
      runtime: 3,
      skill: 26,
    });
    for (const asset of assets) {
      expect(asset.kind).toBe(asset.id.slice(0, asset.id.indexOf(":")));
    }
  });

  // External curation is a policy-document grammar fixed at three kinds, not
  // this inventory's vocabulary. Widening the inventory must not widen it.
  it("keeps the external-curation vocabulary separate and unchanged", () => {
    const assets = allAssets();
    for (const asset of assets) {
      const expected = asset.id.startsWith("agent:")
        ? "agent"
        : asset.id.startsWith("skill:")
          ? "skill"
          : asset.id === "baseline:commands" || asset.id === "module:commands-core"
            ? "command"
            : undefined;
      expect(asset.curationKind, `curationKind for ${asset.id}`).toBe(expected);
    }
    const curatable = assets.filter((asset) => asset.curationKind !== undefined);
    expect(curatable.length).toBe(72);
    for (const asset of curatable) {
      expect(CURATION_KINDS).toContain(asset.curationKind);
    }
  });

  // `#curation-kind` is a three-option select, so prefilling it with a widened
  // kind would silently leave the previous value instead of failing.
  it("offers only curation-expressible assets in the generated prefill", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    const options = [...window.document.querySelectorAll("#curation-asset option")] as unknown as {
      value: string;
    }[];
    const values = options.map((option) => option.value).filter((value) => value !== "");
    expect(values.length).toBe(ecc?.assets.filter((asset) => asset.curationKind).length);
    for (const value of values) {
      expect(CURATION_KINDS).toContain(value.split("|")[0]);
    }
  });
});
