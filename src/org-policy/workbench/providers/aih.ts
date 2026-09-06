import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { type BuiltInCatalogInputV1, compileBuiltInCatalogV1 } from "../compilers/built-in.js";
import { compilerRegistrationForInputFormatV1 } from "../compilers/formats.js";
import { defineCatalogProviderV1 } from "./contracts.js";
export function builtInAssemblyInputV1(
  result: ReturnType<typeof compileBuiltInCatalogV1>,
): CatalogCompilerAssemblyInputV1 {
  return {
    sources: {
      [result.source.id]: {
        id: result.source.id,
        distributor: { kind: "aih", locator: "@aihq/core" },
        upstreamOrigin: { kind: "aih", locator: result.source.locator },
        inputFormat: "built-in/v1",
        revision: { id: result.source.revisionId, contentDigest: result.source.contentDigest },
        compiler: compilerRegistrationForInputFormatV1("built-in/v1"),
      },
    },
    declarations: result.declarations,
    groups: {},
    detailBytes: result.detailBytes,
  };
}
export const aihCatalogProviderV1 = defineCatalogProviderV1({
  providerId: "aih",
  providerVersion: "1",
  fixture: (): BuiltInCatalogInputV1 => ({
    aihCapabilityPackage: { name: "@aihq/core", version: "fixture" },
    mcp: [],
    hooks: [],
    unavailableMcp: [],
    nonProjectableMcp: [],
    aihSkills: [
      {
        id: "fixture",
        pack: "fixture",
        description: "Fixture",
        skills: ["fixture"],
        sources: [{ skill: "fixture", path: "skills/fixture.md", manifestIdentity: "fixture" }],
      },
    ],
    aihAgents: [],
  }),
  compile: (input: BuiltInCatalogInputV1) => [
    builtInAssemblyInputV1(compileBuiltInCatalogV1(input)),
  ],
});
