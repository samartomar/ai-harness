import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 } from "../../src/baseline-evidence/scanner-publication-policy.js";

const mocks = vi.hoisted(() => ({
  records: vi.fn(),
  bindings: vi.fn(),
  catalog: vi.fn(),
  acquire: vi.fn(),
  forget: vi.fn(),
  verify: vi.fn(),
  verifyPackaged: vi.fn(),
  sourceData: vi.fn(),
  materialize: vi.fn(),
  equivalence: vi.fn(),
  removeMaterial: vi.fn(),
  policyCatalog: vi.fn(),
  compileBuiltIn: vi.fn(),
  git: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.git,
}));
vi.mock("../../src/baseline-evidence/aih-scan-material.js", () => ({
  assertAihScanMaterialEquivalenceV1: mocks.equivalence,
  materializeAihScanSubjectsV1: mocks.materialize,
  removeMaterializedAihScanSubjectsV1: mocks.removeMaterial,
}));
vi.mock("../../src/org-policy/catalog.js", () => ({
  policyAuthoringCatalog: mocks.policyCatalog,
}));
vi.mock("../../src/org-policy/workbench/compilers/built-in.js", () => ({
  compileBuiltInCatalogV1: mocks.compileBuiltIn,
}));
vi.mock("../../src/org-policy/packaged-collection-evidence-v1.js", () => ({
  packagedScannerCollectionEvidenceV1: mocks.records,
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-package-v1.js", () => ({
  packagedCatalogQualificationBindingsV1: mocks.bindings,
}));
vi.mock("../../src/org-policy/workbench/prepared-catalog.js", () => ({
  defaultPreparedWorkbenchCatalog: mocks.catalog,
}));
vi.mock("../../src/internals/bounded-github-source-archive.js", () => ({
  acquireBoundedGithubSourceArchiveV1: mocks.acquire,
  forgetAcquiredGithubSourceArchiveV1: mocks.forget,
}));
vi.mock("../../src/internals/verify-workbench-publication.js", () => ({
  verifyWorkbenchPublicPublicationV1: mocks.verify,
}));
vi.mock("../../src/internals/verify-packaged-workbench-source-data.js", () => ({
  verifyPackagedWorkbenchSourceDataV1: mocks.verifyPackaged,
}));
vi.mock("../../src/org-policy/workbench/core/packaged-source-data.js", () => ({
  packagedWorkbenchSourceDataRecordsV1: mocks.sourceData,
}));

import {
  verifyWorkbenchPublicPublicationWithMaterialsV1,
  workbenchPublicationMaterialTargetsV1,
} from "../../src/internals/verify-workbench-publication-with-materials.js";

