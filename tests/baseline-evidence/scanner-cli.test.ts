import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  baselineCatalogById: vi.fn(),
  canonicalRequest: vi.fn(),
  consumeBatches: vi.fn(),
  consumePublication: vi.fn(),
  createPublicKey: vi.fn(),
  createRequests: vi.fn(),
  execFileSync: vi.fn(),
  generatePreview: vi.fn(),
  lockParse: vi.fn(),
  parseEnvelope: vi.fn(),
  parseRequest: vi.fn(),
  readBundle: vi.fn(),
  sourceParse: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("node:crypto", () => ({ createPublicKey: mocks.createPublicKey }));
vi.mock("@aihq/scan", () => ({
  canonicalBaselineVetRequestV1Bytes: mocks.canonicalRequest,
  parseBaselineVetAttestationEnvelopeV1Json: mocks.parseEnvelope,
  parseBaselineVetRequestV1Json: mocks.parseRequest,
  readBaselineVetBundleV1: mocks.readBundle,
}));
vi.mock("../../src/baseline-evidence/catalogs.js", () => ({
  baselineCatalogById: mocks.baselineCatalogById,
}));
vi.mock("../../src/baseline-evidence/ecc-preview-boundary.js", () => ({
  generateAuthorizedEccInstallPreview: mocks.generatePreview,
}));
vi.mock("../../src/baseline-evidence/scanner-consumer.js", () => ({
  consumeVerifiedScannerBaselineBatches: mocks.consumeBatches,
  createCoreBaselineVetRequests: mocks.createRequests,
}));
vi.mock("../../src/baseline-evidence/scanner-publication.js", () => ({
  SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1: 604800,
  SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1: {
    repository: "samartomar/aih-scan",
    workflow: "samartomar/aih-scan/.github/workflows/baseline-publication.yml",
    ref: "refs/heads/main",
    commit: "92679b827d8346294b5fc557056fa838bdba709d",
  },
  consumeScannerBaselinePublicationV1: mocks.consumePublication,
}));
vi.mock("../../src/baseline-evidence/schema.js", () => ({
  BaselineSourceEvidenceSchema: { parse: mocks.sourceParse },
  parseBaselineEvidenceLock: mocks.lockParse,
}));

import { runScannerBridge } from "../../src/baseline-evidence/scanner-cli.js";

const PIN = "a".repeat(40);
const KEY_ID = `ed25519:${"b".repeat(64)}`;

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
  mocks.parseRequest.mockImplementation((value: string) => ({ request: value.trim() }));
  mocks.readBundle.mockImplementation(({ bundleDirectory }: { bundleDirectory: string }) => ({
    bundleDirectory,
  }));
  mocks.parseEnvelope.mockImplementation((value: string) => ({ envelope: value.trim() }));
  mocks.createPublicKey.mockReturnValue({ type: "public" });
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
      "baseline Scanner bridge: expected request, consume, consume-publication, or assemble",
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

  it("consumes one canonical batch with explicit trust roots and replay state", async () => {
    const source = makeDirectory("consume-source");
    const requests = makeDirectory("consume-requests");
    const bundles = makeDirectory("consume-bundles");
    const evidence = makeDirectory("consume-evidence");
    mkdirSync(join(bundles, "batch-001.bundle"));
    writeFileSync(join(requests, "batch-001.request.json"), '{"request":1}\n');
    writeFileSync(join(evidence, "batch-001.evidence.json"), '{"envelope":1}\n');
    const expected = join(root, "expected.json");
    const roots = join(root, "roots.json");
    const seen = join(root, "seen.json");
    const output = join(root, "source-evidence.json");
    writeFileSync(
      expected,
      JSON.stringify({
        now: "2026-09-01T00:00:00Z",
        signer: { identity: "aih-vet", class: "organization", keyId: KEY_ID },
      }),
    );
    writeFileSync(
      roots,
      JSON.stringify({
        roots: [
          {
            identity: "aih-vet",
            class: "organization",
            keyId: KEY_ID,
            publicKeySpkiBase64: "AQ==",
          },
        ],
      }),
    );
    writeFileSync(
      seen,
      JSON.stringify({
        digests: ["d".repeat(64)],
        receipts: [{ requestSha256: "e".repeat(64), receiptSha256: "f".repeat(64) }],
      }),
    );
    mocks.consumeBatches.mockResolvedValue({ id: "ecc", pinnedSha: PIN, components: [] });

    await runScannerBridge([
      "consume",
      "--catalog",
      "ecc",
      "--source",
      source,
      "--requests",
      requests,
      "--bundles",
      bundles,
      "--evidence",
      evidence,
      "--expected",
      expected,
      "--roots",
      roots,
      "--seen",
      seen,
      "--output",
      output,
    ]);

    expect(mocks.consumeBatches).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRoot: source,
        seenEvidenceDigests: ["d".repeat(64)],
        seenReceiptBindings: [{ requestSha256: "e".repeat(64), receiptSha256: "f".repeat(64) }],
        roots: [expect.objectContaining({ identity: "aih-vet", publicKey: { type: "public" } })],
      }),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ id: "ecc", pinnedSha: PIN });
    expect(stdout).toHaveBeenCalledWith(`ecc@${PIN}\n`);
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
        sourceCommit: "92679b827d8346294b5fc557056fa838bdba709d",
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
          commit: "92679b827d8346294b5fc557056fa838bdba709d",
        }),
      }),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ id: "ecc" });
    expect(JSON.parse(readFileSync(provenanceOutput, "utf8"))).toMatchObject({
      authority: "none",
    });
    expect(stdout).toHaveBeenCalledWith(`consumed published ecc@${PIN}\n`);
  });

  it("fails closed for non-canonical or incomplete batch directories", async () => {
    const source = makeDirectory("unsafe-source");
    const requests = makeDirectory("unsafe-requests");
    const bundles = makeDirectory("unsafe-bundles");
    const evidence = makeDirectory("unsafe-evidence");
    writeFileSync(join(requests, "request.json"), "{}\n");
    mkdirSync(join(bundles, "batch-001.bundle"));
    writeFileSync(join(evidence, "batch-001.evidence.json"), "{}\n");

    await expect(
      runScannerBridge([
        "consume",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--requests",
        requests,
        "--bundles",
        bundles,
        "--evidence",
        evidence,
      ]),
    ).rejects.toThrow("request batches must contain contiguous canonical batch names");

    rmSync(join(requests, "request.json"));
    writeFileSync(join(requests, "batch-001.request.json"), "{}\n");
    writeFileSync(join(evidence, "batch-002.evidence.json"), "{}\n");
    await expect(
      runScannerBridge([
        "consume",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--requests",
        requests,
        "--bundles",
        bundles,
        "--evidence",
        evidence,
      ]),
    ).rejects.toThrow("request, bundle, and evidence batch counts differ");
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
