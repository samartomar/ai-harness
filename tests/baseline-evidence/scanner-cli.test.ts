import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  baselineCatalogById: vi.fn(),
  canonicalRequest: vi.fn(),
  consumePublication: vi.fn(),
  consumePublications: vi.fn(),
  createRequests: vi.fn(),
  execFileSync: vi.fn(),
  generatePreview: vi.fn(),
  lockParse: vi.fn(),
  sourceParse: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("@aihq/scan", () => ({
  canonicalBaselineVetRequestV1Bytes: mocks.canonicalRequest,
}));
vi.mock("../../src/baseline-evidence/catalogs.js", () => ({
  baselineCatalogById: mocks.baselineCatalogById,
}));
vi.mock("../../src/baseline-evidence/ecc-preview-boundary.js", () => ({
  generateAuthorizedEccInstallPreview: mocks.generatePreview,
}));
vi.mock("../../src/baseline-evidence/scanner-consumer.js", () => ({
  createCoreBaselineVetRequests: mocks.createRequests,
}));
vi.mock("../../src/baseline-evidence/scanner-publication.js", () => ({
  SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1: 604800,
  SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1: {
    repository: "samartomar/aih-scan",
    workflow: "samartomar/aih-scan/.github/workflows/baseline-publication.yml",
    ref: "refs/heads/main",
    commit: "ba0f0bfc46f2634da71e125bf3bbcefb3493389c",
  },
  consumeScannerBaselinePublicationV1: mocks.consumePublication,
  consumeScannerBaselinePublicationsV1: mocks.consumePublications,
}));
vi.mock("../../src/baseline-evidence/schema.js", () => ({
  BaselineSourceEvidenceSchema: { parse: mocks.sourceParse },
  parseBaselineEvidenceLock: mocks.lockParse,
}));

import { runScannerBridge } from "../../src/baseline-evidence/scanner-cli.js";

const PIN = "a".repeat(40);

let root: string;
let stdout: ReturnType<typeof vi.spyOn>;

function makeDirectory(name: string): string {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-scanner-bridge-"));
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  mocks.execFileSync.mockReturnValue(`${PIN}\n`);
  mocks.baselineCatalogById.mockImplementation((id: string) => ({
    id,
    owner: "samartomar",
    repo: id === "ecc" ? "ECC" : "Superpowers",
    pinnedSha: PIN,
    components: [],
  }));
  mocks.canonicalRequest.mockImplementation((value: unknown) =>
    Buffer.from(`${JSON.stringify(value)}\n`),
  );
  mocks.sourceParse.mockImplementation((value: unknown) => value);
  mocks.lockParse.mockImplementation((value: unknown) => value);
  mocks.generatePreview.mockReturnValue({ format: "aih-ecc-install-preview", version: 1 });
});

