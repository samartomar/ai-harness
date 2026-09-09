import type { BaselineVetRequestV1 } from "@aihq/scan";
import { type BaselineCatalog, BaselineCatalogSchema } from "../../../baseline-evidence/catalog.js";
import { hashComponentTree, hashSourceTree } from "../../../baseline-evidence/hash.js";
import { componentIdentityPaths } from "../../../baseline-evidence/license.js";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "../../../baseline-evidence/scanner-profile.js";
import type { ConsumedScannerBaselinePublicationsV1 } from "../../../baseline-evidence/scanner-publication.js";
import { BaselineSourceEvidenceSchema } from "../../../baseline-evidence/schema.js";
import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import { evidenceExpiryV1 } from "../../../evidence-freshness.js";
import { ScannerPublicationProjectionV1Schema } from "../../packaged-collection-evidence-v1.js";
import { type AuthoringCatalogBundleV1, EvidenceSummaryV1Schema } from "../contracts.js";
import { verifyScannerComponentContainmentV1 } from "./source-data-containment.js";

interface DeclaredClosure {
  componentId: string;
  /** Recomputed compiler primary, never a publisher-selected helper path. */
  primaryPath: string;
  paths: readonly string[];
  files: readonly { path: string; digest: string }[];
  subject: { assetId: string; sourceId: string; sourceRevisionId: string; contentDigest: string };
}
function fail(): never {
  throw new TypeError("Scanner contained report projection rejected");
}
const digest = (value: unknown) => `sha256:${canonicalStrictJsonSha256V1(value)}`;

