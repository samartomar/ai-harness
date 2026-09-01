import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { type EccComponentId, UPSTREAM_CORE_ECC_MODULE_IDS } from "../../src/ecc/components.js";
import { eccModuleDependencyIds } from "../../src/ecc/evidence.js";
import { eccComponentInstallDescriptor } from "../../src/ecc/materialize.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { type PolicyStudioModel, policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const openWindows = new Set<Window>();
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
if (ecc === undefined) throw new Error("expected an ECC framework");

afterEach(async () => {
  await Promise.all([...openWindows].map((window) => window.happyDOM.close()));
  openWindows.clear();
});

function studio(studioModel: PolicyStudioModel = model): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(studioModel);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  openWindows.add(window);
  return window;
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

function selectedIds(window: Window): string[] {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected policy preview");
  const policy = JSON.parse(preview.value) as {
    governance: { externalSelections: Array<{ items: Array<{ id: string }> }> };
  };
  return policy.governance.externalSelections.flatMap((group) =>
    group.items.map((item) => item.id),
  );
}

function selectionRoots(window: Window): string[] | undefined {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected policy preview");
  const policy = JSON.parse(preview.value) as {
    governance: { externalSelections: Array<{ roots?: string[] }> };
  };
  return policy.governance.externalSelections[0]?.roots;
}

function legacyAssetClosure(rootIds: readonly string[]): string[] {
  const selected = new Set(rootIds);
  const pending = [...rootIds];
  while (pending.length > 0) {
    const id = pending.shift();
    const asset = ecc?.assets.find((candidate) => candidate.id === id);
    if (asset === undefined) throw new Error(`expected ECC asset ${id}`);
    const members = (asset as typeof asset & { members?: string[] }).members ?? [];
    for (const required of [...(asset.dependencies ?? []), ...members, ...(asset.riders ?? [])]) {
      if (selected.has(required)) continue;
      selected.add(required);
      pending.push(required);
    }
  }
  return [...selected];
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
    const asset = ecc?.assets.find((candidate) => candidate.id === next.id);
    if (asset === undefined) throw new Error(`expected ECC asset ${next.id}`);
    const members = next.includeMembers
      ? ((asset as typeof asset & { members?: string[] }).members ?? [])
      : [];
    for (const required of [...(asset.dependencies ?? []), ...members, ...(asset.riders ?? [])]) {
      selected.add(required);
      pending.push({ id: required, includeMembers: false });
    }
  }
  return [...selected];
}

