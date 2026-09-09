import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const packageInput = vi.hoisted(() => ({
  collection: [] as readonly Readonly<{ bytes: string; sha256: string }>[],
  qualification: { version: 1, records: [], bindings: [], projections: [] } as unknown,
  matt: undefined as unknown,
  runner: vi.fn(),
}));

// The test supplies release package bytes and the two external GitHub transports.
// Scanner signatures, material preparation, qualification admission, and the final
// canonical projection comparison remain the production implementations.
vi.mock("../../src/org-policy/packaged-collection-evidence-data.js", () => ({
  packagedScannerCollectionEvidenceInputV1: () => packageInput.collection,
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-data.js", () => ({
  catalogQualificationPackageInputV1: () => packageInput.qualification,
}));
vi.mock("../../src/org-policy/workbench/default-catalog-preassembly.js", async (original) => ({
  ...(await original<
    typeof import("../../src/org-policy/workbench/default-catalog-preassembly.js")
  >()),
  packagedDefaultCatalogPreassemblyV1: () => undefined,
}));
vi.mock("../../src/org-policy/workbench/providers/mattpocock.js", async (original) => ({
  ...(await original<typeof import("../../src/org-policy/workbench/providers/mattpocock.js")>()),
  getMattPocockPinnedSkillCollectionV1: () => packageInput.matt,
}));
vi.mock("../../src/internals/proc.js", async (original) => ({
  ...(await original<typeof import("../../src/internals/proc.js")>()),
  defaultRunner: packageInput.runner,
}));
vi.mock("../../src/live/runner.js", async (original) => ({
  ...(await original<typeof import("../../src/live/runner.js")>()),
  findOnPath: () => "fixture-gh",
}));

import {
  authorPackagedScannerCollectionEvidenceRecordV1,
  prepareScannerCollectionPublicationsV1,
} from "../../src/baseline-evidence/scanner-collection-preparation.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { writeOperationalCatalogQualificationDraftV1 } from "../../src/internals/prepare-workbench-catalog-qualification.js";
import { verifyWorkbenchPublicPublicationV1 } from "../../src/internals/verify-workbench-publication.js";
import type { PinnedSkillCollectionInputV1 } from "../../src/org-policy/workbench/compilers/pinned-skill-collection.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICY_V1 } from "../../src/org-policy/workbench/core/catalog-qualification-policy-v1.js";
import {
  compilerQualificationBindingDigestV1,
  prepareRegisteredCompilerQualificationBindingsV1,
} from "../../src/org-policy/workbench/core/catalog-qualification-v1.js";
import { MATTPOCOCK_SKILLS_SOURCE_V1 } from "../../src/org-policy/workbench/providers/mattpocock.js";
import { scannerOperationalFixtureV1 } from "../org-policy/workbench/source-data-scanner-fixture.js";

const roots: string[] = [];
const now = "2026-09-03T13:20:00.000Z";
const bare = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (bytes: string | Uint8Array) => `sha256:${bare(bytes)}`;
const mutableMattSource = MATTPOCOCK_SKILLS_SOURCE_V1 as { repository: string };
const originalMattRepository = mutableMattSource.repository;

afterEach(() => {
  packageInput.collection = [];
  packageInput.qualification = { version: 1, records: [], bindings: [], projections: [] };
  packageInput.matt = undefined;
  packageInput.runner.mockReset();
  mutableMattSource.repository = originalMattRepository;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function catalogAttestation(
  bytes: Uint8Array,
  subjectName: string,
  publisher: Readonly<{
    repository: string;
    workflow: string;
    ref: string;
    issuer: string;
    commit: string;
    subjectName: string;
  }>,
) {
  const workflow = `https://github.com/${publisher.workflow}@${publisher.ref}`;
  return JSON.stringify([
    {
      verificationResult: {
        signature: {
          certificate: {
            subjectAlternativeName: workflow,
            buildSignerURI: workflow,
            buildConfigURI: workflow,
            issuer: publisher.issuer,
            sourceRepositoryURI: `https://github.com/${publisher.repository}`,
            sourceRepositoryRef: publisher.ref,
            sourceRepositoryDigest: publisher.commit,
            runnerEnvironment: "github-hosted",
          },
        },
        verifiedTimestamps: [
          { type: "signed", uri: "https://rekor.sigstore.dev", timestamp: "2026-09-03T13:05:00Z" },
        ],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ name: subjectName, digest: { sha256: bare(bytes) } }],
        },
      },
    },
  ]);
}

