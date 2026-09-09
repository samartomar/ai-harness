import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  author: vi.fn(),
  prepareAih: vi.fn(),
  authorAih: vi.fn(),
  gitHead: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: mocks.gitHead }));
vi.mock("../../src/baseline-evidence/aih-scan-preparation.js", () => ({
  prepareAihScannerPublicationsV1: mocks.prepareAih,
  authorPackagedAihScannerEvidenceRecordV1: mocks.authorAih,
}));
vi.mock("../../src/baseline-evidence/scanner-provider-catalogs.js", () => ({
  prepareRegisteredScannerCatalogV1: () => ({ catalog: {} }),
}));
vi.mock("../../src/baseline-evidence/scanner-consumer.js", () => ({
  createCoreBaselineVetRequests: () => [{ requestSha256: "a".repeat(64) }],
}));
vi.mock("../../src/baseline-evidence/scanner-collection-preparation.js", () => ({
  prepareScannerCollectionPublicationsV1: mocks.prepare,
  authorPackagedScannerCollectionEvidenceRecordV1: mocks.author,
  SCANNER_COLLECTION_TOTAL_INPUT_MAX_BYTES_V1: 128 * 1024 * 1024,
}));

import { prepareWorkbenchCollectionEvidenceCommandV1 } from "../../src/internals/prepare-workbench-collection-evidence.js";

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-collection-command-"));
  roots.push(root);
  const publications = join(root, "publications");
  const batch = join(publications, "batch-001");
  mkdirSync(batch, { recursive: true });
  for (const name of ["publication.json", "discovery.json", "inspection.json", "SHA256SUMS"])
    writeFileSync(join(batch, name), "fixture transport bytes");
  const output = join(root, "output.json");
  return {
    batch,
    output,
    args: [
      "--catalog",
      "mattpocock",
      "--source",
      root,
      "--publication-root",
      publications,
      "--output",
      output,
    ],
  };
}

it("writes only the operational author's output and refuses to replace an existing file", async () => {
  const current = fixture();
  const handle = { kind: "opaque-test-fixture" };
  mocks.prepare.mockResolvedValue(handle);
  mocks.author.mockReturnValue({
    bytes: '{"authority":"display-only","fixture":true}',
    sha256: `sha256:${"a".repeat(64)}`,
  });
  expect(await prepareWorkbenchCollectionEvidenceCommandV1(current.args)).toContain(
    "No scan, signing, publication, or qualification",
  );
  expect(mocks.author).toHaveBeenCalledWith(handle);
  expect(JSON.parse(readFileSync(current.output, "utf8"))).toEqual({
    bytes: '{"authority":"display-only","fixture":true}',
    sha256: `sha256:${"a".repeat(64)}`,
  });
  const before = readFileSync(current.output);
  await expect(prepareWorkbenchCollectionEvidenceCommandV1(current.args)).rejects.toThrow(/EEXIST/);
  expect(readFileSync(current.output)).toEqual(before);
});

it("cannot turn a missing operational witness into an output artifact", async () => {
  const current = fixture();
  mocks.prepare.mockResolvedValue({ kind: "opaque-test-fixture" });
  mocks.author.mockReturnValue(undefined);
  await expect(prepareWorkbenchCollectionEvidenceCommandV1(current.args)).rejects.toThrow(
    /custody/,
  );
  expect(existsSync(current.output)).toBe(false);
});

it("rejects extra attestation inputs and oversized files before operational preparation", async () => {
  const current = fixture();
  writeFileSync(join(current.batch, "attestation.json"), "untrusted supplied claim");
  await expect(prepareWorkbenchCollectionEvidenceCommandV1(current.args)).rejects.toThrow(
    /four-file/,
  );
  rmSync(join(current.batch, "attestation.json"));
  writeFileSync(join(current.batch, "discovery.json"), Buffer.alloc(8193));
  await expect(prepareWorkbenchCollectionEvidenceCommandV1(current.args)).rejects.toThrow(
    /bounded/,
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(existsSync(current.output)).toBe(false);
});

it("rejects a caller-selected provider or duplicate flags", async () => {
  await expect(
    prepareWorkbenchCollectionEvidenceCommandV1([
      "--catalog",
      "unknown",
      "--source",
      ".",
      "--publication-root",
      ".",
      "--output",
      "unused.json",
    ]),
  ).rejects.toThrow(/Usage/);
  await expect(
    prepareWorkbenchCollectionEvidenceCommandV1([
      "--catalog",
      "mattpocock",
      "--source",
      ".",
      "--source",
      ".",
      "--output",
      "unused.json",
    ]),
  ).rejects.toThrow(/Usage/);
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("routes the AIH catalog through its dedicated materializer and common sealed author", async () => {
  const current = fixture();
  current.args[1] = "aih";
  const handle = { kind: "opaque-aih-test-fixture" };
  mocks.gitHead.mockReturnValue("a".repeat(40));
  mocks.prepareAih.mockResolvedValue(handle);
  mocks.authorAih.mockReturnValue({
    bytes: '{"authority":"display-only","catalog":"aih"}',
    sha256: `sha256:${"b".repeat(64)}`,
  });

  await expect(prepareWorkbenchCollectionEvidenceCommandV1(current.args)).resolves.toContain(
    "Prepared sealed collection report",
  );
  expect(mocks.prepareAih).toHaveBeenCalledWith(
    expect.objectContaining({
      packageRoot: current.args[3],
      coreRevision: { pinnedSha: "a".repeat(40) },
      batches: [{ discoveryBytes: expect.any(Buffer), publicationBytes: expect.any(Buffer) }],
    }),
  );
  expect(mocks.authorAih).toHaveBeenCalledWith(handle);
});
