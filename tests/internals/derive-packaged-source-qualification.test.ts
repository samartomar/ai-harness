import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  baseline: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  subjects: vi.fn(),
  qualificationMaterial: vi.fn(),
  bindings: vi.fn(),
}));

vi.mock("../../src/contract/strict-json-v1.js", () => ({
  canonicalStrictJsonSha256V1: (value: unknown) => JSON.stringify(value),
}));
vi.mock("../../src/baseline-evidence/scanner-provider-catalogs.js", () => ({
  prepareCollectionScannerCoverageV1: mocks.collection,
}));
vi.mock("../../src/baseline-evidence/source-data-baseline-preparation.js", () => ({
  prepareSourceDataBaselineCoverageV1: mocks.baseline,
}));
vi.mock("../../src/internals/bounded-github-source-archive.js", () => ({
  assertAcquiredGithubSourceRootV1: mocks.archive,
}));
vi.mock("../../src/internals/workbench-source-data-material.js", () => ({
  restoreSourceCompilerTemplateV1: mocks.restore,
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-v1.js", () => ({
  registeredCoverageGovernanceSubjectsV1: mocks.subjects,
  qualificationMaterialCoverageFromRegisteredCoverageV1: mocks.qualificationMaterial,
  compilerQualificationBindingsFromRegisteredCoverageV1: mocks.bindings,
}));
vi.mock("../../src/org-policy/workbench/core/packaged-source-data-record.js", () => ({
  PackagedSourceDataRecordV1Schema: { parse: (value: unknown) => value },
}));

import { derivePackagedSourceQualificationBindingsV1 } from "../../src/internals/derive-packaged-source-qualification.js";

const sourceId = "source:acme";
const source = {
  upstreamOrigin: { kind: "git", locator: "https://github.com/acme/skills" },
  revision: { id: "a".repeat(40) },
};
const bundle = { sources: { [sourceId]: source } } as never;
const record = {
  source: { repository: "acme/skills", commit: "a".repeat(40) },
  sourceBundle: { sources: { [sourceId]: source } },
  compilerTemplate: { any: "template" },
};
const coverage = { source: { id: sourceId }, components: [], unmappedDerivedAssets: [] };

describe("packaged-source qualification derivation", () => {
  function arrange(version: string) {
    vi.resetAllMocks();
    mocks.archive.mockReturnValue(true);
    mocks.restore.mockReturnValue({ version });
    mocks.collection.mockReturnValue({ coverage });
    mocks.baseline.mockReturnValue({ coverage });
    mocks.subjects.mockReturnValue({ "acme/skill": { subject: true } });
    mocks.qualificationMaterial.mockReturnValue({ qualified: true });
    mocks.bindings.mockReturnValue({ "acme/skill": { binding: true } });
  }

  it("derives a collection binding from restored package material without a provider-name allowlist", () => {
    arrange("pinned-component-collection/v1");
    expect(
      derivePackagedSourceQualificationBindingsV1(bundle, [
        { sourceId, sourceRoot: "C:/sealed/acme", record: record as never },
      ]),
    ).toEqual({ "acme/skill": { binding: true } });
    expect(mocks.collection).toHaveBeenCalledWith("C:/sealed/acme", {
      version: "pinned-component-collection/v1",
    });
    expect(mocks.baseline).not.toHaveBeenCalled();
    expect(mocks.qualificationMaterial).toHaveBeenCalledWith("C:/sealed/acme", coverage);
  });

  it("uses the baseline compiler route and rejects malformed compiler versions", () => {
    arrange("pinned-baseline/v1");
    derivePackagedSourceQualificationBindingsV1(bundle, [
      { sourceId, sourceRoot: "C:/sealed/acme", record: record as never },
    ]);
    expect(mocks.baseline).toHaveBeenCalledWith("C:/sealed/acme", {
      version: "pinned-baseline/v1",
    });
    arrange("unrecognized/v1");
    expect(() =>
      derivePackagedSourceQualificationBindingsV1(bundle, [
        { sourceId, sourceRoot: "C:/sealed/acme", record: record as never },
      ]),
    ).toThrow(/Unsupported/);
  });

  it("rejects a source mismatch or an archive without same-process custody", () => {
    arrange("pinned-component-collection/v1");
    mocks.archive.mockReturnValue(false);
    expect(() =>
      derivePackagedSourceQualificationBindingsV1(bundle, [
        { sourceId, sourceRoot: "C:/sealed/acme", record: record as never },
      ]),
    ).toThrow(/custody/);
    mocks.archive.mockReturnValue(true);
    expect(() =>
      derivePackagedSourceQualificationBindingsV1(bundle, [
        {
          sourceId,
          sourceRoot: "C:/sealed/acme",
          record: {
            ...record,
            source: { repository: "evil/skills", commit: "a".repeat(40) },
          } as never,
        },
      ]),
    ).toThrow(/custody/);
  });
});
