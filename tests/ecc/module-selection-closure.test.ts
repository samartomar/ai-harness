import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { ECC_DECLARATION_RIDERS, UPSTREAM_CORE_ECC_MODULE_IDS } from "../../src/ecc/components.js";
import { eccModuleDependencyIds } from "../../src/ecc/evidence.js";
import {
  assertGovernedEccTargetClosure,
  governedEccComponentIds,
} from "../../src/ecc/governed-lifecycle.js";
import {
  eccComponentSourcePaths,
  eccModuleSelectableMemberIds,
} from "../../src/ecc/materialize.js";
import { eccMandatoryRequirementIds } from "../../src/ecc/selection-closure.js";
import { type OrgPolicy, OrgPolicySchema } from "../../src/org-policy/schema.js";
import { defaultStudioPolicy } from "../../src/org-policy/studio-model.js";
import { compilePolicy } from "../../src/org-policy/workbench/policy-compiler.js";
import { defaultPreparedWorkbenchCatalog } from "../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../src/org-policy/workbench/selection-engine.js";

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

describe("schema-v3 Workbench ECC guard", () => {
  it("consumes compiled V3 pins and refuses stale or missing intent before using its legacy mirror", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const asset = prepared.bundle.assets["ecc/module:rules-core"];
    if (!asset) throw new Error("expected pinned ECC rules-core asset");
    const selected = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: asset.id,
      origin: { kind: "administrator" },
    });
    expect(selected.accepted).toBe(true);
    const compiled = compilePolicy(
      defaultStudioPolicy(),
      selected.state,
      prepared.bundle,
      prepared.bindings,
    );
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.accepted).toBe(true);
    const valid = OrgPolicySchema.parse(compiled.policy) as OrgPolicy;
    expect(governedEccComponentIds(valid, catalog)).toContain("module:rules-core");
    const exactMirror = structuredClone(valid.governance?.externalSelections);
    for (const kind of ["stale", "missing"] as const) {
      const damaged = structuredClone(valid);
      if (damaged.schemaVersion !== 3) throw new Error("expected V3 compiler output");
      const root = damaged.authoringSelections.roots[0];
      if (!root) throw new Error("expected pinned root");
      if (kind === "stale") root.contentDigest = "sha256:" + "f".repeat(64);
      else {
        root.assetId = "ecc/skill:removed";
        root.resolvedItems = [
          {
            assetId: root.assetId,
            sourceId: root.sourceId,
            sourceRevisionId: root.sourceRevisionId,
            contentDigest: root.contentDigest,
          },
        ];
      }
      expect(damaged.governance?.externalSelections).toEqual(exactMirror);
      expect(() => governedEccComponentIds(damaged, catalog)).toThrow(
        /invalid Workbench selections/,
      );
    }
  });

  it("refuses a forged legacy ECC mirror when V3 selections are empty", () => {
    const moduleId = catalog.components
      .find((component) => component.id.startsWith("module:"))
      ?.id.slice("module:".length);
    if (moduleId === undefined) throw new Error("expected pinned ECC module");
    const forged = policyWithModules([moduleId]);
    const v3 = OrgPolicySchema.parse({
      ...forged,
      schemaVersion: 3,
      minimumCoreVersion: "0.6.0",
      authoringSelections: {
        selectionVersion: "workbench-selection/v1",
        roots: [],
        requests: [],
        exclusions: [],
        drafts: [],
      },
    }) as OrgPolicy;
    expect(() => governedEccComponentIds(v3, catalog)).toThrow(
      /Legacy external selections disagree with pinned authoring selections/,
    );
  });
  it("keeps schema-v2 component resolution unchanged", () => {
    const moduleId = catalog.components
      .find((component) => component.id.startsWith("module:"))
      ?.id.slice("module:".length);
    if (moduleId === undefined) throw new Error("expected pinned ECC module");
    expect(governedEccComponentIds(policyWithModules([moduleId]), catalog)).toContain(
      `module:${moduleId}`,
    );
  });
});
describe("governed ECC module selection closure", () => {
  it("keeps lower-level synthetic identifiers total while the governed boundary refuses them", () => {
    expect(eccMandatoryRequirementIds("synthetic:future-component")).toEqual([]);

    const policy = policyWithBareModule("agents-core");
    const item = policy.governance?.externalSelections[0]?.items[0];
    if (item === undefined) throw new Error("missing module:agents-core");
    item.id = "synthetic:future-component";
    item.kind = "capability";

    expect(() => governedEccComponentIds(policy, catalog)).toThrow(
      /policy selects component.*synthetic:future-component/i,
    );
  });

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

  it("refuses a selected component whose declared kind contradicts its pinned identity", () => {
    const policy = policyWithBareModule("agents-core");
    const item = policy.governance?.externalSelections[0]?.items[0];
    if (item === undefined) throw new Error("missing module:agents-core");
    item.kind = "skill";

    expect(() => governedEccComponentIds(policy, catalog)).toThrow(
      /module:agents-core.*kind skill.*pinned kind is module/i,
    );
  });

  it("refuses a selected component whose source path is not its pinned catalog path", () => {
    const policy = policyWithBareModule("agents-core");
    const item = policy.governance?.externalSelections[0]?.items[0];
    if (item === undefined) throw new Error("missing module:agents-core");
    item.source.path = "skills/not-the-agents-core-source";

    expect(() => governedEccComponentIds(policy, catalog)).toThrow(
      /module:agents-core.*source path.*pinned catalog paths/i,
    );
  });

  it("accepts an exact non-primary path carried by a multi-path catalog component", () => {
    const policy = policyWithBareModule("platform-configs");
    const group = policy.governance?.externalSelections[0];
    const item = group?.items[0];
    const component = catalog.components.find((entry) => entry.id === "module:platform-configs");
    const alternatePath = component?.paths[1];
    if (group === undefined || item === undefined || alternatePath === undefined) {
      throw new Error("missing multi-path module:platform-configs");
    }
    group.roots = [item.id];
    item.source.path = alternatePath;

    expect(governedEccComponentIds(policy, catalog)).toEqual(["module:platform-configs"]);
  });

  it("refuses a parent directory that is not an exact pinned component path", () => {
    const policy = policyWithBareModule("platform-configs");
    const item = policy.governance?.externalSelections[0]?.items[0];
    if (item === undefined) throw new Error("missing module:platform-configs");
    item.source.path = ".";

    expect(() => governedEccComponentIds(policy, catalog)).toThrow(
      /module:platform-configs.*source path.*pinned catalog paths/i,
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

  it("refuses target mapping when a required module is unavailable on that target", () => {
    const selected = [
      "module:security",
      ...eccModuleDependencyIds("security").map((id) => `module:${id}`),
    ];

    expect(() =>
      assertGovernedEccTargetClosure(["codex"], selected, [
        {
          target: "codex",
          id: "module:platform-configs",
          reason: "missing-source",
          detail: "the pinned source is unavailable",
        },
      ]),
    ).toThrow(/Codex.*module:security requires module:platform-configs/i);
  });

  it("does not treat a refused optional Agent suggestion as a structural closure failure", () => {
    const selected = [
      "capability:database",
      "module:database",
      ...eccModuleDependencyIds("database").map((id) => `module:${id}`),
      "agent:database-reviewer",
    ];
    expect(() =>
      assertGovernedEccTargetClosure(["codex"], selected, [
        {
          target: "codex",
          id: "agent:database-reviewer",
          reason: "missing-source",
          detail: "the optional Agent source is unavailable",
        },
      ]),
    ).not.toThrow();
  });
});
