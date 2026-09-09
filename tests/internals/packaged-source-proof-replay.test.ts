import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  verify: vi.fn(),
  archive: vi.fn(),
  forget: vi.fn(),
  records: [] as unknown[],
}));
// Only package input and external acquisition/attestation are substituted. The
// compiler, Scanner signature verification, preparation and release replay remain real.
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
import { prepareSourceDataScannerRuntimeFactsV1 } from "../../src/org-policy/workbench/core/source-data-scanner.js";
import {
  issuedAt,
  now,
  scannerOperationalFixtureV1,
  simulatedGithubAttestationForPublicationV1,
} from "../org-policy/workbench/source-data-scanner-fixture.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  transport.records.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function blob(root: string, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(root, `${sha256}.blob`), bytes);
  return { sha256, bytes: bytes.length };
}

it.each(["ecc", "collection"] as const)(
  "replays a prepared %s package against original signed reports and refuses a corrupted download",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const fixture = scannerOperationalFixtureV1(kind);
    roots.push(fixture.root);
    const proofRoot = mkdtempSync(join(tmpdir(), "aih-package-replay-test-"));
    roots.push(proofRoot);
    transport.verify.mockImplementation((bytes: Uint8Array) =>
      simulatedGithubAttestationForPublicationV1(fixture.attestationResult, bytes),
    );
    const batches = fixture.proof.batches as {
      discoveryBytesBase64: string;
      publicationBytesBase64: string;
      attestation: string;
    }[];
    const publications = new Map<string, Buffer>();
    const proof = {
      ...fixture.proof,
      compilerInput: {
        version: "source-compiler-input-blob/v1",
        ...blob(proofRoot, canonicalStrictJsonBytesV1(fixture.compilerInput)),
      },
      batches: batches.map((batch) => {
        const discovery = Buffer.from(batch.discoveryBytesBase64, "base64");
        const publication = Buffer.from(batch.publicationBytesBase64, "base64");
        publications.set(JSON.parse(discovery.toString("utf8")).locator, publication);
        return {
          version: "scanner-proof-blobs/v1",
          discovery: blob(proofRoot, discovery),
          publication: blob(proofRoot, publication),
          attestation: blob(proofRoot, Buffer.from(batch.attestation)),
        };
      }),
    };
    const facts = await prepareSourceDataScannerRuntimeFactsV1(
      fixture.bundle,
      proof,
      fixture.root,
      issuedAt,
      [fixture.proof.publisherCommit as string],
      now,
      proofRoot,
    );
    const bundle = structuredClone(fixture.bundle);
    bundle.evidence = facts.evidence;
    bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance: {} })}`;
    const source = Object.values(bundle.sources)[0];
    if (!source) throw new Error("fixture source missing");
    const sealed = preparePackagedWorkbenchSourceDataV1({
      sourceBundle: bundle,
      proof,
      compilerInput: fixture.compilerInput,
      proofRoot,
      source: {
        repository: source.upstreamOrigin.locator.replace(/^https:\/\/github\.com\//, ""),
        commit: source.revision.id,
      },
      ...(facts.descriptor === undefined ? {} : { runtimeDescriptor: facts.descriptor }),
    });
    const record = JSON.parse(sealed.bytes);
    expect(createHash("sha256").update(sealed.bytes).digest("hex")).toBe(sealed.sha256);
    transport.records.push(record);
    transport.archive.mockImplementation(async ({ destination }: { destination: string }) => {
      mkdirSync(destination, { recursive: true });
      cpSync(fixture.root, destination, { recursive: true });
    });
    const fetchMock = vi.fn(async (url: string) => {
      const bytes = publications.get(url);
      if (!bytes) throw new Error("unexpected publication URL");
      return new Response(new Uint8Array(bytes));
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress: string[] = [];
    await verifyPackagedWorkbenchSourceDataV1((repository, phase) =>
      progress.push(`${repository}:${phase}`),
    );
    expect(progress).toEqual([
      `${record.source.repository}:start`,
      `${record.source.repository}:verified`,
    ]);
    expect(transport.verify).toHaveBeenCalledTimes(2);
    expect(transport.forget).toHaveBeenCalledOnce();
    expect(existsSync(transport.forget.mock.calls[0]?.[0])).toBe(false);
    expect(Object.keys(bundle.evidence).length).toBeGreaterThan(0);
    if (kind === "ecc") {
      expect(record.runtimeDescriptor).toBeDefined();
      expect(Object.values(bundle.evidence).flatMap((item) => item.findings)).toContainEqual(
        expect.stringContaining("BLOCK: skills/one/SKILL.md:2"),
      );
    }
    fetchMock.mockImplementation(async (url: string) => {
      const original = publications.get(url);
      if (!original) throw new Error("unexpected publication URL");
      const bytes = Buffer.from(original);
      bytes[0] = bytes[0] === 0x7b ? 0x20 : 0x7b;
      return new Response(new Uint8Array(bytes));
    });
    progress.length = 0;
    await expect(
      verifyPackagedWorkbenchSourceDataV1((repository, phase) =>
        progress.push(`${repository}:${phase}`),
      ),
    ).rejects.toThrow(/during publication/);
    expect(progress).toEqual([`${record.source.repository}:start`]);
    expect(transport.verify).toHaveBeenCalledTimes(2);
    expect(transport.forget).toHaveBeenCalledTimes(2);
    expect(existsSync(transport.forget.mock.calls[1]?.[0])).toBe(false);
  },
);
