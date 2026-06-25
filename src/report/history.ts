import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { gitInt, gitRead } from "../internals/git.js";
import {
  type DigestAction,
  digest,
  type PlanContext,
  type WriteAction,
  writeText,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { inventory } from "../status.js";
import { scanContextBloat } from "./bloat.js";

/**
 * The time-series tracking layer behind `aih report` trends. `aih track` records
 * one {@link Snapshot} per commit into `.aih/history.jsonl` (gitignored live data,
 * NOT a byte-stable artifact); {@link trendsPanel} renders the accumulated series.
 * Every field comes from local git + repo state — no network, no wall-clock (the
 * sample time is the commit's own date), so a snapshot is deterministic per commit.
 */

export const HISTORY_PATH = join(".aih", "history.jsonl");
const TREND_WINDOW = 14;
const SPARK = "▁▂▃▄▅▆▇█";

export interface Snapshot {
  /** Latest commit's committer date (ISO) — the sample's time, not wall-clock. */
  ts: string;
  sha: string;
  branch: string;
  branches: number;
  commits7d: number;
  loc: { added: number; removed: number; net: number };
  adoptionScore: number;
  contextTokens: number;
  sourceFiles: number;
}

/** Added/removed lines across the last 7 days (binary files count as 0). */
async function locDelta(ctx: PlanContext): Promise<Snapshot["loc"]> {
  const out = await gitRead(ctx, ["log", "--since=7 days ago", "--numstat", "--pretty=tformat:"]);
  let added = 0;
  let removed = 0;
  for (const line of (out ?? "").split("\n").filter(Boolean)) {
    const [a, r] = line.split("\t");
    added += gitInt(a);
    removed += gitInt(r);
  }
  return { added, removed, net: added - removed };
}

/** Collect one metrics snapshot from git + repo state; `undefined` outside a repo. */
export async function collectSnapshot(ctx: PlanContext): Promise<Snapshot | undefined> {
  if ((await gitRead(ctx, ["rev-parse", "--is-inside-work-tree"])) !== "true") return undefined;
  const [ts = "", sha = ""] = (
    (await gitRead(ctx, ["log", "-1", "--pretty=format:%cI%n%h"])) ?? ""
  ).split("\n");
  const branch = (await gitRead(ctx, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
  const branchList = await gitRead(ctx, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const commits7d = gitInt(
    await gitRead(ctx, ["rev-list", "--count", "--since=7 days ago", "HEAD"]),
  );
  const loc = await locDelta(ctx);
  const inv = inventory(ctx.root, ctx.contextDir);
  const present = inv.filter((i) => i.present).length;
  const lsFiles = await gitRead(ctx, ["ls-files"]);
  return {
    ts,
    sha,
    branch,
    branches: (branchList ?? "").split("\n").filter(Boolean).length,
    commits7d,
    loc,
    adoptionScore: inv.length > 0 ? Math.round((100 * present) / inv.length) : 0,
    contextTokens: scanContextBloat(ctx.root, ctx.contextDir).totalTokens,
    sourceFiles: (lsFiles ?? "").split("\n").filter(Boolean).length,
  };
}

/** Read the accumulated history (skips malformed lines). */
export function readHistory(ctx: PlanContext): Snapshot[] {
  const raw = readIfExists(join(ctx.root, HISTORY_PATH));
  if (!raw) return [];
  const rows: Snapshot[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as Snapshot);
    } catch {
      // skip a malformed line rather than failing the whole read
    }
  }
  return rows;
}

/**
 * A write that appends `snapshot` to the history — but only when the latest row is
 * a different commit, so re-running `aih track` on the same commit is a byte-stable
 * no-op (one sample per commit). Rewrites the whole JSONL so the `write` action
 * stays idempotent against disk.
 */
export function historyWrite(ctx: PlanContext, snapshot: Snapshot): WriteAction {
  const existing = readHistory(ctx);
  // Dedupe by SHA across the WHOLE retained history, not just the last row: re-running
  // track on an older/reordered commit (rebase, restored history, manual edit) must
  // not append a duplicate sample — one sample per commit, regardless of position.
  const seen = new Set(existing.map((r) => r.sha));
  const rows = seen.has(snapshot.sha) ? existing : [...existing, snapshot];
  const content = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  return writeText(
    HISTORY_PATH,
    content,
    `record metrics sample → ${HISTORY_PATH.replace(/\\/g, "/")} (${rows.length} sample${rows.length === 1 ? "" : "s"})`,
  );
}

/** A unicode sparkline of `values`, scaled across their own min/max. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  return values
    .map(
      (v) => SPARK[Math.min(SPARK.length - 1, Math.floor(((v - min) / span) * (SPARK.length - 1)))],
    )
    .join("");
}

const TRENDS: Array<{ label: string; pick: (s: Snapshot) => number }> = [
  { label: "commits (7d)", pick: (s) => s.commits7d },
  { label: "LOC net", pick: (s) => s.loc.net },
  { label: "adoption", pick: (s) => s.adoptionScore },
  { label: "branches", pick: (s) => s.branches },
  { label: "ctx tokens", pick: (s) => s.contextTokens },
];

/** The trends digest for `aih report` (local). Honest stub until 2+ samples exist. */
export function trendsPanel(ctx: PlanContext): DigestAction {
  const rows = readHistory(ctx).slice(-TREND_WINDOW);
  if (rows.length < 2) {
    return digest(
      "Trends — not enough history yet",
      lines(
        "Trends need ≥2 recorded samples. `aih track --apply` records one — wire it into a",
        "commit / agent-stop hook (`aih bootstrap-ai --cli kiro` installs the Kiro hook) so",
        "history accumulates in `.aih/history.jsonl`.",
      ),
      { samples: rows.length },
    );
  }
  const body = lines(
    `Last ${rows.length} samples (oldest → newest):`,
    "",
    ...TRENDS.map(({ label, pick }) => {
      const v = rows.map(pick);
      const delta = (v[v.length - 1] ?? 0) - (v[0] ?? 0);
      return `  ${label.padEnd(13)}${sparkline(v)}  ${v[v.length - 1]} (${delta >= 0 ? "+" : ""}${delta})`;
    }),
  );
  const latest = rows[rows.length - 1];
  return digest(`Trends — ${rows.length} samples · adoption ${latest?.adoptionScore}/100`, body, {
    samples: rows.length,
    rows,
  });
}
