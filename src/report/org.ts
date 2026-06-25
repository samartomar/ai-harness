import { type CacheSavings, cacheSavings, type TokenSplit } from "./pricing.js";

/**
 * Org analytics, normalized from a saved Admin-API export.
 *
 * The exact wire shape of the Claude Code usage / skills endpoints is external
 * and versioned, so {@link parseOrgAnalytics} is a deliberately TOLERANT
 * anti-corruption layer: it accepts `{data:[…]}`, `{data:[{results:[…]}]}`, or a
 * bare array, and reads each metric from any of several known field-name variants.
 * Confirm against live `fetch-analytics.mjs --run` output; if a field is renamed
 * upstream, this file is the single place to adjust.
 */
export interface ModelTokens {
  model: string;
  tokens: TokenSplit;
}

export interface SkillStat {
  name: string;
  users: number;
  sessions: number;
}

export interface OrgAnalytics {
  window?: { startingAt?: string; endingAt?: string };
  tokens: TokenSplit;
  byModel: ModelTokens[];
  estimatedCostUsd?: number;
  toolActions?: { accepted: number; rejected: number };
  skills: SkillStat[];
  /** How many usage records were folded; 0 → "no usage data in the export". */
  records: number;
}

export interface OrgDigestData extends OrgAnalytics {
  savings: CacheSavings;
}

const ZERO: TokenSplit = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** First finite number among candidate keys (else 0). */
function num(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

/** First non-empty string among candidate keys (else undefined). */
function str(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Flatten a usage/skills response into leaf records. Handles a bare array,
 * `{data:[…]}` / `{results:[…]}`, and one nested level (`{data:[{results:[…]}]}`).
 */
function leafRecords(node: unknown): Record<string, unknown>[] {
  const top = Array.isArray(node)
    ? node
    : isRecord(node)
      ? ((node.data ?? node.results ?? node.items) as unknown)
      : undefined;
  const arr = Array.isArray(top) ? top : [];
  const out: Record<string, unknown>[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    if (Array.isArray(item.results)) {
      for (const r of item.results) if (isRecord(r)) out.push(r);
    } else {
      out.push(item);
    }
  }
  return out;
}

function tokensOf(r: Record<string, unknown>): TokenSplit {
  return {
    input: num(r, ["uncached_input_tokens", "input_tokens", "input"]),
    output: num(r, ["output_tokens", "output"]),
    cacheRead: num(r, ["cache_read_input_tokens", "cache_read_tokens", "cache_read", "cacheRead"]),
    cacheCreation: num(r, [
      "cache_creation_input_tokens",
      "cache_creation_tokens",
      "cache_creation",
      "cacheCreation",
    ]),
  };
}

function addTokens(a: TokenSplit, b: TokenSplit): TokenSplit {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

const sumTokens = (t: TokenSplit): number => t.input + t.output + t.cacheRead + t.cacheCreation;

/** `estimated_cost` may be a number or a `{amount|value|usd}` money object. */
function costOf(r: Record<string, unknown>): number {
  const c = r.estimated_cost ?? r.estimatedCost ?? r.cost;
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (isRecord(c)) return num(c, ["amount", "value", "usd", "total"]);
  return 0;
}

/** Sum accept/reject across `tool_actions.{edit,write,…}` plus any flat fields. */
function toolActionsOf(r: Record<string, unknown>): { accepted: number; rejected: number } {
  let accepted = num(r, ["accepted"]);
  let rejected = num(r, ["rejected"]);
  const ta = r.tool_actions ?? r.toolActions;
  if (isRecord(ta)) {
    for (const v of Object.values(ta)) {
      if (isRecord(v)) {
        accepted += num(v, ["accepted"]);
        rejected += num(v, ["rejected"]);
      }
    }
  }
  return { accepted, rejected };
}

function parseSkills(node: unknown): SkillStat[] {
  const out: SkillStat[] = [];
  for (const r of leafRecords(node)) {
    const name = str(r, ["skill_name", "name", "skill"]);
    if (!name) continue;
    const users = num(r, ["distinct_user_count", "distinct_users", "user_count", "users"]);
    let sessions = num(r, ["session_count", "sessions", "total_sessions"]);
    const bySurface = r.session_counts ?? r.sessions_by_surface ?? r.surfaces;
    if (sessions === 0 && isRecord(bySurface)) {
      for (const v of Object.values(bySurface)) if (typeof v === "number") sessions += v;
    }
    out.push({ name, users, sessions });
  }
  out.sort((a, b) => b.users - a.users || b.sessions - a.sessions || a.name.localeCompare(b.name));
  return out;
}

function pickWindow(
  usageNode: unknown,
  recs: Record<string, unknown>[],
): { startingAt?: string; endingAt?: string } | undefined {
  const node = isRecord(usageNode) ? usageNode : {};
  const startingAt =
    str(node, ["starting_at", "startingAt"]) ??
    (recs[0] ? str(recs[0], ["starting_at", "startingAt", "date"]) : undefined);
  const endingAt =
    str(node, ["ending_at", "endingAt"]) ??
    (recs[0] ? str(recs[0], ["ending_at", "endingAt"]) : undefined);
  return startingAt || endingAt ? { startingAt, endingAt } : undefined;
}

/**
 * Normalize a saved Admin-API export (`{ usage_report, skills }`, or a bare
 * usage response) into {@link OrgAnalytics}. Pure: no fs, no network; tolerant
 * of missing fields so a partial export still yields a useful digest.
 */
export function parseOrgAnalytics(raw: unknown): OrgAnalytics {
  const root = isRecord(raw) ? raw : {};
  const usageNode = root.usage_report ?? root.usageReport ?? root.usage ?? raw;
  const skillsNode = root.skills ?? root.analytics_skills;

  const recs = leafRecords(usageNode);
  let totals: TokenSplit = ZERO;
  const byModelMap = new Map<string, TokenSplit>();
  let cost = 0;
  let accepted = 0;
  let rejected = 0;
  for (const r of recs) {
    const t = tokensOf(r);
    totals = addTokens(totals, t);
    const model = str(r, ["model", "model_id"]) ?? "unknown";
    byModelMap.set(model, addTokens(byModelMap.get(model) ?? ZERO, t));
    cost += costOf(r);
    const ta = toolActionsOf(r);
    accepted += ta.accepted;
    rejected += ta.rejected;
  }

  const byModel = [...byModelMap.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => sumTokens(b.tokens) - sumTokens(a.tokens) || a.model.localeCompare(b.model));

  return {
    window: pickWindow(usageNode, recs),
    tokens: totals,
    byModel,
    estimatedCostUsd: cost > 0 ? cost : undefined,
    toolActions: accepted + rejected > 0 ? { accepted, rejected } : undefined,
    skills: skillsNode !== undefined ? parseSkills(skillsNode) : [],
    records: recs.length,
  };
}

/** Parse a saved export and attach computed cache savings. */
export function aggregateOrg(raw: unknown): OrgDigestData {
  const analytics = parseOrgAnalytics(raw);
  return { ...analytics, savings: cacheSavings(analytics.byModel, analytics.tokens) };
}
