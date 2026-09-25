import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ gitHead: vi.fn(), facts: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.gitHead }));
vi.mock("../../src/org-policy/workbench/core/source-data-scanner.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/org-policy/workbench/core/source-data-scanner.js")
  >()),
  prepareSourceDataScannerRuntimeFactsV1: mocks.facts,
}));

import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { preparePackagedWorkbenchSourceDataCommandV1 } from "../../src/internals/prepare-packaged-workbench-source-data.js";
import { PackagedSourceDataRecordV1Schema } from "../../src/org-policy/workbench/core/packaged-source-data-record.js";
import { sealedSingleSourceBundle } from "../baseline-evidence/candidate-bundle-fixture.js";
import {
  candidateListingDigest,
  candidatePackageFiles,
  markedCandidatePackageFiles,
} from "../catalog-package/candidate-catalog-fixture.js";

const PIN = "c".repeat(40);
const PUBLISHER = "42885cd87e65520da5e47494d344d4a600e79ff9";
const locator = (digest: string, commit = PUBLISHER) =>
  `https://github.com/samartomar/aih-scan/releases/download/baseline-v1-${commit}-${digest}/publication.json`;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const skill = "---\nname: tdd\n---\n";
const compilerInput = {
  version: "pinned-component-collection/v1",
  source: { id: "ponytail", repository: "https://github.com/DietrichGebert/ponytail", commit: PIN },
  files: [
    {
      path: "skills/tdd/SKILL.md",
      bytesBase64: Buffer.from(skill).toString("base64"),
      sha256: `sha256:${sha(skill)}`,
    },
  ],
};
const publishedCatalog = {
  id: "ponytail",
  owner: "DietrichGebert",
  repo: "ponytail",
  pinnedSha: PIN,
  components: [{ id: "tdd", paths: ["skills/tdd/SKILL.md"], skillContent: true }],
};

let root: string;
let args: string[];
let output: string;
let publications: string;

function json(name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function batch(name: string, digest: string, commit = PUBLISHER) {
  const directory = join(publications, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "discovery.json"),
    JSON.stringify({ locator: locator(digest, commit) }),
  );
  writeFileSync(join(directory, "publication.json"), `{"publication":"${name}"}`);
  writeFileSync(join(directory, "attestation.jsonl"), `{"bundle":"${name}"}\n`);
  return directory;
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "aih-packaged-source-"));
  publications = join(root, "publications");
  batch("batch-001", "a".repeat(64));
  output = join(root, "record.json");
  mocks.gitHead.mockReturnValue(`${PIN}\n`);
  mocks.facts.mockResolvedValue({ evidence: {} });
  args = [
    "--provider",
    "ponytail",
    "--source-root",
    join(root, "source"),
    "--publication-root",
    publications,
    "--source-bundle",
    json("bundle.json", sealedSingleSourceBundle("ponytail", PIN, ["tdd"])),
    "--compiler-input",
    json("compiler-input.json", compilerInput),
    "--published-catalog",
    json("published-catalog.json", publishedCatalog),
    "--output",
    output,
  ];
  mkdirSync(join(root, "source"));
});

