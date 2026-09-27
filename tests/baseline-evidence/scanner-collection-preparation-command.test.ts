import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  author: vi.fn(),
  prepareAih: vi.fn(),
  authorAih: vi.fn(),
  firstParty: vi.fn(),
  gitHead: vi.fn(),
  definitionCoverage: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: mocks.gitHead }));
vi.mock("../../src/baseline-evidence/aih-scan-preparation.js", () => ({
  prepareAihScannerPublicationsV1: mocks.prepareAih,
  authorPackagedAihScannerEvidenceRecordV1: mocks.authorAih,
}));
vi.mock("../../src/baseline-evidence/scanner-catalog-consumer.js", () => ({
  prepareRegisteredScannerCatalogV1: () => ({ catalog: {} }),
}));
vi.mock("../../src/baseline-evidence/scanner-definition.js", () => ({
  prepareDefinitionScannerCoverageV1: mocks.definitionCoverage,
}));
vi.mock("../../src/baseline-evidence/scanner-consumer.js", () => ({
  createCoreBaselineVetRequests: () => [{ requestSha256: "a".repeat(64) }],
}));
vi.mock("../../src/baseline-evidence/scanner-collection-preparation.js", () => ({
  prepareScannerCollectionPublicationsV1: mocks.prepare,
  authorPackagedScannerCollectionEvidenceRecordV1: mocks.author,
  SCANNER_COLLECTION_TOTAL_INPUT_MAX_BYTES_V1: 128 * 1024 * 1024,
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-v1.js", () => ({
  prepareAihFirstPartyCompilerQualificationsV1: mocks.firstParty,
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

it("accepts a new output under the current temp root and refuses to replace it", async () => {
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
  expect(mocks.definitionCoverage).not.toHaveBeenCalled();
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

it("writes a bounded, inert first-party candidate draft only from the same verified AIH handle", async () => {
  const current = fixture();
  current.args[1] = "aih";
  const qualificationOutput = join(join(current.output, ".."), "qualification.json");
  const handle = { kind: "opaque-aih-test-fixture" };
  mocks.gitHead.mockReturnValue("a".repeat(40));
  mocks.prepareAih.mockResolvedValue(handle);
  mocks.authorAih.mockReturnValue({
    bytes: '{"authority":"display-only","catalog":"aih"}',
    sha256: `sha256:${"b".repeat(64)}`,
  });
  mocks.firstParty.mockReturnValue({
    bindings: {
      "aih/code-review-graph": {
        format: "aih-compiler-qualification-binding",
        version: 1,
        fixture: true,
      },
      "aih/z": { format: "aih-compiler-qualification-binding", version: 1, fixture: "sorted" },
    },
    profiles: {
      "aih/code-review-graph": {
        bytes: Buffer.from('{"format":"first-party-profile"}'),
        sha256: `sha256:${"c".repeat(64)}`,
      },
      "aih/z": {
        bytes: Buffer.from('{"format":"sorted-profile"}'),
        sha256: `sha256:${"d".repeat(64)}`,
      },
    },
    unsupported: [{ assetId: "aih/usage-metering", reason: "unsupported-governance-subject-kind" }],
  });

  await expect(
    prepareWorkbenchCollectionEvidenceCommandV1([
      ...current.args,
      "--qualification-output",
      qualificationOutput,
    ]),
  ).resolves.toContain("no-authority first-party Catalog qualification candidate draft");
  expect(mocks.firstParty).toHaveBeenCalledWith(expect.anything(), handle);
  expect(JSON.parse(readFileSync(qualificationOutput, "utf8"))).toEqual({
    authority: "none",
    bindings: [
      { fixture: true, format: "aih-compiler-qualification-binding", version: 1 },
      { fixture: "sorted", format: "aih-compiler-qualification-binding", version: 1 },
    ],
    format: "aih-first-party-catalog-qualification-draft",
    profiles: [
      {
        assetId: "aih/code-review-graph",
        bytesBase64: Buffer.from('{"format":"first-party-profile"}').toString("base64"),
        sha256: `sha256:${"c".repeat(64)}`,
      },
      {
        assetId: "aih/z",
        bytesBase64: Buffer.from('{"format":"sorted-profile"}').toString("base64"),
        sha256: `sha256:${"d".repeat(64)}`,
      },
    ],
    purpose: "candidate-input-only",
    unsupported: [{ assetId: "aih/usage-metering", reason: "unsupported-governance-subject-kind" }],
    version: 1,
  });
});

it("preflights every output and writes neither artifact when first-party derivation fails", async () => {
  const current = fixture();
  current.args[1] = "aih";
  const qualificationOutput = join(join(current.output, ".."), "qualification.json");
  const handle = { kind: "opaque-aih-test-fixture" };
  mocks.gitHead.mockReturnValue("a".repeat(40));
  mocks.prepareAih.mockResolvedValue(handle);
  mocks.firstParty.mockReturnValue(undefined);
  await expect(
    prepareWorkbenchCollectionEvidenceCommandV1([
      ...current.args,
      "--qualification-output",
      qualificationOutput,
    ]),
  ).rejects.toThrow(/could not derive/);
  expect(existsSync(current.output)).toBe(false);
  expect(existsSync(qualificationOutput)).toBe(false);

  writeFileSync(qualificationOutput, "existing");
  await expect(
    prepareWorkbenchCollectionEvidenceCommandV1([
      ...current.args,
      "--qualification-output",
      qualificationOutput,
    ]),
  ).rejects.toThrow(/must not already exist/);
  expect(mocks.prepareAih).toHaveBeenCalledTimes(1);
});

it("rejects qualification output for non-AIH catalogs", async () => {
  const current = fixture();
  await expect(
    prepareWorkbenchCollectionEvidenceCommandV1([
      ...current.args,
      "--qualification-output",
      join(join(current.output, ".."), "qualification.json"),
    ]),
  ).rejects.toThrow(/Usage/);
});

it.skipIf(process.platform === "win32")(
  "rejects a symlinked output parent beneath the temporary anchor",
  async () => {
    const current = fixture();
    const parent = join(current.output, "..");
    const linkedParent = join(parent, "linked-output-parent");
    symlinkSync(parent, linkedParent, "dir");
    current.args[7] = join(linkedParent, "output.json");
    await expect(prepareWorkbenchCollectionEvidenceCommandV1(current.args)).rejects.toThrow(
      /real parent directory/,
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "win32")(
  "accepts an uppercased temporary output directory alias",
  async () => {
    const current = fixture();
    current.args[7] = join(dirname(current.output).toUpperCase(), basename(current.output));
    const handle = { kind: "opaque-test-fixture" };
    mocks.prepare.mockResolvedValue(handle);
    mocks.author.mockReturnValue({
      bytes: '{"authority":"display-only","fixture":true}',
      sha256: `sha256:${"a".repeat(64)}`,
    });
    await expect(prepareWorkbenchCollectionEvidenceCommandV1(current.args)).resolves.toContain(
      "Prepared sealed collection report",
    );
    expect(existsSync(current.output)).toBe(true);
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects Windows case aliases for the two output paths",
  async () => {
    const current = fixture();
    current.args[1] = "aih";
    const qualificationOutput = current.output.toUpperCase();
    await expect(
      prepareWorkbenchCollectionEvidenceCommandV1([
        ...current.args,
        "--qualification-output",
        qualificationOutput,
      ]),
    ).rejects.toThrow(/Usage/);
    expect(mocks.prepareAih).not.toHaveBeenCalled();
  },
);

describe("definition route (a pin the installed Catalog does not carry)", () => {
  const sealedReport = {
    bytes: '{"authority":"display-only","fixture":true}',
    sha256: `sha256:${"a".repeat(64)}`,
  };

  it("prepares coverage from the definition and candidate bundle and hands it to preparation", async () => {
    const current = fixture();
    const definition = join(current.batch, "..", "..", "definition.json");
    const bundle = join(current.batch, "..", "..", "bundle.json");
    const coverage = { catalog: { id: "mattpocock" }, coverage: {}, coverageDigest: "x" };
    mocks.gitHead.mockReturnValue(`${"c".repeat(40)}
`);
    mocks.definitionCoverage.mockReturnValue(coverage);
    mocks.prepare.mockResolvedValue({ kind: "opaque-test-fixture" });
    mocks.author.mockReturnValue(sealedReport);
    await expect(
      prepareWorkbenchCollectionEvidenceCommandV1([
        ...current.args,
        "--definition",
        definition,
        "--source-bundle",
        bundle,
      ]),
    ).resolves.toContain("Prepared sealed collection report");
    expect(mocks.definitionCoverage).toHaveBeenCalledWith({
      sourceRoot: current.args[3],
      catalogId: "mattpocock",
      definitionPath: resolve(definition),
      head: "c".repeat(40),
      sourceBundlePath: resolve(bundle),
    });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "mattpocock", coverage }),
    );
  });

  it("passes the assembled vendor lock for a framework", async () => {
    const current = fixture();
    current.args[1] = "superpowers";
    mocks.gitHead.mockReturnValue("c".repeat(40));
    mocks.definitionCoverage.mockReturnValue({ catalog: { id: "superpowers" } });
    mocks.prepare.mockResolvedValue({ kind: "opaque-test-fixture" });
    mocks.author.mockReturnValue(sealedReport);
    await prepareWorkbenchCollectionEvidenceCommandV1([
      ...current.args,
      "--vendor-lock",
      "lock.json",
      "--source-bundle",
      "bundle.json",
      "--definition",
      "definition.json",
    ]);
    expect(mocks.definitionCoverage).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "superpowers", vendorLockPath: resolve("lock.json") }),
    );
  });

  it.each(["disjoint", "compiler-catalog"] as const)(
    "forwards the named %s overlap mode to the definition coverage",
    async (overlap) => {
      const current = fixture();
      current.args[1] = "ecc";
      mocks.gitHead.mockReturnValue("c".repeat(40));
      mocks.definitionCoverage.mockReturnValue({ catalog: { id: "ecc" } });
      mocks.prepare.mockResolvedValue({ kind: "opaque-test-fixture" });
      mocks.author.mockReturnValue(sealedReport);
      await prepareWorkbenchCollectionEvidenceCommandV1([
        ...current.args,
        "--definition-overlap",
        overlap,
        "--definition",
        "definition.json",
        "--source-bundle",
        "bundle.json",
      ]);
      expect(mocks.definitionCoverage).toHaveBeenCalledWith({
        sourceRoot: current.args[3],
        catalogId: "ecc",
        definitionPath: resolve("definition.json"),
        head: "c".repeat(40),
        sourceBundlePath: resolve("bundle.json"),
        overlap,
      });
    },
  );

  it("stops before any publication is read when the definition is refused", async () => {
    const current = fixture();
    mocks.gitHead.mockReturnValue("c".repeat(40));
    mocks.definitionCoverage.mockImplementation(() => {
      throw new TypeError("baseline definition: the installed Catalog carries mattpocock@c");
    });
    await expect(
      prepareWorkbenchCollectionEvidenceCommandV1([
        ...current.args,
        "--definition",
        "d.json",
        "--source-bundle",
        "b.json",
      ]),
    ).rejects.toThrow(/installed Catalog carries/);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(existsSync(current.output)).toBe(false);
  });

  it.each([
    ["a definition without its candidate bundle", ["--definition", "d.json"]],
    ["a candidate bundle without its definition", ["--source-bundle", "b.json"]],
    ["a vendor lock without a definition", ["--vendor-lock", "l.json"]],
    ["an overlap mode without a definition", ["--definition-overlap", "compiler-catalog"]],
    [
      "an unknown overlap mode",
      ["--definition", "d.json", "--source-bundle", "b.json", "--definition-overlap", "any"],
    ],
    [
      "a repeated definition flag",
      ["--definition", "d.json", "--source-bundle", "b.json", "--definition", "e.json"],
    ],
    ["a flag without a value", ["--definition", "--source-bundle", "b.json"]],
    ["an unknown flag", ["--definition", "d.json", "--source-bundle", "b.json", "--x", "y"]],
  ])("rejects %s", async (_label, extra) => {
    const current = fixture();
    await expect(
      prepareWorkbenchCollectionEvidenceCommandV1([...current.args, ...extra]),
    ).rejects.toThrow(/Usage/);
    expect(mocks.definitionCoverage).not.toHaveBeenCalled();
  });

  it("rejects a definition for the AIH catalog", async () => {
    const current = fixture();
    current.args[1] = "aih";
    await expect(
      prepareWorkbenchCollectionEvidenceCommandV1([
        ...current.args,
        "--definition",
        "d.json",
        "--source-bundle",
        "b.json",
      ]),
    ).rejects.toThrow(/Usage/);
    expect(mocks.prepareAih).not.toHaveBeenCalled();
  });
});
