import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ input: undefined as unknown, runner: vi.fn() }));
// Substitute the package snapshot and GitHub transport only. Material hashing,
// compiler bindings, receipt parsing, qualification admission and encoding are real.
vi.mock("../../src/org-policy/workbench/providers/mattpocock.js", async (original) => ({
  ...(await original<typeof import("../../src/org-policy/workbench/providers/mattpocock.js")>()),
  getMattPocockPinnedSkillCollectionV1: () => transport.input,
}));
vi.mock("../../src/internals/proc.js", async (original) => ({
  ...(await original<typeof import("../../src/internals/proc.js")>()),
  defaultRunner: transport.runner,
}));
vi.mock("../../src/live/runner.js", async (original) => ({
  ...(await original<typeof import("../../src/live/runner.js")>()),
  findOnPath: () => "fixture-gh",
}));

import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { writeOperationalCatalogQualificationDraftV1 } from "../../src/internals/prepare-workbench-catalog-qualification.js";
import { decodeCatalogQualificationPackageInputV1 } from "../../src/org-policy/workbench/core/catalog-qualification-package-v1.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICY_V1 } from "../../src/org-policy/workbench/core/catalog-qualification-policy-v1.js";
import {
  compilerQualificationBindingDigestV1,
  prepareRegisteredCompilerQualificationBindingsV1,
} from "../../src/org-policy/workbench/core/catalog-qualification-v1.js";
import { scannerOperationalFixtureV1 } from "../org-policy/workbench/source-data-scanner-fixture.js";

const roots: string[] = [];
const now = "2026-09-09T12:00:00.000Z";
const bare = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (bytes: string | Uint8Array) => `sha256:${bare(bytes)}`;
afterEach(() => {
  transport.runner.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("writes only a material-bound, attested qualification and preserves the draft when source bytes change", async () => {
  const fixture = scannerOperationalFixtureV1("collection");
  roots.push(fixture.root);
  transport.input = fixture.compilerInput;
  const bindings = prepareRegisteredCompilerQualificationBindingsV1(
    fixture.bundle,
    fixture.root,
    "mattpocock",
  );
  const binding = Object.values(bindings ?? {})[0];
  if (binding?.material.kind !== "source-files") throw new Error("missing real material binding");
  const artifactRoot = mkdtempSync(join(tmpdir(), "aih-qualification-roundtrip-"));
  roots.push(artifactRoot);
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
    closure: { identity: "artifact:artifacts/fixture-closure.json", sha256: bare(closureBytes) },
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
  let calls = 0;
  transport.runner.mockImplementation(() => {
    const isReceipt = calls++ % 2 === 0;
    const publisher = isReceipt
      ? { ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher, subjectName: "recipe.fixture.json" }
      : CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher;
    const workflow = `https://github.com/${publisher.workflow}@${publisher.ref}`;
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify([
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
              {
                type: "signed",
                uri: "https://rekor.sigstore.dev",
                timestamp: "2026-09-02T00:00:00Z",
              },
            ],
            statement: {
              _type: "https://in-toto.io/Statement/v1",
              predicateType: "https://slsa.dev/provenance/v1",
              subject: [
                {
                  name: publisher.subjectName,
                  digest: { sha256: bare(isReceipt ? receiptBytes : receiptSetBytes) },
                },
              ],
            },
          },
        },
      ]),
    };
  });
  const output = join(artifactRoot, "prepared.json");
  const input = {
    bundle: fixture.bundle,
    sourceRoot: fixture.root,
    providerId: "mattpocock",
    artifactRoot,
    output,
    now,
  };
  const prepared = await writeOperationalCatalogQualificationDraftV1(input);
  const original = readFileSync(output);
  const decoded = decodeCatalogQualificationPackageInputV1(JSON.parse(original.toString("utf8")));
  expect(decoded.records[0]?.receiptBytes).toEqual(receiptBytes);
  expect(prepared.projection.summary[binding.asset.assetId]).toMatchObject({
    verifiedAt: now,
    validUntil: receipt.expiresAt,
  });
  expect(transport.runner).toHaveBeenCalledTimes(2);
  const skillFile = binding.material.files.find((file) => file.path.endsWith("SKILL.md"));
  if (!skillFile) throw new Error("missing skill material");
  writeFileSync(join(fixture.root, skillFile.path), "changed source bytes");
  await expect(writeOperationalCatalogQualificationDraftV1(input)).rejects.toThrow();
  expect(readFileSync(output)).toEqual(original);
  expect(transport.runner).toHaveBeenCalledTimes(2);
});
