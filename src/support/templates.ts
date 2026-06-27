/**
 * Copy-ready bodies for support findings. Three registers, picked by
 * {@link SupportFinding.kind}:
 *
 *   - escalation / improvement → EXTERNAL, sent to IT / security / a platform
 *     team. These are TOOL-NEUTRAL by contract: they never name this harness or
 *     its commands. They frame a project / development-environment configuration
 *     problem the recipient must fix at the system level — not a tool to approve.
 *   - self-fix → INTERNAL developer note; may reference harness commands.
 *
 * Same discipline as the other capability templates: pure functions over
 * {@link lines}, exact and paste-ready, NO wall-clock — the run's
 * `runId`/`timestamp` arrive via {@link SupportContext} so output is deterministic.
 *
 * CONTRACT: every {@link SupportContext} string and every `finding.details` entry
 * MUST be pre-redacted by the caller (home-dir scrub, key-aware argv masking) —
 * these bodies are pasted into tickets. Redaction lands with the integration step;
 * this layer renders what it is given.
 */

import { lines } from "../internals/render.js";
import { isExternal, type SupportFinding } from "./findings.js";

/** Per-run facts woven into every template. All strings are caller-redacted. */
export interface SupportContext {
  projectName: string;
  /** Workspace path — home-dir already scrubbed by the caller. */
  root: string;
  /** The command that surfaced the finding (self-fix note only; never external). */
  command: string;
  contextDir: string;
  /** Target AI CLIs, comma-joined (or "none"). */
  targets: string;
  platform: string;
  /** Opaque correlation id, rendered as "Reference" (no tool name implied). */
  runId: string;
  /** ISO timestamp, supplied by the caller (never read from the clock here). */
  timestamp: string;
  /**
   * Why a correct environment matters for THIS project — sourced from SETUP.md
   * (see `parseSupportGuidance`). Falls back to a generic line when absent.
   */
  projectContext?: string;
  /**
   * A project instruction telling an agent/author to adapt the email to the
   * organisation's corporate language — sourced from SETUP.md. Rendered as a
   * clearly-marked "adapt before sending" footer, never as part of the message.
   */
  corporateGuidance?: string;
}

/** Default "why this matters" when SETUP.md offers no project-specific context. */
const DEFAULT_PROJECT_CONTEXT =
  "A correctly configured development environment is required for this project so the team can install approved dependencies, build reproducibly, and work within the organisation's security and governance controls.";

/** A left-aligned `label  value` block with stable column width. */
function contextBlock(rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
}

/** Render the live `details` as bullets, or a placeholder when there are none. */
function bullets(details: string[]): string[] {
  return details.length > 0 ? details.map((d) => `  - ${d}`) : ["  - (no further detail)"];
}

/**
 * "Adapt before sending" footer carrying the project's corporate-language
 * instruction — present only when SETUP.md provided one. Clearly fenced so the
 * author strips it before the message goes out.
 */
function adaptationFooter(ctx: SupportContext): string[] {
  if (!ctx.corporateGuidance) return [];
  return [
    "",
    "— adapt before sending (remove this section) —",
    "  Rewrite the message above in this organisation's standard support language:",
    `  ${ctx.corporateGuidance}`,
  ];
}

/** Level 1 — EXTERNAL escalation: a blocking/degrading environment setup issue. */
export function escalationBody(finding: SupportFinding, ctx: SupportContext): string {
  const impact = finding.severity === "blocking" ? "blocking" : "degrading";
  return lines(
    "Hello,",
    "",
    `The development environment for this project has a configuration issue on this machine`,
    `that is currently ${impact} development work. Resolving it requires a change to the`,
    "system or environment configuration, not to the project's own code.",
    "",
    "Project / environment",
    contextBlock([
      ["Project:", ctx.projectName],
      ["Machine:", ctx.platform],
      ["Reference:", ctx.runId],
      ["Date:", ctx.timestamp],
    ]),
    "",
    "Issue",
    `  ${finding.title}`,
    bullets(finding.details),
    "",
    "Why this matters for this project",
    `  ${ctx.projectContext ?? DEFAULT_PROJECT_CONTEXT}`,
    "",
    "What is needed",
    `  ${finding.recommendedAction}`,
    "",
    "Thank you.",
    ...adaptationFooter(ctx),
  );
}

/** Level 2 — EXTERNAL improvement request (not blocking today). */
export function improvementBody(finding: SupportFinding, ctx: SupportContext): string {
  return lines(
    "Hello,",
    "",
    "I'd like to request a development-environment improvement for this project. This is not",
    "blocking work today, but enabling it would improve consistency and keep the project",
    "aligned with our security and governance expectations.",
    "",
    "Project / environment",
    contextBlock([
      ["Project:", ctx.projectName],
      ["Machine:", ctx.platform],
      ["Reference:", ctx.runId],
      ["Date:", ctx.timestamp],
    ]),
    "",
    "Requested improvement",
    `  ${finding.title}`,
    bullets(finding.details),
    "",
    "Why this matters for this project",
    `  ${ctx.projectContext ?? DEFAULT_PROJECT_CONTEXT}`,
    "",
    "What is needed",
    `  ${finding.recommendedAction}`,
    "",
    "Thank you.",
    ...adaptationFooter(ctx),
  );
}

/** INTERNAL developer self-fix note — terse, runnable, may name harness commands. */
export function selfFixBody(finding: SupportFinding, ctx: SupportContext): string {
  return lines(
    finding.title,
    bullets(finding.details),
    "",
    `Fix: ${finding.recommendedAction}`,
    `Detected by \`${ctx.command}\`.`,
  );
}

/**
 * Guard for the tool-neutrality contract: an EXTERNAL finding's rendered body must
 * never name the harness. Exposed so the integration layer (and tests) can assert
 * it before anything is written. Returns true when `body` is safe to send.
 */
export function isToolNeutral(body: string): boolean {
  return !/\baih\b|AI Harness/i.test(body);
}

/** Which findings render as tool-neutral external messages (vs internal self-fix). */
export function isExternalFinding(finding: SupportFinding): boolean {
  return isExternal(finding.audience);
}
