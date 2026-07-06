import type { UsageEvent } from "./events.js";

/** A counted item: a name (skill/server/tool) and how many events referenced it. */
export interface Counted {
  name: string;
  count: number;
}

/** Skills grouped by provenance for the "which ECC/canon/user skills" question. */
export interface SkillsBySource {
  ecc: Counted[];
  canon: Counted[];
  user: Counted[];
}

export interface UsageSummary {
  total: number;
  /** Distinct tools that produced events (e.g. git, claude, kiro). */
  tools: Counted[];
  /** Commit activity from the universal git floor. */
  commits: { count: number; added: number; removed: number; files: number };
  /** Local token/cache counters from on-box usage samples. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
    cacheEfficiencyPct: number;
  };
  /** Top skills, overall and split by source. */
  skills: { top: Counted[]; bySource: SkillsBySource };
  /** Top MCP servers + tools. */
  mcp: { servers: Counted[]; tools: Counted[] };
}

function top(map: Map<string, number>, limit = 12): Counted[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function bump(map: Map<string, number>, key: string | undefined, by = 1): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

function counter(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Fold a usage-event list into a {@link UsageSummary} (pure, deterministic). */
export function aggregateUsage(events: UsageEvent[]): UsageSummary {
  const tools = new Map<string, number>();
  const skillAll = new Map<string, number>();
  const bySource: SkillsBySource = { ecc: [], canon: [], user: [] };
  const skillSrc = {
    ecc: new Map<string, number>(),
    canon: new Map<string, number>(),
    user: new Map<string, number>(),
  };
  const mcpServers = new Map<string, number>();
  const mcpTools = new Map<string, number>();
  const commits = { count: 0, added: 0, removed: 0, files: 0 };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  for (const e of events) {
    bump(tools, e.tool);
    tokens.input += counter(e.tokens?.input);
    tokens.output += counter(e.tokens?.output);
    tokens.cacheRead += counter(e.tokens?.cacheRead);
    tokens.cacheCreation += counter(e.tokens?.cacheCreation);
    if (e.kind === "commit") {
      commits.count += 1;
      commits.added += e.added ?? 0;
      commits.removed += e.removed ?? 0;
      commits.files += e.files ?? 0;
    } else if (e.kind === "skill" && e.name) {
      bump(skillAll, e.name);
      bump(skillSrc[e.source ?? "user"], e.name);
    } else if (e.kind === "mcp") {
      bump(mcpServers, e.server);
      bump(mcpTools, e.name);
    }
  }

  bySource.ecc = top(skillSrc.ecc);
  bySource.canon = top(skillSrc.canon);
  bySource.user = top(skillSrc.user);
  const tokenTotal = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
  const cacheDenom = tokens.cacheRead + tokens.input;

  return {
    total: events.length,
    tools: top(tools),
    commits,
    tokens: {
      ...tokens,
      total: tokenTotal,
      cacheEfficiencyPct: cacheDenom > 0 ? Math.round((tokens.cacheRead / cacheDenom) * 100) : 0,
    },
    skills: { top: top(skillAll), bySource },
    mcp: { servers: top(mcpServers), tools: top(mcpTools) },
  };
}