describe("policy studio dependency-closed selection", () => {
  it("maps an ECC module to its selectable Skill, Agent, and baseline members", () => {
    const module = ecc.assets.find((asset) => asset.id === "module:agents-core");
    if (module === undefined) throw new Error("expected module:agents-core");
    const expectedMembers = ecc.assets
      .filter((asset) => ["agent", "baseline", "skill"].includes(asset.kind))
      .filter(
        (asset) =>
          eccComponentInstallDescriptor(asset.id as EccComponentId).containingModuleId ===
          "agents-core",
      )
      .map((asset) => asset.id);
    expect(expectedMembers.length).toBeGreaterThan(10);
    expect((module as typeof module & { members?: string[] }).members?.sort()).toEqual(
      expectedMembers.sort(),
    );

    const window = studio();
    click(window, `.rail [data-framework-select="ecc|module|${module.id}"]`);
    expect(selectedIds(window).sort()).toEqual(assetClosure([module.id]).sort());
    for (const member of expectedMembers) {
      const memberAsset = ecc.assets.find((asset) => asset.id === member);
      if (memberAsset === undefined) throw new Error(`expected ${member}`);
      expect(
        window.document
          .querySelector(`[data-framework-select="ecc|${memberAsset.kind}|${member}"]`)
          ?.getAttribute("aria-pressed"),
        `${member} is selected from the left-panel module choice`,
      ).toBe("true");
    }
    window.close();
  });

  it("never turns module membership into MCP activation or another semantic choice", () => {
    const moduleAssets = ecc.assets.filter((asset) => asset.kind === "module");
    for (const module of moduleAssets) {
      const members = module.members ?? [];
      for (const id of members) {
        const member = ecc.assets.find((asset) => asset.id === id);
        expect(member, `${module.id} carries ${id}`).toBeDefined();
        expect(["agent", "baseline", "skill"], `${module.id} -> ${id}`).toContain(member?.kind);
      }
    }
    expect(moduleAssets.flatMap((module) => module.members ?? [])).not.toContain("mcp:github");
  });

  it("selects only the TypeScript rider and structural ECC Core dependencies", () => {
    const language = ecc.assets.find((asset) => asset.id === "lang:typescript");
    if (language === undefined) throw new Error("expected lang:typescript");
    const coreModules = UPSTREAM_CORE_ECC_MODULE_IDS.map((id) => `module:${id}`);
    expect(language.dependencies).toEqual(expect.arrayContaining(coreModules));

    const window = studio();
    click(window, `.rail [data-framework-select="ecc|lang|${language.id}"]`);

    const expected = assetClosure([language.id]).sort();
    expect(selectedIds(window).sort()).toEqual(expected);
    expect(
      selectedIds(window)
        .filter((id) => id.startsWith("agent:"))
        .sort(),
    ).toEqual(["agent:typescript-reviewer"]);
    for (const id of expected) {
      const asset = ecc.assets.find((candidate) => candidate.id === id);
      if (asset === undefined) throw new Error(`expected ${id}`);
      expect(
        window.document
          .querySelector(`[data-framework-select="ecc|${asset.kind}|${id}"]`)
          ?.getAttribute("aria-pressed"),
        `${id} is selected in the canonical inventory`,
      ).toBe("true");
    }
    window.close();
  });

  it("exports TypeScript and Python as explicit roots distinct from their dependency closure", () => {
    const window = studio();
    click(window, '.rail [data-framework-select="ecc|lang|lang:typescript"]');
    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');

    expect(selectionRoots(window)).toEqual(["lang:typescript", "lang:python"]);
    expect(selectedIds(window)).toEqual(
      expect.arrayContaining([
        "lang:typescript",
        "lang:python",
        "agent:typescript-reviewer",
        "agent:python-reviewer",
        "module:rules-core",
        "module:agents-core",
        "module:commands-core",
        "module:hooks-runtime",
      ]),
    );
    expect(selectionRoots(window)).not.toContain("agent:typescript-reviewer");
    expect(selectionRoots(window)).not.toContain("module:rules-core");
    window.close();
  });

  it("removes a selected root even when its closure contains a mutual module member", () => {
    const window = studio();

    click(window, '[data-framework-select="ecc|module|module:hooks-runtime"]');
    expect(selectionRoots(window)).toEqual(["module:hooks-runtime"]);
    expect(selectedIds(window)).toEqual(
      expect.arrayContaining(["module:hooks-runtime", "baseline:hooks"]),
    );

    click(window, '[data-framework-select="ecc|module|module:hooks-runtime"]');
    expect(selectedIds(window)).toEqual([]);
    window.close();
  });

  it("keeps rootless legacy selections without promoting them to explicit roots", () => {
    const partialModel = structuredClone(model);
    const legacyIds = legacyAssetClosure(["lang:typescript"]);
    const legacyItems = legacyIds.map((id) => {
      const asset = ecc.assets.find((candidate) => candidate.id === id);
      if (asset === undefined) throw new Error(`expected ECC asset ${id}`);
      return { kind: asset.kind, id: asset.id, source: { ...asset.source } };
    });
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      items: legacyItems,
    });
    const window = studio(partialModel);

    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');
    expect(selectionRoots(window)).toEqual(["lang:python"]);

    const preview = window.document.getElementById("config-preview") as unknown as {
      value: string;
    } | null;
    if (preview === null) throw new Error("expected policy preview");
    const editedPolicy = parseOrgPolicy(JSON.parse(preview.value));
    expect(editedPolicy.governance?.externalSelections[0]?.unattributedItems?.sort()).toEqual(
      legacyIds.toSorted(),
    );
    window.close();

    const reopenedModel = structuredClone(model);
    reopenedModel.initialPolicy = editedPolicy;
    const reopened = studio(reopenedModel);

    click(reopened, '.rail [data-framework-select="ecc|lang|lang:python"]');
    expect(selectedIds(reopened).sort()).toEqual(legacyIds.sort());
    expect(selectionRoots(reopened)).toEqual([]);
    reopened.close();
  });

  it("rejects a stray attributed module that is not reachable from any root", () => {
    const partialModel = structuredClone(model);
    const module = ecc.assets.find((asset) => asset.id === "module:agents-core");
    if (module === undefined) throw new Error("expected module:agents-core");
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      roots: [],
      items: [{ kind: module.kind, id: module.id, source: { ...module.source } }],
    });
    const window = studio(partialModel);

    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /module:agents-core.*not reachable from an explicit root or preserved legacy item/i,
    );
    window.close();
  });

  it("rejects a selection whose kind contradicts the pinned Workbench asset", () => {
    const partialModel = structuredClone(model);
    const module = ecc.assets.find((asset) => asset.id === "module:agents-core");
    if (module === undefined) throw new Error("expected module:agents-core");
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      roots: [module.id],
      items: [{ kind: "skill", id: module.id, source: { ...module.source } }],
    });
    const window = studio(partialModel);

    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation failed.*module:agents-core.*kind skill.*pinned kind is module/i,
    );
    window.close();
  });

  it("rejects a selection whose source tuple does not match the pinned Workbench asset", () => {
    const partialModel = structuredClone(model);
    const module = ecc.assets.find((asset) => asset.id === "module:agents-core");
    if (module === undefined) throw new Error("expected module:agents-core");
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      roots: [module.id],
      items: [
        {
          kind: module.kind,
          id: module.id,
          source: { ...module.source, path: "skills/not-the-agents-core-source" },
        },
      ],
    });
    const window = studio(partialModel);

    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation failed.*module:agents-core.*source path.*pinned source paths/i,
    );
    window.close();
  });

  it("accepts an exact non-primary path from a multi-path Workbench asset", () => {
    const partialModel = structuredClone(model);
    const module = ecc.assets.find((asset) => asset.id === "module:platform-configs");
    const alternatePath = module?.sourcePaths[1];
    if (module === undefined || alternatePath === undefined) {
      throw new Error("expected multi-path module:platform-configs");
    }
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      roots: [module.id],
      items: [
        {
          kind: module.kind,
          id: module.id,
          source: { ...module.source, path: alternatePath },
        },
      ],
    });
    const window = studio(partialModel);

    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation passed/i,
    );
    window.close();
  });

  it("rejects a parent directory that is not an exact Workbench source path", () => {
    const partialModel = structuredClone(model);
    const rootId = "module:database";
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      roots: [rootId],
      items: assetClosure([rootId]).map((id) => {
        const asset = ecc.assets.find((candidate) => candidate.id === id);
        if (asset === undefined) throw new Error(`expected ${id}`);
        return {
          kind: asset.kind,
          id,
          source: { ...asset.source, ...(id === rootId ? { path: "skills" } : {}) },
        };
      }),
    });
    const window = studio(partialModel);

    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation failed.*module:database.*source path.*pinned source paths/i,
    );
    window.close();
  });

  it("attributes imported rootless closure before honoring a center suggestion override", () => {
    const partialModel = structuredClone(model);
    const legacyIds = legacyAssetClosure(["capability:database"]);
    const legacyItems = legacyIds.map((id) => {
      const asset = ecc.assets.find((candidate) => candidate.id === id);
      if (asset === undefined) throw new Error(`expected ECC asset ${id}`);
      return { kind: asset.kind, id: asset.id, source: { ...asset.source } };
    });
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      items: legacyItems,
    });
    const window = studio(partialModel);

    clickCanonical(window, "ecc|agent|agent:database-reviewer");

    expect(selectedIds(window)).not.toContain("agent:database-reviewer");
    expect(selectedIds(window)).toContain("capability:database");
    expect(selectionRoots(window)).toEqual(["capability:database"]);
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /center deselected agent:database-reviewer.*rootless intent was attributed/i,
    );
    click(window, "#validate");
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation passed/i,
    );
    window.close();
  });

  it("attributes a cyclic rootless module closure before a center removal", () => {
    const partialModel = structuredClone(model);
    const cycleItems = ["module:hooks-runtime", "baseline:hooks"].map((id) => {
      const asset = ecc.assets.find((candidate) => candidate.id === id);
      if (asset === undefined) throw new Error(`expected ECC asset ${id}`);
      return { kind: asset.kind, id: asset.id, source: { ...asset.source } };
    });
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      items: cycleItems,
    });
    const window = studio(partialModel);

    clickCanonical(window, "ecc|baseline|baseline:hooks");

    expect(selectedIds(window)).toEqual(["module:hooks-runtime"]);
    expect(selectionRoots(window)).toEqual(["module:hooks-runtime"]);
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /center deselected baseline:hooks.*rootless intent was attributed/i,
    );
    click(window, "#validate");
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation passed/i,
    );
    window.close();
  });

  it("carries the pinned transitive dependency closure on every ECC module", () => {
    const moduleAssets = ecc.assets.filter((asset) => asset.kind === "module");
    expect(moduleAssets.length).toBeGreaterThan(0);
    for (const asset of moduleAssets) {
      const moduleId = asset.id.slice("module:".length);
      expect(asset.dependencies ?? [], asset.id).toEqual(
        eccModuleDependencyIds(moduleId).map((id) => `module:${id}`),
      );
    }
  });

  it("makes a whole-module semantic component visibly require its containing module", () => {
    const asset = ecc.assets.find(
      (candidate) =>
        candidate.kind !== "module" &&
        candidate.dependencies?.some((dependency) => dependency.startsWith("module:")),
    );
    if (asset === undefined) throw new Error("expected a semantic whole-module ECC component");

    const window = studio();
    click(window, `[data-framework-select="ecc|${asset.kind}|${asset.id}"]`);

    expect(selectedIds(window).sort()).toEqual(assetClosure([asset.id]).sort());
    for (const dependency of asset.dependencies ?? []) {
      expect(
        window.document
          .querySelector(`[data-framework-select="ecc|module|${dependency}"]`)
          ?.getAttribute("aria-pressed"),
        `${dependency} is visibly selected with ${asset.id}`,
      ).toBe("true");
    }
    window.close();
  });

  it("selects and visibly checks every transitive module dependency in one change", () => {
    const window = studio();
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) >= 3,
    );
    if (module === undefined)
      throw new Error("expected an ECC module with transitive dependencies");

    click(window, `.rail [data-framework-select="ecc|module|${module.id}"]`);

    const expected = assetClosure([module.id]).sort();
    expect(selectedIds(window).sort()).toEqual(expected);
    for (const id of expected) {
      const asset = ecc.assets.find((candidate) => candidate.id === id);
      if (asset === undefined) throw new Error(`expected ${id}`);
      const key = `ecc|${asset.kind}|${id}`;
      if (["lang", "framework", "capability", "module"].includes(asset.kind)) {
        expect(
          window.document
            .querySelector(`.rail [data-framework-select="${key}"]`)
            ?.getAttribute("aria-pressed"),
          `${id} is checked in the ECC left rail`,
        ).toBe("true");
      }
      const canonicalControls = [
        ...window.document.querySelectorAll(`[data-framework-select="${key}"]`),
      ].filter((control) => control.closest(".rail") === null);
      expect(
        canonicalControls.some((control) => control.getAttribute("aria-pressed") === "true"),
        `${id} is checked in the canonical inventory`,
      ).toBe(true);
    }
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `${expected.length - 1} required component`,
    );
    window.close();
  }, 15_000);

  it("keeps database and React suggestions exact while center deselection remains authoritative", () => {
    const window = studio();

    click(window, '.rail [data-framework-select="ecc|capability|capability:database"]');
    click(window, '.rail [data-framework-select="ecc|framework|framework:react"]');

    expect(
      selectedIds(window)
        .filter((id) => id.startsWith("agent:"))
        .sort(),
    ).toEqual(
      [
        "agent:a11y-architect",
        "agent:database-reviewer",
        "agent:e2e-runner",
        "agent:react-build-resolver",
        "agent:react-reviewer",
      ].sort(),
    );

    clickCanonical(window, "ecc|agent|agent:database-reviewer");

    expect(selectionRoots(window)).toEqual(["capability:database", "framework:react"]);
    expect(selectedIds(window).sort()).toEqual(
      assetClosure(["capability:database", "framework:react"])
        .filter((id) => id !== "agent:database-reviewer")
        .sort(),
    );
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /center deselected agent:database-reviewer/i,
    );

    click(window, "#validate");
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation passed/i,
    );
    window.close();
  });

  it("keeps a center-deselected language rider excluded until the center restores it", () => {
    const window = studio();

    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');
    expect(selectedIds(window)).toContain("agent:python-reviewer");

    clickCanonical(window, "ecc|agent|agent:python-reviewer");
    expect(selectedIds(window)).not.toContain("agent:python-reviewer");
    expect(selectedIds(window)).toContain("lang:python");

    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');
    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');
    expect(selectedIds(window)).not.toContain("agent:python-reviewer");
    expect(selectedIds(window)).toContain("lang:python");

    clickCanonical(window, "ecc|agent|agent:python-reviewer");
    expect(selectedIds(window)).toContain("agent:python-reviewer");
    expect(selectedIds(window)).toEqual(
      expect.arrayContaining(["lang:python", "agent:python-reviewer"]),
    );
    click(window, "#validate");
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation passed/i,
    );
    window.close();
  });

  it("preserves a center-deselected language rider after reopening the exported policy", () => {
    const window = studio();

    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');
    clickCanonical(window, "ecc|agent|agent:python-reviewer");

    const preview = window.document.getElementById("config-preview") as unknown as {
      value: string;
    } | null;
    if (preview === null) throw new Error("expected policy preview");
    const editedPolicy = parseOrgPolicy(JSON.parse(preview.value));
    window.close();

    const reopenedModel = structuredClone(model);
    reopenedModel.initialPolicy = editedPolicy;
    const reopened = studio(reopenedModel);

    expect(selectionRoots(reopened)).toEqual(["lang:python"]);
    expect(selectedIds(reopened)).not.toContain("agent:python-reviewer");
    click(reopened, '.rail [data-framework-select="ecc|lang|lang:python"]');
    click(reopened, '.rail [data-framework-select="ecc|lang|lang:python"]');

    expect(selectedIds(reopened)).toContain("lang:python");
    expect(selectedIds(reopened)).not.toContain("agent:python-reviewer");
    clickCanonical(reopened, "ecc|agent|agent:python-reviewer");
    expect(selectedIds(reopened)).toContain("agent:python-reviewer");
    reopened.close();
  });

  it("keeps a center-deselected Skill excluded from later module suggestions", () => {
    const module = ecc.assets.find(
      (asset) =>
        asset.kind === "module" && asset.members?.some((member) => member.startsWith("skill:")),
    );
    const skillId = module?.members?.find((member) => member.startsWith("skill:"));
    if (module === undefined || skillId === undefined) {
      throw new Error("expected an ECC module with a Skill member");
    }
    const window = studio();

    click(window, `.rail [data-framework-select="ecc|module|${module.id}"]`);
    expect(selectedIds(window)).toContain(skillId);

    clickCanonical(window, `ecc|skill|${skillId}`);
    expect(selectedIds(window)).not.toContain(skillId);
    expect(selectedIds(window)).toContain(module.id);

    click(window, `.rail [data-framework-select="ecc|module|${module.id}"]`);
    click(window, `.rail [data-framework-select="ecc|module|${module.id}"]`);
    expect(selectedIds(window)).not.toContain(skillId);
    expect(selectedIds(window)).toContain(module.id);

    clickCanonical(window, `ecc|skill|${skillId}`);
    expect(selectedIds(window)).toContain(skillId);
    expect(selectedIds(window)).toEqual(expect.arrayContaining([module.id, skillId]));
    click(window, "#validate");
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation passed/i,
    );
    window.close();
  }, 10_000);

  it("clears session-only center exclusions when the administrator clears the policy", () => {
    const window = studio();

    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');
    clickCanonical(window, "ecc|agent|agent:python-reviewer");
    click(window, "#clear-policy");
    click(window, '.rail [data-framework-select="ecc|lang|lang:python"]');

    expect(selectedIds(window)).toEqual(
      expect.arrayContaining(["lang:python", "agent:python-reviewer"]),
    );
    window.close();
  });

  it("lets center removal of a required module prune its dependent root", () => {
    const window = studio();
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) >= 3,
    );
    if (module === undefined) throw new Error("expected an ECC module with dependencies");
    const dependency = module.dependencies?.[0];
    if (dependency === undefined) throw new Error("expected a module dependency");

    click(window, `[data-framework-select="ecc|module|${module.id}"]`);
    clickCanonical(window, `ecc|module|${dependency}`);
    expect(selectedIds(window)).toEqual([]);
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      new RegExp(`center deselected ${dependency}.*removed.*${module.id}`, "i"),
    );

    click(window, "#validate");
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation passed/i,
    );
    window.close();
  });

  it("retains shared dependencies while another selected root still requires them", () => {
    const modules = ecc.assets.filter(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) > 0,
    );
    const pair = modules
      .flatMap((first, index) => modules.slice(index + 1).map((second) => ({ first, second })))
      .find(({ first, second }) =>
        (first.dependencies ?? []).some((dependency) =>
          (second.dependencies ?? []).includes(dependency),
        ),
      );
    if (pair === undefined) throw new Error("expected ECC modules with a shared dependency");

    const window = studio();
    click(window, `[data-framework-select="ecc|module|${pair.first.id}"]`);
    click(window, `[data-framework-select="ecc|module|${pair.second.id}"]`);
    click(window, `[data-framework-select="ecc|module|${pair.first.id}"]`);

    expect(selectedIds(window).sort()).toEqual(assetClosure([pair.second.id]).sort());
    window.close();
  });

  it("rejects a policy that omits a selected module dependency", () => {
    const partialModel = structuredClone(model);
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) > 0,
    );
    if (module === undefined) throw new Error("expected an ECC module dependency");
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      items: [{ kind: module.kind, id: module.id, source: { ...module.source } }],
    });

    const window = studio(partialModel);
    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation failed.*requires.*module:/i,
    );
    window.close();
  });

  it("rejects a legacy rootless module that omits its selectable members", () => {
    const partialModel = structuredClone(model);
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.members?.length ?? 0) > 0,
    );
    if (module === undefined) throw new Error("expected an ECC module with selectable members");
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      items: [{ kind: module.kind, id: module.id, source: { ...module.source } }],
    });

    const window = studio(partialModel);
    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation failed.*requires.*(?:agent|baseline|skill):/i,
    );
    window.close();
  });

  it("rejects an out-of-closure explicit root in the portable browser validator", () => {
    const partialModel = structuredClone(model);
    const asset = ecc.assets[0];
    if (asset === undefined) throw new Error("expected an ECC asset");
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      roots: ["lang:not-in-items"],
      items: [{ kind: asset.kind, id: asset.id, source: { ...asset.source } }],
    });

    const window = studio(partialModel);
    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation failed.*selection root lang:not-in-items is not present in items/i,
    );
    window.close();
  });
});
