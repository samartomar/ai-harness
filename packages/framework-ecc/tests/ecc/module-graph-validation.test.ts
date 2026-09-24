import "../core-invocation.js";
import { AihError } from "@aihq/core/framework-host";
import { describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../../../src/baseline-evidence/verify.js";
import { EccDescriptorError } from "../../src/descriptor.js";
import { eccModuleDependencyIds, eccProfileModuleIds } from "../../src/ecc/evidence.js";
import { assertGovernedEccTargetClosure } from "../../src/ecc/governed-lifecycle.js";
import { resolveEccMaterializationSelection } from "../../src/ecc/materialization-selection.js";
import { eccMandatoryRequirementIds } from "../../src/ecc/selection-closure.js";
import { withEccInvocation } from "../../src/invocation.js";
import { descriptorFromDocument, fixtureDescriptorDocument } from "../context.js";

/**
 * A schema-valid module graph can still name a module it does not contain or
 * loop back on itself. Reading the graph refuses both with a typed error, and
 * no production closure caller turns that refusal into an empty closure.
 */

interface GraphModule {
  id: string;
  dependencies: string[];
}

function withGraph<T>(
  mutate: (modules: GraphModule[], profiles: Record<string, { modules: string[] }>) => void,
  body: () => T,
): T {
  const document = fixtureDescriptorDocument();
  const sections = document.sections as {
    moduleGraph: { modules: GraphModule[] };
    profileGraph: { profiles: Record<string, { modules: string[] }> };
  };
  mutate(sections.moduleGraph.modules, sections.profileGraph.profiles);
  return withEccInvocation({ descriptor: descriptorFromDocument(document) }, body);
}

function module(modules: GraphModule[], id: string): GraphModule {
  const found = modules.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`fixture module graph has no ${id}`);
  return found;
}

const dangling = (modules: GraphModule[]) =>
  module(modules, "database").dependencies.push("no-such-module");
const cycle = (modules: GraphModule[]) =>
  module(modules, "platform-configs").dependencies.push("database");

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/core release",
    evidenceSha256: "c".repeat(64),
  };
}

function refusal(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("ECC module graph references and cycles", () => {
  it("refuses a dangling dependency where the graph is read", () => {
    const error = withGraph(dangling, () => refusal(() => eccModuleDependencyIds("rules-core")));
    expect(error).toBeInstanceOf(EccDescriptorError);
    expect(error.message).toMatch(/moduleGraph.*database.*unknown module.*no-such-module/);
  });

  it("refuses a dependency cycle where the graph is read", () => {
    const error = withGraph(cycle, () => refusal(() => eccModuleDependencyIds("rules-core")));
    expect(error).toBeInstanceOf(EccDescriptorError);
    expect(error.message).toMatch(/moduleGraph.*cycle.*database.*platform-configs/);
  });

  it("refuses a profile that names a module the graph does not contain", () => {
    const error = withGraph(
      (_modules, profiles) => profiles.core?.modules.push("no-such-module"),
      () => refusal(() => eccProfileModuleIds("core")),
    );
    expect(error).toBeInstanceOf(EccDescriptorError);
    expect(error.message).toMatch(/profileGraph.*core.*unknown module.*no-such-module/);
  });

  it("keeps the published graph valid", () => {
    expect(eccModuleDependencyIds("database")).toContain("platform-configs");
  });
});

describe("no production closure caller gets an empty closure on error", () => {
  it("propagates the refusal from the structural requirements of a component", () => {
    for (const mutate of [dangling, cycle]) {
      const error = withGraph(mutate, () =>
        refusal(() => eccMandatoryRequirementIds("module:database")),
      );
      expect(error).toBeInstanceOf(EccDescriptorError);
    }
  });

  it("refuses an unknown component with a typed error instead of an empty closure", () => {
    const error = refusal(() => eccMandatoryRequirementIds("synthetic:future-component"));
    expect(error).toBeInstanceOf(AihError);
    expect(error.message).toMatch(/structural dependency closure.*synthetic:future-component/);
  });

  it("refuses the evidence-passed selection instead of admitting an incomplete closure", () => {
    const error = withGraph(dangling, () =>
      refusal(() =>
        resolveEccMaterializationSelection(
          {
            externalSelections: [
              {
                framework: "ecc",
                items: [
                  {
                    kind: "module",
                    id: "module:database",
                    source: { repository: "affaan-m/ECC", commit: "a".repeat(40), path: "skills" },
                  },
                ],
              },
            ],
          } as never,
          { authorizations: [authorization("module:database")], held: [] },
        ),
      ),
    );
    expect(error).toBeInstanceOf(EccDescriptorError);
  });

  it("refuses the governed target closure instead of passing it", () => {
    const error = withGraph(dangling, () =>
      refusal(() =>
        assertGovernedEccTargetClosure(
          ["claude"],
          ["module:database", "module:platform-configs"],
          [],
        ),
      ),
    );
    expect(error).toBeInstanceOf(EccDescriptorError);
  });
});
