import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  admittedSourceFromCandidateBundleV1,
  collectionCoverageV1,
} from "../../src/baseline-evidence/scanner-catalog-consumer.js";
import { createCoreBaselineVetRequests } from "../../src/baseline-evidence/scanner-consumer.js";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 } from "../../src/baseline-evidence/scanner-publication-policy.js";
import type { Runner } from "../../src/internals/proc.js";
import { sealedSingleSourceBundle } from "./candidate-bundle-fixture.js";

const mocks = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock("../../src/baseline-evidence/scanner-publication.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/baseline-evidence/scanner-publication.js")>()),
  consumeScannerBaselinePublicationsV1: mocks.consume,
}));

import {
  authorPackagedScannerCollectionEvidenceRecordV1,
  authorPreparedScannerCollectionPublicationV1,
  prepareScannerCollectionPublicationsV1,
  projectPreparedScannerCollectionEvidenceForDisplayV1,
} from "../../src/baseline-evidence/scanner-collection-preparation.js";

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
let root: string;
afterEach(() => {
  vi.resetAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

it("consumes verified publication bytes but never grants custody to an injected verifier", async () => {
  root = mkdtempSync(join(tmpdir(), "aih-injected-custody-"));
  mkdirSync(join(root, "skills", "tdd"), { recursive: true });
  writeFileSync(join(root, "skills", "tdd", "SKILL.md"), skill);
  const coverage = collectionCoverageV1(
    root,
    definition,
    admittedSourceFromCandidateBundleV1(
      sealedSingleSourceBundle("mattpocock", pin, ["tdd"]),
      "source:mattpocock",
    ),
  );
  const request = createCoreBaselineVetRequests(root, coverage.catalog)[0];
  if (request === undefined) throw new Error("missing scanner request fixture");
  const component = request.components[0];
  if (component === undefined) throw new Error("missing scanner component fixture");
  const publicationBytes = Buffer.from('{"publication":"fixture"}');
  const locator = `https://github.com/${SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.repository}/releases/download/baseline-v1-${SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.commit}-${"a".repeat(64)}/publication.json`;
  const discoveryBytes = Buffer.from(JSON.stringify({ locator }));
  const provenance = {
    authority: "publisher",
    repository: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.repository,
    workflow: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.workflow,
    ref: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.ref,
    sourceCommit: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.commit,
    publicationSha256: "a".repeat(64),
    requestSha256: request.requestSha256,
    receiptSha256: "b".repeat(64),
    publicationLocator: locator,
    reportSignedAt: "2026-09-24T00:00:00.000Z",
    reportVerificationExpiresAt: "2026-09-25T00:00:00.000Z",
    attestedAt: "2026-09-24T01:00:00.000Z",
  };
  mocks.consume.mockResolvedValue({
    evidence: { id: "mattpocock", components: [{ id: component.id }] },
    provenance: [provenance],
  });
  let attestations = 0;
  const run: Runner = async (argv) => {
    if (argv[0] === "git") return { code: 0, stdout: `${pin}\n`, stderr: "" };
    expect(argv.slice(0, 3)).toEqual(["gh", "attestation", "verify"]);
    expect(readFileSync(argv[3] ?? "")).toEqual(publicationBytes);
    attestations += 1;
    return { code: 0, stdout: '{"verified":true}', stderr: "" };
  };
  const prepared = await prepareScannerCollectionPublicationsV1({
    sourceRoot: root,
    catalogId: "mattpocock",
    batches: [{ discoveryBytes, publicationBytes }],
    now: "2026-09-24T02:00:00.000Z",
    coverage,
    run,
  });
  expect(attestations).toBe(1);
  expect(mocks.consume).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceRoot: root,
      catalog: coverage.catalog,
      publications: [
        expect.objectContaining({
          discoveryBytes,
          publicationBytes,
          expectedRequestSha256: request.requestSha256,
          attestationResultBytes: Buffer.from('{"verified":true}'),
        }),
      ],
    }),
  );
  expect(prepared).toEqual({ kind: "prepared-scanner-collection-publications/v1" });
  expect(projectPreparedScannerCollectionEvidenceForDisplayV1(prepared)).toBeUndefined();
  expect(authorPreparedScannerCollectionPublicationV1(prepared)).toBeUndefined();
  expect(authorPackagedScannerCollectionEvidenceRecordV1(prepared)).toBeUndefined();
});
