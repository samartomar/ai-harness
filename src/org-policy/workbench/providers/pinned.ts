import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import type { PolicyAuthoringFramework } from "../../catalog-provider-types.js";
import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { compilerRegistrationForInputFormatV1 } from "../compilers/formats.js";
import {
  compilePinnedBaselineV1,
  type PinnedBaselineSourceInputV1,
} from "../compilers/pinned-baseline.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
export interface PinnedProviderInputV1 {
  framework: PolicyAuthoringFramework;
  source: PinnedBaselineSourceInputV1;
}
export type TemplateDefinitionV1 = Omit<AuthoringCatalogBundleV1["templates"][string], "digest">;
export function compileTemplateDefinitionsV1(
  definitions: readonly TemplateDefinitionV1[],
): AuthoringCatalogBundleV1["templates"] {
  return Object.fromEntries(
    definitions.map((template) => {
      const roots = [...template.roots].sort((a, b) =>
        a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0,
      );
      return [
        template.id,
        {
          ...template,
          roots,
          digest: `sha256:${canonicalStrictJsonSha256V1({ ...template, roots })}`,
        },
      ];
    }),
  );
}
export function methodologyTemplateV1(framework: PolicyAuthoringFramework): TemplateDefinitionV1 {
  return {
    id: `template:${framework.id}/methodology`,
    label: `${framework.repository.split("/").at(-1)} methodology`,
    roots: [
      {
        assetId: `${framework.id}/profile:methodology`,
        mode: "select",
        includeOptionalMembers: false,
      },
    ],
    exclusions: [],
  };
}
export function compilePinnedProviderV1(
  input: PinnedProviderInputV1,
  templates: readonly TemplateDefinitionV1[],
): CatalogCompilerAssemblyInputV1 {
  const result = compilePinnedBaselineV1(input.framework, input.source);
  return {
    sources: {
      [result.source.id]: {
        id: result.source.id,
        distributor: { kind: "aih", locator: "@aihq/core" },
        upstreamOrigin: { kind: "git", locator: result.source.repository },
        inputFormat: "pinned-baseline/v1",
        revision: { id: result.source.revisionId, contentDigest: result.source.contentDigest },
        compiler: compilerRegistrationForInputFormatV1("pinned-baseline/v1"),
      },
    },
    declarations: result.declarations,
    relations: result.relations,
    groups: result.groups,
    evidence: result.evidence as AuthoringCatalogBundleV1["evidence"],
    detailBytes: result.detailBytes,
    templates: compileTemplateDefinitionsV1(templates),
  };
}
export function pinnedProviderFixtureV1(id: "ecc" | "superpowers"): PinnedProviderInputV1 {
  return {
    framework: {
      id,
      repository: `fixture/${id}`,
      commit: "a".repeat(40),
      assets: [
        {
          id: "skill:fixture",
          kind: "skill",
          source: {
            repository: `fixture/${id}`,
            commit: "a".repeat(40),
            path: "skills/fixture.md",
          },
          sourcePaths: ["skills/fixture.md"],
          metadata: {
            title: "Fixture",
            summary: "Fixture skill",
            usageContext: "testing",
            allowedTools: [],
            sourcePath: "skills/fixture.md",
            sourceSha256: "b".repeat(64),
          },
        },
      ],
    },
    source: {
      id,
      owner: "fixture",
      repo: id,
      pinnedSha: "a".repeat(40),
      sourceTreeSha256: "c".repeat(64),
      components: [],
    },
  };
}
