import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectionRecords: vi.fn(),
  encodeCollection: vi.fn(),
  readCollection: vi.fn(),
  reverifyAih: vi.fn(),
  reverifyExternal: vi.fn(),
  policyCatalog: vi.fn(),
  compileBuiltIn: vi.fn(),
  qualificationRecords: vi.fn(),
  qualificationProjections: vi.fn(),
  preparedCatalog: vi.fn(),
  prepareAih: vi.fn(),
  prepareExternal: vi.fn(),
  derivePackaged: vi.fn(),
  verifyQualification: vi.fn(),
  projectQualification: vi.fn(),
  projectionSchema: vi.fn(),
  publicEvidence: vi.fn(),
}));

vi.mock("../../src/baseline-evidence/aih-scan-preparation.js", () => ({
  reverifyPackagedAihScannerEvidenceRecordV1: mocks.reverifyAih,
}));
vi.mock("../../src/baseline-evidence/scanner-collection-preparation.js", () => ({
  reverifyPackagedScannerCollectionEvidenceRecordV1: mocks.reverifyExternal,
}));
vi.mock("../../src/org-policy/catalog.js", () => ({ policyAuthoringCatalog: mocks.policyCatalog }));
vi.mock("../../src/org-policy/packaged-collection-evidence-v1.js", () => ({
  encodePackagedScannerCollectionEvidenceRecordV1: mocks.encodeCollection,
  packagedScannerCollectionEvidenceV1: mocks.collectionRecords,
}));
vi.mock("../../src/org-policy/packaged-public-baseline-v1.js", () => ({
  packagedPublicBaselineEvidenceV1: mocks.publicEvidence,
}));
vi.mock("../../src/org-policy/workbench/compilers/built-in.js", () => ({
  compileBuiltInCatalogV1: mocks.compileBuiltIn,
}));
vi.mock("../../src/org-policy/workbench/contracts.js", () => ({
  CatalogQualificationSummariesV1Schema: { safeParse: mocks.projectionSchema },
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-package-v1.js", () => ({
  packagedCatalogQualificationProjectionsV1: mocks.qualificationProjections,
  packagedCatalogQualificationRecordsV1: mocks.qualificationRecords,
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-v1.js", () => ({
  catalogQualificationPackagedProjectionV1: mocks.projectQualification,
  prepareAihFirstPartyCompilerQualificationsV1: mocks.prepareAih,
  prepareRegisteredCompilerQualificationBindingsV1: mocks.prepareExternal,
  verifyCatalogQualificationForPackagingV1: mocks.verifyQualification,
}));
vi.mock("../../src/org-policy/workbench/prepared-catalog.js", () => ({
  defaultPreparedWorkbenchCatalog: mocks.preparedCatalog,
}));
vi.mock("../../src/internals/derive-packaged-source-qualification.js", () => ({
  derivePackagedSourceQualificationBindingsV1: mocks.derivePackaged,
}));
vi.mock("../../src/internals/prepare-workbench-collection-evidence.js", () => ({
  readWorkbenchCollectionPublicationMaterialV1: mocks.readCollection,
}));

import { verifyWorkbenchPublicPublicationV1 } from "../../src/internals/verify-workbench-publication.js";

const pin = "a".repeat(40);
const now = "2026-09-09T12:00:00.000Z";
const summary = { "aih/skill:example": { verifiedAt: now } };
const projection = { summary };
const sealed = { bytes: "{}", sha256: `sha256:${"b".repeat(64)}` };
const aihRecord = { catalog: { id: "aih", pinnedCommit: pin } };
const firstPartyBinding = { marker: "first-party" };
const packagedBinding = { marker: "packaged" };
const externalMaterial = [
  { catalogId: "mattpocock", sourceRoot: "acquired-s", publicationRoot: "publications" },
] as const;

function setAihCollection() {
  mocks.collectionRecords.mockReturnValue([aihRecord]);
  mocks.encodeCollection.mockReturnValue(sealed);
  mocks.readCollection.mockReturnValue({ batches: ["batch"] });
}

function setExternalCollection() {
  mocks.collectionRecords.mockReturnValue([{ catalog: { id: "mattpocock", pinnedCommit: pin } }]);
  mocks.encodeCollection.mockReturnValue(sealed);
  mocks.readCollection.mockReturnValue({ batches: ["batch"] });
  mocks.reverifyExternal.mockResolvedValue(undefined);
}

