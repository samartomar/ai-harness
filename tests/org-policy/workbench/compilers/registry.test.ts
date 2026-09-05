import { describe, expect, it } from "vitest";
import { canonicalStrictJsonSha256V1 } from "../../../../src/contract/strict-json-v1.js";
import {
  assembleAuthoringCatalogBundleFromCompilerOutputsV1,
  type CatalogCompilerAssemblyInputV1,
  policyAuthoringCatalogBundleWithOrganizationManifestsV1,
  verifyAuthoringCatalogBundleIntegrityV1,
} from "../../../../src/org-policy/workbench/catalog-bundle.js";
import { registeredCatalogCompilersV1 } from "../../../../src/org-policy/workbench/compilers/index.js";
import { compileOrganizationManifestV1 } from "../../../../src/org-policy/workbench/compilers/organization-manifest.js";
import {
  actionForCompilerDeclarationV1,
  assemblyRegistryForCompiledDeclarationsV1,
  compilerFormatRegistrationsV1,
} from "../../../../src/org-policy/workbench/compilers/registry.js";
import { parseAuthoringCatalogBundleV1 } from "../../../../src/org-policy/workbench/contracts.js";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const declaration = {
  id: "organization/skill:triage",
  sourceId: "source:organization",
  sourceRevisionId: "v1",
  contentDigest: digest,
  originalPath: "skills/triage/SKILL.md",
  derivation: "organization-declaration" as const,
  kind: "skill",
  label: "Triage",
  detailChunkId: "detail:organization/skill:triage",
  declaredHostCapabilities: [],
};

function organizationInput(sourceId: string): CatalogCompilerAssemblyInputV1 {
  const result = compileOrganizationManifestV1(
    JSON.stringify({
      version: "organization-authoring-manifest/v1",
      source: {
        id: sourceId,
        revisionId: "v1",
        locator: `${sourceId} manifest`,
      },
      assets: [
        {
          id: "skill:triage",
          kind: "skill",
          label: "Triage",
          path: "skills/triage/SKILL.md",
        },
      ],
    }),
  );
  return {
    sources: {
      [result.source.id]: {
        id: result.source.id,
        distributor: { kind: "organization", locator: result.source.locator },
        upstreamOrigin: {
          kind: "organization",
          locator: result.source.locator,
        },
        inputFormat: result.source.inputFormat,
        revision: {
          id: result.source.revisionId,
          contentDigest: result.source.contentDigest,
        },
        compiler: { id: "organization-manifest", version: "1" },
      },
    },
    declarations: result.declarations,
    relations: result.relations,
    detailBytes: result.detailBytes,
  };
}

