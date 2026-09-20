import { useId } from "react";
import type {
  AdminEngine,
  CatalogBrowseViewV1,
  CatalogFiltersV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { CARD_GRID, TEXT_INPUT } from "../chrome.js";
import { CatalogCard } from "./CatalogCards.js";
import type { RunEngineCall } from "./types.js";

/**
 * Inventory row 11: the catalog search field, the type tabs and the source
 * picker of the hand-built catalog (`ui/catalog-inventory.ts` lines 724-775 and
 * 2860-2930), over the engine's browse projection.
 *
 * With 442 items the list stays usable the way that page keeps it usable: the
 * engine returns one page of 50 and this file renders exactly that page, with
 * the same "Previous 50" / "Next 50" controls and the same results line.
 */

const SEARCH_LABEL = "Search catalog";
const SOURCE_LABEL = "Choose catalog source";
const TYPES_LABEL = "Catalog item types";
const ALL_TYPES = "All";
const PAGES_LABEL = "Result pages";
const PREVIOUS = "Previous 50";
const NEXT = "Next 50";
const SHOW_ALL_TYPES = "Show all types";
const RESULTS_LABEL = "Catalog browse results";

const TAB =
  "shrink-0 px-2.5 py-1 rounded font-mono text-[10.5px] transition-colors aria-pressed:bg-surface-container-highest aria-pressed:text-on-surface aria-pressed:font-semibold text-on-surface-variant hover:bg-surface-container";
const PAGE_BUTTON =
  "px-2 py-0.5 rounded font-mono text-[10.5px] text-on-surface-variant hover:bg-surface-container hover:text-on-surface border border-surface-container-high/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export function CatalogBrowse({
  engine,
  view,
  filters,
  onFilters,
  run,
  onOpen,
}: {
  readonly engine: AdminEngine;
  readonly view: CatalogBrowseViewV1;
  readonly filters: CatalogFiltersV1;
  readonly onFilters: (next: CatalogFiltersV1) => void;
  readonly run: RunEngineCall;
  readonly onOpen: (assetId: string) => void;
}) {
  const searchId = useId();
  const sourceId = useId();

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="px-5 py-2 border-b border-surface-container-high/40 bg-[#0e131d] flex flex-wrap items-center gap-2 shrink-0 text-[11.5px]">
        <label className="flex items-center gap-1.5" htmlFor={searchId}>
          <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
            {SEARCH_LABEL}
          </span>
        </label>
        <input
          className={`${TEXT_INPUT} w-56`}
          id={searchId}
          onChange={(event) => onFilters({ ...filters, query: event.target.value, page: 0 })}
          type="search"
          value={filters.query ?? ""}
        />

        <label className="flex items-center gap-1.5" htmlFor={sourceId}>
          <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
            {SOURCE_LABEL}
          </span>
        </label>
        <select
          className={`${TEXT_INPUT} w-56`}
          id={sourceId}
          onChange={(event) => onFilters({ ...filters, sourceId: event.target.value, page: 0 })}
          value={filters.sourceId ?? ""}
        >
          {view.sourceOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {`${option.label} (${option.count})`}
            </option>
          ))}
        </select>

        <fieldset
          aria-label={TYPES_LABEL}
          className="flex items-center gap-1 flex-wrap border-0 p-0 m-0"
        >
          <TypeTab
            active={filters.kind === undefined}
            count={view.allTypesCount}
            label={ALL_TYPES}
            onSelect={() => onFilters({ ...filters, kind: undefined, page: 0 })}
          />
          {view.typeOptions
            .filter((option) => option.count > 0 || filters.kind === option.id)
            .map((option) => (
              <TypeTab
                active={filters.kind === option.id}
                count={option.count}
                key={option.id}
                label={option.label}
                onSelect={() => onFilters({ ...filters, kind: option.id, page: 0 })}
              />
            ))}
        </fieldset>
      </div>

      <section
        aria-label={RESULTS_LABEL}
        className="flex-1 overflow-y-auto p-4 bg-[#0d111a] flex flex-col gap-3"
      >
        {view.rangeText === "" ? null : (
          <fieldset
            aria-label={PAGES_LABEL}
            className="flex items-center gap-2 text-[11px] border-0 p-0 m-0"
          >
            <span className="font-mono text-outline" role="status">
              {view.rangeText}
            </span>
            {view.pageText === "" ? null : (
              <>
                <button
                  className={PAGE_BUTTON}
                  disabled={view.page === 0}
                  onClick={() => onFilters({ ...filters, page: view.page - 1 })}
                  type="button"
                >
                  {PREVIOUS}
                </button>
                <span className="font-mono text-outline">{view.pageText}</span>
                <button
                  className={PAGE_BUTTON}
                  disabled={view.page + 1 >= view.pageCount}
                  onClick={() => onFilters({ ...filters, page: view.page + 1 })}
                  type="button"
                >
                  {NEXT}
                </button>
              </>
            )}
          </fieldset>
        )}

        {view.emptyMessage === undefined ? null : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[12px] text-on-surface-variant">{view.emptyMessage}</p>
            {filters.kind !== undefined && view.otherTypeMatches > 0 ? (
              <button
                className={PAGE_BUTTON}
                onClick={() => onFilters({ ...filters, kind: undefined, page: 0 })}
                type="button"
              >
                {SHOW_ALL_TYPES}
              </button>
            ) : null}
          </div>
        )}

        <div className={CARD_GRID}>
          {view.items.map((item) => (
            <CatalogCard
              item={item}
              key={item.assetId}
              onOpen={onOpen}
              onToggle={(next) => run(() => engine.setItemSelected(item.assetId, next))}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function TypeTab({
  label,
  count,
  active,
  onSelect,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button aria-pressed={active} className={TAB} onClick={onSelect} type="button">
      {`${label} (${count})`}
    </button>
  );
}