function setQualificationProjection() {
  mocks.qualificationRecords.mockReturnValue([{}]);
  mocks.qualificationProjections.mockReturnValue([projection]);
  mocks.projectionSchema.mockReturnValue({ success: true, data: summary });
  const prepared = { marker: "prepared-qualification" };
  mocks.verifyQualification.mockResolvedValue(prepared);
  mocks.projectQualification.mockReturnValue(projection);
}

describe("release first-party AIH Catalog qualification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.collectionRecords.mockReturnValue([]);
    mocks.publicEvidence.mockReturnValue(undefined);
    mocks.policyCatalog.mockReturnValue({ marker: "authoring-catalog" });
    mocks.compileBuiltIn.mockReturnValue({ marker: "compiled-built-in" });
    mocks.preparedCatalog.mockReturnValue({ bundle: { marker: "final-bundle" } });
    mocks.derivePackaged.mockReturnValue({});
    mocks.prepareExternal.mockReturnValue({});
    setQualificationProjection();
  });

  it("derives AIH-only bindings from the genuine reverify handle without external roots", async () => {
    setAihCollection();
    const handle = { marker: "opaque-prepared-aih" };
    mocks.reverifyAih.mockResolvedValue(handle);
    mocks.prepareAih.mockReturnValue({ bindings: { "aih/skill:example": firstPartyBinding } });

    await verifyWorkbenchPublicPublicationV1({
      now,
      collectionMaterial: [
        { catalogId: "aih", sourceRoot: "acquired-s", publicationRoot: "publications" },
      ],
    });

    expect(mocks.reverifyAih).toHaveBeenCalledWith(
      expect.objectContaining({
        packageRoot: "acquired-s",
        coreRevision: { pinnedSha: pin },
        now,
        sealed,
      }),
    );
    expect(mocks.prepareAih).toHaveBeenCalledWith({ marker: "final-bundle" }, handle);
    expect(mocks.verifyQualification).toHaveBeenCalledWith(
      { marker: "final-bundle" },
      { "aih/skill:example": firstPartyBinding },
      now,
      now,
    );
  });

  it("permits package-only bindings without external roots", async () => {
    setExternalCollection();
    mocks.derivePackaged.mockReturnValue({ "aih/skill:example": packagedBinding });
    const packageMaterial = [{ sourceId: "source:package" }];

    await verifyWorkbenchPublicPublicationV1({
      now,
      packagedSourceQualification: packageMaterial as never,
      collectionMaterial: externalMaterial,
    });

    expect(mocks.derivePackaged).toHaveBeenCalledWith({ marker: "final-bundle" }, packageMaterial);
    expect(mocks.verifyQualification).toHaveBeenCalledWith(
      { marker: "final-bundle" },
      { "aih/skill:example": packagedBinding },
      now,
      now,
    );
  });

  it("fails closed when AIH and package material overlap an asset binding", async () => {
    setAihCollection();
    mocks.reverifyAih.mockResolvedValue({ marker: "opaque-prepared-aih" });
    mocks.prepareAih.mockReturnValue({ bindings: { "aih/skill:example": firstPartyBinding } });
    mocks.derivePackaged.mockReturnValue({ "aih/skill:example": packagedBinding });

    await expect(
      verifyWorkbenchPublicPublicationV1({
        now,
        collectionMaterial: [
          { catalogId: "aih", sourceRoot: "acquired-s", publicationRoot: "publications" },
        ],
      }),
    ).rejects.toThrow(/overlaps an asset binding/);
    expect(mocks.verifyQualification).not.toHaveBeenCalled();
  });

  it("leaves missing bindings to the exact qualification verifier", async () => {
    setExternalCollection();
    mocks.verifyQualification.mockRejectedValue(new Error("missing exact qualification binding"));

    await expect(
      verifyWorkbenchPublicPublicationV1({ now, collectionMaterial: externalMaterial }),
    ).rejects.toThrow(/missing exact qualification binding/);
    expect(mocks.verifyQualification).toHaveBeenCalledWith(
      { marker: "final-bundle" },
      {},
      now,
      now,
    );
  });
});
