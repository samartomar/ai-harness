/**
 * Assemble copy-ready {@link SupportTemplate}s from a verification run: map its
 * checks to {@link SupportFinding}s (one per code), then render each into a
 * subject + body + a terminal copy label, picking the register from the finding's
 * `kind`. Pure and deterministic — the only seam is {@link SupportContext}, which
 * the caller fills (and redacts) at integration time.
 */

import type { Check, CheckCode } from "../internals/verify.js";
import {
  type Audience,
  findingsFrom,
  type Severity,
  type SupportFinding,
  type TemplateKind,
} from "./findings.js";
import { escalationBody, improvementBody, type SupportContext, selfFixBody } from "./templates.js";

export interface SupportTemplate {
  /** Stable id `${kind}:${code}` — one template per code per run. */
  id: string;
  code: CheckCode;
  kind: TemplateKind;
  audience: Audience;
  severity: Severity;
  subject: string;
  body: string;
  /** Short label for the terminal "[copy] …" affordance. */
  copyLabel: string;
}

const AUDIENCE_LABEL: Record<Audience, string> = {
  "internal-it": "Internal IT",
  "dev-platform": "Dev platform",
  security: "Security",
  developer: "Developer",
};

function subjectFor(finding: SupportFinding, ctx: SupportContext): string {
  if (finding.kind === "escalation")
    return `[AI Harness] ${finding.severity} — ${finding.title} (${ctx.projectName})`;
  if (finding.kind === "improvement")
    return `[AI Harness] improvement — ${finding.title} (${ctx.projectName})`;
  return `aih: ${finding.title}`;
}

function copyLabelFor(finding: SupportFinding): string {
  if (finding.kind === "escalation")
    return `[copy] ${AUDIENCE_LABEL[finding.audience]} escalation — ${finding.title}`;
  if (finding.kind === "improvement") return `[copy] Improvement request — ${finding.title}`;
  return `Self-fix — ${finding.title}`;
}

function bodyFor(finding: SupportFinding, ctx: SupportContext): string {
  if (finding.kind === "escalation") return escalationBody(finding, ctx);
  if (finding.kind === "improvement") return improvementBody(finding, ctx);
  return selfFixBody(finding, ctx);
}

/** Render a single finding into a template. */
export function renderTemplate(finding: SupportFinding, ctx: SupportContext): SupportTemplate {
  return {
    id: `${finding.kind}:${finding.code}`,
    code: finding.code,
    kind: finding.kind,
    audience: finding.audience,
    severity: finding.severity,
    subject: subjectFor(finding, ctx),
    body: bodyFor(finding, ctx),
    copyLabel: copyLabelFor(finding),
  };
}

/**
 * The full pipeline for a capability's verification: checks → findings (deduped,
 * most-urgent-first) → rendered templates, preserving that order.
 */
export function supportTemplates(
  checks: readonly Check[],
  capability: string,
  ctx: SupportContext,
): SupportTemplate[] {
  return findingsFrom(checks, capability).map((finding) => renderTemplate(finding, ctx));
}
