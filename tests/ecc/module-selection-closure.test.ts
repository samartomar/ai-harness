import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { ECC_DECLARATION_RIDERS, UPSTREAM_CORE_ECC_MODULE_IDS } from "../../src/ecc/components.js";
import { eccModuleDependencyIds } from "../../src/ecc/evidence.js";
import { governedEccComponentIds } from "../../src/ecc/governed-lifecycle.js";
import {
  eccComponentSourcePaths,
  eccModuleSelectableMemberIds,
} from "../../src/ecc/materialize.js";
import { defaultStudioPolicy } from "../../src/org-policy/studio-model.js";

const catalog = baselineCatalogById("ecc");
const repository = `${catalog.owner}/${catalog.repo}`;

function selectedPolicyIds(policy: ReturnType<typeof defaultStudioPolicy>): string[] {
  return [
    ...new Set(
      (policy.governance?.externalSelections ?? []).flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ),
  ];
}

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
  const group = governance.externalSelections[0];
  if (group === undefined) throw new Error("missing ECC selection group");
  for (const moduleId of moduleIds) {
    for (const id of eccModuleSelectableMemberIds(
      moduleId,
      catalog.components.map((component) => component.id),
    )) {
      if (group.items.some((item) => item.id === id)) continue;
      const component = catalog.components.find((item) => item.id === id);
      const path = component?.paths[0];
      if (path === undefined) throw new Error(`missing ${id}`);
      const kind = id.startsWith("agent:")
        ? "agent"
        : id.startsWith("baseline:")
          ? "baseline"
          : "skill";
      group.items.push({
        kind,
        id,
        source: { repository, commit: catalog.pinnedSha, path },
      });
    }
  }
  return policy;
}

function policyWithBareModule(moduleId: string) {
  const policy = defaultStudioPolicy();
  const component = catalog.components.find((item) => item.id === `module:${moduleId}`);
  const path = component?.paths[0];
  if (path === undefined) throw new Error(`missing module:${moduleId}`);
  if (policy.governance === undefined) throw new Error("expected governance");
  policy.governance.externalSelections = [
    {
      framework: "ecc",
      items: [
        {
          kind: "module",
          id: `module:${moduleId}`,
          source: { repository, commit: catalog.pinnedSha, path },
        },
      ],
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

function withTypescriptLanguageAndCore(includeRider = true) {
  const coreModules = [
    ...new Set(
      UPSTREAM_CORE_ECC_MODULE_IDS.flatMap((moduleId) => [
        moduleId,
        ...eccModuleDependencyIds(moduleId),
      ]),
    ),
  ];
  const policy = withTypescriptLanguage(includeRider);
  const group = policy.governance?.externalSelections[0];
  if (group === undefined) throw new Error("missing ECC selection group");
  group.roots = ["lang:typescript"];
  for (const moduleId of coreModules) {
    const id = `module:${moduleId}`;
    const component = catalog.components.find((item) => item.id === id);
    const path = component?.paths[0];
    if (path === undefined) throw new Error(`missing ${id}`);
    group.items.push({
      kind: "module",
      id,
      source: { repository, commit: catalog.pinnedSha, path },
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

  it("accepts an exact module selection after its suggested members are deselected", () => {
    const policy = policyWithBareModule("agents-core");
    const group = policy.governance?.externalSelections[0];
    if (group === undefined) throw new Error("missing ECC selection group");
    group.roots = ["module:agents-core"];

    expect(governedEccComponentIds(policy, catalog).sort()).toEqual(
      selectedPolicyIds(policy).sort(),
    );
  });

  it("refuses a stray module hidden behind empty explicit roots", () => {
    const policy = policyWithBareModule("agents-core");
    const group = policy.governance?.externalSelections[0];
    if (group === undefined) throw new Error("missing ECC selection group");
    group.roots = [];

    expect(() => governedEccComponentIds(policy, catalog)).toThrow(
      /not reachable from an explicit root or preserved legacy item.*module:agents-core/i,
    );
  });

  it("accepts the exact pinned dependency closure and resolves every module source", () => {
    const selected = ["machine-learning", ...eccModuleDependencyIds("machine-learning")];
    const policy = policyWithModules(selected);
    expect(governedEccComponentIds(policy, catalog).sort()).toEqual(
      selectedPolicyIds(policy).sort(),
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
    const policy = withMachineLearningCapability(modules, true);
    expect(governedEccComponentIds(policy, catalog).sort()).toEqual(
      selectedPolicyIds(policy).sort(),
    );
  });

  it("retains a selected declaration rider without treating it as structural authority", () => {
    const selected = governedEccComponentIds(withTypescriptLanguageAndCore(), catalog);
    expect(selected).toContain("lang:typescript");
    expect(selected.filter((id) => id.startsWith("agent:"))).toEqual(["agent:typescript-reviewer"]);
  });

  it("rejects a rootless legacy declaration whose suggested rider is missing", () => {
    const policy = withTypescriptLanguageAndCore(false);
    const group = policy.governance?.externalSelections[0];
    if (group === undefined) throw new Error("missing ECC selection group");
    delete group.roots;

    expect(() => governedEccComponentIds(policy, catalog)).toThrow(
      /lang:typescript.*requires.*agent:typescript-reviewer/i,
    );
  });

  it("preserves an explicit language choice after its suggested Agent is deselected", () => {
    const policy = withTypescriptLanguageAndCore(false);

    expect(governedEccComponentIds(policy, catalog).sort()).toEqual(
      selectedPolicyIds(policy).sort(),
    );
    expect(selectedPolicyIds(policy)).not.toContain("agent:typescript-reviewer");
  });

  it("refuses a language selection that omits ECC Core", () => {
    expect(() => governedEccComponentIds(withTypescriptLanguage(true), catalog)).toThrow(
      /lang:typescript.*requires.*module:rules-core/i,
    );
  });
});
