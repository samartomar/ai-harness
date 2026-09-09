import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  archive: vi.fn(),
  forget: vi.fn(),
  records: [] as unknown[],
  verify: vi.fn(),
}));

// The package bytes and GitHub boundaries are supplied by this fixture. Scanner
// preparation, proof replay, source signing, receipt creation, and activation
// remain the production implementations.
vi.mock("../../src/org-policy/workbench/core/packaged-source-data.js", () => ({
  packagedWorkbenchSourceDataRecordsV1: () => transport.records,
}));
vi.mock("../../src/internals/bounded-github-source-archive.js", async (original) => ({
  ...(await original<typeof import("../../src/internals/bounded-github-source-archive.js")>()),
  acquireBoundedGithubSourceArchiveV1: transport.archive,
  forgetAcquiredGithubSourceArchiveV1: transport.forget,
}));
vi.mock("../../src/org-policy/workbench/core/source-data-qualification.js", async (original) => ({
  ...(await original<
    typeof import("../../src/org-policy/workbench/core/source-data-qualification.js")
  >()),
  verifySourceDataArtifactWithGithubV1: transport.verify,
}));

import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../src/contract/strict-json-v1.js";
import { preparePackagedWorkbenchSourceDataV1 } from "../../src/internals/prepare-packaged-workbench-source-data.js";
import { verifyPackagedWorkbenchSourceDataV1 } from "../../src/internals/verify-packaged-workbench-source-data.js";
import {
  applyWorkbenchSourceDataV1,
  importWorkbenchSourceDataWithProofsV1,
} from "../../src/org-policy/workbench/core/source-data.js";
import { prepareSourceDataScannerRuntimeFactsV1 } from "../../src/org-policy/workbench/core/source-data-scanner.js";
import {
  issuedAt,
  now,
  scannerOperationalFixtureV1,
  simulatedGithubAttestationForPublicationV1,
} from "../org-policy/workbench/source-data-scanner-fixture.js";
import { tinySourceDataPreparedCatalogV1 } from "../org-policy/workbench/source-data-test-fixture.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
  transport.records.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeBlob(root: string, bytes: Uint8Array) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(root, `${sha256}.blob`);
  writeFileSync(path, bytes, { flag: "wx" });
  return { path, bytes: Buffer.from(bytes), reference: { sha256, bytes: bytes.length } };
}

function blobBackedProof(root: string, proof: Record<string, unknown>) {
  const compiler = writeBlob(root, canonicalStrictJsonBytesV1(proof.compilerInput));
  const batches = proof.batches as {
    discoveryBytesBase64: string;
    publicationBytesBase64: string;
    attestation: string;
  }[];
  const blobBatches = batches.map((batch) => ({
    discovery: writeBlob(root, Buffer.from(batch.discoveryBytesBase64, "base64")),
    publication: writeBlob(root, Buffer.from(batch.publicationBytesBase64, "base64")),
    attestation: writeBlob(root, Buffer.from(batch.attestation)),
  }));
  return {
    compiler,
    publication: blobBatches[0]?.publication,
    proof: {
      ...proof,
      compilerInput: { version: "source-compiler-input-blob/v1", ...compiler.reference },
      batches: blobBatches.map((batch) => ({
        version: "scanner-proof-blobs/v1",
        discovery: batch.discovery.reference,
        publication: batch.publication.reference,
        attestation: batch.attestation.reference,
      })),
    },
  };
}

function snapshot(root: string) {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((name) => [name, readFileSync(join(root, name), "base64")]),
  );
}

