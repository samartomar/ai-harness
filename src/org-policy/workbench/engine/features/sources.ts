import {
  CATALOG_BROWSE_PAGE_SIZE,
  type CatalogBrowseResult,
  catalogBrowse,
  catalogKindLabel,
  catalogSourceDisplayName,
} from "../../catalog-browse.js";
import {
  assetDetailsPresentation,
  assetEvidencePresentation,
} from "../../ui/catalog-presentation.js";
import { buildKindLedgerViewModel } from "../../ui/kind-ledger.js";
import type { AdminCatalogItem } from "../admin-engine.js";
import type { AdminEngineContext } from "./context.js";

/**
 * The Sources screen's feature (Policy Workbench UI delivery, inventory rows 7,
 * 11 and 12): the catalog browse the hand-built page runs in
 * `ui/catalog-inventory.ts`, the kind ledger of `ui/kind-ledger.ts`, and the
 * item inspector's three tabs (`ui/shell/admin-shell.ts` `INSPECTOR_TABS`).
 *
 * Everything here reads the BROWSE projection of the prepared catalog
 * (`workbenchBrowseBundleV1`), which is what the hand-built catalog offers.
 * Selection, import and download keep using the complete bundle, so a saved
 * policy still round-trips.
 *
 * Pure, like everything under `engine/`: no DOM, no `window`, no Node built-ins.
 */

/** `CatalogBrowseFilters` of `catalog-browse.ts`, as the view supplies it. */
export interface CatalogFiltersV1 {
  readonly sourceId?: string;
  readonly kind?: string;
  readonly query?: string;
  readonly page?: number;
}

