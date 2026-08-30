import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { ECC_DECLARATION_RIDERS } from "../../src/ecc/components.js";
import { eccModuleDependencyIds } from "../../src/ecc/evidence.js";
import { governedEccComponentIds } from "../../src/ecc/governed-lifecycle.js";
import { eccComponentSourcePaths } from "../../src/ecc/materialize.js";
import { defaultStudioPolicy } from "../../src/org-policy/studio-model.js";

const catalog = baselineCatalogById("ecc");
const repository = `${catalog.owner}/${catalog.repo}`;

function policyWithModules(moduleIds: readonly string[]) {
  const policy = defaultStudioPolicy();
  const governance = policy.governance;
  if (governance === undefined) throw new Error("expected governance");
  governance.externalSelections = [
    {
      framework: "ecc",
      items: moduleIds.map((moduleId) => {
        const id = `module:${moduleId}`;
        const component = catalog.components.find((item) => item.id === id);
        const path = component?.paths[0];
        if (path === undefined) throw new Error(`missing catalog component ${id}`);
        return {
          kind: "module" as const,
          id,
          source: { repository, commit: catalog.pinnedSha, path },
        };
      }),
    },
  ];
  return policy;
}

function withMachineLearningCapability(moduleIds: readonly string[], includeRiders = false) {
  const policy = policyWithModules(moduleIds);
  const component = catalog.components.find((item) => item.id === "capability:machine-learning");
  const path = component?.paths[0];
  if (path === undefined) throw new Error("missing capability:machine-learning");
  policy.governance?.externalSelections[0]?.items.push({
    kind: "capability",
    id: "capability:machine-learning",
    source: { repository, commit: catalog.pinnedSha, path },
  });
  if (includeRiders) {
    for (const id of ECC_DECLARATION_RIDERS["capability:machine-learning"] ?? []) {
      const rider = catalog.components.find((item) => item.id === id);
      const riderPath = rider?.paths[0];
      if (riderPath === undefined) throw new Error(`missing ${id}`);
      policy.governance?.externalSelections[0]?.items.push({
        kind: "agent",
        id,
        source: { repository, commit: catalog.pinnedSha, path: riderPath },
      });
    }
  }
  return policy;
}

function withTypescriptLanguage(includeRider: boolean) {
  const policy = policyWithModules([]);
  const group = policy.governance?.externalSelections[0];
  const language = catalog.components.find((item) => item.id === "lang:typescript");
  const languagePath = language?.paths[0];
  if (group === undefined || languagePath === undefined) throw new Error("missing lang:typescript");
  group.items.push({
    kind: "lang",
    id: "lang:typescript",
    source: { repository, commit: catalog.pinnedSha, path: languagePath },
  });
  if (includeRider) {
    const rider = catalog.components.find((item) => item.id === "agent:typescript-reviewer");
    const riderPath = rider?.paths[0];
    if (riderPath === undefined) throw new Error("missing agent:typescript-reviewer");
    group.items.push({
      kind: "agent",
      id: "agent:typescript-reviewer",
      source: { repository, commit: catalog.pinnedSha, path: riderPath },
    });
  }
  return policy;
}

describe("governed ECC module selection closure", () => {
  it("refuses a module selection whose pinned dependency closure is incomplete", () => {
    expect(() => governedEccComponentIds(policyWithModules(["machine-learning"]), catalog)).toThrow(
      /incomplete.*dependency|requires.*module:/i,
    );
  });

  it("accepts the exact pinned dependency closure and resolves every module source", () => {
    const selected = ["machine-learning", ...eccModuleDependencyIds("machine-learning")];
    expect(governedEccComponentIds(policyWithModules(selected), catalog).sort()).toEqual(
      selected.map((id) => `module:${id}`).sort(),
    );
    for (const id of selected) {
      expect(eccComponentSourcePaths(`module:${id}`)).not.toHaveLength(0);
    }
  });

  it("requires a whole-module capability to select its containing module visibly", () => {
    expect(() => governedEccComponentIds(withMachineLearningCapability([]), catalog)).toThrow(
      /capability:machine-learning.*requires.*module:machine-learning/i,
    );

    const modules = ["machine-learning", ...eccModuleDependencyIds("machine-learning")];
    expect(
      governedEccComponentIds(withMachineLearningCapability(modules, true), catalog).sort(),
    ).toEqual(
      [
        "capability:machine-learning",
        ...modules.map((id) => `module:${id}`),
        ...(ECC_DECLARATION_RIDERS["capability:machine-learning"] ?? []),
      ].sort(),
    );
  });

  it("refuses a declaration whose required rider is missing", () => {
    expect(() => governedEccComponentIds(withTypescriptLanguage(false), catalog)).toThrow(
      /lang:typescript.*requires.*agent:typescript-reviewer/i,
    );
    expect(governedEccComponentIds(withTypescriptLanguage(true), catalog).sort()).toEqual([
      "agent:typescript-reviewer",
      "lang:typescript",
    ]);
  });
});