const pin = "a".repeat(40);
const releasePin = "c".repeat(40);
const request = "b".repeat(64);
const locator = `https://github.com/${SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.repository}/releases/download/baseline-v1-${SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.commit}-${request}-r00000001/publication.json`;
function aihFixture() {
  mocks.records.mockReturnValue([
    {
      catalog: {
        source: { id: "source:aih-core" },
        repository: "samartomar/ai-harness",
        pinnedCommit: pin,
      },
      publications: [],
    },
  ]);
  mocks.catalog.mockReturnValue({
    bundle: {
      sources: {
        "source:aih-core": {
          upstreamOrigin: { kind: "git", locator: "https://github.com/samartomar/ai-harness" },
          revision: { id: pin },
        },
      },
    },
  });
}
function sourceFixture(publicationLocator = locator) {
  mocks.records.mockReturnValue([
    {
      catalog: {
        source: { id: "source:mattpocock" },
        repository: "mattpocock/skills",
        pinnedCommit: pin,
      },
      publications: [
        {
          repository: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.repository,
          sourceCommit: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.commit,
          requestSha256: request,
          publicationLocator,
        },
      ],
    },
  ]);
  mocks.catalog.mockReturnValue({
    bundle: {
      sources: {
        "source:mattpocock": {
          upstreamOrigin: { kind: "git", locator: "https://github.com/mattpocock/skills" },
          revision: { id: pin },
        },
      },
    },
  });
}
describe("release-only pinned publication material acquisition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.records.mockReturnValue([]);
    mocks.bindings.mockReturnValue([]);
    mocks.sourceData.mockReturnValue([]);
    mocks.policyCatalog.mockReturnValue({ marker: "current-catalog" });
    mocks.compileBuiltIn.mockReturnValue({ marker: "current-compiler" });
    mocks.git.mockImplementation((_command, args: readonly string[]) =>
      args.includes("rev-parse") ? `${releasePin}\n` : "",
    );
    mocks.catalog.mockReturnValue({ bundle: { sources: {} } });
    mocks.acquire.mockImplementation(async ({ destination }) => {
      mkdirSync(destination, { recursive: true });
      return destination;
    });
    mocks.verify.mockResolvedValue(undefined);
    mocks.verifyPackaged.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("transport bytes")),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it("does no acquisition when no package material is claimed", async () => {
    await verifyWorkbenchPublicPublicationWithMaterialsV1();
    expect(mocks.verify).toHaveBeenCalledWith();
    expect(mocks.verifyPackaged).toHaveBeenCalledOnce();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stops release verification if packaged source proof replay fails", async () => {
    mocks.verifyPackaged.mockRejectedValue(new Error("required analyzer missing"));
    await expect(verifyWorkbenchPublicPublicationWithMaterialsV1()).rejects.toThrow(
      "required analyzer missing",
    );
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it("fetches an exact registered commit and renewal, verifies real paths, then removes temporary material", async () => {
    sourceFixture();
    let checkout = "";
    mocks.verify.mockImplementation(async (options) => {
      const material = options.collectionMaterial[0];
      checkout = material.sourceRoot;
      expect(material.catalogId).toBe("mattpocock");
      expect(
        readFileSync(join(material.publicationRoot, "batch-001", "publication.json"), "utf8"),
      ).toBe("transport bytes");
      expect(options.catalogQualification).toEqual([
        { sourceRoot: checkout, providerId: "mattpocock" },
      ]);
    });
    await verifyWorkbenchPublicPublicationWithMaterialsV1();
    expect(mocks.acquire).toHaveBeenCalledWith({
      repository: "mattpocock/skills",
      commit: pin,
      destination: checkout,
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenCalledWith(locator, expect.objectContaining({ redirect: "follow" }));
    expect(checkout).not.toBe("");
    expect(mocks.forget).toHaveBeenCalledWith(checkout);
    expect(existsSync(checkout)).toBe(false);
  });
  it("requires clean-checkout AIH material equivalence before release re-verification", async () => {
    aihFixture();
    const scanned = { sourceRoot: "scanned-material" } as never;
    const release = { sourceRoot: "release-material" } as never;
    mocks.materialize.mockReturnValueOnce(scanned).mockReturnValueOnce(release);
    await verifyWorkbenchPublicPublicationWithMaterialsV1();
    const checkout = mocks.acquire.mock.calls[0]?.[0]?.destination;
    expect(checkout).toEqual(expect.any(String));
    expect(mocks.materialize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        packageRoot: checkout,
        coreRevision: { pinnedSha: pin },
        catalog: { marker: "current-catalog" },
        compiled: { marker: "current-compiler" },
      }),
    );
    expect(mocks.materialize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        coreRevision: { pinnedSha: releasePin },
        catalog: { marker: "current-catalog" },
        compiled: { marker: "current-compiler" },
      }),
    );
    expect(mocks.equivalence).toHaveBeenCalledWith(scanned, release);
    expect(mocks.removeMaterial).toHaveBeenNthCalledWith(1, release);
    expect(mocks.removeMaterial).toHaveBeenNthCalledWith(2, scanned);
    expect(mocks.verify).toHaveBeenCalledOnce();
  });
  it("stops before publication re-verification when AIH material differs", async () => {
    aihFixture();
    const scanned = { sourceRoot: "scanned-material" } as never;
    const release = { sourceRoot: "release-material" } as never;
    mocks.materialize.mockReturnValueOnce(scanned).mockReturnValueOnce(release);
    mocks.equivalence.mockImplementation(() => {
      throw new Error("release material differs from scanned material");
    });
    await expect(verifyWorkbenchPublicPublicationWithMaterialsV1()).rejects.toThrow(
      /release material differs/,
    );
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.removeMaterial).toHaveBeenNthCalledWith(1, release);
    expect(mocks.removeMaterial).toHaveBeenNthCalledWith(2, scanned);
  });
  it("rejects arbitrary fetch hosts, wrong renewal tags and unpinned source revisions before acquisition", async () => {
    for (const invalid of [
      "https://evil.example/publication.json",
      locator.replace("00000001", "latest"),
      locator.replace(request, "c".repeat(64)),
    ]) {
      sourceFixture(invalid);
      await expect(verifyWorkbenchPublicPublicationWithMaterialsV1()).rejects.toThrow(/immutable/);
    }
    sourceFixture();
    mocks.catalog.mockReturnValue({
      bundle: {
        sources: {
          "source:mattpocock": {
            upstreamOrigin: { kind: "git", locator: "mattpocock/skills" },
            revision: { id: "main" },
          },
        },
      },
    });
    expect(workbenchPublicationMaterialTargetsV1()[0]?.pin).toBe(pin);
    const records = mocks.records();
    records[0].catalog.pinnedCommit = "main";
    expect(workbenchPublicationMaterialTargetsV1).toThrow(/exact registered/);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("acquires an unlisted packaged source and passes its compiler material for live derivation", async () => {
    const sourceId = "source:acme-skills";
    const record = {
      source: { repository: "acme/skills", commit: pin },
      sourceBundle: { sources: { [sourceId]: { marker: "packaged" } } },
      compilerTemplate: { version: "pinned-component-collection/v1" },
    };
    mocks.sourceData.mockReturnValue([record]);
    mocks.catalog.mockReturnValue({
      bundle: {
        sources: {
          [sourceId]: {
            upstreamOrigin: { kind: "git", locator: "https://github.com/acme/skills" },
            revision: { id: pin },
          },
        },
      },
    });
    let checkout = "";
    mocks.verify.mockImplementation(async (options) => {
      const material = options.packagedSourceQualification;
      expect(material).toHaveLength(1);
      expect(material[0]?.sourceId).toBe(sourceId);
      expect(material[0]?.record).toBe(record);
      checkout = material[0]?.sourceRoot ?? "";
      expect(options.catalogQualification).toEqual([]);
    });
    await verifyWorkbenchPublicPublicationWithMaterialsV1();
    expect(mocks.acquire).toHaveBeenCalledWith({
      repository: "acme/skills",
      commit: pin,
      destination: checkout,
    });
    expect(checkout).not.toBe("");
  });
  it("rejects a packaged source whose commit or repository does not match the displayed bundle", () => {
    const sourceId = "source:acme-skills";
    mocks.sourceData.mockReturnValue([
      {
        source: { repository: "acme/skills", commit: pin },
        sourceBundle: { sources: { [sourceId]: {} } },
      },
    ]);
    mocks.catalog.mockReturnValue({
      bundle: {
        sources: {
          [sourceId]: {
            upstreamOrigin: { kind: "git", locator: "https://github.com/acme/skills" },
            revision: { id: "c".repeat(40) },
          },
        },
      },
    });
    expect(workbenchPublicationMaterialTargetsV1).toThrow(/does not match/);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it("stops on fetch failure or oversized transport before publication verification", async () => {
    sourceFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(9_000))),
    );
    await expect(verifyWorkbenchPublicPublicationWithMaterialsV1()).rejects.toThrow(/byte bound/);
    expect(mocks.verify).not.toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    await expect(verifyWorkbenchPublicPublicationWithMaterialsV1()).rejects.toThrow(
      /could not be downloaded/,
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
