import { catalogKindLabel } from "../catalog-browse.js";
import { workbenchIcon } from "./icons.js";

/**
 * P2b: the kind ledger mounted in the Workbench footer (prototype
 * `admin-sources.html`'s `#framework-matrix-tabs` tile row, adapted).
 *
 * The prototype shows six tiles (Skills, Commands, Agents, MCP Servers,
 * Hook Events, Token Budget). This ledger renders five of them — every
 * asset `kind` the product catalog actually carries (see
 * `catalog-browse.ts` / `contracts.ts`: "skill", "command", "agent", "mcp",
 * "hook") — each fed by the real catalog bundle and the real resolved
 * selection, never a fabricated number. The sixth prototype tile, "Token
 * Budget", is a token/context cost figure and is intentionally omitted:
 * D6 forbids rendering token or context cost numbers anywhere in the
 * product Workbench.
 */
export const KIND_LEDGER_KINDS = ["skill", "command", "agent", "mcp", "hook"] as const;

export type KindLedgerKind = (typeof KIND_LEDGER_KINDS)[number];

const KIND_LEDGER_ICONS: Record<KindLedgerKind, string> = {
  skill: "extension",
  command: "terminal",
  agent: "smart_toy",
  mcp: "dns",
  hook: "webhook",
};

/**
 * P3.1: the kind glyph for a catalog card (prototype `#cards-grid` card
 * header). Ledger kinds reuse the ledger glyph and its `wb-primitive-*`
 * colour; any other catalog kind (profile, lang, module, ...) gets a neutral
 * package glyph and no colour class, so an unknown kind never throws.
 */
export function catalogKindIcon(kind: string): { name: string; colorClass: string | undefined } {
  if ((KIND_LEDGER_KINDS as readonly string[]).includes(kind)) {
    const ledgerKind = kind as KindLedgerKind;
    return { name: KIND_LEDGER_ICONS[ledgerKind], colorClass: `wb-primitive-${ledgerKind}` };
  }
  return { name: "inventory_2", colorClass: undefined };
}

export interface KindLedgerAsset {
  readonly id: string;
  readonly kind: string;
}

export interface KindLedgerEntry {
  readonly kind: KindLedgerKind;
  readonly label: string;
  readonly total: number;
  readonly selected: number;
}

export interface KindLedgerViewModel {
  readonly entries: readonly KindLedgerEntry[];
}

/**
 * Pure view-model: counts assets per ledger kind from the catalog the
 * product already holds (`bundle.assets`, projected by the caller to
 * `{ id, kind }`), and how many of those are in the resolved selection.
 * A kind absent from the catalog renders with a real count of 0 rather
 * than being fabricated or hidden.
 */
export function buildKindLedgerViewModel(
  assets: readonly KindLedgerAsset[],
  selectedAssetIds: ReadonlySet<string> | readonly string[],
): KindLedgerViewModel {
  const selected = selectedAssetIds instanceof Set ? selectedAssetIds : new Set(selectedAssetIds);
  const totals = new Map<KindLedgerKind, number>(KIND_LEDGER_KINDS.map((kind) => [kind, 0]));
  const selectedCounts = new Map<KindLedgerKind, number>(
    KIND_LEDGER_KINDS.map((kind) => [kind, 0]),
  );
  for (const asset of assets) {
    if (!(KIND_LEDGER_KINDS as readonly string[]).includes(asset.kind)) continue;
    const kind = asset.kind as KindLedgerKind;
    totals.set(kind, (totals.get(kind) ?? 0) + 1);
    if (selected.has(asset.id)) selectedCounts.set(kind, (selectedCounts.get(kind) ?? 0) + 1);
  }
  return {
    entries: KIND_LEDGER_KINDS.map((kind) => ({
      kind,
      label: catalogKindLabel(kind),
      total: totals.get(kind) ?? 0,
      selected: selectedCounts.get(kind) ?? 0,
    })),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/**
 * Renders the ledger as an HTML string for the footer `.ledger` mount
 * point. Tailwind utility classes plus `--wb-*` tokens and the
 * `--wb-primitive-*` kind colours (`wb-tokens.css`) style each tile; no
 * network fonts or icon fonts (icons come from `workbenchIcon`, D2).
 */
export function renderKindLedger(model: KindLedgerViewModel): string {
  const tiles = model.entries
    .map((entry) => {
      const percent = entry.total === 0 ? 0 : Math.round((entry.selected / entry.total) * 100);
      const primitiveClass = `wb-primitive-${entry.kind}`;
      return `<div class="flex flex-col gap-0.5 px-2 py-1 flex-1 min-w-[72px] max-w-[140px]" data-kind-ledger-tile="${entry.kind}">
  <div class="flex items-center gap-1 text-[9px] uppercase tracking-wide font-semibold text-on-surface-variant">
    <span class="w-3 h-3 shrink-0 ${primitiveClass}">${workbenchIcon(KIND_LEDGER_ICONS[entry.kind])}</span>
    <span class="truncate" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</span>
  </div>
  <div class="flex items-baseline gap-1 text-[10px] font-mono tabular-nums text-on-surface-variant">
    <span class="font-semibold text-on-surface">${entry.selected}/${entry.total}</span>
  </div>
  <div class="h-[3px] rounded-full bg-surface-container-highest overflow-hidden">
    <div class="h-full rounded-full ${primitiveClass}" style="width:${percent}%;background:currentColor" data-kind-ledger-bar="${entry.kind}"></div>
  </div>
</div>`;
    })
    .join("");
  return `<div class="flex flex-1 flex-wrap items-stretch gap-x-0 gap-y-0.5 min-w-0" data-kind-ledger role="group" aria-label="Catalog kinds">${tiles}</div>`;
}

/**
 * Mounts (or re-renders) the kind ledger into the footer `.ledger`
 * element. Called from the Workbench refresh loop so the tile counts
 * follow selection changes, exactly like the other panels it renders
 * alongside (see `mountWorkbench`'s `refresh()` in `catalog-inventory.ts`).
 */
export function mountKindLedger(
  container: { innerHTML: string },
  assets: readonly KindLedgerAsset[],
  selectedAssetIds: ReadonlySet<string> | readonly string[],
): KindLedgerViewModel {
  const model = buildKindLedgerViewModel(assets, selectedAssetIds);
  container.innerHTML = renderKindLedger(model);
  return model;
}
