import { useId } from "react";
import type {
  AdminCatalogItem,
  AdminEngine,
  AdminFramework,
} from "../../../src/org-policy/workbench/engine/index.js";
import { CARD, CARD_FOOTER, CARD_GRID, CARD_TITLE, KIND_CHIP } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/** The catalog cards of one scope, and the switch that selects an item. */

const SELECTED = "Selected";
const NOT_SELECTED = "Not selected";

export function CatalogCards({
  engine,
  framework,
  run,
  onOpen,
}: {
  readonly engine: AdminEngine;
  readonly framework: AdminFramework | undefined;
  readonly run: RunEngineCall;
  /** LANE A: open this item in the inspector (row 12). */
  readonly onOpen?: (assetId: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto p-4 bg-[#0d111a] flex flex-col gap-4">
      {framework?.groups.map((group) => (
        <section className="flex flex-col gap-2" key={group.id}>
          <h2 className="font-bold text-white text-[13px] tracking-tight">{group.label}</h2>
          <div className={CARD_GRID}>
            {group.items.map((item) => (
              <CatalogCard
                item={item}
                key={item.assetId}
                onOpen={onOpen}
                onToggle={(next) => run(() => engine.setItemSelected(item.assetId, next))}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function CatalogCard({
  item,
  onToggle,
  onOpen,
}: {
  readonly item: AdminCatalogItem;
  readonly onToggle: (selected: boolean) => void;
  readonly onOpen?: (assetId: string) => void;
}) {
  const reasonId = useId();
  return (
    <div className={CARD} data-card-id={item.assetId}>
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {onOpen === undefined ? (
              <span className={CARD_TITLE}>{item.label}</span>
            ) : (
              <button
                className={`${CARD_TITLE} text-left hover:text-primary`}
                onClick={() => onOpen(item.assetId)}
                type="button"
              >
                {item.label}
              </button>
            )}
          </div>
          <span className={KIND_CHIP}>{item.kind}</span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-2 leading-relaxed">{item.assetId}</p>
      </div>
      <div className={CARD_FOOTER}>
        <span
          className={`px-1.5 py-0.5 rounded font-mono font-medium flex items-center gap-1 ${
            item.selected
              ? "bg-secondary-container/20 text-secondary"
              : "bg-surface-container-low border border-surface-container-high/40 text-outline"
          }`}
        >
          <span
            className={`w-1 h-1 rounded-full ${item.selected ? "bg-secondary" : "bg-outline"}`}
          />
          {item.selected ? SELECTED : NOT_SELECTED}
        </span>
        <div className="flex items-center gap-1.5">
          {item.selectable ? null : (
            <span className="text-[10px] text-outline" id={reasonId}>
              {item.reason}
            </span>
          )}
          <button
            aria-checked={item.selected}
            aria-describedby={item.selectable ? undefined : reasonId}
            aria-disabled={item.selectable ? undefined : true}
            aria-label={item.label}
            className={`toggle-switch w-6 h-3.5 rounded-full p-0.5 flex items-center transition-colors ${
              item.selected ? "bg-primary" : "bg-surface-container-highest"
            }`}
            data-active={item.selected}
            onClick={() => {
              if (item.selectable) onToggle(!item.selected);
            }}
            role="switch"
            type="button"
          >
            <span
              className={`w-2.5 h-2.5 rounded-full bg-white transition-transform ${
                item.selected ? "translate-x-2.5" : ""
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
