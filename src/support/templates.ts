/**
 * Ticket-ready bodies for support findings, in the structure: Summary → Impact →
 * Issue → Observed evidence → Environment → Requested fix → Acceptance criteria.
 *
 *   - escalation / improvement → EXTERNAL, sent to IT / security / a platform
 *     team. TOOL-NEUTRAL by contract: never name this harness or its commands.
 *     They describe the failed INTERNAL configuration the recipient must fix at
 *     the system level — not a tool to approve. Evidence / affected-area /
 *     acceptance are canned per code (no guessed free text); the live detail
 *     rides along as supporting evidence.
 *   - self-fix → INTERNAL developer note; may reference harness commands.
 *
 * Pure functions over {@link lines}; NO wall-clock — `runId`/`timestamp` arrive
 * via {@link SupportContext} so output is deterministic.
 *
 * CONTRACT: every {@link SupportContext} string and every `finding.details` entry
 * MUST be pre-redacted by the caller (home-dir scrub, key-aware argv masking).
 */

import { lines } from "../internals/render.js";
import { isExternal, type SupportFinding } from "./findings.js";

/** Per-run facts woven into every template. All strings are caller-redacted. */
export interface SupportContext {
  projectName: string;
  /** Workspace path — self-fix note only; never rendered in an external ticket. */
  root: string;
  /** The command that surfaced the finding — self-fix note only. */
  command: string;
  contextDir: string;
  /** Target AI CLIs, comma-joined — self-fix note only. */
  targets: string;
  platform: string;
  /** Opaque correlation id, rendered as "Reference" (no tool name implied). */
  runId: string;
  /** ISO timestamp, supplied by the caller (never read from the clock here). */
  timestamp: string;
  /** Why a correct environment matters for THIS project — from SETUP.md, optional. */
  projectContext?: string;
  /**
   * Real routing metadata (assignment group, ticket prefix, …) IF the project's
   * setup files provide it. Rendered verbatim in the Environment block. NEVER
   * invented — absent means absent.
   */
  routing?: string;
  /**
   * SETUP.md instruction to adapt the message to corporate language. Surfaced by
   * the integration layer as a terminal note to the author, NOT embedded in the
   * ticket body (which stays clean and ready to paste).
   */
  corporateGuidance?: string;
}

/** Default "why this matters" when SETUP.md offers no project-specific context. */
const DEFAULT_PROJECT_CONTEXT =
  "A correctly configured development environment is required for this project so the team can install approved dependencies, build reproducibly, and work within the organisation's security and governance controls.";

/** Acceptance fallback when a code has no canned criteria. */
const DEFAULT_ACCEPTANCE = [
  "The failing development setup check passes on this machine.",
  "No project code changes are required.",
];

/** The work-around guard appended to every escalation. */
const SECURITY_FOOTER =
  "Security controls should remain enabled. Please do not work around this by disabling TLS verification, bypassing certificate validation, weakening secret controls, or changing project code.";

/** Wrap content lines in a ```text fence for ticket-ready monospace blocks. */
function fence(content: string[]): string[] {
  return ["```text", ...content, "```"];
}

/** Canned evidence (split to lines) followed by the live detail(s). */
function evidenceLines(finding: SupportFinding): string[] {
  const out: string[] = [];
  if (finding.evidence) out.push(...finding.evidence.split("\n"));
  out.push(...finding.details);
  return out.length > 0 ? out : ["(no further detail captured)"];
}

/** The Environment block: aligned `label  value` rows, routing only if provided. */
function environment(finding: SupportFinding, ctx: SupportContext): string[] {
  const rows: Array<[string, string]> = [
    ["Project:", ctx.projectName],
    ["Machine / OS:", ctx.platform],
    ["Reference:", ctx.runId],
    ["Date:", ctx.timestamp],
    ["Affected area:", finding.affectedArea ?? "development environment configuration"],
  ];
  if (ctx.routing) rows.push(["Routing:", ctx.routing]);
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `${label.padEnd(width)}${value}`);
}

/** EXTERNAL escalation — a failing internal-configuration check (Summary → … → Acceptance). */
export function escalationBody(finding: SupportFinding, ctx: SupportContext): string {
  const blocking = finding.severity === "blocking";
  const impactLine = blocking
    ? `This is currently blocking development work for \`${ctx.projectName}\`.`
    : `This is currently degrading the development setup for \`${ctx.projectName}\`.`;
  return lines(
    "Hello,",
    "",
    `A required development setup check for \`${ctx.projectName}\` is failing on this machine. The`,
    "issue appears to be caused by internal environment configuration, not by the project code.",
    "",
    "Impact",
    impactLine,
    ctx.projectContext ?? DEFAULT_PROJECT_CONTEXT,
    "",
    "Issue",
    finding.title,
    "",
    "Observed evidence",
    "",
    ...fence(evidenceLines(finding)),
    "",
    "Environment",
    "",
    ...fence(environment(finding, ctx)),
    "",
    "Requested fix",
    finding.recommendedAction,
    "",
    "Acceptance criteria",
    "",
    ...fence(finding.acceptance ?? DEFAULT_ACCEPTANCE),
    "",
    SECURITY_FOOTER,
    "",
    "Thank you.",
  );
}

/** EXTERNAL improvement — a non-blocking configuration gap. */
export function improvementBody(finding: SupportFinding, ctx: SupportContext): string {
  return lines(
    "Hello,",
    "",
    `A project setup check found a configuration gap for \`${ctx.projectName}\`. This is not`,
    "currently blocking development, but resolving it would make the local workflow more",
    "consistent and reduce manual setup.",
    "",
    "Why this helps",
    ctx.projectContext ?? DEFAULT_PROJECT_CONTEXT,
    "",
    "Configuration gap",
    finding.title,
    "",
    "Observed evidence",
    "",
    ...fence(evidenceLines(finding)),
    "",
    "Environment",
    "",
    ...fence(environment(finding, ctx)),
    "",
    "Requested configuration",
    finding.recommendedAction,
    "",
    "Expected result",
    "",
    ...fence(finding.acceptance ?? DEFAULT_ACCEPTANCE),
    "",
    "Thank you.",
  );
}

/** INTERNAL developer self-fix note — terse, runnable, may name harness commands. */
export function selfFixBody(finding: SupportFinding, ctx: SupportContext): string {
  return lines(
    finding.title,
    finding.details.length > 0
      ? finding.details.map((d) => `  - ${d}`)
      : ["  - (no further detail)"],
    "",
    `Fix: ${finding.recommendedAction}`,
    `Detected by \`${ctx.command}\`.`,
  );
}

/**
 * Guard for the tool-neutrality contract: an EXTERNAL body/subject must never name
 * the harness. Exposed so the integration layer (and tests) can assert it before
 * anything is written. Returns true when `text` is safe to send externally.
 */
export function isToolNeutral(text: string): boolean {
  return !/\baih\b|\bai-harness\b|AI Harness/i.test(text);
}

/** Which findings render as tool-neutral external messages (vs internal self-fix). */
export function isExternalFinding(finding: SupportFinding): boolean {
  return isExternal(finding.audience);
}