it("replays an installed signed Scanner source, activates it, and preserves its receipt when retained proof bytes change", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const fixture = scannerOperationalFixtureV1("ecc");
  const root = mkdtempSync(join(tmpdir(), "aih-installed-source-publication-"));
  const proofRoot = join(root, "proofs");
  const store = join(root, "store");
  const verifier = join(root, "verifier");
  roots.push(fixture.root, root);
  mkdirSync(proofRoot);
  mkdirSync(store);
  vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", verifier);
  const blobs = blobBackedProof(proofRoot, fixture.proof);
  if (!blobs.publication) throw new Error("fixture publication blob missing");
  transport.verify.mockImplementation((bytes: Uint8Array) =>
    simulatedGithubAttestationForPublicationV1(fixture.attestationResult, bytes),
  );
  const facts = await prepareSourceDataScannerRuntimeFactsV1(
    fixture.bundle,
    blobs.proof,
    fixture.root,
    issuedAt,
    [fixture.proof.publisherCommit as string],
    now,
    proofRoot,
  );
  const sourceBundle = structuredClone(fixture.bundle);
  sourceBundle.evidence = facts.evidence;
  sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({
    ...sourceBundle,
    provenance: {},
  })}`;
  const source = Object.values(sourceBundle.sources)[0];
  if (!source) throw new Error("fixture source missing");
  const record = JSON.parse(
    preparePackagedWorkbenchSourceDataV1({
      sourceBundle,
      proof: blobs.proof,
      compilerInput: fixture.compilerInput,
      proofRoot,
      source: {
        repository: source.upstreamOrigin.locator.replace(/^https:\/\/github\.com\//, ""),
        commit: source.revision.id,
      },
      ...(facts.descriptor === undefined ? {} : { runtimeDescriptor: facts.descriptor }),
    }).bytes,
  );
  transport.records.push(record);
  transport.archive.mockImplementation(async ({ destination }: { destination: string }) => {
    mkdirSync(destination, { recursive: true });
    cpSync(fixture.root, destination, { recursive: true });
  });
  transport.forget.mockImplementation((directory: string) =>
    rmSync(directory, { recursive: true }),
  );
  const publications = new Map<string, Buffer>();
  for (const batch of fixture.proof.batches as {
    discoveryBytesBase64: string;
    publicationBytesBase64: string;
  }[]) {
    const discovery = JSON.parse(
      Buffer.from(batch.discoveryBytesBase64, "base64").toString("utf8"),
    );
    publications.set(discovery.locator, Buffer.from(batch.publicationBytesBase64, "base64"));
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => new Response(new Uint8Array(publications.get(url) ?? []))),
  );
  const progress: string[] = [];
  await verifyPackagedWorkbenchSourceDataV1((repository, phase) =>
    progress.push(`${repository}:${phase}`),
  );
  expect(progress).toEqual([
    `${record.source.repository}:start`,
    `${record.source.repository}:verified`,
  ]);
  expect(transport.forget).toHaveBeenCalledOnce();
  expect(existsSync(transport.forget.mock.calls[0]?.[0] as string)).toBe(false);

  const sourceId = Object.keys(sourceBundle.sources)[0];
  if (!sourceId) throw new Error("fixture source id missing");
  const signer = generateKeyPairSync("ed25519");
  const keyId = createHash("sha256")
    .update(signer.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  writeFileSync(
    join(store, "trust.json"),
    JSON.stringify({
      version: 1,
      authorities: [
        {
          keyId,
          publicKeyPem: signer.publicKey.export({ format: "pem", type: "spki" }).toString(),
          role: "workbench-source-data/v1",
          sources: [sourceId],
          scannerPublisherCommits: [fixture.proof.publisherCommit],
          catalogPublisherCommits: ["c".repeat(40)],
        },
      ],
    }),
  );
  const payload = {
    version: "workbench-source-data/v1" as const,
    compatibility: "core-workbench-data/v1" as const,
    sequence: 1,
    previousDigest: null,
    issuedAt,
    expiresAt: "2026-09-03T13:29:00.000Z",
    sourceBundle,
    scanner: blobs.proof,
  };
  const envelope = canonicalStrictJsonBytesV1({
    version: "signed-workbench-source-data/v1",
    keyId,
    payload,
    signature: sign(null, canonicalStrictJsonBytesV1(payload), signer.privateKey).toString(
      "base64",
    ),
  }).toString("utf8");
  await expect(
    importWorkbenchSourceDataWithProofsV1(store, envelope, {
      sourceRoot: fixture.root,
      proofRoot,
      now,
    }),
  ).resolves.toMatchObject({ sourceId });
  expect(
    Object.values(
      applyWorkbenchSourceDataV1(tinySourceDataPreparedCatalogV1(), { root: store, now }).bundle
        .evidence,
    ).flatMap((entry) => entry.findings),
  ).toContainEqual(expect.stringContaining("BLOCK: skills/one/SKILL.md:2"));

  const before = snapshot(store);
  const receiptBefore = snapshot(verifier);
  const changed = Buffer.from(blobs.publication.bytes);
  changed[0] = changed[0] === 0x7b ? 0x20 : 0x7b;
  writeFileSync(blobs.publication.path, changed);
  await expect(
    importWorkbenchSourceDataWithProofsV1(store, envelope, {
      sourceRoot: fixture.root,
      proofRoot,
      now,
    }),
  ).rejects.toThrow("Source proof blob size or digest mismatch");
  expect(snapshot(store)).toEqual(before);
  expect(snapshot(verifier)).toEqual(receiptBefore);
});