afterEach(() => {
  vi.resetAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("prepare-packaged-workbench-source-data", () => {
  it("verifies the publications against the source and writes one sealed record", async () => {
    const message = await preparePackagedWorkbenchSourceDataCommandV1(args);
    expect(message).toMatch(/^Prepared packaged source data ponytail@c{40} sha256:[0-9a-f]{64}\./);
    expect(mocks.facts).toHaveBeenCalledTimes(1);
    const [bundle, proof, sourceRoot, issuedAt, authorized, now, proofRoot] =
      mocks.facts.mock.calls[0] ?? [];
    expect(bundle).toEqual(sealedSingleSourceBundle("ponytail", PIN, ["tdd"]));
    expect(sourceRoot).toBe(join(root, "source"));
    expect(authorized).toBeUndefined();
    expect(now).toBe(issuedAt);
    const compilerBytes = canonicalStrictJsonBytesV1(compilerInput);
    expect(proof).toEqual({
      version: "source-data-scanner-proof/v1",
      compilerInput: {
        version: "source-compiler-input-blob/v1",
        sha256: sha(compilerBytes),
        bytes: compilerBytes.length,
      },
      publishedCatalog,
      preparedAt: issuedAt,
      publisherCommit: PUBLISHER,
      batches: [
        {
          version: "scanner-proof-blobs/v1",
          discovery: expect.objectContaining({ bytes: expect.any(Number) }),
          publication: expect.objectContaining({ bytes: expect.any(Number) }),
          attestation: expect.objectContaining({ bytes: expect.any(Number) }),
        },
      ],
    });
    // The proof root is a private temporary directory, gone once the record is written.
    expect(existsSync(proofRoot as string)).toBe(false);

    const record = PackagedSourceDataRecordV1Schema.parse(JSON.parse(readFileSync(output, "utf8")));
    expect(record.source).toEqual({ repository: "DietrichGebert/ponytail", commit: PIN });
    expect(record.scannerProof).toEqual(proof);
    expect(record.updateKind).toBeUndefined();
    expect(record.runtimeDescriptor).toBeUndefined();
    expect(record.publicationBlobs).toEqual([
      {
        sha256: sha('{"publication":"batch-001"}'),
        bytes: 27,
        url: locator("a".repeat(64)),
      },
    ]);
    expect(
      record.inlineBlobs.map((blob) => Buffer.from(blob.bytesBase64, "base64").toString()),
    ).toEqual([JSON.stringify({ locator: locator("a".repeat(64)) }), '{"bundle":"batch-001"}\n']);
    expect(JSON.stringify(record.compilerTemplate)).not.toContain('bytesBase64":"');
  });

  it("never overwrites an output and reads nothing when it already exists", async () => {
    writeFileSync(output, "existing");
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(output, "utf8")).toBe("existing");
    expect(mocks.gitHead).not.toHaveBeenCalled();
    expect(mocks.facts).not.toHaveBeenCalled();
  });

  it("writes nothing when publication verification fails", async () => {
    mocks.facts.mockRejectedValue(new TypeError("Workbench source data: proof rejected"));
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("aih-packaged-proof-"));
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      /proof rejected/,
    );
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("aih-packaged-proof-"))).toEqual(
      before,
    );
  });

  it("carries an explicit evidence-only update kind", async () => {
    await preparePackagedWorkbenchSourceDataCommandV1([...args, "--update-kind", "evidence-only"]);
    expect(JSON.parse(readFileSync(output, "utf8")).updateKind).toBe("evidence-only");
  });

  it("refuses a checkout that is not at the bundle's admitted revision", async () => {
    mocks.gitHead.mockReturnValue("d".repeat(40));
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      `ponytail checkout is ${"d".repeat(40)}, the source bundle admits ${PIN}`,
    );
    expect(mocks.facts).not.toHaveBeenCalled();
  });

  it("refuses a source bundle for another provider", async () => {
    args[7] = json("other.json", sealedSingleSourceBundle("superpowers", PIN, ["tdd"]));
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      "candidate source bundle must carry exactly source:ponytail, not source:superpowers",
    );
  });

  it("refuses a published catalog pinned elsewhere", async () => {
    args[11] = json("published-other.json", { ...publishedCatalog, pinnedSha: "d".repeat(40) });
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      /published catalog must be DietrichGebert\/ponytail@c{40}/,
    );
  });

  it("refuses publications from a publisher outside the allowlist", async () => {
    rmSync(publications, { recursive: true });
    batch("batch-001", "a".repeat(64), "f".repeat(40));
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      /batch-001 is not an allowlisted Scanner publication/,
    );
  });

  it("refuses batches from more than one publisher", async () => {
    batch("batch-002", "b".repeat(64), "349fcadac4bdb20807c0f3451f91178a3b5911cd");
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      /one publisher commit/,
    );
  });

  it.each([
    ["an extra file", (directory: string) => writeFileSync(join(directory, "x.json"), "{}")],
    ["a missing attestation", (directory: string) => rmSync(join(directory, "attestation.jsonl"))],
  ])("refuses a batch with %s", async (_label, mutate) => {
    mutate(join(publications, "batch-001"));
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      /discovery\.json, publication\.json and attestation\.jsonl/,
    );
  });

  it("refuses a gap in the batch sequence", async () => {
    batch("batch-003", "b".repeat(64));
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      /batch-001 \.\. batch-NNN/,
    );
  });

  it("requires the ECC runtime descriptor and refuses one for any other provider", async () => {
    mocks.facts.mockResolvedValue({ evidence: {}, descriptor: { fixture: true } });
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      "only ecc carries a runtime descriptor",
    );
    args[1] = "ecc";
    args[7] = json("ecc-bundle.json", sealedSingleSourceBundle("ecc", PIN, ["tdd"]));
    args[11] = json("ecc-catalog.json", {
      ...publishedCatalog,
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
    });
    mocks.facts.mockResolvedValue({ evidence: {} });
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(
      "ecc verification produced no runtime descriptor",
    );
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    ["an unknown provider", (a: string[]) => a.splice(1, 1, "mattpocock")],
    ["a missing flag", (a: string[]) => a.splice(10, 2)],
    [
      "flags out of order",
      (a: string[]) => a.splice(0, 4, "--source-root", a[3] as string, "--provider", "ponytail"),
    ],
    ["an unknown update kind", (a: string[]) => a.push("--update-kind", "full")],
    ["a flag value that is a flag", (a: string[]) => a.splice(13, 1, "--output")],
    ["a candidate Catalog without its digest", (a: string[]) => a.push("--candidate-catalog", "c")],
    [
      "a candidate digest without a candidate Catalog",
      (a: string[]) => a.push("--candidate-catalog-sha256", "0".repeat(64)),
    ],
    [
      "a malformed candidate digest",
      (a: string[]) => a.push("--candidate-catalog", "c", "--candidate-catalog-sha256", "ABC"),
    ],
    [
      "a repeated candidate flag",
      (a: string[]) =>
        a.push(
          "--candidate-catalog",
          "c",
          "--candidate-catalog",
          "d",
          "--candidate-catalog-sha256",
          "0".repeat(64),
        ),
    ],
  ])("rejects %s", async (_label, mutate) => {
    mutate(args);
    await expect(preparePackagedWorkbenchSourceDataCommandV1(args)).rejects.toThrow(/^Usage:/);
    expect(mocks.facts).not.toHaveBeenCalled();
  });
});