function collectionInput(fixture: ReturnType<typeof scannerOperationalFixtureV1>) {
  const input = fixture.compilerInput;
  if (input.version !== "pinned-skill-collection/v1") throw new Error("collection fixture missing");
  return input as PinnedSkillCollectionInputV1;
}

async function prepareQualificationPackage(
  fixture: ReturnType<typeof scannerOperationalFixtureV1>,
  artifactRoot: string,
) {
  const bindings = prepareRegisteredCompilerQualificationBindingsV1(
    fixture.bundle,
    fixture.root,
    "mattpocock",
  );
  const binding = Object.values(bindings ?? {})[0];
  if (binding?.material.kind !== "source-files") throw new Error("fixture binding missing");
  const closure = {
    format: "aih-supported-catalog-member-closure",
    version: 1,
    ...binding.asset,
    sourceContentDigest: binding.sourceContentDigest,
    subjectDigest: binding.subject.subjectDigest,
    bindingDigest: compilerQualificationBindingDigestV1(binding),
    scope: { kind: "source-files", description: "Fixture source files" },
    files: binding.material.files,
  };
  const closureBytes = canonicalStrictJsonBytesV1(closure);
  const member = {
    capabilities: { commands: [], egress: [], hooks: [], mcpTools: [], permissions: [] },
    closure: { identity: "artifact:fixture-closure.json", sha256: bare(closureBytes) },
    entryId: "recipe.fixture",
    platforms: [{ architecture: "amd64", os: "linux" }],
    prose: { identity: "artifact:prose.md", sha256: bare("fixture prose") },
    qualification: {
      findings: [],
      gaps: [],
      report: { identity: "evidence:report", sha256: bare("fixture report") },
      rights: [],
    },
    recipe: { identity: "artifact:recipe.json", sha256: bare("fixture recipe") },
    subject: binding.subject,
    versions: { effect: "2", schema: "2" },
  };
  const memberBytes = canonicalStrictJsonBytesV1(member);
  const memberDigest = digest(`aih-supported-catalog-member/v2\0${memberBytes.toString("utf8")}`);
  const headDigest = digest("fixture head");
  const receipt = {
    format: "aih-supported-qualification-receipt",
    version: 2,
    organizationAdmission: "not-authoritative",
    entryId: member.entryId,
    subject: binding.subject,
    qualificationBasis: {
      kind: "aih-supported",
      catalogSignerIdentity: "administrator:aih-supported/catalog-v2",
      catalogDigest: digest("fixture catalog"),
      catalogHeadDigest: headDigest,
      catalogMemberDigest: memberDigest,
      subjectKind: binding.subject.kind,
      subjectDigest: binding.subject.subjectDigest,
    },
    catalogContinuity: {
      catalogHeadDigest: headDigest,
      previousCatalogHeadDigest: `sha256:${"0".repeat(64)}`,
      sequence: 0,
      replayIdentity: `catalog-head:${bare("fixture head")}:${bare("fixture replay")}`,
      signerKeyId: `ed25519:${bare("fixture key")}`,
      headValidFrom: "2026-09-01T00:00:00Z",
      headValidUntil: "2026-11-30T00:00:00Z",
    },
    issuedAt: "2026-09-01T00:00:00Z",
    notBefore: "2026-09-01T00:00:00Z",
    expiresAt: "2026-11-30T00:00:00Z",
  };
  const receiptBytes = canonicalStrictJsonBytesV1(receipt);
  const receiptSetBytes = canonicalStrictJsonBytesV1({
    format: "aih-supported-qualification-receipt-set",
    version: 1,
    entries: [
      {
        entryId: member.entryId,
        memberDigest,
        path: "receipts/recipe.fixture.json",
        receiptSha256: bare(receiptBytes),
      },
    ],
  });
  for (const [name, bytes] of Object.entries({
    "receipt.json": receiptBytes,
    "receipt-set.json": receiptSetBytes,
    "member.json": memberBytes,
    "closure.json": closureBytes,
  }))
    writeFileSync(join(artifactRoot, name), bytes);
  packageInput.runner.mockImplementation((args: readonly string[]) => {
    if (args[0] === "git")
      return { code: 0, stdout: collectionInput(fixture).source.commit, stderr: "" };
    const path = args[3];
    if (typeof path !== "string") throw new Error("missing attestation subject");
    const isReceipt =
      JSON.parse(readFileSync(path, "utf8")).format === "aih-supported-qualification-receipt";
    const publisher = isReceipt
      ? { ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher, subjectName: "recipe.fixture.json" }
      : CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher;
    return {
      code: 0,
      stderr: "",
      stdout: catalogAttestation(readFileSync(path), publisher.subjectName, publisher),
    };
  });
  const output = join(artifactRoot, "qualification-package.json");
  await writeOperationalCatalogQualificationDraftV1({
    bundle: fixture.bundle,
    sourceRoot: fixture.root,
    providerId: "mattpocock",
    artifactRoot,
    output,
    now,
  });
  return JSON.parse(readFileSync(output, "utf8"));
}

