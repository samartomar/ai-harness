/**
 * The append-only RUN LEDGER — one row per `aih` invocation in
 * `.aih/runs/YYYY-MM.jsonl`. This is the "what happened" half of the
 * Supportability Pack, distinct from `.aih/history.jsonl` (PR2 of the report
 * trends), which is a deterministic, byte-stable metrics snapshot PER COMMIT.
 *
 * The ledger is the OPPOSITE: wall-clock, non-deterministic, append-only, and
 * written OUTSIDE the plan's `FsTransaction` (no idempotency, no `.aih.bak`). It
 * is local diagnostics — `.aih/` is gitignored — so it never touches the managed
 * project surface and never needs `--apply`.
 *
 * Trust model: log only once a repo is initialised (a committed `.aih-config.json`
 * marker exists), and never when the operator opts out (`--no-log` / `AIH_LOG=0`).
 * Writing must NEVER fail the command — {@link appendRunLog} swallows its own I/O
 * errors. Entry assembly ({@link buildRunEntry}) is separated from the append; raw
 * ledger files are local diagnostics, while tamper evidence/integrity comes from
 * packaging them with `aih evidence build`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readAihConfig } from "../config/marker.js";
import type { PlanResult, WriteSummary } from "../internals/execute.js";
import { readIfExists } from "../internals/fsxn.js";
import type { Verdict } from "../internals/verify.js";

export const RUNS_DIR = join(".aih", "runs");

/** How the run ended, mapped from the exit signals (see {@link statusFor}). */
export type RunStatus = "success" | "failed" | "partial" | "error";

/** Tally of plan write effects (mirrors {@link WriteSummary.effect}). */
export interface WriteTally {
  create: number;
  overwrite: number;
  merge: number;
  unchanged: number;
  kept: number;
}

export interface RunLogEntry {
  schemaVersion: 2;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  capability: string;
  /** The invoking argv, redacted by the caller. */
  argv: string[];
  status: RunStatus;
  exitCode: number;
  mode: { apply: boolean; verify: boolean; json: boolean; sarif: boolean };
  platform: string;
  node: string;
  host: { platform: string; hostnameHash: string };
  repo: { remoteHash: string };
  writes: WriteTally;
  docs: number;
  execs: number;
  digests: number;
  backups: number;
  /** Verification counts, when probes ran. */
  verification?: Record<Verdict, number>;
  /** Support-template counts, when a verification report produced findings. */
  support?: { findings: number; templates: number };
}

/**
 * Map the run's exit signals to a status. `error` is a thrown exception (set by
 * the caller); otherwise: a failed probe → `failed`; a failed exec with probes
 * clean → `partial`; else `success`. Mirrors runCapability's exit-code logic.
 */
export function statusFor(verifyFailed: boolean, execFailed: boolean): RunStatus {
  if (verifyFailed) return "failed";
  if (execFailed) return "partial";
  return "success";
}

function tallyWrites(writes: readonly WriteSummary[]): WriteTally {
  const t: WriteTally = { create: 0, overwrite: 0, merge: 0, unchanged: 0, kept: 0 };
  for (const w of writes) t[w.effect] += 1;
  return t;
}

export interface RunEntryInput {
  runId: string;
  startedAt: string;
  finishedAt: string;
  capability: string;
  argv: string[];
  status: RunStatus;
  exitCode: number;
  mode: { apply: boolean; verify: boolean; json: boolean; sarif: boolean };
  platform: string;
  node: string;
  root?: string;
  /** The plan result, when one was produced (absent on a thrown error). */
  result?: PlanResult;
  support?: { findings: number; templates: number };
}

function stableHash(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function repoIdentity(root: string | undefined): string {
  if (root === undefined) return stableHash("repo", "unknown");
  const config = readIfExists(join(root, ".git", "config"));
  const remote = config?.match(/^\s*url\s*=\s*(.+)\s*$/m)?.[1]?.trim();
  return stableHash("repo", remote && remote.length > 0 ? remote : "unknown");
}

/** Assemble a {@link RunLogEntry} from a run's inputs. No clock; repo identity is hashed. */
export function buildRunEntry(input: RunEntryInput): RunLogEntry {
  const { result } = input;
  return {
    schemaVersion: 2,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(
      0,
      new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime(),
    ),
    capability: input.capability,
    argv: input.argv,
    status: input.status,
    exitCode: input.exitCode,
    mode: input.mode,
    platform: input.platform,
    node: input.node,
    host: {
      platform: input.platform,
      hostnameHash: stableHash("host", hostname()),
    },
    repo: {
      remoteHash: repoIdentity(input.root),
    },
    writes: tallyWrites(result?.writes ?? []),
    docs: result?.docs.length ?? 0,
    execs: result?.execs.length ?? 0,
    digests: result?.digests.length ?? 0,
    backups: result?.backups.length ?? 0,
    verification: result?.report ? result.report.counts() : undefined,
    support: input.support,
  };
}

/**
 * Is run logging enabled for this root? Only after the repo is initialised (a
 * committed `.aih-config.json` marker), and never when opted out via `--no-log`
 * or `AIH_LOG=0`. No CI special-case — a CI job that wants silence sets `AIH_LOG=0`.
 */
export function isLoggingEnabled(
  root: string,
  env: NodeJS.ProcessEnv,
  opts: { noLog?: boolean },
): boolean {
  if (opts.noLog === true || env.AIH_LOG === "0") return false;
  return readAihConfig(root) !== undefined;
}

/** Month-sharded ledger filename for `date` (UTC), e.g. `2026-06.jsonl`. */
export function monthFile(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}.jsonl`;
}

/**
 * Append one entry to `.aih/runs/YYYY-MM.jsonl` under `root`. Pure append (no
 * read, no dedup), outside any transaction. Swallows all I/O errors — a logging
 * failure must never change the command's outcome.
 */
export function appendRunLog(root: string, entry: RunLogEntry, date: Date): void {
  try {
    const dir = join(root, RUNS_DIR);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, monthFile(date)), `${JSON.stringify(entry)}\n`);
  } catch {
    // Local diagnostics only — never surface a logging failure to the user.
  }
}
