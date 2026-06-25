/**
 * Token pricing + cache-savings math for the org analytics digest.
 *
 * Cache savings are NOT "cached tokens × full rate". Anthropic prices a cache
 * *write* at a premium over standard input and a cache *read* at a deep discount,
 * so a defensible figure nets the write premium out of the read win:
 *
 *   net = cacheRead × (Pinput − PcacheRead) − cacheCreation × (PcacheWrite − Pinput)
 *
 * Always rendered as an ESTIMATE of avoided cost, never as proven
 * incurred-then-saved spend. Only the cache-efficiency PERCENT is
 * rate-independent and fully defensible.
 */

/** Per-model token split (counts) — the unit the savings math consumes. */
export interface TokenSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** USD per *million* tokens for one model tier. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Default list price (USD / MTok) for the Claude 4.5 family at the 5-minute cache
 * TTL — verified against platform.claude.com/docs/en/about-claude/pricing on
 * 2026-06-24. The cache-efficiency percent is rate-independent; re-verify these
 * rates before trusting the dollar figures (older callers had 4.1-era Opus rates).
 */
export const DEFAULT_RATES: Record<"opus" | "sonnet" | "haiku", ModelRate> = {
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Map a model id (e.g. "claude-opus-4-8") to its rate tier by substring match. */
export function rateFor(
  model: string,
  rates: Record<string, ModelRate> = DEFAULT_RATES,
): ModelRate | undefined {
  const m = model.toLowerCase();
  if (m.includes("opus")) return rates.opus;
  if (m.includes("sonnet")) return rates.sonnet;
  if (m.includes("haiku")) return rates.haiku;
  return undefined;
}

export interface CacheSavings {
  /** cacheRead / (cacheRead + input), 0..1 — rate-independent, the defensible number. */
  efficiency: number;
  grossAvoidedUsd: number;
  writePremiumUsd: number;
  netSavedUsd: number;
  /** Models priced vs. skipped (no rate in the table) for the dollar figures. */
  pricedModels: string[];
  unpricedModels: string[];
}

const PER_MTOK = 1_000_000;

/**
 * Net cache savings across per-model token splits. Per-model because the
 * read-discount / write-premium deltas differ by tier; models absent from
 * `rates` land in `unpricedModels` and are excluded from the dollar figures
 * (the efficiency percent still counts their tokens via `totals`).
 */
export function cacheSavings(
  byModel: ReadonlyArray<{ model: string; tokens: TokenSplit }>,
  totals: TokenSplit,
  rates: Record<string, ModelRate> = DEFAULT_RATES,
): CacheSavings {
  let gross = 0;
  let premium = 0;
  const priced: string[] = [];
  const unpriced: string[] = [];
  for (const { model, tokens } of byModel) {
    const r = rateFor(model, rates);
    if (!r) {
      unpriced.push(model);
      continue;
    }
    priced.push(model);
    gross += (tokens.cacheRead * (r.input - r.cacheRead)) / PER_MTOK;
    premium += (tokens.cacheCreation * (r.cacheWrite - r.input)) / PER_MTOK;
  }
  const denom = totals.cacheRead + totals.input;
  return {
    efficiency: denom > 0 ? totals.cacheRead / denom : 0,
    grossAvoidedUsd: gross,
    writePremiumUsd: premium,
    netSavedUsd: gross - premium,
    pricedModels: priced,
    unpricedModels: unpriced,
  };
}