describe("prepare-packaged-workbench-source-data with a candidate Catalog", () => {
  const record = () => `${output}.candidate-catalog.json`;
  /** Fresh module state: a candidate is activated once per process, as in a real run. */
  async function command() {
    vi.resetModules();
    return (await import("../../src/internals/prepare-packaged-workbench-source-data.js"))
      .preparePackagedWorkbenchSourceDataCommandV1;
  }
  function candidate(files = candidatePackageFiles()) {
    const directory = join(root, "candidate");
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      writeFileSync(join(directory, path), bytes);
    }
    return { directory, digest: candidateListingDigest(files) };
  }

  it("prepares through the named candidate and records its digest beside the output", async () => {
    const { directory, digest } = candidate();
    args.push("--candidate-catalog", directory, "--candidate-catalog-sha256", digest);
    const run = await command();
    const message = await run(args);
    expect(message).toContain(`candidate Catalog 0.3.0 sha256:${digest} (directory-listing)`);
    expect(JSON.parse(readFileSync(record(), "utf8"))).toEqual({
      format: "aih-candidate-catalog-use",
      version: 1,
      tool: "prepare-packaged-workbench-source-data",
      output: { file: "record.json", sha256: sha(readFileSync(output)) },
      candidateCatalog: {
        sha256: digest,
        digestOf: "directory-listing",
        version: "0.3.0",
        files: expect.any(Array),
      },
    });
    const loader = await import("../../src/catalog-package/load-catalog-package.js");
    expect(loader.candidateCatalogActiveV1()).toBe(true);
  });

  it("prepares through an activated candidate that carries both candidate markers", async () => {
    // Ordinary loads refuse a marked package; the named, digest-checked activation is the
    // one route a candidate is used by, and it reads neither marker.
    const { directory, digest } = candidate(markedCandidatePackageFiles());
    args.push("--candidate-catalog", directory, "--candidate-catalog-sha256", digest);
    const run = await command();
    expect(await run(args)).toContain(
      `candidate Catalog 0.3.0 sha256:${digest} (directory-listing)`,
    );
    const used = JSON.parse(readFileSync(record(), "utf8")).candidateCatalog.files.map(
      (file: { path: string }) => file.path,
    );
    expect(used).toContain("package.json");
    expect(used).not.toContain("CANDIDATE.json");
  });

  it("refuses a candidate whose digest does not match before reading any input", async () => {
    const { directory } = candidate();
    args.push("--candidate-catalog", directory, "--candidate-catalog-sha256", "0".repeat(64));
    const run = await command();
    await expect(run(args)).rejects.toThrow(/directory listing sha256 [0-9a-f]{64} does not match/);
    expect(mocks.gitHead).not.toHaveBeenCalled();
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
    expect(existsSync(record())).toBe(false);
  });

  it("refuses an existing candidate-use record before reading anything", async () => {
    const { directory, digest } = candidate();
    writeFileSync(record(), "keep");
    args.push("--candidate-catalog", directory, "--candidate-catalog-sha256", digest);
    const run = await command();
    await expect(run(args)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(record(), "utf8")).toBe("keep");
    expect(mocks.facts).not.toHaveBeenCalled();
  });

  it("writes no candidate-use record and activates nothing without a candidate", async () => {
    const run = await command();
    await run(args);
    expect(existsSync(record())).toBe(false);
    const loader = await import("../../src/catalog-package/load-catalog-package.js");
    expect(loader.candidateCatalogActiveV1()).toBe(false);
  });
});
