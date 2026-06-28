import { gitInt, gitRead } from "../internals/git.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * The OUTPUT VELOCITY panels for `aih report` (local scope): a daily-commit bar
 * chart over a recent window + a lines-of-code delta over 30 days, plus the
 * commit counts (7d / 30d / total) the hero KPI strip surfaces. All derived from
 * read-only git through the Runner seam. Byte-stable: the day axis is built from
 * the COMMIT dates in the data (no wall-clock injected into output) — git's own
 * `--since` clock bounds the window, exactly as the existing `commits7d` does.
 */

const DAILY_DAYS = 14;
const LOC_WINDOW_DAYS = 30;
/** Heatmap window: 15 columns × 7 rows of days for the v4 activity grid. */
const HEATMAP_DAYS = 105;

/** Sum +/- lines over a `--since` window via numstat (binary files count as 0). */
async function locWindow(
  ctx: PlanContext,
  days: number,
): Promise<{ added: number; removed: number; net: number }> {
  const out = await gitRead(ctx, [
    "log",
    `--since=${days}.days.ago`,
    "--numstat",
    "--pretty=tformat:",
  ]);
  let added = 0;
  let removed = 0;
  for (const line of (out ?? "").split("\n").filter(Boolean)) {
    const [a, r] = line.split("\t");
    added += gitInt(a);
    removed += gitInt(r);
  }
  return { added, removed, net: added - removed };
}

/** "YYYY-MM-DD" → the next calendar day (string in/out; seeded by data, not the clock). */
function nextDay(d: string): string {
  const [y, m, day] = d.split("-").map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (day ?? 1) + 1)).toISOString().slice(0, 10);
}

/** Per-day commit counts, gap-filled to a contiguous axis between first/last commit day. */
async function dailyCommits(
  ctx: PlanContext,
  days: number,
): Promise<{ date: string; count: number }[]> {
  const out = await gitRead(ctx, [
    "log",
    `--since=${days}.days.ago`,
    "--date=short",
    "--pretty=%cd",
  ]);
  const counts = new Map<string, number>();
  for (const d of (out ?? "").split("\n").filter(Boolean)) counts.set(d, (counts.get(d) ?? 0) + 1);
  if (counts.size === 0) return [];
  const sorted = [...counts.keys()].sort();
  const last = sorted[sorted.length - 1] ?? "";
  const series: { date: string; count: number }[] = [];
  let cur = sorted[0] ?? "";
  for (let i = 0; i < 400 && cur && cur <= last; i++) {
    series.push({ date: cur, count: counts.get(cur) ?? 0 });
    cur = nextDay(cur);
  }
  return series.slice(-days);
}

/** The two OUTPUT VELOCITY digests (daily commits + LOC 30d); empty when not a repo. */
export async function velocityDigests(ctx: PlanContext): Promise<DigestAction[]> {
  if ((await gitRead(ctx, ["rev-parse", "--is-inside-work-tree"])) !== "true") return [];
  const d7 = gitInt(await gitRead(ctx, ["rev-list", "--count", "--since=7.days.ago", "HEAD"]));
  const d30 = gitInt(await gitRead(ctx, ["rev-list", "--count", "--since=30.days.ago", "HEAD"]));
  const total = gitInt(await gitRead(ctx, ["rev-list", "--count", "HEAD"]));
  const daily = await dailyCommits(ctx, DAILY_DAYS);
  // A longer per-day series for the v4 dashboard's activity heatmap (gap-filled,
  // most-recent last). Cheap extra git call; the legacy renderer ignores it.
  const daily90 = await dailyCommits(ctx, HEATMAP_DAYS);
  const loc = await locWindow(ctx, LOC_WINDOW_DAYS);

  const commitsDigest = digest(
    `Daily commits — ${d7} in 7d · ${d30} in 30d · ${total} total`,
    lines(
      `Commits: ${d7} (7d) · ${d30} (30d) · ${total} total`,
      "",
      `Daily commits (last ${DAILY_DAYS}d active span):`,
      `  ${daily.length > 0 ? daily.map((d) => d.count).join(" ") : "(none)"}`,
    ),
    { commits: { d7, d30, total }, daily, daily90 },
  );
  const locDigest = digest(
    `Lines of code (${LOC_WINDOW_DAYS}d) — +${loc.added} / −${loc.removed}`,
    `Lines of code (${LOC_WINDOW_DAYS}d): +${loc.added} −${loc.removed}  (net ${loc.net >= 0 ? "+" : ""}${loc.net})`,
    { loc, windowDays: LOC_WINDOW_DAYS },
  );
  return [commitsDigest, locDigest];
}
