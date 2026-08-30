import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
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
});
