/**
 * v1 `--json` envelope schemas (slice 1, issue #123).
 *
 * These zod schemas pin the machine-readable output contract of `aih <cmd>
 * --json`: the success envelope is the serialized PlanResult from
 * src/internals/execute.ts (with `report` rendered via
 * VerificationReport.toJSON() and an optional `support` block added by
 * src/commands/run.ts); the error envelope is runCapability's catch path.
 *
 * Deliberately NON-strict everywhere: an ADDITIVE change (a new key at any
 * level) must stay legal under a minor — consumers are required to tolerate
 * unknown keys. A REMOVAL or RENAME of any key pinned here fails parsing and
 * is a breaking change: majors only — see STABILITY.md.
 */
import { z } from "zod";

/** One verification outcome — VerificationReport checks as serialized to JSON. */
export const CheckSchema = z.object({
  name: z.string(),
  verdict: z.enum(["pass", "fail", "skip"]),
  detail: z.string().optional(),
  /** Stable machine code (CheckCode) — set only on routable fail/skip emitters. */
  code: z.string().optional(),
  location: z.object({ uri: z.string(), startLine: z.number().optional() }).optional(),
  fingerprint: z.string().optional(),
});

/** VerificationReport.toJSON(): { ok, counts, checks }. */
export const ReportSchema = z.object({
  ok: z.boolean(),
  counts: z.object({ pass: z.number(), fail: z.number(), skip: z.number() }),
  checks: z.array(CheckSchema),
});

export const WriteSummarySchema = z.object({
  path: z.string(),
  describe: z.string(),
  merged: z.boolean(),
  effect: z.enum(["create", "overwrite", "merge", "unchanged", "kept"]),
});

export const RemoveSummarySchema = z.object({
  path: z.string(),
  describe: z.string(),
  effect: z.enum(["remove", "delete", "absent"]),
  to: z.string().optional(),
});

export const ExecSummarySchema = z.object({
  describe: z.string(),
  argv: z.array(z.string()),
  ran: z.boolean(),
  /** Present only after the exec actually ran (apply mode). */
  code: z.number().nullable().optional(),
  ok: z.boolean().optional(),
});

export const DigestSummarySchema = z.object({
  describe: z.string(),
  text: z.string(),
  /** Structured machine payload — capability-specific, so unknown by design. */
  data: z.unknown().optional(),
});

/**
 * The success envelope of every capability/read-only command under `--json`.
 * `report` appears only when verification ran; `support` only when the report
 * carries at least one check (ticket-ready escalation templates).
 */
export const PlanResultEnvelopeSchema = z.object({
  capability: z.string(),
  applied: z.boolean(),
  writes: z.array(WriteSummarySchema),
  docs: z.array(z.object({ describe: z.string(), path: z.string().optional() })),
  probes: z.array(z.object({ describe: z.string() })),
  execs: z.array(ExecSummarySchema),
  digests: z.array(DigestSummarySchema),
  backups: z.array(z.string()),
  removed: z.array(RemoveSummarySchema),
  report: ReportSchema.optional(),
  support: z.object({ findings: z.array(z.unknown()), templates: z.array(z.unknown()) }).optional(),
});

/** The error envelope: runCapability's catch path under `--json` (AihError et al.). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