export interface CatalogOptionV1 {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

/** Everything the catalog browse renders, already in the page's own words. */
export interface CatalogBrowseViewV1 {
  /** The catalog sources, in the rail's and the picker's order. */
  readonly sourceOptions: readonly CatalogOptionV1[];
  /** The type tabs, without the leading "All" tab. */
  readonly typeOptions: readonly CatalogOptionV1[];
  /** The count the "All" type tab carries. */
  readonly allTypesCount: number;
  /** The open source's display name; empty when no source is chosen. */
  readonly sourceLabel: string;
  /** Only the items of the current page: a 442-item catalog renders 50. */
  readonly items: readonly AdminCatalogItem[];
  readonly total: number;
  readonly page: number;
  readonly pageCount: number;
  /** "Showing 1–50 of 442 items" (`catalog-inventory.ts` lines 1056-1062). */
  readonly rangeText: string;
  /** "Page 1 of 9"; empty while one page holds everything. */
  readonly pageText: string;
  /** Why nothing is listed; absent while the page lists items. */
  readonly emptyMessage?: string;
  /** Matches the active type filter hides (`otherTypeMatchCount`). */
  readonly otherTypeMatches: number;
}

export interface KindLedgerEntryV1 {
  readonly kind: string;
  readonly label: string;
  readonly total: number;
  readonly selected: number;
  /** The share of this kind already in the draft, 0-100 and never a cost figure. */
  readonly percent: number;
}

export interface ItemFactV1 {
  readonly label: string;
  readonly value: string;
}

/** The inspector's Security Scan tab: `assetEvidencePresentation`, as text. */
export interface ItemSecurityV1 {
  readonly statusLabel: string;
  readonly reportedResult?: string;
  readonly binding: string;
  readonly coverage: string;
  readonly qualification: string;
  readonly freshness: string;
  readonly findingsLabel: string;
  readonly findings: readonly string[];
  readonly scopePaths: readonly string[];
  readonly nextStep: string;
  readonly limitation: string;
}

/** One catalog item, as the inspector's three tabs show it. */
export interface ItemInspectionV1 {
  readonly assetId: string;
  readonly title: string;
  readonly summary: string;
  readonly facts: readonly ItemFactV1[];
  readonly security: ItemSecurityV1;
  /** The prepared item as JSON, exactly the inspector's "Policy JSON" tab. */
  readonly policyJson: string;
}

export interface SourcesFeature {
  /** The catalog browse for these filters; a fresh read each call. */
  browseCatalog(filters: CatalogFiltersV1): CatalogBrowseViewV1;
  /** The five kind tiles, with the catalog's real counts. */
  kindLedger(): readonly KindLedgerEntryV1[];
  /** One browsable item, or undefined when the catalog does not offer it. */
  inspectItem(assetId: string): ItemInspectionV1 | undefined;
}

const EMPTY_VIEW: CatalogBrowseViewV1 = {
  sourceOptions: [],
  typeOptions: [],
  allTypesCount: 0,
  sourceLabel: "",
  items: [],
  total: 0,
  page: 0,
  pageCount: 0,
  rangeText: "",
  pageText: "",
  emptyMessage: "Prepared catalog is invalid or unavailable. Regenerate this artifact with Core.",
  otherTypeMatches: 0,
};

/** `otherTypeMatchCount` of `ui/catalog-inventory.ts` (lines 2931-2938), verbatim. */
function otherTypeMatchCount(browse: CatalogBrowseResult, kind: string | undefined): number {
  if (kind === undefined) return 0;
  return browse.typeOptions.reduce((total, item) => total + (item.id === kind ? 0 : item.count), 0);
}

/** `emptyBrowseMessage` of `ui/catalog-inventory.ts` (lines 2939-2958), verbatim. */
function emptyBrowseMessage(
  browse: CatalogBrowseResult,
  filters: CatalogFiltersV1,
  sourceName: (sourceId: string) => string,
): string {
  const query = filters.query?.trim();
  const selectedKind = filters.kind;
  if (selectedKind !== undefined) {
    const otherMatches = otherTypeMatchCount(browse, selectedKind);
    const item = otherMatches === 1 ? "item is" : "items are";
    const type = catalogKindLabel(selectedKind).toLowerCase();
    const scope = filters.sourceId === undefined ? "the catalog" : "the selected source";
    const subject = query ? `match "${query}"` : "are available";
    return (
      `No ${type} ${subject} in ${scope}.` +
      (otherMatches === 0 ? "" : ` ${otherMatches} ${item} available in other types.`)
    );
  }
  if (query) return `No catalog items match "${query}" in the selected source.`;
  const sourceId = filters.sourceId;
  return sourceId === undefined
    ? "No prepared catalog source is available."
    : `No catalog items are present in ${sourceName(sourceId)}.`;
}

export function sourcesFeature(ctx: AdminEngineContext): SourcesFeature {
  const sourceName = (sourceId: string): string =>
    ctx.bundle === undefined ? sourceId : catalogSourceDisplayName(ctx.bundle, sourceId);

  return {
    browseCatalog(filters) {
      try {
        const browseBundle = ctx.browseBundle;
        if (browseBundle === undefined || !ctx.catalogValid) return EMPTY_VIEW;
        const normalized: CatalogFiltersV1 = {
          ...filters,
          ...(typeof filters.query === "string" && filters.query.trim() === ""
            ? { query: undefined }
            : {}),
        };
        const browse = catalogBrowse(browseBundle, { ...normalized });
        const options = (entries: readonly CatalogOptionV1[]): readonly CatalogOptionV1[] =>
          entries.map((entry) => ({ id: entry.id, label: entry.label, count: entry.count }));
        const total = browse.total;
        const first = total === 0 ? 0 : browse.page * CATALOG_BROWSE_PAGE_SIZE + 1;
        const last = Math.min((browse.page + 1) * CATALOG_BROWSE_PAGE_SIZE, total);
        return {
          sourceOptions: options(browse.sourceOptions),
          typeOptions: options(browse.typeOptions),
          allTypesCount: browse.typeOptions.reduce((sum, item) => sum + item.count, 0),
          sourceLabel: filters.sourceId === undefined ? "" : sourceName(filters.sourceId),
          items: ctx.catalogItems(browse.pageAssetIds),
          total,
          page: browse.page,
          pageCount: browse.pageCount,
          rangeText: total === 0 ? "" : `Showing ${first}–${last} of ${total} items`,
          pageText:
            total > CATALOG_BROWSE_PAGE_SIZE
              ? `Page ${browse.page + 1} of ${browse.pageCount}`
              : "",
          ...(total === 0
            ? { emptyMessage: emptyBrowseMessage(browse, normalized, sourceName) }
            : {}),
          otherTypeMatches: otherTypeMatchCount(browse, normalized.kind),
        };
      } catch {
        return EMPTY_VIEW;
      }
    },

    kindLedger() {
      const browseBundle = ctx.browseBundle;
      if (browseBundle === undefined) return [];
      const assets = Object.values(browseBundle.assets).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
      }));
      return buildKindLedgerViewModel(assets, ctx.selectedAssetIds()).entries.map((entry) => ({
        kind: entry.kind,
        label: entry.label,
        total: entry.total,
        selected: entry.selected,
        percent: entry.total === 0 ? 0 : Math.round((entry.selected / entry.total) * 100),
      }));
    },

    inspectItem(assetId) {
      try {
        const browseBundle = ctx.browseBundle;
        const bundle = ctx.bundle;
        if (browseBundle === undefined || bundle === undefined) return undefined;
        // Only a browsable item is inspectable; the presentation still reads
        // the complete bundle, so relations and evidence are not truncated.
        const asset = browseBundle.assets[assetId];
        if (asset === undefined) return undefined;
        const details = assetDetailsPresentation(asset, bundle);
        const report = assetEvidencePresentation(asset, bundle);
        return {
          assetId,
          title: details.title,
          summary: details.summary,
          facts: details.facts.map((fact) => ({ label: fact.label, value: fact.value })),
          security: {
            statusLabel: report.statusLabel,
            ...(report.reportedResult === undefined
              ? {}
              : { reportedResult: report.reportedResult }),
            binding: report.binding,
            coverage: report.coverage,
            qualification: report.qualification,
            freshness: report.freshness,
            findingsLabel: report.findingsLabel,
            findings: [...report.findings],
            scopePaths: [...report.scopePaths],
            nextStep: report.nextStep,
            limitation: report.limitation,
          },
          policyJson: details.advancedJson,
        };
      } catch {
        return undefined;
      }
    },
  };
}
