import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  baselineCatalogById: vi.fn(),
  prepareCatalog: vi.fn(),
  resolveDefinition: vi.fn(),
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
vi.mock("../../src/baseline-evidence/scanner-catalog-consumer.js", () => ({
  prepareRegisteredScannerCatalogV1: mocks.prepareCatalog,
}));
vi.mock("../../src/baseline-evidence/scanner-definition.js", () => ({
  resolveScannerDefinitionV1: mocks.resolveDefinition,
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
    commit: "f6189c0211fe27369fb15672f00da76c2072361c",
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
const RETAINED_PUBLISHER = "f6189c0211fe27369fb15672f00da76c2072361c";
const WEEKLY_PUBLISHER = "981d50f19ec8923974597de28c4c7b7acf684ded";
const discoveryBytes = (commit = RETAINED_PUBLISHER, request = "d".repeat(64), renewal = "") =>
  Buffer.from(
    JSON.stringify({
      locator: `https://github.com/samartomar/aih-scan/releases/download/baseline-v1-${commit}-${request}${renewal}/publication.json`,
    }),
  );

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
  mocks.prepareCatalog.mockImplementation((_root: string, id: string) => ({
    catalog: mocks.baselineCatalogById(id),
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
  it("retains a non-authoritative coverage companion bound to the exact authored requests", async () => {
    const source = makeDirectory("provider-source");
    const output = join(root, "provider-requests");
    mocks.createRequests.mockReturnValue([{ requestSha256: "1".repeat(64) }]);
    mocks.prepareCatalog.mockReturnValue({
      catalog: mocks.baselineCatalogById("mattpocock"),
      coverage: { authority: "none", version: "workbench-scanner-coverage/v1" },
      coverageDigest: `sha256:${"2".repeat(64)}`,
    });
    await runScannerBridge([
      "request",
      "--catalog",
      "mattpocock",
      "--source",
      source,
      "--output",
      output,
    ]);
    expect(JSON.parse(readFileSync(join(output, "coverage-map.json"), "utf8"))).toEqual({
      authority: "none",
      version: "workbench-scanner-coverage/v1",
      coverageDigest: `sha256:${"2".repeat(64)}`,
      requestSha256: ["1".repeat(64)],
    });
  });
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

  it.each([
    [RETAINED_PUBLISHER, ""],
    [WEEKLY_PUBLISHER, ""],
    [WEEKLY_PUBLISHER, "-r20260914"],
  ])(
    "consumes independently published bytes with reviewed publisher %s%s",
    async (commit, renewal) => {
      const source = makeDirectory("published-source");
      const discovery = join(root, "discovery.json");
      const publication = join(root, "publication.json");
      const attestation = join(root, "attestation.json");
      const output = join(root, "published-source-evidence.json");
      const provenanceOutput = join(root, "published-provenance.json");
      writeFileSync(discovery, discoveryBytes(commit, "d".repeat(64), renewal));
      writeFileSync(publication, '{"publication":1}');
      writeFileSync(attestation, '[{"attestation":1}]');
      mocks.consumePublication.mockResolvedValue({
        evidence: { id: "ecc", pinnedSha: PIN, components: [] },
        provenance: {
          authority: "none",
          sourceCommit: "f6189c0211fe27369fb15672f00da76c2072361c",
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
          discoveryBytes: discoveryBytes(commit, "d".repeat(64), renewal),
          publicationBytes: Buffer.from('{"publication":1}'),
          attestationResultBytes: Buffer.from('[{"attestation":1}]'),
          maxAgeSeconds: 604800,
          publisher: expect.objectContaining({
            commit,
          }),
        }),
      );
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ id: "ecc" });
      expect(JSON.parse(readFileSync(provenanceOutput, "utf8"))).toMatchObject({
        authority: "none",
      });
      expect(stdout).toHaveBeenCalledWith(`consumed published ecc@${PIN}\n`);
    },
  );

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
      writeFileSync(
        join(batch, "discovery.json"),
        discoveryBytes(RETAINED_PUBLISHER, requestSha256),
      );
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
          discoveryBytes: discoveryBytes(RETAINED_PUBLISHER, expectedRequestSha256),
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

  it.each([
    discoveryBytes("f".repeat(40)),
    Buffer.from(
      '{"locator":"https://github.com/samartomar/aih-scan/releases/latest/download/publication.json"}',
    ),
    Buffer.from("{}"),
    Buffer.from("null"),
    Buffer.from("[1]"),
    Buffer.from("invalid JSON"),
    Buffer.from('{"locator":"unreviewed","locator":"duplicate"}'),
    Buffer.from([0xff]),
  ])(
    "rejects discovery without a reviewed immutable publisher before consumption",
    async (bytes) => {
      const source = makeDirectory("unknown-publisher-source");
      const discovery = join(root, "discovery.json");
      const output = join(root, "evidence.json");
      const publication = join(root, "publication.json");
      const attestation = join(root, "attestation.json");
      writeFileSync(discovery, bytes);
      writeFileSync(publication, "{}");
      writeFileSync(attestation, "[]");
      await expect(
        runScannerBridge([
          "consume-publication",
          "--catalog",
          "ecc",
          "--source",
          source,
          "--discovery",
          discovery,
          "--output",
          output,
          "--publication",
          publication,
          "--attestation",
          attestation,
          "--request-sha256",
          "d".repeat(64),
          "--provenance-output",
          join(root, "provenance.json"),
        ]),
      ).rejects.toThrow(/discovery.*publisher/);
      expect(mocks.consumePublication).not.toHaveBeenCalled();
      expect(existsSync(output)).toBe(false);
    },
  );

  it("rejects a batch set mixing reviewed publisher revisions before consumption", async () => {
    const source = makeDirectory("mixed-publisher-source");
    const publicationRoot = makeDirectory("mixed-publications");
    const output = join(root, "mixed-evidence.json");
    const requestDigests = ["1".repeat(64), "2".repeat(64)];
    mocks.createRequests.mockReturnValue(
      requestDigests.map((requestSha256) => ({ requestSha256 })),
    );
    for (const [index, commit] of [RETAINED_PUBLISHER, WEEKLY_PUBLISHER].entries()) {
      const batch = join(publicationRoot, `batch-${String(index + 1).padStart(3, "0")}`);
      mkdirSync(batch);
      writeFileSync(join(batch, "discovery.json"), discoveryBytes(commit, requestDigests[index]));
      writeFileSync(join(batch, "publication.json"), "{}");
      writeFileSync(join(batch, "attestation.json"), "[]");
    }
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
        output,
        "--provenance-output",
        join(root, "mixed-provenance.json"),
      ]),
    ).rejects.toThrow("publication batches must use one reviewed publisher");
    expect(mocks.consumePublications).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
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

  describe("--definition", () => {
    const NEW_PIN = "5064474d4d762dc9640234a41617cccb79185cec";
    const definitionCatalog = {
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: NEW_PIN,
      components: [{ id: "runtime:ecc-installer", paths: ["package.json"] }],
    };

    beforeEach(() => {
      mocks.execFileSync.mockReturnValue(`${NEW_PIN}
`);
      mocks.resolveDefinition.mockReturnValue({ route: "definition", catalog: definitionCatalog });
    });

    it("authors requests from a definition at a pin the installed Catalog does not carry", async () => {
      const source = makeDirectory("definition-source");
      const definition = join(root, "ecc.definition.json");
      writeFileSync(definition, "{}");
      const output = join(root, "definition-requests");
      mocks.createRequests.mockReturnValue([{ requestSha256: "3".repeat(64) }]);

      await runScannerBridge([
        "request",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--definition",
        definition,
        "--output",
        output,
      ]);

      expect(mocks.resolveDefinition).toHaveBeenCalledWith({
        sourceRoot: source,
        catalogId: "ecc",
        definitionPath: definition,
        head: NEW_PIN,
      });
      expect(mocks.prepareCatalog).not.toHaveBeenCalled();
      expect(mocks.createRequests).toHaveBeenCalledWith(source, definitionCatalog);
      expect(existsSync(join(output, "batch-001.request.json"))).toBe(true);
      expect(existsSync(join(output, "coverage-map.json"))).toBe(false);
    });

    it("passes the named compiler-catalog overlap mode only when it is asked for", async () => {
      const source = makeDirectory("compiler-source");
      const definition = join(root, "compiler.definition.json");
      writeFileSync(definition, "{}");
      mocks.createRequests.mockReturnValue([{ requestSha256: "5".repeat(64) }]);
      await runScannerBridge([
        "request",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--definition",
        definition,
        "--definition-overlap",
        "compiler-catalog",
        "--output",
        join(root, "compiler-requests"),
      ]);
      expect(mocks.resolveDefinition).toHaveBeenCalledWith({
        sourceRoot: source,
        catalogId: "ecc",
        definitionPath: definition,
        head: NEW_PIN,
        overlap: "compiler-catalog",
      });
    });

    it.each([
      [["--definition-overlap", "compiler-catalog"], "--definition-overlap requires --definition"],
      [
        ["--definition", "d.json", "--definition-overlap", "any"],
        "--definition-overlap must be disjoint|compiler-catalog",
      ],
    ])("refuses %j", async (extra, message) => {
      const source = makeDirectory(`overlap-refused-${extra.length}`);
      await expect(
        runScannerBridge([
          "request",
          "--catalog",
          "ecc",
          "--source",
          source,
          ...extra,
          "--output",
          join(root, `overlap-refused-${extra.length}-requests`),
        ]),
      ).rejects.toThrow(message);
      expect(mocks.resolveDefinition).not.toHaveBeenCalled();
      expect(mocks.prepareCatalog).not.toHaveBeenCalled();
    });

    it("defers to the installed Catalog route when it carries the identical definition", async () => {
      const source = makeDirectory("carried-source");
      const definition = join(root, "carried.definition.json");
      writeFileSync(definition, "{}");
      mocks.resolveDefinition.mockReturnValue({ route: "installed", catalog: definitionCatalog });
      mocks.prepareCatalog.mockReturnValue({ catalog: { ...definitionCatalog } });
      mocks.createRequests.mockReturnValue([{ requestSha256: "4".repeat(64) }]);

      await runScannerBridge([
        "request",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--definition",
        definition,
        "--output",
        join(root, "carried-requests"),
      ]);

      expect(mocks.prepareCatalog).toHaveBeenCalledWith(source, "ecc");
    });

    it("propagates a definition refusal and never falls back to the installed Catalog", async () => {
      const source = makeDirectory("refused-source");
      mocks.resolveDefinition.mockImplementation(() => {
        throw new Error(
          "baseline definition: installed Catalog carries ecc@x; the definition differs",
        );
      });
      await expect(
        runScannerBridge([
          "request",
          "--catalog",
          "ecc",
          "--source",
          source,
          "--definition",
          join(root, "refused.json"),
          "--output",
          join(root, "refused-requests"),
        ]),
      ).rejects.toThrow("the definition differs");
      expect(mocks.prepareCatalog).not.toHaveBeenCalled();
      expect(mocks.createRequests).not.toHaveBeenCalled();
    });

    it("consumes publications against the definition catalog", async () => {
      const source = makeDirectory("definition-consume-source");
      const publicationRoot = makeDirectory("definition-publications");
      const definition = join(root, "consume.definition.json");
      writeFileSync(definition, "{}");
      const batch = join(publicationRoot, "batch-001");
      mkdirSync(batch);
      writeFileSync(
        join(batch, "discovery.json"),
        discoveryBytes(RETAINED_PUBLISHER, "5".repeat(64)),
      );
      writeFileSync(join(batch, "publication.json"), "{}");
      writeFileSync(join(batch, "attestation.json"), "[]");
      mocks.createRequests.mockReturnValue([{ requestSha256: "5".repeat(64) }]);
      mocks.consumePublications.mockResolvedValue({
        evidence: { id: "ecc", pinnedSha: NEW_PIN, components: [] },
        provenance: [],
      });

      await runScannerBridge([
        "consume-publications",
        "--catalog",
        "ecc",
        "--source",
        source,
        "--definition",
        definition,
        "--publication-root",
        publicationRoot,
        "--output",
        join(root, "definition-evidence.json"),
        "--provenance-output",
        join(root, "definition-provenance.json"),
      ]);

      expect(mocks.prepareCatalog).not.toHaveBeenCalled();
      expect(mocks.createRequests).toHaveBeenCalledWith(source, definitionCatalog);
      expect(mocks.consumePublications).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRoot: source, catalog: definitionCatalog }),
      );
    });

    it("assembles the ECC preview against the definition catalog", async () => {
      const eccRoot = makeDirectory("definition-ecc");
      const definition = join(root, "assemble.definition.json");
      writeFileSync(definition, "{}");
      const eccEvidence = join(root, "definition-ecc-evidence.json");
      const superpowersEvidence = join(root, "definition-superpowers-evidence.json");
      writeFileSync(eccEvidence, JSON.stringify({ id: "ecc", pinnedSha: NEW_PIN }));
      writeFileSync(superpowersEvidence, JSON.stringify({ id: "superpowers" }));

      await runScannerBridge([
        "assemble",
        "--ecc-root",
        eccRoot,
        "--definition",
        definition,
        "--ecc-evidence",
        eccEvidence,
        "--superpowers-evidence",
        superpowersEvidence,
        "--out",
        join(root, "definition-lock.json"),
        "--preview-out",
        join(root, "definition-preview.json"),
      ]);

      expect(mocks.resolveDefinition).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRoot: eccRoot, catalogId: "ecc" }),
      );
      expect(mocks.generatePreview).toHaveBeenCalledWith(
        expect.objectContaining({ eccRoot, catalog: definitionCatalog }),
      );
    });
  });
});
