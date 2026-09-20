import type { KindLedgerEntryV1 } from "../../../src/org-policy/workbench/engine/index.js";

/**
 * Inventory row 7, the kind ledger: the five tiles of `ui/kind-ledger.ts`
 * mounted in the hand-built shell's ledger strip (`ui/shell/admin-shell.ts`
 * `ledgerTile`). Every figure is a real catalog count; the prototype's sixth
 * "Token Budget" tile is a token/context cost figure and is not rendered.
 */

const LEDGER_LABEL = "Catalog kinds";
const SELECTED = "selected";

export function KindLedger({ entries }: { readonly entries: readonly KindLedgerEntryV1[] }) {
  return (
    <fieldset
      aria-label={LEDGER_LABEL}
      className="m-0 p-0 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 border-0 border-b border-surface-container-high/60 bg-[#0e131d] shrink-0 w-full"
    >
      {entries.map((entry) => (
        <div
          className="px-4 py-3 flex flex-col gap-2 min-w-0 border-r border-surface-container-high/40 last:border-r-0"
          data-kind-ledger-tile={entry.kind}
          key={entry.kind}
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[10px] uppercase font-semibold tracking-[0.08em] truncate text-outline">
              {entry.label}
            </span>
            <span className="text-[10px] font-mono tabular-nums shrink-0 text-outline">
              {entry.percent}%
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex items-baseline gap-1">
              <span className="text-[22px] leading-none font-semibold font-mono tabular-nums tracking-tight text-white">
                {entry.selected}
              </span>
              <span className="text-[11px] font-mono tabular-nums text-outline">
                /{entry.total}
              </span>
            </span>
            <span className="text-[10px] font-mono tabular-nums whitespace-nowrap text-outline">
              {SELECTED}
            </span>
          </div>
          {/* The bar repeats the figures above; the numbers carry the meaning. */}
          <div aria-hidden="true" className="h-[3px] rounded-full bg-surface-container-highest">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${entry.percent}%` }}
            />
          </div>
        </div>
      ))}
    </fieldset>
  );
}