it("replays a real Scanner collection and Catalog qualification package through the top-level verifier", async () => {
  const fixture = scannerOperationalFixtureV1("collection");
  const compilerInput = collectionInput(fixture);
  const artifactRoot = mkdtempSync(join(tmpdir(), "aih-top-level-publication-"));
  roots.push(fixture.root, artifactRoot);
  packageInput.matt = fixture.compilerInput;
  mutableMattSource.repository = compilerInput.source.repository;
  const batch = (
    fixture.proof.batches as { discoveryBytesBase64: string; publicationBytesBase64: string }[]
  )[0];
  if (!batch) throw new Error("fixture batch missing");
  packageInput.runner.mockImplementation((args: readonly string[]) => {
    if (args[0] === "git") return { code: 0, stdout: compilerInput.source.commit, stderr: "" };
    return { code: 0, stdout: fixture.attestationResult, stderr: "" };
  });
  const prepared = await prepareScannerCollectionPublicationsV1({
    sourceRoot: fixture.root,
    catalogId: "mattpocock",
    batches: [
      {
        discoveryBytes: Buffer.from(batch.discoveryBytesBase64, "base64"),
        publicationBytes: Buffer.from(batch.publicationBytesBase64, "base64"),
      },
    ],
    now,
  });
  const sealed = authorPackagedScannerCollectionEvidenceRecordV1(prepared);
  if (!sealed) throw new Error("fixture scanner material was not prepared");
  packageInput.collection = [sealed];
  packageInput.qualification = await prepareQualificationPackage(fixture, artifactRoot);

  const publicationRoot = join(artifactRoot, "publications");
  const batchRoot = join(publicationRoot, "batch-001");
  mkdirSync(batchRoot, { recursive: true });
  for (const [name, bytes] of Object.entries({
    "discovery.json": Buffer.from(batch.discoveryBytesBase64, "base64"),
    "publication.json": Buffer.from(batch.publicationBytesBase64, "base64"),
    "inspection.json": Buffer.from("{}\n"),
    SHA256SUMS: Buffer.from("fixture\n"),
  })) {
    const path = join(batchRoot, name);
    writeFileSync(path, bytes, { flag: "w" });
  }
  packageInput.runner.mockImplementation((args: readonly string[]) => {
    if (args[0] === "git") return { code: 0, stdout: compilerInput.source.commit, stderr: "" };
    const path = args[3];
    if (typeof path !== "string") throw new Error("missing attestation subject");
    if (args.includes("--signer-workflow"))
      return { code: 0, stdout: fixture.attestationResult, stderr: "" };
    const isReceipt =
      JSON.parse(readFileSync(path, "utf8")).format === "aih-supported-qualification-receipt";
    const publisher = isReceipt
      ? { ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher, subjectName: "recipe.fixture.json" }
      : CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher;
    return {
      code: 0,
      stderr: "",
      stdout: catalogAttestation(readFileSync(path), publisher.subjectName, publisher),
    };
  });
  const material = [
    { sourceRoot: fixture.root, catalogId: "mattpocock" as const, publicationRoot },
  ];
  // Use a deliberately corrupted transport byte sequence after the successful run:
  // the top-level contract must reject a record that no longer replays to its seal.
  await expect(
    verifyWorkbenchPublicPublicationV1({
      now,
      catalogQualification: [{ sourceRoot: fixture.root, providerId: "mattpocock" }],
      collectionMaterial: material,
    }),
  ).resolves.toBeUndefined();
  const publication = JSON.parse(
    Buffer.from(batch.publicationBytesBase64, "base64").toString("utf8"),
  );
  publication.receipt.receiptSha256 = "0".repeat(64);
  writeFileSync(join(batchRoot, "publication.json"), canonicalStrictJsonBytesV1(publication));
  await expect(
    verifyWorkbenchPublicPublicationV1({
      now,
      catalogQualification: [{ sourceRoot: fixture.root, providerId: "mattpocock" }],
      collectionMaterial: material,
    }),
  ).rejects.toThrow(/publication|receipt|collection/i);
});