/** Pure projection after independent raw-proof consumption. Never manufactures or edits reports. */
export function projectContainedScannerEvidenceV1(input: {
  bundle: AuthoringCatalogBundleV1;
  sourceRoot: string;
  declared: readonly DeclaredClosure[];
  /** Recomputed by the registered compiler preparer, never the uploaded published catalog. */
  declaredCatalog: BaselineCatalog;
  catalog: BaselineCatalog;
  requests: readonly BaselineVetRequestV1[];
  consumed: ConsumedScannerBaselinePublicationsV1;
  preparedAt: string;
}): AuthoringCatalogBundleV1["evidence"] {
  const { bundle, sourceRoot, declared, requests, consumed, preparedAt } = input;
  const catalog = BaselineCatalogSchema.parse(input.catalog);
  const declaredCatalog = BaselineCatalogSchema.parse(input.declaredCatalog);
  if (
    declaredCatalog.owner !== catalog.owner ||
    declaredCatalog.repo !== catalog.repo ||
    declaredCatalog.pinnedSha !== catalog.pinnedSha ||
    declaredCatalog.components.length !== declared.length
  )
    fail();
  const report = BaselineSourceEvidenceSchema.parse(consumed.evidence);
  if (
    !Number.isFinite(Date.parse(preparedAt)) ||
    report.id !== catalog.id ||
    report.owner !== catalog.owner ||
    report.repo !== catalog.repo ||
    report.pinnedSha !== catalog.pinnedSha ||
    report.sourceTreeSha256 !== hashSourceTree(sourceRoot).treeSha256 ||
    requests.length !== consumed.provenance.length
  )
    fail();
  const requested = requests.flatMap((request) => request.components);
  const reports = new Map(report.components.map((item) => [item.id, item]));
  if (
    reports.size !== report.components.length ||
    reports.size !== requested.length ||
    requested.length !== catalog.components.length ||
    new Set(requested.map((item) => item.id)).size !== requested.length
  )
    fail();
  const publicationByComponent = new Map<string, (typeof consumed.provenance)[number]>();
  for (const [index, request] of requests.entries()) {
    const publication = consumed.provenance[index];
    if (
      !publication ||
      publication.requestSha256 !== request.requestSha256 ||
      request.source.id !== catalog.id ||
      request.source.owner !== catalog.owner ||
      request.source.repository !== catalog.repo ||
      request.source.pinnedCommit !== catalog.pinnedSha ||
      request.source.treeSha256 !== report.sourceTreeSha256
    )
      fail();
    ScannerPublicationProjectionV1Schema.parse({
      authority: publication.authority,
      repository: publication.repository,
      workflow: publication.workflow,
      ref: publication.ref,
      sourceCommit: publication.sourceCommit,
      publicationSha256: publication.publicationSha256,
      requestSha256: publication.requestSha256,
      receiptSha256: publication.receiptSha256,
      publicationLocator: publication.publicationLocator,
      publishedAt: publication.attestedAt,
    });
    if (
      !Number.isFinite(Date.parse(publication.reportSignedAt)) ||
      !Number.isFinite(Date.parse(publication.reportVerificationExpiresAt)) ||
      Date.parse(publication.reportSignedAt) >=
        Date.parse(publication.reportVerificationExpiresAt) ||
      Date.parse(publication.reportSignedAt) > Date.parse(publication.attestedAt) ||
      Date.parse(publication.attestedAt) > Date.parse(preparedAt)
    )
      fail();
    for (const component of request.components) {
      const fact = reports.get(component.id);
      const expected = catalog.components.find((item) => item.id === component.id);
      if (
        !fact ||
        !expected ||
        digest([...fact.paths].sort()) !== digest([...component.paths].sort()) ||
        digest([...expected.paths].sort()) !== digest([...component.paths].sort()) ||
        fact.treeSha256 !==
          hashComponentTree(sourceRoot, componentIdentityPaths(sourceRoot, component.paths))
            .treeSha256
      )
        fail();
      publicationByComponent.set(component.id, publication);
    }
  }
  const mappings = verifyScannerComponentContainmentV1(sourceRoot, declared, requested);
  const sourceReportDigest = digest({
    catalog,
    report,
    requests,
    publications: consumed.provenance.map(({ ageSeconds: _ageSeconds, ...original }) => original),
  });
  const evidence: AuthoringCatalogBundleV1["evidence"] = {};
  for (const mapping of mappings) {
    const closure = declared.find((item) => item.componentId === mapping.componentId);
    if (!closure) fail();
    const declaredComponent = declaredCatalog.components.find(
      (item) => item.id === closure.componentId,
    );
    if (
      !declaredComponent ||
      digest([...declaredComponent.paths].sort()) !== digest([...closure.paths].sort())
    )
      fail();
    const asset = bundle.assets[closure.subject.assetId];
    if (
      !asset ||
      asset.sourceId !== closure.subject.sourceId ||
      asset.sourceRevisionId !== closure.subject.sourceRevisionId ||
      asset.contentDigest !== closure.subject.contentDigest
    )
      fail();
    const facts = mapping.publishedComponentIds.map((id) => reports.get(id) ?? fail());
    // Apply the floor to each exact, already digest-verified intersection. Cisco
    // discovers SKILL.md material; a skill elsewhere in a composite closure must
    // not propagate its floor to unrelated general hook/rule/benchmark files.
    // A path-neutral explicit skill still cannot be downgraded by its publisher.
    const pathNeutralSkill =
      declaredComponent.skillContent === true &&
      !closure.files.some((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
    const primary = pathNeutralSkill
      ? hashComponentTree(sourceRoot, [closure.primaryPath]).files
      : [];
    if (
      pathNeutralSkill &&
      (primary.length === 0 ||
        primary.some(
          (file) =>
            !closure.files.some(
              (covered) => covered.path === file.path && covered.digest === `sha256:${file.sha256}`,
            ),
        ))
    )
      fail();
    const primaryPaths = new Set(primary.map((file) => file.path));
    for (const fact of facts) {
      const intersection = closure.files
        .filter((file) =>
          fact.paths.some((path) => file.path === path || file.path.startsWith(`${path}/`)),
        )
        .map((file) => file.path);
      if (intersection.length === 0) fail();
      // These are exact verified files, not coarse request paths. A directory
      // name such as `skills` is not evidence that a helper is skill material.
      const requiresCisco = intersection.some(
        (path) => path === "SKILL.md" || path.endsWith("/SKILL.md") || primaryPaths.has(path),
      );
      const required = Object.keys(SCANNER_BASELINE_ANALYZER_VERSIONS).filter(
        (name) => name !== "cisco@uvx" || requiresCisco,
      );
      if (
        required.some(
          (name) =>
            !fact.analyzers.some(
              (analyzer) =>
                analyzer.name === name &&
                analyzer.version ===
                  SCANNER_BASELINE_ANALYZER_VERSIONS[
                    name as keyof typeof SCANNER_BASELINE_ANALYZER_VERSIONS
                  ],
            ),
        )
      )
        throw new TypeError(
          `Scanner contained report lacks required analyzer coverage for ${closure.subject.assetId}`,
        );
    }
    const provenance = mapping.publishedComponentIds.map(
      (id) => publicationByComponent.get(id) ?? fail(),
    );
    const signedAt = new Date(
      Math.min(...provenance.map((item) => Date.parse(item.reportSignedAt))),
    ).toISOString();
    const expiry = evidenceExpiryV1(signedAt);
    if (Date.parse(expiry) <= Date.parse(preparedAt)) fail();
    const id = `evidence:${asset.id}`;
    if (evidence[id]) fail();
    evidence[id] = EvidenceSummaryV1Schema.parse({
      id,
      projectionVersion: "evidence-summary/v1",
      subjects: [closure.subject],
      evidenceDigest: digest({ sourceReportDigest, mapping, subject: closure.subject }),
      coveredPaths: [...closure.paths].sort(),
      verification: {
        state: "verified",
        verifiedAt: preparedAt,
        validUntil: expiry,
        contextDigest: sourceReportDigest,
      },
      scan: {
        outcome: facts.some((item) => item.verdict === "blocked") ? "failed" : "pass",
        coverage: "complete",
        analyzers: [
          ...new Map(
            facts
              .flatMap((item) => item.analyzers)
              .map((item) => [`${item.name}\u0000${item.version}`, item]),
          ).values(),
        ].sort((a, b) => (`${a.name}\u0000${a.version}` < `${b.name}\u0000${b.version}` ? -1 : 1)),
        reportSignedAt: signedAt,
        reportVerificationExpiresAt: new Date(
          Math.min(...provenance.map((item) => Date.parse(item.reportVerificationExpiresAt))),
        ).toISOString(),
        publishedAt: new Date(
          Math.max(...provenance.map((item) => Date.parse(item.attestedAt))),
        ).toISOString(),
        scope: "published-component-containment",
        publishedComponentIds: mapping.publishedComponentIds,
        reportFindingCount: facts.reduce(
          (sum, item) =>
            sum + item.findings.reduce((count, finding) => count + (finding.count ?? 1), 0),
          0,
        ),
      },
      qualification: { state: "unknown" },
      // Findings belong to the original broader component, not an invented narrower report.
      findings: facts
        .flatMap((item) =>
          item.findings.map((finding) =>
            `[${item.id}] ${finding.code}: ${finding.detail}`.slice(0, 1_000),
          ),
        )
        .slice(0, 50),
    });
  }
  return evidence;
}
