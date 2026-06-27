/**
 * Copy-ready bodies for support findings. Three registers, picked by
 * {@link SupportFinding.kind}: an IT/security/dev-platform escalation ticket, a
 * lighter improvement request, and a terse developer self-fix note.
 *
 * Same discipline as the other capability templates: pure functions over
 * {@link lines}/{@link indent}, exact and paste-ready, NO wall-clock — the run's
 * `runId`/`timestamp` arrive via {@link SupportContext} so output is deterministic
 * for golden tests.
 *
 * CONTRACT: every {@link SupportContext} string and every `finding.details` entry
 * MUST be pre-redacted by the caller (home-dir scrub, key-aware argv masking).
 * These bodies are meant to be pasted into a ticket, so a secret or a local path
 * that reaches here is exposed. Redaction lands with the `runCapability`
 * integration; this layer renders what it is given.
 */

import { lines } from "../internals/render.js";
import type { SupportFinding } from "./findings.js";

/** Per-run facts woven into every template. All strings are caller-redacted. */
export interface SupportContext {
  projectName: string;
  /** Workspace path — home-dir already scrubbed by the caller. */
  root: string;
  /** The command that surfaced the finding, e.g. "aih heal --verify". */
  command: string;
  contextDir: string;
  /** Target AI CLIs, comma-joined (or "none"). */
  targets: string;
  platform: string;
  runId: string;
  /** ISO timestamp, supplied by the caller (never read from the clock here). */
  timestamp: string;
}

/** A left-aligned `label  value` block with stable column width. */
function contextBlock(rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
}

/** Render the live `details` as bullets, or a placeholder when there are none. */
function bullets(details: string[]): string[] {
  return details.length > 0 ? details.map((d) => `  - ${d}`) : ["  - (no further detail)"];
}

/** Level 1 — IT / security / dev-platform escalation ticket. */
export function escalationBody(finding: SupportFinding, ctx: SupportContext): string {
  const impact = finding.severity === "blocking" ? "blocking" : "degrading";
  return lines(
    "Hello,",
    "",
    `I need help with an AI Harness (aih) setup issue that is ${impact}`,
    "AI-assisted development on this project.",
    "",
    "Project context",
    contextBlock([
      ["Repository:", ctx.projectName],
      ["Workspace path:", ctx.root],
      ["Command run:", ctx.command],
      ["Context dir:", ctx.contextDir],
      ["Target AI CLIs:", ctx.targets],
      ["Platform:", ctx.platform],
      ["Run ID:", ctx.runId],
      ["Time:", ctx.timestamp],
    ]),
    "",
    "What failed",
    `  ${finding.title}`,
    bullets(finding.details),
    "",
    "Why this matters",
    "  aih bootstraps governed, proxy-safe AI coding — context loading, verification, and",
    "  enterprise configuration. Until this is resolved the workflow may miss project",
    "  guardrails, fail to load required context, or be blocked by the local/corporate",
    "  environment.",
    "",
    "What aih already checked",
    `  This was surfaced by \`${ctx.command}\` (read-only diagnostics) — the failure persists`,
    "  after the harness's own automatic remediation.",
    "",
    "Requested help",
    `  ${finding.recommendedAction}`,
    "",
    "Thank you.",
  );
}

/** Level 2 — quality-of-life improvement request (not an outage). */
export function improvementBody(finding: SupportFinding, ctx: SupportContext): string {
  return lines(
    "Hello,",
    "",
    "I'd like to improve the AI Harness (aih) setup for this project. This is not an outage —",
    "enabling it would improve consistency, speed, and alignment with our security and",
    "governance expectations.",
    "",
    "Project context",
    contextBlock([
      ["Repository:", ctx.projectName],
      ["Target AI CLIs:", ctx.targets],
      ["Platform:", ctx.platform],
      ["Run ID:", ctx.runId],
      ["Time:", ctx.timestamp],
    ]),
    "",
    "Current gap",
    `  ${finding.title}`,
    bullets(finding.details),
    "",
    "Requested help",
    `  ${finding.recommendedAction}`,
    "",
    "Thank you.",
  );
}

/** Developer self-fix note — terse, runnable, not addressed to anyone. */
export function selfFixBody(finding: SupportFinding, ctx: SupportContext): string {
  return lines(
    finding.title,
    bullets(finding.details),
    "",
    `Fix: ${finding.recommendedAction}`,
    `Surfaced by \`${ctx.command}\`.`,
  );
}
