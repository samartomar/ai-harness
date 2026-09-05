import { policyAuthoringCatalog } from "../../catalog.js";
import type { CatalogCompilerAssemblyInputV1 } from "../catalog-bundle.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
import { compileBuiltInCatalogV1 } from "./built-in.js";
import { compileOrganizationManifestV1 } from "./organization-manifest.js";
import { compilePinnedBaselineV1 } from "./pinned-baseline.js";
import {
  compilerFormatRegistrationsV1,
  type RegisteredCompilerFormatRegistrationV1,
  type RegisteredCompilerInputFormatV1,
} from "./registry.js";

export type RegisteredCatalogCompilerV1 = RegisteredCompilerFormatRegistrationV1 & {
  /**
   * A mandatory offline fixture for this registered source format. It feeds the
   * same source-neutral assembler used by product preparation; no Core
   * capability is supplied here.
   */
  compileFixture(): readonly CatalogCompilerAssemblyInputV1[];
};

function source(
  registration: RegisteredCompilerFormatRegistrationV1,
  id: string,
  revisionId: string,
  contentDigest: string,
  distributor: AuthoringCatalogBundleV1["sources"][string]["distributor"],
  upstreamOrigin: AuthoringCatalogBundleV1["sources"][string]["upstreamOrigin"],
): AuthoringCatalogBundleV1["sources"][string] {
  return {
    id,
    distributor,
    upstreamOrigin,
    inputFormat: registration.inputFormat,
    revision: { id: revisionId, contentDigest },
    compiler: { id: registration.id, version: registration.version },
  };
}

const compilerFixtureFactoriesV1: {
  readonly [format in RegisteredCompilerInputFormatV1]: () => readonly CatalogCompilerAssemblyInputV1[];
} = {
  "pinned-baseline/v1": () => {
    const registration = compilerFormatRegistrationsV1.find(
      (candidate) => candidate.inputFormat === "pinned-baseline/v1",
    );
    if (registration === undefined) throw new Error("missing pinned-baseline registration");
    return policyAuthoringCatalog().frameworks.map((framework) => {
      const result = compilePinnedBaselineV1(framework);
      return {
        sources: {
          [result.source.id]: source(
            registration,
            result.source.id,
            result.source.revisionId,
            result.source.contentDigest,
            { kind: "aih", locator: "@aihq/core" },
            { kind: "git", locator: result.source.repository },
          ),
        },
        declarations: result.declarations,
        relations: result.relations,
        groups: result.groups,
        evidence: result.evidence as AuthoringCatalogBundleV1["evidence"],
        detailBytes: result.detailBytes,
      };
    });
  },
  "built-in/v1": () => {
    const registration = compilerFormatRegistrationsV1.find(
      (candidate) => candidate.inputFormat === "built-in/v1",
    );
    if (registration === undefined) throw new Error("missing built-in registration");
    const result = compileBuiltInCatalogV1(policyAuthoringCatalog());
    return [
      {
        sources: {
          [result.source.id]: source(
            registration,
            result.source.id,
            result.source.revisionId,
            result.source.contentDigest,
            { kind: "aih", locator: "@aihq/core" },
            { kind: "aih", locator: result.source.locator },
          ),
        },
        declarations: result.declarations,
        detailBytes: result.detailBytes,
      },
    ];
  },
  "organization-authoring-manifest/v1": () => {
    const registration = compilerFormatRegistrationsV1.find(
      (candidate) => candidate.inputFormat === "organization-authoring-manifest/v1",
    );
    if (registration === undefined) throw new Error("missing organization-manifest registration");
    const result = compileOrganizationManifestV1(
      JSON.stringify({
        version: "organization-authoring-manifest/v1",
        source: {
          id: "source:contract-fixture",
          revisionId: "v1",
          locator: "contract fixture",
        },
        assets: [
          {
            id: "agent:fixture",
            kind: "agent",
            label: "Fixture Agent",
            path: "agents/fixture.md",
          },
          {
            id: "mcp:fixture",
            kind: "mcp",
            label: "Fixture MCP",
            path: "mcp.json",
          },
        ],
      }),
    );
    return [
      {
        sources: {
          [result.source.id]: source(
            registration,
            result.source.id,
            result.source.revisionId,
            result.source.contentDigest,
            { kind: "organization", locator: result.source.locator },
            { kind: "organization", locator: result.source.locator },
          ),
        },
        declarations: result.declarations,
        relations: result.relations,
        detailBytes: result.detailBytes,
      },
    ];
  },
};

/**
 * Registry-driven fixture discovery. The mapped factory type makes a newly
 * registered format a compile-time error until it supplies its contract input.
 */
export const registeredCatalogCompilersV1: readonly RegisteredCatalogCompilerV1[] = Object.freeze(
  compilerFormatRegistrationsV1.map((registration) => ({
    ...registration,
    compileFixture: compilerFixtureFactoriesV1[registration.inputFormat],
  })),
);