afterEach(() => {
  stdout.mockRestore();
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("baseline Scanner bridge CLI", () => {
  it("authors contiguous immutable request batches for the exact catalog checkout", async () => {
    const source = makeDirectory("source");
    const output = join(root, "requests");
    mocks.createRequests.mockReturnValue([
      { requestSha256: "1".repeat(64) },
      { requestSha256: "2".repeat(64) },
    ]);

    await runScannerBridge(["request", "--catalog", "ecc", "--source", source, "--output", output]);

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", source, "rev-parse", "HEAD"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(readFileSync(join(output, "batch-001.request.json"), "utf8")).toContain("1".repeat(64));
    expect(readFileSync(join(output, "batch-002.request.json"), "utf8")).toContain("2".repeat(64));
    expect(stdout).toHaveBeenCalledWith("authored 2 bounded Scanner request(s)\n");
  });

  it("rejects ambiguous flags, unknown commands, and a checkout at the wrong commit", async () => {
    await expect(runScannerBridge([])).rejects.toThrow(
      "baseline Scanner bridge: expected request, consume-publication, consume-publications, or assemble",
    );
    await expect(runScannerBridge(["consume"])).rejects.toThrow(
      "baseline Scanner bridge: expected request, consume-publication, consume-publications, or assemble",
    );
    await expect(
      runScannerBridge(["request", "--catalog", "ecc", "--catalog", "ecc"]),
    ).rejects.toThrow("--catalog must appear exactly once");
    await expect(runScannerBridge(["request", "--catalog", "--source"])).rejects.toThrow(
      "--catalog requires a value",
    );

    const source = makeDirectory("wrong-source");
    mocks.execFileSync.mockReturnValueOnce(`${"c".repeat(40)}\n`);
    await expect(
      runScannerBridge([
        "request",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--output",
        join(root, "wrong-output"),
      ]),
    ).rejects.toThrow(`ecc checkout is ${"c".repeat(40)}, expected ${PIN}`);
  });

  it("consumes independently published bytes with the pinned Scanner publisher", async () => {
    const source = makeDirectory("published-source");
    const discovery = join(root, "discovery.json");
    const publication = join(root, "publication.json");
    const attestation = join(root, "attestation.json");
    const output = join(root, "published-source-evidence.json");
    const provenanceOutput = join(root, "published-provenance.json");
    writeFileSync(discovery, '{"discovery":1}');
    writeFileSync(publication, '{"publication":1}');
    writeFileSync(attestation, '[{"attestation":1}]');
    mocks.consumePublication.mockResolvedValue({
      evidence: { id: "ecc", pinnedSha: PIN, components: [] },
      provenance: {
        authority: "none",
        sourceCommit: "ba0f0bfc46f2634da71e125bf3bbcefb3493389c",
      },
    });

    await runScannerBridge([
      "consume-publication",
      "--catalog",
      "ecc",
      "--source",
      source,
      "--discovery",
      discovery,
      "--publication",
      publication,
      "--attestation",
      attestation,
      "--request-sha256",
      "d".repeat(64),
      "--output",
      output,
      "--provenance-output",
      provenanceOutput,
    ]);

    expect(mocks.consumePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRoot: source,
        expectedRequestSha256: "d".repeat(64),
        discoveryBytes: Buffer.from('{"discovery":1}'),
        publicationBytes: Buffer.from('{"publication":1}'),
        attestationResultBytes: Buffer.from('[{"attestation":1}]'),
        maxAgeSeconds: 604800,
        publisher: expect.objectContaining({
          commit: "ba0f0bfc46f2634da71e125bf3bbcefb3493389c",
        }),
      }),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ id: "ecc" });
    expect(JSON.parse(readFileSync(provenanceOutput, "utf8"))).toMatchObject({
      authority: "none",
    });
    expect(stdout).toHaveBeenCalledWith(`consumed published ecc@${PIN}\n`);
  });

  it("consumes a closed contiguous set of independently published batches", async () => {
    const source = makeDirectory("published-batch-source");
    const publicationRoot = makeDirectory("published-batches");
    const output = join(root, "published-batch-evidence.json");
    const provenanceOutput = join(root, "published-batch-provenance.json");
    const requestDigests = ["1".repeat(64), "2".repeat(64)];
    mocks.createRequests.mockReturnValue(
      requestDigests.map((requestSha256) => ({ requestSha256 })),
    );
    for (const [index, requestSha256] of requestDigests.entries()) {
      const batch = join(publicationRoot, `batch-${String(index + 1).padStart(3, "0")}`);
      mkdirSync(batch);
      writeFileSync(join(batch, "discovery.json"), `{"request":"${requestSha256}"}`);
      writeFileSync(join(batch, "publication.json"), `{"batch":${index + 1}}`);
      writeFileSync(join(batch, "attestation.json"), `[{"batch":${index + 1}}]`);
    }
    mocks.consumePublications.mockResolvedValue({
      evidence: { id: "ecc", pinnedSha: PIN, components: [] },
      provenance: requestDigests.map((requestSha256) => ({ requestSha256 })),
    });

    await runScannerBridge([
      "consume-publications",
      "--catalog",
      "ecc",
      "--source",
      source,
      "--publication-root",
      publicationRoot,
      "--output",
      output,
      "--provenance-output",
      provenanceOutput,
    ]);

    expect(mocks.consumePublications).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRoot: source,
        publications: requestDigests.map((expectedRequestSha256, index) => ({
          expectedRequestSha256,
          discoveryBytes: Buffer.from(`{"request":"${expectedRequestSha256}"}`),
          publicationBytes: Buffer.from(`{"batch":${index + 1}}`),
          attestationResultBytes: Buffer.from(`[{"batch":${index + 1}}]`),
        })),
      }),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ id: "ecc" });
    expect(JSON.parse(readFileSync(provenanceOutput, "utf8"))).toHaveLength(2);
    expect(stdout).toHaveBeenCalledWith(`consumed 2 published ecc batch(es)@${PIN}\n`);
  });

  it("rejects extra entries in a publication batch set", async () => {
    const source = makeDirectory("closed-batch-source");
    const publicationRoot = makeDirectory("closed-batches");
    const batch = join(publicationRoot, "batch-001");
    mkdirSync(batch);
    writeFileSync(join(batch, "discovery.json"), "{}");
    writeFileSync(join(batch, "publication.json"), "{}");
    writeFileSync(join(batch, "attestation.json"), "[]");
    writeFileSync(join(publicationRoot, "unexpected.json"), "{}");
    mocks.createRequests.mockReturnValue([{ requestSha256: "1".repeat(64) }]);

    await expect(
      runScannerBridge([
        "consume-publications",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--publication-root",
        publicationRoot,
        "--output",
        join(root, "closed-evidence.json"),
        "--provenance-output",
        join(root, "closed-provenance.json"),
      ]),
    ).rejects.toThrow("publication batch layout");
    expect(mocks.consumePublications).not.toHaveBeenCalled();
  });

  it("assembles exact source evidence and the authorized ECC preview without overwriting", async () => {
    const eccRoot = makeDirectory("ecc-source");
    const eccEvidence = join(root, "ecc-evidence.json");
    const superpowersEvidence = join(root, "superpowers-evidence.json");
    const output = join(root, "baseline-lock.json");
    const previewOutput = join(root, "preview.json");
    writeFileSync(eccEvidence, JSON.stringify({ id: "ecc", pinnedSha: PIN }));
    writeFileSync(
      superpowersEvidence,
      JSON.stringify({ id: "superpowers", pinnedSha: "b".repeat(40) }),
    );

    await runScannerBridge([
      "assemble",
      "--ecc-root",
      eccRoot,
      "--ecc-evidence",
      eccEvidence,
      "--superpowers-evidence",
      superpowersEvidence,
      "--out",
      output,
      "--preview-out",
      previewOutput,
    ]);

    expect(mocks.lockParse).toHaveBeenCalledWith({
      schemaVersion: 1,
      sources: [
        { id: "ecc", pinnedSha: PIN },
        { id: "superpowers", pinnedSha: "b".repeat(40) },
      ],
    });
    expect(mocks.generatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ eccRoot, evidence: { id: "ecc", pinnedSha: PIN } }),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(readFileSync(previewOutput, "utf8"))).toMatchObject({
      format: "aih-ecc-install-preview",
    });
    expect(stdout).toHaveBeenCalledWith("assembled 2 Scanner-vetted baseline sources\n");

    await expect(
      runScannerBridge([
        "assemble",
        "--ecc-root",
        eccRoot,
        "--ecc-evidence",
        eccEvidence,
        "--superpowers-evidence",
        superpowersEvidence,
        "--out",
        output,
        "--preview-out",
        previewOutput,
      ]),
    ).rejects.toThrow(/exist/i);
  });
});
