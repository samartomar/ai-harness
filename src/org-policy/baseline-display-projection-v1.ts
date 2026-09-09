import type { BaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { canonicalStrictJsonSha256V1 } from "../contract/strict-json-v1.js";
import { adminBaselineEvidenceTimestampEpochV1 } from "./admin-baseline-evidence-cache-v1.js";
import { type AuthoringCatalogBundleV1, EvidenceSummaryV1Schema } from "./workbench/contracts.js";

export interface BaselineDisplayFactsV1 {
  readonly lock: BaselineEvidenceLock;
  readonly contextDigest: string;
  readonly evidenceDigest: string;
  readonly verifiedAt: string;
  readonly validUntil: string;
}
function epoch(value: string, label: string): number {
  const result = adminBaselineEvidenceTimestampEpochV1(value, false);
  if (result === undefined) throw new TypeError(label);
  return result;
}
/** Pure display projection only. Its caller must own the verification custody. */
export function projectBaselineDisplayEvidenceV1(
  facts: BaselineDisplayFactsV1,
  bundle: AuthoringCatalogBundleV1,
  now: string,
): AuthoringCatalogBundleV1["evidence"] {
  const current = epoch(now, "Workbench evidence clock");
  const fresh =
    current >= epoch(facts.verifiedAt, "verification clock") &&
    current < epoch(facts.validUntil, "evidence validity");
  const result: AuthoringCatalogBundleV1["evidence"] = {};
  for (const source of facts.lock.sources) {
    const sourceId = `source:${source.id}`;
    const descriptor = bundle.sources[sourceId];
    if (
      !descriptor ||
      descriptor.inputFormat !== "pinned-baseline/v1" ||
      descriptor.upstreamOrigin.kind !== "git" ||
      descriptor.upstreamOrigin.locator !== `${source.owner}/${source.repo}` ||
      descriptor.revision.id !== source.pinnedSha ||
      descriptor.revision.contentDigest !== `sha256:${source.sourceTreeSha256}`
    )
      continue;
    for (const component of source.components) {
      const assetId = `${source.id}/${component.id}`;
      const asset = bundle.assets[assetId];
      if (
        !asset ||
        asset.sourceId !== sourceId ||
        asset.sourceRevisionId !== source.pinnedSha ||
        asset.contentDigest !== `sha256:${component.treeSha256}` ||
        asset.derivation !== "upstream"
      )
        continue;
      const id = `evidence:${assetId}`;
      result[id] = EvidenceSummaryV1Schema.parse({
        id,
        projectionVersion: "evidence-summary/v1",
        subjects: [
          {
            assetId,
            sourceId,
            sourceRevisionId: source.pinnedSha,
            contentDigest: asset.contentDigest,
          },
        ],
        evidenceDigest: `sha256:${canonicalStrictJsonSha256V1({
          artifact: facts.evidenceDigest,
          source: { id: source.id, pinnedSha: source.pinnedSha },
          component,
        })}`,
        coveredPaths: [...component.paths].sort(),
        verification: fresh
          ? {
              state: "verified",
              verifiedAt: facts.verifiedAt,
              validUntil: facts.validUntil,
              contextDigest: facts.contextDigest,
            }
          : { state: "stale" },
        scan: {
          outcome: component.verdict === "blocked" ? "failed" : fresh ? "pass" : "unknown",
          coverage: "complete",
          analyzers: component.analyzers.map(({ name, version }) => ({ name, version })),
        },
        qualification: { state: "unknown" },
        findings: component.findings
          .slice(0, 50)
          .map((finding) => `${finding.code}: ${finding.detail}`.slice(0, 1000)),
      });
    }
  }
  return result;
}
