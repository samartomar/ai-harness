/**
 * Integration glue between a verification run and the support templates: take the
 * run's checks + environment facts + SETUP.md text, redact, and produce the
 * rendered {@link SupportTemplate}s plus a terminal summary.
 *
 * Kept pure (no I/O, no clock): the caller reads SETUP.md and supplies `runId` /
 * `timestamp`, so this is fully testable and deterministic. Redaction runs HERE
 * (defence in depth) over the command and every live detail, regardless of what
 * the caller already scrubbed.
 */

import type { Check } from "../internals/verify.js";
import { findingsFrom, type SupportFinding } from "./findings.js";
import { redactText } from "./redact.js";
import { renderTemplate, type SupportTemplate } from "./render.js";
import { parseSupportGuidance } from "./setup.js";
import { isExternalFinding, isToolNeutral, type SupportContext } from "./templates.js";

export interface SupportInputs {
  capability: string;
  checks: readonly Check[];
  projectName: string;
  root: string;
  command: string;
  contextDir: string;
  targets: string;
  platform: string;
  runId: string;
  timestamp: string;
  /** Raw SETUP.md (or similar) contents, if a setup file was found. */
  setupText?: string;
  /** For home-dir scrubbing. */
  env: NodeJS.ProcessEnv;
}

export interface SupportBundle {
  findings: SupportFinding[];
  templates: SupportTemplate[];
  /** SETUP.md corporate-language instruction, surfaced as a terminal note (not in tickets). */
  corporateGuidance?: string;
}

function neutralizeToolText(text: string): string {
  return text
    .replace(/\bAI Harness\b/gi, "the setup check")
    .replace(/\bai-harness\b/gi, "the setup check")
    .replace(/\baih(?:\s+[A-Za-z0-9._:/=@+-]+)*/gi, "the setup check");
}

function neutralProjectName(name: string): string {
  return isToolNeutral(name) ? name : "this project";
}

function neutralizeExternalFinding(finding: SupportFinding): SupportFinding {
  if (!isExternalFinding(finding)) return finding;
  return {
    ...finding,
    title: neutralizeToolText(finding.title),
    recommendedAction: neutralizeToolText(finding.recommendedAction),
    details: finding.details.map(neutralizeToolText),
    evidence: finding.evidence === undefined ? undefined : neutralizeToolText(finding.evidence),
    affectedArea:
      finding.affectedArea === undefined ? undefined : neutralizeToolText(finding.affectedArea),
    acceptance: finding.acceptance?.map(neutralizeToolText),
  };
}

function renderCheckedTemplate(finding: SupportFinding, ctx: SupportContext): SupportTemplate {
  const template = renderTemplate(finding, ctx);
  if (
    isExternalFinding(finding) &&
    (!isToolNeutral(template.subject) || !isToolNeutral(template.body))
  ) {
    throw new Error(`external support template is not tool-neutral for ${finding.code}`);
  }
  return template;
}

/** Build redacted, rendered support templates from a verification run. */
export function buildSupport(input: SupportInputs): SupportBundle {
  const guidance = input.setupText ? parseSupportGuidance(input.setupText) : {};
  const projectContext =
    guidance.projectContext === undefined
      ? undefined
      : neutralizeToolText(redactText(guidance.projectContext, input.env));
  const routing =
    guidance.routing === undefined
      ? undefined
      : neutralizeToolText(redactText(guidance.routing, input.env));
  const corporateGuidance =
    guidance.corporateGuidance === undefined
      ? undefined
      : neutralizeToolText(redactText(guidance.corporateGuidance, input.env));
  const ctx: SupportContext = {
    projectName: neutralProjectName(input.projectName),
    root: redactText(input.root, input.env),
    command: redactText(input.command, input.env),
    contextDir: input.contextDir,
    targets: input.targets,
    platform: input.platform,
    runId: input.runId,
    timestamp: input.timestamp,
    projectContext,
    routing,
    corporateGuidance,
  };
  const checks = input.checks.map((c) =>
    c.detail ? { ...c, detail: redactText(c.detail, input.env) } : c,
  );
  const findings = findingsFrom(checks, input.capability).map(neutralizeExternalFinding);
  return {
    findings,
    templates: findings.map((f) => renderCheckedTemplate(f, ctx)),
    corporateGuidance,
  };
}

/**
 * The terminal section: one `[copy] …` line per template, the saved path when
 * files were written, and the SETUP.md corporate-language note when present.
 * Empty string when there are no templates (nothing to print).
 */
export function supportSummary(bundle: SupportBundle, saved?: Record<string, string>): string {
  if (bundle.templates.length === 0) return "";
  const out: string[] = ["", "Support templates:"];
  for (const t of bundle.templates) {
    out.push(`  ${t.copyLabel}`);
    const path = saved?.[t.code];
    if (path) out.push(`    saved: ${path}`);
  }
  if (bundle.corporateGuidance) {
    out.push("", `  Note: SETUP.md asks to adapt outgoing messages — ${bundle.corporateGuidance}`);
  }
  if (saved === undefined) {
    out.push("", "  Re-run with --support-out <dir> to save the full tickets.");
  }
  return `${out.join("\n")}\n`;
}
