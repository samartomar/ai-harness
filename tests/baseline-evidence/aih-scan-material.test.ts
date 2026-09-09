import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  cpSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  type BaselineVetBatchResultV1,
  type BaselineVetRequestV1,
  canonicalBaselineVetAttestationEnvelopeV1Bytes,
  ed25519KeyIdV2,
  signBaselineVetBundleV1,
} from "@aihq/scan";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ defaultRunner: vi.fn() }));

vi.mock("../../src/internals/proc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/internals/proc.js")>()),
  defaultRunner: mocks.defaultRunner,
}));

import {
  type MaterializedAihScanSubjectsV1,
  materializeAihScanSubjectsV1,
} from "../../src/baseline-evidence/aih-scan-material.js";
import {
  authorPackagedAihScannerEvidenceRecordV1,
  authorPreparedAihScannerPublicationV1,
  prepareAihScannerPublicationsV1,
  reverifyPackagedAihScannerEvidenceRecordV1,
} from "../../src/baseline-evidence/aih-scan-preparation.js";
import { hashComponentTree, hashSourceTree } from "../../src/baseline-evidence/hash.js";
import {
  createCoreBaselineVetRequest,
  createCoreBaselineVetRequests,
} from "../../src/baseline-evidence/scanner-consumer.js";
import {
  SCANNER_BASELINE_ANALYZER_VERSIONS,
  SCANNER_TO_CORE_BASELINE_ANALYZER,
  type ScannerBaselineAnalyzer,
} from "../../src/baseline-evidence/scanner-profile.js";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 } from "../../src/baseline-evidence/scanner-publication-policy.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { acquireBoundedGithubSourceArchiveV1 } from "../../src/internals/bounded-github-source-archive.js";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import { PackagedScannerCollectionEvidenceRecordV1Schema } from "../../src/org-policy/packaged-collection-evidence-v1.js";
import { compileBuiltInCatalogV1 } from "../../src/org-policy/workbench/compilers/built-in.js";

