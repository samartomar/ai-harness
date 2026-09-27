import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  admittedSourceFromCandidateBundleV1,
  collectionCoverageV1,
} from "../../../src/baseline-evidence/scanner-catalog-consumer.js";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 } from "../../../src/baseline-evidence/scanner-publication-policy.js";
import { sealedSingleSourceBundle } from "../../baseline-evidence/candidate-bundle-fixture.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  verify: vi.fn(),
  consume: vi.fn(),
  project: vi.fn(),
  projectCollection: vi.fn(),
}));
vi.mock("../../../src/org-policy/packaged-collection-evidence-v1.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/org-policy/packaged-collection-evidence-v1.js")
  >()),
  projectScannerCollectionEvidenceV1: mocks.projectCollection,
}));
vi.mock("../../../src/baseline-evidence/scanner-catalog-consumer.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/baseline-evidence/scanner-catalog-consumer.js")
  >()),
  prepareCollectionScannerCoverageV1: mocks.prepare,
}));
vi.mock(
  "../../../src/org-policy/workbench/core/source-data-qualification.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/org-policy/workbench/core/source-data-qualification.js")
    >()),
    verifySourceDataArtifactWithGithubV1: mocks.verify,
  }),
);
vi.mock("../../../src/baseline-evidence/scanner-publication.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/baseline-evidence/scanner-publication.js")
  >()),
  consumeScannerBaselinePublicationsV1: mocks.consume,
}));
vi.mock(
  "../../../src/org-policy/workbench/core/source-data-contained-projection.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/org-policy/workbench/core/source-data-contained-projection.js")
    >()),
    projectContainedScannerEvidenceV1: mocks.project,
  }),
);

import { prepareSourceDataScannerEvidenceV1 } from "../../../src/org-policy/workbench/core/source-data-scanner.js";

const pin = "c".repeat(40);
const skill = "---\nname: tdd\n---\n# TDD\n";
const definition = {
  version: "pinned-skill-collection/v1" as const,
  source: { id: "mattpocock", repository: "https://github.com/mattpocock/skills", commit: pin },
  skills: [
    {
      id: "tdd",
      files: [{ path: "skills/tdd/SKILL.md", bytesBase64: Buffer.from(skill).toString("base64") }],
    },
  ],
};
const roots: string[] = [];
function blob(root: string, content: string): { sha256: string; bytes: number } {
  const bytes = Buffer.from(content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(root, `${sha256}.blob`), bytes);
  return { sha256, bytes: bytes.length };
}
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("replays a declared collection against its admitted source before accepting publication evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-scanner-proof-"));
  roots.push(root);
  mkdirSync(join(root, "skills", "tdd"), { recursive: true });
  writeFileSync(join(root, "skills", "tdd", "SKILL.md"), skill);
  const bundle = sealedSingleSourceBundle("mattpocock", pin, ["tdd"]);
  const prepared = collectionCoverageV1(
    root,
    definition,
    admittedSourceFromCandidateBundleV1(bundle, "source:mattpocock"),
  );
  mocks.prepare.mockReturnValue(prepared);
  mocks.verify.mockReturnValue("{}");
  mocks.consume.mockResolvedValue({
    evidence: { id: "mattpocock" },
    provenance: [{ attestedAt: "2026-09-24T00:00:00.000Z" }],
  });
  const accepted = { "mattpocock/skill:tdd": { authority: "display-only" } };
  mocks.project.mockReturnValue(accepted);
  const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1[0];
  if (publisher === undefined) throw new Error("scanner publisher fixture is missing");
  const proof = {
    version: "source-data-scanner-proof/v1",
    definitionOverlap: "compiler-catalog",
    compilerInput: {
      version: "source-compiler-input-blob/v1",
      ...blob(root, JSON.stringify(definition)),
    },
    publishedCatalog: prepared.catalog,
    preparedAt: "2026-09-24T01:00:00.000Z",
    publisherCommit: publisher.commit,
    batches: [
      {
        version: "scanner-proof-blobs/v1",
        discovery: blob(root, "{}"),
        publication: blob(root, '{"publication":true}'),
        attestation: blob(root, '{"verified":true}'),
      },
    ],
  };
  expect(
    await prepareSourceDataScannerEvidenceV1(
      bundle as never,
      proof,
      root,
      "2026-09-24T02:00:00.000Z",
      [proof.publisherCommit],
      "2026-09-24T03:00:00.000Z",
      root,
    ),
  ).toEqual(accepted);
  expect(mocks.consume).toHaveBeenCalledOnce();
  expect(mocks.project).toHaveBeenCalledWith(
    expect.objectContaining({
      bundle,
      sourceRoot: root,
      declaredCatalog: prepared.catalog,
      catalog: prepared.catalog,
      overlap: "compiler-catalog",
    }),
  );
});

