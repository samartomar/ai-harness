import type { AdminState } from "../../../src/org-policy/workbench/engine/index.js";
import { RAIL, RAIL_HEADING } from "../chrome.js";

/** The left rail: the catalog scopes, and which one the cards show. */

const HEADING = "Catalog scopes";

export function CatalogScopes({
  frameworks,
  activeSourceId,
  onSelect,
}: {
  readonly frameworks: AdminState["frameworks"];
  readonly activeSourceId: string | undefined;
  readonly onSelect: (sourceId: string) => void;
}) {
  return (
    <aside className={RAIL}>
      <div className="p-2 space-y-1 flex-1 overflow-y-auto">
        <div className={RAIL_HEADING}>
          <span>{HEADING}</span>
        </div>
        <div className="space-y-0.5 text-[11px]">
          {frameworks.map((entry) => {
            const active = entry.sourceId === activeSourceId;
            return (
              <button
                aria-pressed={active}
                className={`flex w-full items-center justify-between px-1.5 py-1 rounded border border-surface-container-high/40 ${
                  active
                    ? "bg-surface-container-low/80 text-primary font-semibold"
                    : "bg-surface-container-low/40 hover:bg-surface-container-low/80 text-on-surface"
                }`}
                key={entry.sourceId}
                onClick={() => onSelect(entry.sourceId)}
                type="button"
              >
                <span className="truncate text-[11.5px]">{entry.label}</span>
                <span className="font-mono text-[10px] text-outline">
                  {entry.groups.reduce((total, group) => total + group.items.length, 0)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
