import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { readUsage, type UsageEvent } from "../usage/events.js";

/**
 * The "AI events" chronological feed — one row per recorded event from
 * `.aih/usage.jsonl`, newest first. Distinct from the aggregate Usage panel (which
 * shows totals): this is the raw activity log (time · tool·kind · detail · ±LOC).
 * Byte-stable — timestamps are DATA from the log, formatted absolutely (never a
 * relative "2h ago" that would churn every render). Returns `undefined` when the
 * log is empty, so the dashboard simply omits the panel rather than showing a stub.
 */

const SHOWN = 50;

export interface EventRow {
  ts: string; // absolute "YYYY-MM-DD HH:MM"
  tool: string;
  kind: string;
  detail: string; // branch (commit) | skill/mcp name
  added?: number;
  removed?: number;
}

/** ISO → "YYYY-MM-DD HH:MM" (deterministic; no wall-clock, no relative time). */
function fmtTs(iso?: string): string {
  if (!iso) return "—";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso.slice(0, 16);
}

/** The per-row detail: branch for commits, name/server for skill/mcp. */
function detailOf(e: UsageEvent): string {
  if (e.kind === "commit") return e.branch ?? "—";
  if (e.kind === "mcp") return [e.name, e.server].filter(Boolean).join(" · ") || "—";
  return e.name ? `${e.name}${e.source ? ` (${e.source})` : ""}` : "—";
}

export function aiEventsDigest(ctx: PlanContext): DigestAction | undefined {
  const events = readUsage(ctx);
  if (events.length === 0) return undefined;
  // Newest first (ISO timestamps sort lexicographically; missing ts sinks to the end).
  const sorted = [...events].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  const total = sorted.length;
  const rows: EventRow[] = sorted.slice(0, SHOWN).map((e) => ({
    ts: fmtTs(e.ts),
    tool: e.tool,
    kind: e.kind,
    detail: detailOf(e),
    added: e.added,
    removed: e.removed,
  }));
  const text = lines(
    "TIME              EVENT            DETAIL                Δ LINES",
    ...rows.map((r) => {
      const ev = `${r.tool}·${r.kind}`.slice(0, 15).padEnd(16);
      const dl = r.detail.slice(0, 20).padEnd(21);
      const loc =
        r.added !== undefined || r.removed !== undefined
          ? `+${r.added ?? 0} -${r.removed ?? 0}`
          : "—";
      return `${r.ts.padEnd(17)} ${ev} ${dl} ${loc}`;
    }),
    ...(total > SHOWN ? ["", `… +${total - SHOWN} older`] : []),
  );
  return digest(`AI events — ${total} recorded`, text, { rows, shown: rows.length, total });
}