describe("registered catalog compilers", () => {
  it("enrolls every registered format through generic source, template, parse, and integrity contracts", () => {
    expect(registeredCatalogCompilersV1.map((compiler) => compiler.inputFormat)).toEqual(
      compilerFormatRegistrationsV1.map((registration) => registration.inputFormat),
    );

    for (const compiler of registeredCatalogCompilersV1) {
      const fixtureInputs = compiler.compileFixture();
      const root = fixtureInputs
        .flatMap((input) => input.declarations)
        .find(
          (entry) =>
            actionForCompilerDeclarationV1(entry.inputFormat, entry.declaration.kind) ===
            "record-selection",
        )?.declaration;
      if (root === undefined)
        throw new Error(`fixture ${compiler.inputFormat} has no selectable root`);
      const template = {
        id: `template:contract-${compiler.id}`,
        roots: [
          {
            assetId: root.id,
            mode: "select" as const,
            includeOptionalMembers: false,
          },
        ],
        exclusions: [],
      };
      const inputs = fixtureInputs.map((input, index) =>
        index === 0
          ? {
              ...input,
              templates: {
                ...(input.templates ?? {}),
                [template.id]: {
                  ...template,
                  digest: `sha256:${canonicalStrictJsonSha256V1(template)}`,
                },
              },
            }
          : input,
      );
      const bundle = assembleAuthoringCatalogBundleFromCompilerOutputsV1(inputs);
      expect(() => parseAuthoringCatalogBundleV1(bundle)).not.toThrow();
      expect(() => verifyAuthoringCatalogBundleIntegrityV1(bundle)).not.toThrow();
      expect(Object.values(bundle.sources).map((source) => source.inputFormat)).toEqual(
        expect.arrayContaining([compiler.inputFormat]),
      );
      expect(bundle.templates[template.id]?.roots).toEqual(template.roots);
      expect(bundle.templates[template.id]?.digest).toBe(
        `sha256:${canonicalStrictJsonSha256V1(template)}`,
      );
    }
  });

  it("merges unfamiliar organization sources without source-specific UI assembly", () => {
    const bundle = assembleAuthoringCatalogBundleFromCompilerOutputsV1([
      organizationInput("source:alpha"),
      organizationInput("source:beta"),
    ]);
    expect(Object.keys(bundle.sources)).toEqual(["source:alpha", "source:beta"]);
    expect(Object.keys(bundle.assets)).toHaveLength(2);
    expect(new Set(Object.keys(bundle.assets)).size).toBe(2);
  });

  it("prepares multiple real organization manifests alongside ECC and Superpowers", () => {
    const manifests = ["source:alpha", "source:beta"].map((sourceId) =>
      JSON.stringify({
        version: "organization-authoring-manifest/v1",
        source: {
          id: sourceId,
          revisionId: "v1",
          locator: `${sourceId} manifest`,
        },
        assets: [
          {
            id: "skill:triage",
            kind: "skill",
            label: "Triage",
            path: "skills/triage/SKILL.md",
          },
        ],
      }),
    );
    const bundle = policyAuthoringCatalogBundleWithOrganizationManifestsV1(manifests);
    expect(Object.keys(bundle.sources)).toEqual(
      expect.arrayContaining(["source:ecc", "source:superpowers", "source:alpha", "source:beta"]),
    );
    expect(
      Object.values(bundle.assets).filter(
        (asset) =>
          asset.sourceId.startsWith("source:") &&
          ["source:alpha", "source:beta"].includes(asset.sourceId),
      ),
    ).toHaveLength(2);
    expect(() => verifyAuthoringCatalogBundleIntegrityV1(bundle)).not.toThrow();
  });

  it("rejects future compiler versions, caller capability injection, and relation collisions", () => {
    const future = organizationInput("source:future");
    const futureSource = future.sources["source:future"];
    if (futureSource === undefined) throw new Error("expected future source");
    futureSource.compiler.version = "999";
    expect(() => assembleAuthoringCatalogBundleFromCompilerOutputsV1([future])).toThrow(
      /unregistered source compiler/,
    );

    const injected = organizationInput("source:injected") as CatalogCompilerAssemblyInputV1 & {
      coreCapabilities: unknown[];
    };
    const injectedDeclaration = injected.declarations[0]?.declaration;
    if (injectedDeclaration === undefined) throw new Error("expected organization declaration");
    injected.coreCapabilities = [
      {
        assetId: injectedDeclaration.id,
        sourceId: injectedDeclaration.sourceId,
        sourceRevisionId: injectedDeclaration.sourceRevisionId,
        contentDigest: injectedDeclaration.contentDigest,
        action: "select-control",
        projectorId: "mcp-managed-settings",
        supportedTargets: ["claude"],
      },
    ];
    expect(
      assembleAuthoringCatalogBundleFromCompilerOutputsV1([injected]).assets[injectedDeclaration.id]
        ?.authoring.action,
    ).toBe("record-selection");

    const relationCollision = organizationInput("source:relations");
    const assetId = relationCollision.declarations[0]?.declaration.id;
    if (assetId === undefined) throw new Error("expected organization declaration");
    relationCollision.relations = [
      { fromAssetId: assetId, toAssetId: assetId, kind: "requires" },
      {
        toAssetId: assetId,
        membership: "optional",
        kind: "member",
        fromAssetId: assetId,
      },
    ];
    expect(() => assembleAuthoringCatalogBundleFromCompilerOutputsV1([relationCollision])).toThrow(
      /ambiguous catalog relation/,
    );
  });

  it("rejects generic compiler evidence that claims Core verification", () => {
    const input = organizationInput("source:untrusted-evidence");
    const declaration = input.declarations[0]?.declaration;
    if (declaration === undefined) throw new Error("expected organization declaration");
    input.evidence = {
      "evidence:untrusted": {
        id: "evidence:untrusted",
        projectionVersion: "evidence-summary/v1",
        subjects: [
          {
            assetId: declaration.id,
            sourceId: declaration.sourceId,
            sourceRevisionId: declaration.sourceRevisionId,
            contentDigest: declaration.contentDigest,
          },
        ],
        evidenceDigest: digest,
        coveredPaths: ["skills/triage/SKILL.md"],
        verification: {
          state: "verified",
          verifiedAt: "2026-01-01T00:00:00.000Z",
          contextDigest: digest,
          validUntil: "2026-01-02T00:00:00.000Z",
        },
        scan: { outcome: "pass", coverage: "complete" },
        qualification: { state: "qualified" },
        findings: [],
      },
    };
    expect(() => assembleAuthoringCatalogBundleFromCompilerOutputsV1([input])).toThrow(
      /untrusted compiler evidence/i,
    );
  });
  it("derives actions from the closed format policy rather than compiler data", () => {
    expect(actionForCompilerDeclarationV1("organization-authoring-manifest/v1", "mcp")).toBe(
      "record-request",
    );
    expect(actionForCompilerDeclarationV1("built-in/v1", "skill")).toBe("record-selection");
    expect(() =>
      actionForCompilerDeclarationV1("organization-authoring-manifest/v1", "hook"),
    ).toThrow(/unsupported compiler declaration kind/);
  });

  it("rejects duplicate exact Core capabilities instead of silently choosing one", () => {
    const capability = {
      assetId: declaration.id,
      sourceId: declaration.sourceId,
      sourceRevisionId: declaration.sourceRevisionId,
      contentDigest: declaration.contentDigest,
      action: "select-control" as const,
      projectorId: "mcp-managed-settings" as const,
      supportedTargets: ["claude" as const],
    };
    expect(() =>
      assemblyRegistryForCompiledDeclarationsV1(
        [{ declaration, inputFormat: "organization-authoring-manifest/v1" }],
        [capability, capability],
      ),
    ).toThrow(/ambiguous Core authoring capability/);
  });
});