it("builds a display-only collection record from the authenticated report", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-scanner-record-"));
  roots.push(root);
  mkdirSync(join(root, "skills", "tdd"), { recursive: true });
  writeFileSync(join(root, "skills", "tdd", "SKILL.md"), skill);
  const bundle = sealedSingleSourceBundle("mattpocock", pin, ["tdd"]);
  const prepared = collectionCoverageV1(
    root,
    definition,
    admittedSourceFromCandidateBundleV1(bundle, "source:mattpocock"),
  );
  const component = prepared.coverage.components[0];
  if (component === undefined) throw new Error("missing scanner component fixture");
  mocks.prepare.mockReturnValue(prepared);
  mocks.verify.mockReturnValue('{"verified":true}');
  const reportComponent = {
    id: component.componentId,
    paths: component.paths,
    treeSha256: component.componentTreeSha256,
    verdict: "no-findings",
    analyzers: [{ name: "scanner", version: "1" }],
    findings: [],
    evidenceProblems: [],
  };
  const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1[0];
  if (publisher === undefined) throw new Error("scanner publisher fixture is missing");
  const provenance = {
    authority: "none",
    repository: publisher.repository,
    workflow: publisher.workflow,
    ref: publisher.ref,
    sourceCommit: publisher.commit,
    publicationSha256: "a".repeat(64),
    requestSha256: "b".repeat(64),
    receiptSha256: "c".repeat(64),
    publicationLocator: `https://github.com/${publisher.repository}/releases/download/baseline-v1-${publisher.commit}-${"b".repeat(64)}/publication.json`,
    reportSignedAt: "2026-09-24T00:00:00.000Z",
    reportVerificationExpiresAt: "2026-09-25T00:00:00.000Z",
    attestedAt: "2026-09-24T01:00:00.000Z",
  };
  mocks.consume.mockResolvedValue({
    evidence: {
      id: prepared.catalog.id,
      owner: prepared.catalog.owner,
      repo: prepared.catalog.repo,
      pinnedSha: prepared.catalog.pinnedSha,
      sourceTreeSha256: prepared.coverage.sourceTreeSha256,
      components: [reportComponent],
    },
    provenance: [provenance],
  });
  const accepted = { "mattpocock/skill:tdd": { authority: "display-only" } };
  mocks.projectCollection.mockReturnValue(accepted);
  const proof = {
    version: "source-data-scanner-proof/v1",
    compilerInput: {
      version: "source-compiler-input-blob/v1",
      ...blob(root, JSON.stringify(definition)),
    },
    preparedAt: "2026-09-24T02:00:00.000Z",
    publisherCommit: publisher.commit,
    batches: [
      {
        version: "scanner-proof-blobs/v1",
        discovery: blob(root, "{}"),
        publication: blob(root, '{"publication":true}'),
        attestation: blob(root, '{"verified":true}'),
      },
    ],
  };
  expect(
    await prepareSourceDataScannerEvidenceV1(
      bundle as never,
      proof,
      root,
      "2026-09-24T02:00:00.000Z",
      [publisher.commit],
      "2026-09-24T03:00:00.000Z",
      root,
    ),
  ).toEqual(accepted);
  expect(mocks.projectCollection).toHaveBeenCalledWith(bundle, [
    expect.objectContaining({
      authority: "display-only",
      report: expect.objectContaining({ components: [reportComponent] }),
      observations: [
        expect.objectContaining({
          componentId: component.componentId,
          componentTreeSha256: component.componentTreeSha256,
          reportSignedAt: provenance.reportSignedAt,
        }),
      ],
    }),
  ]);
});
