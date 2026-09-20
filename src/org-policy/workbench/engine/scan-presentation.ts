import type { CatalogBrowseInventory } from "../catalog-browse.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
import { sourceEvidenceSummary } from "../ui/catalog-presentation.js";
import { stableDecisionJson } from "../ui/decision-json.js";
import { projectDeveloperToolCatalogInventory } from "../ui/developer-tool-catalog.js";

/**
 * The scan screen's pure presentation (Policy Workbench UI delivery, editors
 * 5, 6 and 10): the report totals, the preserved receipt's rows, and the
 * imported decision's lines. These were computed inside
 * `ui/shell/scan-screen.ts` and `ui/main.ts`; the DOM screen now builds its
 * nodes from the same functions, so both pages read one source.
 *
 * Pure: no DOM, no `window`, no Node built-ins.
 */

/** Report totals across the prepared catalog (`sourceEvidenceSummary` per source). */
export interface ScanGlance {
  /** Catalog items. */
  readonly total: number;
  /** A current verified passing report with complete coverage and no findings. */
  readonly passed: number;
  /** A report is attached, but it is stale, unverified, partial or lists findings. */
  readonly review: number;
  /** No report is attached. */
  readonly notScanned: number;
  readonly reportsIncluded: number;
  readonly currentlyVerified: number;
}

/** One preserved receipt subject: the row's id and its source note. */
export interface ScanReceiptRowV1 {
  readonly id: string;
  readonly note: string;
}

type Loose = Record<string, unknown>;

function object(value: unknown): Loose | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : undefined;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

/**
 * The catalog the admin browses: the complete bundle minus what the catalog
 * UI no longer offers. Ponytail is no longer offered, and GitHub is not part
 * of the Core baseline. This browse projection carries no authority; saved
 * policies still round-trip through the complete bundle. The hand-built
 * catalog (`ui/catalog-inventory.ts` `workbenchBrowseBundle`) is this function.
 */
export function workbenchBrowseBundleV1(
  bundle: AuthoringCatalogBundleV1,
): AuthoringCatalogBundleV1 {
  const inventory: CatalogBrowseInventory = projectDeveloperToolCatalogInventory({
    sources: Object.fromEntries(
      Object.entries(bundle.sources).filter(([id]) => id !== "source:ponytail"),
    ),
    assets: Object.fromEntries(
      Object.entries(bundle.assets).filter(
        ([, asset]) =>
          asset.sourceId !== "source:ponytail" &&
          !(asset.sourceId === "source:aih-core" && asset.id === "aih/github"),
      ),
    ),
  });
  return { ...bundle, sources: inventory.sources, assets: inventory.assets };
}

/**
 * "The scan at a glance", which `ui/main.ts` also calls: the
 * catalog's report totals, summed over its sources. Passed has a current,
 * clean report; Not scanned has none; Review is every other item that needs
 * review.
 */
export function scanGlanceV1(bundle: AuthoringCatalogBundleV1): ScanGlance {
  const catalog = workbenchBrowseBundleV1(bundle);
  const empty = { roots: [], exclusions: [], requests: [], drafts: [] };
  const totals = {
    total: 0,
    passed: 0,
    review: 0,
    notScanned: 0,
    reportsIncluded: 0,
    currentlyVerified: 0,
  };
  for (const sourceId of Object.keys(catalog.sources)) {
    const summary = sourceEvidenceSummary(catalog, sourceId, empty);
    const unscanned = summary.totalAssets - summary.includedReports;
    totals.total += summary.totalAssets;
    totals.passed += summary.totalAssets - summary.needsReview;
    totals.notScanned += unscanned;
    totals.review += Math.max(0, summary.needsReview - unscanned);
    totals.reportsIncluded += summary.includedReports;
    totals.currentlyVerified += summary.currentReports;
  }
  return totals;
}

/** The preserved receipt's rows: its approvals, then its evidence entries. */
export function scanReceiptRowsV1(receipt: unknown): ScanReceiptRowV1[] {
  const record = object(receipt);
  const rows: ScanReceiptRowV1[] = [];
  if (record === undefined) return rows;
  if (Array.isArray(record.approvals))
    for (const approval of record.approvals) {
      const entry = object(approval) ?? {};
      rows.push({
        id: text(entry.id, "approval"),
        note: `${text(entry.issuer, "unknown issuer")} — preserved/preflight-only`,
      });
    }
  if (Array.isArray(record.evidence))
    for (const evidence of record.evidence) {
      const entry = object(evidence) ?? {};
      rows.push({
        id: text(entry.id, "evidence"),
        note: `${text(entry.state, "unknown")} evidence — preserved/preflight-only`,
      });
    }
  return rows;
}

/** The imported decision, field by field, as the scan screen lists it. */
export function scanDecisionLinesV1(decision: Record<string, unknown>): string {
  return [
    `id: ${decision.id}`,
    `candidate: ${decision.candidate}`,
    `kind: ${decision.kind}`,
    `disposition: ${decision.disposition}`,
    `targets: ${list(decision.targets)}`,
    `effects: ${list(decision.effects)}`,
    `issuer: ${decision.issuer}`,
    `actor: ${decision.actor}`,
    `policyVersion: ${decision.policyVersion}`,
    `issuedAt: ${decision.issuedAt}`,
    `notBefore: ${decision.notBefore}`,
    `expiresAt: ${decision.expiresAt}`,
    `reviewBy: ${decision.reviewBy || "none"}`,
    `acceptedFindings: ${list(decision.acceptedFindings)}`,
    `acceptedGaps: ${list(decision.acceptedGaps)}`,
    `conditions: ${Array.isArray(decision.conditions) ? decision.conditions.join(" | ") : String(decision.conditions)}`,
    `reason: ${decision.reason}`,
  ].join("\n");
}

/** The canonical decision JSON the scan screen shows and the download writes. */
export function scanDecisionExportV1(decision: unknown): string {
  return stableDecisionJson(decision);
}