const roots: string[] = [];
afterEach(() => {
  mocks.defaultRunner.mockReset();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function currentRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

type TarEntry = Readonly<{ name: string; bytes: Buffer; type?: string; linkTarget?: string }>;

function tarField(target: Buffer, offset: number, length: number, value: string): void {
  target.write(value, offset, Math.min(Buffer.byteLength(value), length), "ascii");
}

function tarOctal(target: Buffer, offset: number, length: number, value: number): void {
  tarField(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarEntry(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(entry.name) <= 100) tarField(header, 0, 100, entry.name);
  else {
    const boundary = entry.name.lastIndexOf("/");
    const prefix = boundary < 1 ? "" : entry.name.slice(0, boundary);
    const name = boundary < 1 ? entry.name : entry.name.slice(boundary + 1);
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100)
      throw new Error("fixture tar path");
    tarField(header, 0, 100, name);
    tarField(header, 345, 155, prefix);
  }
  tarOctal(header, 100, 8, 0o644);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, entry.bytes.length);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  tarField(header, 156, 1, entry.type ?? "0");
  if (entry.linkTarget !== undefined) tarField(header, 157, 100, entry.linkTarget);
  tarField(header, 257, 6, "ustar");
  tarField(header, 263, 2, "00");
  tarOctal(
    header,
    148,
    8,
    header.reduce((total, value) => total + value, 0),
  );
  return Buffer.concat([
    header,
    entry.bytes,
    Buffer.alloc((512 - (entry.bytes.length % 512)) % 512),
  ]);
}

function coreArchiveEntries(relativePath: string): readonly TarEntry[] {
  const absolute = resolve(relativePath);
  const stats = lstatSync(absolute);
  if (stats.isFile())
    return [
      {
        name: `ai-harness-${currentRevision()}/${relativePath.replaceAll("\\", "/")}`,
        bytes: readFileSync(absolute),
      },
    ];
  if (!stats.isDirectory()) throw new Error("fixture source shape");
  return readdirSync(absolute)
    .sort()
    .flatMap((name) => coreArchiveEntries(join(relativePath, name)));
}

function currentCoreArchive(extra: readonly TarEntry[] = []): Buffer {
  const entries = [
    ...coreArchiveEntries("aih-packs.json"),
    ...coreArchiveEntries("packs"),
    ...extra,
  ];
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
}

function copiedPackageCheckout(): string {
  const source = mkdtempSync(join(tmpdir(), "aih-scan-material-source-"));
  roots.push(source);
  cpSync(resolve("aih-packs.json"), join(source, "aih-packs.json"));
  cpSync(resolve("packs"), join(source, "packs"), { recursive: true });
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", [
    "-C",
    source,
    "-c",
    "user.name=AIH test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  return source;
}

function materialize(): MaterializedAihScanSubjectsV1 {
  const outputParent = mkdtempSync(join(tmpdir(), "aih-scan-material-test-"));
  roots.push(outputParent);
  const catalog = policyAuthoringCatalog();
  return materializeAihScanSubjectsV1({
    packageRoot: resolve("."),
    outputParent,
    coreRevision: { pinnedSha: currentRevision() },
    catalog,
    compiled: compileBuiltInCatalogV1(catalog),
  });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function signedPublication(request: BaselineVetRequestV1) {
  const annexArtifacts = [
    ...new Set(request.components.flatMap((component) => component.analyzers)),
  ].map((analyzer) => {
    const value =
      analyzer === "aih-native"
        ? {
            protocol: "BaselineNativeObservationV1",
            sourceTreeSha256: request.source.treeSha256,
            files: [],
          }
        : { version: "2.1.0", runs: [{ tool: { driver: { name: analyzer } }, results: [] }] };
    return {
      path: `annex/${analyzer}.json`,
      bytes: canonicalStrictJsonBytesV1(value),
    };
  });
  const byAnalyzer = new Map(
    annexArtifacts.map((artifact) => [artifact.path.slice(6, -5), artifact]),
  );
  const observations = [
    ...new Set(request.components.flatMap((component) => component.analyzers)),
  ].map((analyzer) => {
    const annex = byAnalyzer.get(analyzer);
    if (annex === undefined) throw new Error("fixture annex missing");
    const coreName = SCANNER_TO_CORE_BASELINE_ANALYZER[analyzer as ScannerBaselineAnalyzer];
    return {
      analyzer,
      analyzerVersion: SCANNER_BASELINE_ANALYZER_VERSIONS[coreName],
      annex: {
        path: annex.path,
        mediaType:
          analyzer === "aih-native"
            ? ("application/vnd.aih.baseline-native+json" as const)
            : ("application/sarif+json" as const),
        sha256: sha256(annex.bytes),
        byteLength: annex.bytes.byteLength,
      },
    };
  });
  const receiptWithoutDigest = {
    protocol: "BaselineVetReceiptV1" as const,
    profile: request.profile,
    requestSha256: request.requestSha256,
    source: request.source,
    observations,
    components: request.components.map((component) => ({
      id: component.id,
      content: component.content,
      paths: component.paths,
      treeSha256: component.treeSha256,
      observations: component.analyzers.map((analyzer) => {
        const annex = byAnalyzer.get(analyzer);
        if (annex === undefined) throw new Error("fixture component annex missing");
        return { analyzer, annexSha256: sha256(annex.bytes) };
      }),
    })),
  };
  const result = {
    receipt: {
      ...receiptWithoutDigest,
      receiptSha256: sha256(
        canonicalStrictJsonBytesV1({
          domain: "aih.baseline-vet-receipt-v1",
          receipt: receiptWithoutDigest,
        }),
      ),
    },
    annexArtifacts,
  } as BaselineVetBatchResultV1;
  const keys = generateKeyPairSync("ed25519");
  const signer = {
    identity: "aih-material-test-fixture",
    class: "test-ephemeral" as const,
    keyId: ed25519KeyIdV2(keys.publicKey),
  };
  const signed = signBaselineVetBundleV1({
    request,
    result,
    signer: { ...signer, privateKey: keys.privateKey },
    claims: {
      signedAt: "2026-09-07T11:30:00.000Z",
      expiresAt: "2026-09-07T12:30:00.000Z",
    },
  });
  const publicationBytes = canonicalStrictJsonBytesV1({
    protocol: "BaselineVetPublicationV1",
    request,
    receipt: result.receipt,
    annexes: annexArtifacts.map((annex) => ({
      path: annex.path,
      bytesBase64: annex.bytes.toString("base64"),
    })),
    envelope: JSON.parse(canonicalBaselineVetAttestationEnvelopeV1Bytes(signed).toString("utf8")),
    verification: {
      root: {
        ...signer,
        publicKeySpkiBase64: Buffer.from(
          keys.publicKey.export({ type: "spki", format: "der" }),
        ).toString("base64"),
      },
      expected: { now: "2026-09-07T12:00:00.000Z", signer },
    },
  });
  const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1;
  const discoveryBytes = canonicalStrictJsonBytesV1({
    protocol: "BaselineVetDiscoveryV1",
    authority: "none",
    requestSha256: request.requestSha256,
    receiptSha256: result.receipt.receiptSha256,
    evidenceDigestSha256: sha256(canonicalBaselineVetAttestationEnvelopeV1Bytes(signed)),
    publicationSha256: sha256(publicationBytes),
    locator: `https://github.com/${publisher.repository}/releases/download/baseline-v1-${publisher.commit}-${request.requestSha256}/publication.json`,
  });
  const workflowUri = `https://github.com/${publisher.workflow}@${publisher.ref}`;
  const attestationBytes = canonicalStrictJsonBytesV1([
    {
      attestation: {},
      verificationResult: {
        mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
        signature: {
          certificate: {
            subjectAlternativeName: workflowUri,
            buildSignerURI: workflowUri,
            buildConfigURI: workflowUri,
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryURI: `https://github.com/${publisher.repository}`,
            sourceRepositoryRef: publisher.ref,
            sourceRepositoryDigest: publisher.commit,
            runnerEnvironment: "github-hosted",
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ name: "publication.json", digest: { sha256: sha256(publicationBytes) } }],
        },
        verifiedTimestamps: [
          {
            type: "transparency-log",
            uri: "https://rekor.sigstore.dev",
            timestamp: "2026-09-07T12:05:00Z",
          },
        ],
      },
    },
  ]);
  return { discoveryBytes, publicationBytes, attestationBytes };
}

describe("AIH scan material", () => {
  it("binds the ten actual Core deliveries to their unchanged compiled identities", () => {
    const materialized = materialize();
    const request = createCoreBaselineVetRequest(materialized.sourceRoot, materialized.catalog);

    expect(materialized.catalog).toMatchObject({
      id: "aih",
      owner: "samartomar",
      repo: "ai-harness",
      pinnedSha: currentRevision(),
    });
    expect(materialized.coverage).toMatchObject({
      version: "workbench-scanner-coverage/v1",
      authority: "none",
      scope: "declared-source-files",
      sourceTreeSha256: hashSourceTree(materialized.sourceRoot).treeSha256,
    });
    expect(materialized.coverage.components).toHaveLength(10);
    expect(materialized.subjects).toHaveLength(10);
    expect(request.components).toHaveLength(10);
    expect(
      new Set(materialized.coverage.components.map((component) => component.componentId)).size,
    ).toBe(10);

    for (const subject of materialized.subjects) {
      const coverage = materialized.coverage.components.find(
        (component) => component.componentId === subject.componentId,
      );
      const scanned = request.components.find((component) => component.id === subject.componentId);
      if (coverage === undefined || scanned === undefined)
        throw new Error("missing scan subject join");
      expect(coverage.subject.assetId).toBe(subject.assetId);
      expect(scanned.treeSha256).toBe(coverage.componentTreeSha256);
      expect(hashComponentTree(materialized.sourceRoot, subject.paths).files).toEqual(
        subject.files,
      );
      expect(coverage.subject.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(coverage.subject.sourceId).toBe("source:aih-core");
      expect(coverage.subject.sourceRevisionId).toMatch(/^package:@aihq\/core@/);
    }
  });

  it("uses actual pack files and the reviewed pack manifest, generated recorder bytes, and scope-limited MCP declarations", () => {
    const materialized = materialize();
    const byAsset = new Map(materialized.subjects.map((subject) => [subject.assetId, subject]));
    const packs = [...byAsset.values()].filter((subject) =>
      subject.assetId.startsWith("aih/package:skill-pack/"),
    );
    expect(packs).toHaveLength(3);
    for (const pack of packs) {
      expect(pack.paths).toContain("aih-packs.json");
      expect(pack.files.some((file) => file.path.endsWith("/SKILL.md"))).toBe(true);
    }

    const hook = byAsset.get("aih/usage-metering");
    expect(hook?.paths).toEqual(["generated/usage-metering/usage-record.mjs"]);
    expect(hook?.files).toHaveLength(1);
    expect(hook?.files[0]?.bytes).toBeGreaterThan(1_000);

    const mcp = [...byAsset.values()].filter(
      (subject) =>
        subject.assetId.startsWith("aih/") &&
        subject.assetId !== "aih/usage-metering" &&
        !subject.assetId.startsWith("aih/package:"),
    );
    expect(mcp).toHaveLength(6);
    for (const subject of mcp) {
      expect(subject.paths).toHaveLength(1);
      expect(subject.paths[0]).toMatch(/^declarations\/claude\/project\/.+\.json$/);
      const file = subject.files[0];
      if (file === undefined) throw new Error("MCP material missing file");
      const value = JSON.parse(readFileSync(join(materialized.sourceRoot, file.path), "utf8")) as {
        client: string;
        scope: string;
        config: { mcpServers: Record<string, unknown> };
      };
      expect(value.client).toBe("claude");
      expect(value.scope).toBe("project");
      expect(Object.keys(value.config.mcpServers)).toHaveLength(1);
      expect(JSON.stringify(value)).not.toContain("implementation");
    }
  });

  it("refuses a non-pinned checkout, output below the checkout, and altered compiler output before producing a scan tree", () => {
    const parent = mkdtempSync(join(tmpdir(), "aih-scan-material-reject-"));
    roots.push(parent);
    const catalog = policyAuthoringCatalog();
    const compiled = compileBuiltInCatalogV1(catalog);
    expect(() =>
      materializeAihScanSubjectsV1({
        packageRoot: resolve("."),
        outputParent: parent,
        coreRevision: { pinnedSha: "0".repeat(40) },
        catalog,
        compiled,
      }),
    ).toThrow(/checkout revision/);
    expect(readdirSync(parent)).toEqual([]);

    expect(() =>
      materializeAihScanSubjectsV1({
        packageRoot: resolve("."),
        outputParent: resolve(".aih-scratch"),
        coreRevision: { pinnedSha: currentRevision() },
        catalog,
        compiled,
      }),
    ).toThrow(/outside Core checkout/);

    const altered = structuredClone(compiled);
    const first = altered.declarations[0];
    if (first === undefined) throw new Error("compiled fixture has no declaration");
    first.declaration.contentDigest = `sha256:${"0".repeat(64)}`;
    expect(() =>
      materializeAihScanSubjectsV1({
        packageRoot: resolve("."),
        outputParent: parent,
        coreRevision: { pinnedSha: currentRevision() },
        catalog,
        compiled: altered,
      }),
    ).toThrow(/canonical compiler output/);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("allows ordinary source directories while rejecting a hard-linked delivery file", () => {
    const packageRoot = copiedPackageCheckout();
    const outputParent = mkdtempSync(join(tmpdir(), "aih-scan-material-links-"));
    roots.push(outputParent);
    const catalog = policyAuthoringCatalog();
    const compiled = compileBuiltInCatalogV1(catalog);
    const sourceFile = join(packageRoot, "packs/docs-quality/aih-betterdoc/SKILL.md");
    linkSync(sourceFile, join(packageRoot, "packs/docs-quality/aih-betterdoc/hardlink.md"));

    expect(() =>
      materializeAihScanSubjectsV1({
        packageRoot,
        outputParent,
        coreRevision: {
          pinnedSha: execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
        },
        catalog,
        compiled,
      }),
    ).toThrow(/hard-linked file/);
    expect(readdirSync(outputParent)).toHaveLength(1);
  });

  it("refuses copied pack bytes that no longer match the pinned Core Git revision", () => {
    const packageRoot = copiedPackageCheckout();
    const outputParent = mkdtempSync(join(tmpdir(), "aih-scan-material-dirty-pack-"));
    roots.push(outputParent);
    const catalog = policyAuthoringCatalog();
    const compiled = compileBuiltInCatalogV1(catalog);
    const skill = join(packageRoot, "packs/docs-quality/aih-betterdoc/SKILL.md");
    writeFileSync(skill, `${readFileSync(skill, "utf8")}\nchanged after pin\n`);

    expect(() =>
      materializeAihScanSubjectsV1({
        packageRoot,
        outputParent,
        coreRevision: {
          pinnedSha: execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
        },
        catalog,
        compiled,
      }),
    ).toThrow(/differs from pinned Core revision/);
    expect(readdirSync(outputParent)).toHaveLength(1);
  });

  it("accepts only a same-process integrity-checked Core archive and rejects a later archive mutation", async () => {
    const archiveParent = mkdtempSync(join(tmpdir(), "aih-scan-material-archive-"));
    const packageRoot = join(archiveParent, "checkout");
    const outputParent = mkdtempSync(join(tmpdir(), "aih-scan-material-archive-output-"));
    roots.push(archiveParent, outputParent);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(currentCoreArchive())),
    );
    await acquireBoundedGithubSourceArchiveV1({
      repository: "samartomar/ai-harness",
      commit: currentRevision(),
      destination: packageRoot,
    });
    const catalog = policyAuthoringCatalog();
    const compiled = compileBuiltInCatalogV1(catalog);
    expect(
      materializeAihScanSubjectsV1({
        packageRoot,
        outputParent,
        coreRevision: { pinnedSha: currentRevision() },
        catalog,
        compiled,
      }).subjects,
    ).toHaveLength(10);

    writeFileSync(
      join(packageRoot, "packs/docs-quality/aih-betterdoc/SKILL.md"),
      "changed archive bytes",
    );
    expect(() =>
      materializeAihScanSubjectsV1({
        packageRoot,
        outputParent,
        coreRevision: { pinnedSha: currentRevision() },
        catalog,
        compiled,
      }),
    ).toThrow(/Core checkout revision/);
  });

  it("rejects an omitted archive symlink beneath a declared pack before creating material", async () => {
    const archiveParent = mkdtempSync(join(tmpdir(), "aih-scan-material-link-archive-"));
    const packageRoot = join(archiveParent, "checkout");
    const outputParent = mkdtempSync(join(tmpdir(), "aih-scan-material-link-output-"));
    roots.push(archiveParent, outputParent);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            currentCoreArchive([
              {
                name: `ai-harness-${currentRevision()}/packs/docs-quality/aih-betterdoc/omitted-link`,
                bytes: Buffer.alloc(0),
                type: "2",
                linkTarget: "SKILL.md",
              },
            ]),
          ),
      ),
    );
    await acquireBoundedGithubSourceArchiveV1({
      repository: "samartomar/ai-harness",
      commit: currentRevision(),
      destination: packageRoot,
    });
    const catalog = policyAuthoringCatalog();
    expect(() =>
      materializeAihScanSubjectsV1({
        packageRoot,
        outputParent,
        coreRevision: { pinnedSha: currentRevision() },
        catalog,
        compiled: compileBuiltInCatalogV1(catalog),
      }),
    ).toThrow(/omits a covered source path/);
    expect(readdirSync(outputParent)).toEqual([]);
  });

  it("seals the shared package record only after Scanner verifies the real materialized subjects", async () => {
    const materialized = materialize();
    const preparationParent = mkdtempSync(join(tmpdir(), "aih-scan-material-prepared-"));
    roots.push(preparationParent);
    const artifacts = createCoreBaselineVetRequests(
      materialized.sourceRoot,
      materialized.catalog,
    ).map(signedPublication);
    const calls: string[][] = [];
    let next = 0;
    mocks.defaultRunner.mockImplementation(async (argv) => {
      calls.push([...argv]);
      expect(argv.slice(0, 3)).toEqual(["gh", "attestation", "verify"]);
      const artifact = artifacts[next++];
      if (artifact === undefined) throw new Error("unexpected attestation invocation");
      return { code: 0, stdout: artifact.attestationBytes.toString("utf8"), stderr: "" };
    });

    const catalog = policyAuthoringCatalog();
    const prepared = await prepareAihScannerPublicationsV1({
      packageRoot: resolve("."),
      materialOutputParent: preparationParent,
      coreRevision: { pinnedSha: currentRevision() },
      catalog,
      compiled: compileBuiltInCatalogV1(catalog),
      batches: artifacts.map(({ discoveryBytes, publicationBytes }) => ({
        discoveryBytes,
        publicationBytes,
      })),
      now: "2026-09-07T12:10:00.000Z",
    });
    expect(readdirSync(preparationParent)).toEqual([]);
    const authored = authorPreparedAihScannerPublicationV1(prepared);
    const sealed = authorPackagedAihScannerEvidenceRecordV1(prepared);
    if (authored === undefined || sealed === undefined)
      throw new Error("operational output missing");
    const record = PackagedScannerCollectionEvidenceRecordV1Schema.parse(JSON.parse(sealed.bytes));

    expect(calls).toHaveLength(artifacts.length);
    expect(authored).toMatchObject({
      catalog: {
        id: "aih",
        source: {
          id: "source:aih-core",
          inputFormat: "built-in/v1",
          upstreamOrigin: { kind: "aih" },
        },
      },
      verification: {
        method: "gh-attestation-verify",
        preparedAt: "2026-09-07T12:10:00.000Z",
      },
    });
    expect(record).toMatchObject({
      version: "packaged-scanner-collection-evidence/v1",
      authority: "display-only",
      catalog: authored.catalog,
      verification: {
        method: "gh-attestation-verify",
        preparedAt: "2026-09-07T12:10:00.000Z",
      },
    });
    expect(record.coverage.components).toHaveLength(10);
    expect(sealed.bytes).not.toContain("ageSeconds");
    expect(sealed.bytes).not.toContain("reverifiedAt");
    expect(authorPreparedAihScannerPublicationV1(structuredClone(prepared))).toBeUndefined();
    expect(authorPackagedAihScannerEvidenceRecordV1(structuredClone(prepared))).toBeUndefined();

    next = 0;
    const reverified = await reverifyPackagedAihScannerEvidenceRecordV1({
      packageRoot: resolve("."),
      coreRevision: { pinnedSha: currentRevision() },
      catalog,
      compiled: compileBuiltInCatalogV1(catalog),
      batches: artifacts.map(({ discoveryBytes, publicationBytes }) => ({
        discoveryBytes,
        publicationBytes,
      })),
      now: "2026-09-07T12:20:00.000Z",
      sealed,
    });
    expect(authorPreparedAihScannerPublicationV1(reverified)).toMatchObject({
      verification: { preparedAt: "2026-09-07T12:20:00.000Z" },
    });
  });

  it("uses the process-owned attestation verifier after materializing from a real Core pin", async () => {
    const outputParent = mkdtempSync(join(tmpdir(), "aih-scan-material-preparation-"));
    roots.push(outputParent);
    const catalog = policyAuthoringCatalog();
    const calls: string[][] = [];
    mocks.defaultRunner.mockImplementation(async (argv) => {
      calls.push([...argv]);
      return { code: 0, stdout: "{}", stderr: "" };
    });
    await expect(
      prepareAihScannerPublicationsV1({
        packageRoot: resolve("."),
        materialOutputParent: outputParent,
        coreRevision: { pinnedSha: currentRevision() },
        catalog,
        compiled: compileBuiltInCatalogV1(catalog),
        batches: [
          {
            discoveryBytes: Buffer.from(
              JSON.stringify({
                locator: `https://github.com/samartomar/aih-scan/releases/download/baseline-v1-${SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.commit}-${"a".repeat(64)}/publication.json`,
              }),
            ),
            publicationBytes: Buffer.from("{}"),
          },
        ],
        now: "2026-09-07T12:10:00.000Z",
      }),
    ).rejects.toThrow(/publication/i);
    expect(readdirSync(outputParent)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["gh", "attestation", "verify"]);
  });
});
