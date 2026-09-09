import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../../src/baseline-evidence/catalog.js";
import { hashComponentTree, hashSourceTree } from "../../../src/baseline-evidence/hash.js";
import { createCoreBaselineVetRequests } from "../../../src/baseline-evidence/scanner-consumer.js";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "../../../src/baseline-evidence/scanner-profile.js";
import type { ConsumedScannerBaselinePublicationsV1 } from "../../../src/baseline-evidence/scanner-publication.js";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 } from "../../../src/baseline-evidence/scanner-publication-policy.js";
import { projectContainedScannerEvidenceV1 } from "../../../src/org-policy/workbench/core/source-data-contained-projection.js";
import { evidenceDisplayFor } from "../../../src/org-policy/workbench/ui/evidence-display.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(blocked = false) {
  const sourceRoot = mkdtempSync(join(tmpdir(), "aih-contained-projection-"));
  roots.push(sourceRoot);
  mkdirSync(join(sourceRoot, "shared"));
  writeFileSync(join(sourceRoot, "shared/one.md"), "one");
  writeFileSync(join(sourceRoot, "shared/two.md"), "two");
  const catalog = defineBaselineCatalog({
    id: "fixture",
    owner: "fixture",
    repo: "source",
    pinnedSha: "a".repeat(40),
    components: [{ id: "runtime:shared", paths: ["shared"] }],
  });
  const requests = createCoreBaselineVetRequests(sourceRoot, catalog);
  const material = hashComponentTree(sourceRoot, ["shared"]);
  const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1;
  const consumed: ConsumedScannerBaselinePublicationsV1 = {
    evidence: {
      id: catalog.id,
      owner: catalog.owner,
      repo: catalog.repo,
      pinnedSha: catalog.pinnedSha,
      sourceTreeSha256: hashSourceTree(sourceRoot).treeSha256,
      components: [
        {
          id: "runtime:shared",
          paths: ["shared"],
          treeSha256: material.treeSha256,
          verdict: blocked ? "blocked" : "pass",
          analyzers: Object.entries(SCANNER_BASELINE_ANALYZER_VERSIONS)
            .filter(([name]) => name !== "cisco@uvx")
            .map(([name, version]) => ({ name, version })),
          findings: blocked
            ? Array.from({ length: 70 }, (_, index) => ({
                code: `finding-${index}`,
                detail: "Original broader component finding",
              }))
            : [],
        },
      ],
    },
    provenance: requests.map((request) => ({
      authority: "none",
      repository: publisher.repository,
      workflow: publisher.workflow,
      ref: publisher.ref,
      sourceCommit: publisher.commit,
      publicationSha256: "b".repeat(64),
      requestSha256: request.requestSha256,
      receiptSha256: "c".repeat(64),
      publicationLocator: `https://github.com/${publisher.repository}/releases/download/baseline-v1-${publisher.commit}-${request.requestSha256}/publication.json`,
      attestedAt: "2026-09-09T00:01:00.000Z",
      ageSeconds: 60,
      reportSignedAt: "2026-09-09T00:00:00.000Z",
      reportVerificationExpiresAt: "2026-09-09T00:45:00.000Z",
    })),
  };
  const bundle = tinyStudioModel().workbenchBundle;
  const assets = [bundle.assets["fixture:control"]!, bundle.assets["fixture:external"]!];
  assets[0]!.originalPath = "shared/one.md";
  assets[1]!.originalPath = "shared/two.md";
  const declared = material.files.map((file, index) => ({
    componentId: `asset:${index}`,
    primaryPath: file.path,
    paths: [file.path],
    files: [{ path: file.path, digest: `sha256:${file.sha256}` }],
    subject: {
      assetId: assets[index]!.id,
      sourceId: assets[index]!.sourceId,
      sourceRevisionId: assets[index]!.sourceRevisionId,
      contentDigest: assets[index]!.contentDigest,
    },
  }));
  return {
    bundle,
    sourceRoot,
    declared,
    declaredCatalog: defineBaselineCatalog({
      ...catalog,
      components: declared.map((item) => ({ id: item.componentId, paths: item.paths })),
    }),
    catalog,
    requests,
    consumed,
    preparedAt: "2026-09-09T00:02:00.000Z",
  };
}
describe("source-level report projection after independent consumption", () => {
  it.each([
    [false, "shared"],
    [true, "shared"],
    [false, "skills"],
    [true, "skills"],
  ] as const)(
    "requires Cisco on the actual skill primary without propagating it to helpers (path-neutral: %s, directory: %s)",
    (neutral, directory) => {
      const input = fixture();
      if (directory !== "shared")
        renameSync(join(input.sourceRoot, "shared"), join(input.sourceRoot, directory));
      const primary = `${directory}/${neutral ? "one.md" : "SKILL.md"}`;
      if (!neutral)
        renameSync(join(input.sourceRoot, directory, "one.md"), join(input.sourceRoot, primary));
      input.bundle.assets["fixture:control"]!.originalPath = primary;
      input.catalog = defineBaselineCatalog({
        ...input.catalog,
        components: [
          { id: "skill:actual", paths: [primary], skillContent: true },
          { id: "runtime:helper", paths: [`${directory}/two.md`] },
        ],
      });
      input.requests = createCoreBaselineVetRequests(input.sourceRoot, input.catalog);
      input.consumed.evidence.sourceTreeSha256 = hashSourceTree(input.sourceRoot).treeSha256;
      input.consumed.evidence.components = input.catalog.components.map((component, index) => ({
        id: component.id,
        paths: component.paths,
        treeSha256: hashComponentTree(input.sourceRoot, component.paths).treeSha256,
        verdict: index === 0 ? "pass" : "blocked",
        analyzers: Object.entries(SCANNER_BASELINE_ANALYZER_VERSIONS)
          .filter(([name]) => index === 0 || name !== "cisco@uvx")
          .map(([name, version]) => ({ name, version })),
        findings:
          index === 0
            ? []
            : [{ code: "helper-finding", detail: "Original helper finding remains" }],
      }));
      const publication = input.consumed.provenance[0];
      const request = input.requests[0];
      const closure = input.declared[0];
      if (!publication || !request || !closure) throw Error("fixture");
      input.consumed = {
        ...input.consumed,
        provenance: [
          {
            ...publication,
            requestSha256: request.requestSha256,
            publicationLocator: `https://github.com/${publication.repository}/releases/download/baseline-v1-${publication.sourceCommit}-${request.requestSha256}/publication.json`,
          },
        ],
      };
      const material = hashComponentTree(input.sourceRoot, [directory]);
      input.declared = [
        {
          ...closure,
          primaryPath: primary,
          paths: [directory],
          files: material.files.map((file) => ({
            path: file.path,
            digest: `sha256:${file.sha256}`,
          })),
        },
      ];
      input.declaredCatalog = defineBaselineCatalog({
        ...input.catalog,
        components: [{ id: closure.componentId, paths: [directory], skillContent: true }],
      });
      const original = JSON.stringify(input.consumed);
      const result = Object.values(projectContainedScannerEvidenceV1(input));
      expect(result[0]?.scan).toMatchObject({ coverage: "complete", outcome: "failed" });
      expect(result[0]?.findings.join(" ")).toContain("Original helper finding remains");
      expect(result[0]?.scan.reportSignedAt).toBe(publication.reportSignedAt);
      expect(result[0]?.scan.publishedAt).toBe(publication.attestedAt);
      expect(JSON.stringify(input.consumed)).toBe(original);
      input.consumed.evidence.components[0]!.analyzers =
        input.consumed.evidence.components[0]!.analyzers.filter(
          (item) => item.name !== "cisco@uvx",
        );
      input.consumed.evidence.components[1]!.analyzers.push({
        name: "cisco@uvx",
        version: SCANNER_BASELINE_ANALYZER_VERSIONS["cisco@uvx"],
      });
      expect(() => projectContainedScannerEvidenceV1(input)).toThrow();
    },
  );
  it("rejects a path-neutral declared skill covered by a weaker general report", () => {
    const input = fixture();
    const component = input.declaredCatalog.components[0];
    if (!component) throw new Error("fixture");
    component.skillContent = true;
    expect(() => projectContainedScannerEvidenceV1(input)).toThrow();
    input.consumed.evidence.components[0]!.analyzers.push({
      name: "cisco@uvx",
      version: SCANNER_BASELINE_ANALYZER_VERSIONS["cisco@uvx"],
    });
    expect(() => projectContainedScannerEvidenceV1(input)).not.toThrow();
  });
  it("keeps reverified summaries stable as wall-clock publication age changes", () => {
    const input = fixture();
    const before = projectContainedScannerEvidenceV1(input);
    input.consumed = {
      ...input.consumed,
      provenance: input.consumed.provenance.map((item) => ({
        ...item,
        ageSeconds: item.ageSeconds + 600,
      })),
    };
    expect(projectContainedScannerEvidenceV1(input)).toEqual(before);
  });
  it("retains original broad report facts and labels exact contained file coverage", () => {
    const input = fixture(true);
    const original = JSON.stringify(input.consumed);
    const result = projectContainedScannerEvidenceV1(input);
    expect(Object.keys(result)).toHaveLength(2);
    for (const summary of Object.values(result)) {
      expect(summary.scan).toMatchObject({
        outcome: "failed",
        coverage: "complete",
        scope: "published-component-containment",
        publishedComponentIds: ["runtime:shared"],
        reportFindingCount: 70,
      });
      expect(summary.findings).toHaveLength(50);
      expect(summary.findings[0]).toContain("[runtime:shared]");
      expect(
        evidenceDisplayFor(
          input.bundle.assets[summary.subjects[0]!.assetId]!,
          [summary],
          Date.parse(input.preparedAt),
        ).text,
      ).toContain("shared source-file coverage");
    }
    expect(JSON.stringify(input.consumed)).toBe(original);
  });
  it.each([
    "source",
    "report-path",
    "report-tree",
    "missing-report",
    "publication-request",
    "publication-date",
    "asset-digest",
    "incomplete-closure",
  ])("rejects %s without projecting a pass", (caseName) => {
    const input = fixture();
    if (caseName === "source") input.consumed.evidence.pinnedSha = "f".repeat(40);
    if (caseName === "report-path")
      input.consumed.evidence.components[0]!.paths = ["shared/one.md"];
    if (caseName === "report-tree")
      input.consumed.evidence.components[0]!.treeSha256 = "f".repeat(64);
    if (caseName === "missing-report") input.consumed.evidence.components = [];
    if (caseName === "publication-request")
      input.consumed = {
        ...input.consumed,
        provenance: [{ ...input.consumed.provenance[0]!, requestSha256: "f".repeat(64) }],
      };
    if (caseName === "publication-date") input.preparedAt = "2026-09-09T00:00:00.000Z";
    if (caseName === "asset-digest")
      input.declared[0]!.subject.contentDigest = `sha256:${"f".repeat(64)}`;
    if (caseName === "incomplete-closure") input.declared[0]!.paths = ["shared"];
    expect(() => projectContainedScannerEvidenceV1(input)).toThrow();
  });
});
