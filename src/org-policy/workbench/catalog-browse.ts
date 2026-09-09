import type { AuthoringAssetV1, AuthoringCatalogBundleV1 } from "./contracts.js";

export const CATALOG_BROWSE_PAGE_SIZE = 50;

export interface CatalogBrowseFilters {
  sourceId?: string;
  kind?: string;
  query?: string;
  page?: number;
}

export interface CatalogBrowseOption {
  id: string;
  label: string;
  count: number;
}

export interface CatalogBrowseResult {
  active: boolean;
  sourceOptions: readonly CatalogBrowseOption[];
  typeOptions: readonly CatalogBrowseOption[];
  total: number;
  page: number;
  pageCount: number;
  pageAssetIds: readonly string[];
}

const primaryKinds = ["skill", "agent", "profile"] as const;

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function selectedValue(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function normalizedQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : searchableText(trimmed);
}

function searchableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[:/._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function catalogSourceDisplayName(
  bundle: AuthoringCatalogBundleV1,
  sourceId: string,
): string {
  const labelFor = (id: string): string => {
    const locator = bundle.sources[id]?.upstreamOrigin.locator;
    return locator === undefined || locator === id
      ? id
      : locator.replace(/^https:\/\/github\.com\//u, "").replace(/\.git$/u, "");
  };
  const label = labelFor(sourceId);
  return Object.keys(bundle.sources).some((id) => id !== sourceId && labelFor(id) === label)
    ? `${label} (${sourceId})`
    : label;
}

export function catalogKindLabel(kind: string): string {
  if (kind === "skill") return "Skills";
  if (kind === "agent") return "Agents";
  if (kind === "profile") return "Profiles";
  if (kind === "mcp") return "MCP servers";
  if (kind === "hook") return "Hooks";
  if (kind === "lang") return "Languages";
  if (kind === "module") return "Packages";
  return kind.slice(0, 1).toUpperCase() + kind.slice(1);
}

function inventoryText(bundle: AuthoringCatalogBundleV1, asset: AuthoringAssetV1): string {
  return searchableText(
    [
      asset.id,
      asset.label,
      asset.kind,
      asset.sourceId,
      catalogSourceDisplayName(bundle, asset.sourceId),
    ].join(" "),
  );
}

export function catalogBrowse(
  bundle: AuthoringCatalogBundleV1,
  filters: CatalogBrowseFilters,
): CatalogBrowseResult {
  const sourceId = selectedValue(filters.sourceId);
  const kind = selectedValue(filters.kind);
  const query = normalizedQuery(filters.query);
  const sourceCounts = new Map(Object.keys(bundle.sources).map((id) => [id, 0]));
  const typeCounts = new Map<string, number>(primaryKinds.map((id) => [id, 0]));
  const matchingAssetIds: string[] = [];
  for (const [assetId, asset] of Object.entries(bundle.assets)) {
    typeCounts.set(asset.kind, typeCounts.get(asset.kind) ?? 0);
    if (query !== undefined && !inventoryText(bundle, asset).includes(query)) continue;
    if (kind === undefined || asset.kind === kind)
      sourceCounts.set(asset.sourceId, (sourceCounts.get(asset.sourceId) ?? 0) + 1);
    if (sourceId === undefined || asset.sourceId === sourceId)
      typeCounts.set(asset.kind, (typeCounts.get(asset.kind) ?? 0) + 1);
    if (
      (sourceId === undefined || asset.sourceId === sourceId) &&
      (kind === undefined || asset.kind === kind)
    )
      matchingAssetIds.push(assetId);
  }
  const sourceOptions = [...sourceCounts]
    .map(([id, count]) => ({
      id,
      label: catalogSourceDisplayName(bundle, id),
      count,
    }))
    .sort((left, right) => compareText(left.label, right.label) || compareText(left.id, right.id));
  const typeOptions = [...typeCounts]
    .map(([id, count]) => ({ id, label: catalogKindLabel(id), count }))
    .sort((left, right) => {
      const leftIndex = primaryKinds.indexOf(left.id as (typeof primaryKinds)[number]);
      const rightIndex = primaryKinds.indexOf(right.id as (typeof primaryKinds)[number]);
      return (
        (leftIndex < 0 ? primaryKinds.length : leftIndex) -
          (rightIndex < 0 ? primaryKinds.length : rightIndex) ||
        compareText(left.label, right.label)
      );
    });
  const active = sourceId !== undefined || kind !== undefined || query !== undefined;
  if (!active)
    return {
      active,
      sourceOptions,
      typeOptions,
      total: 0,
      page: 0,
      pageCount: 0,
      pageAssetIds: [],
    };
  matchingAssetIds.sort(
    (left, right) =>
      compareText(bundle.assets[left]?.label ?? left, bundle.assets[right]?.label ?? right) ||
      compareText(left, right),
  );
  const total = matchingAssetIds.length;
  const pageCount = total === 0 ? 0 : Math.ceil(total / CATALOG_BROWSE_PAGE_SIZE);
  const requestedPage =
    typeof filters.page === "number" && Number.isFinite(filters.page)
      ? Math.trunc(filters.page)
      : 0;
  const page = pageCount === 0 ? 0 : Math.min(Math.max(requestedPage, 0), pageCount - 1);
  return {
    active,
    sourceOptions,
    typeOptions,
    total,
    page,
    pageCount,
    pageAssetIds: matchingAssetIds.slice(
      page * CATALOG_BROWSE_PAGE_SIZE,
      (page + 1) * CATALOG_BROWSE_PAGE_SIZE,
    ),
  };
}
