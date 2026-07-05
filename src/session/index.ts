import { createHash } from "node:crypto";
import { AihError } from "../errors.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { digest, plan, probe } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import {
  type Evidence,
  runVerificationPipeline,
  type Severity,
  type VerificationInput,
  type VerificationPass,
  type VerificationPipelineRun,
  type VerificationResult,
} from "../verification/index.js";
import { isWellFormedUtf16 } from "../verification/validation.js";

export const SESSION_GUARDRAIL_PASS_NAMES = [
  "session-input-bounds",
  "session-secret-detection",
  "session-dangerous-action",
] as const;

type SessionGuardrailPassName = (typeof SESSION_GUARDRAIL_PASS_NAMES)[number];

export interface SessionGuardInput {
  text: string;
  source?: string;
  maxChars?: number;
}

export interface SessionGuardOptions {
  projectRoot: string;
  timeoutMs?: number;
  maxEvidencePerPass?: number;
}

export interface SessionGuardReport extends VerificationPipelineRun {
  schemaVersion: 1;
  input: {
    source: string;
    sha256: string;
    originalChars: number;
    inspectedChars: number;
    truncated: boolean;
  };
}

interface NormalizedSessionGuardInput {
  text: string;
  source: string;
  sha256: string;
  originalChars: number;
  inspectedChars: number;
  truncated: boolean;
}

interface Finding {
  kind: string;
  index: number;
  offset: number;
}

const DEFAULT_SESSION_SOURCE = "session";
const DEFAULT_MAX_SESSION_CHARS = 20_000;
const HARD_MAX_SESSION_CHARS = 100_000;
const MAX_FINDINGS_PER_SESSION_PASS = 50;
const SESSION_CONTEXT_KEY = "sessionGuard";

const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: "env-secret",
    pattern:
      /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*["']?[^\s"']{8,}/gi,
  },
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gi,
  },
  {
    kind: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}\b/gi,
  },
  {
    kind: "api-token",
    pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/gi,
  },
];

const DANGEROUS_ACTION_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "git-reset-hard", pattern: /\bgit\s+reset\s+--hard\b/gi },
  {
    kind: "recursive-remove",
    pattern: /\brm\b(?=[^,\r\n;&|]*\s-(?:[A-Za-z]*r[A-Za-z]*|-recursive)\b)[^,\r\n;&|]*\s+\S+/gi,
  },
  {
    kind: "powershell-recursive-remove",
    pattern:
      /\bRemove-Item\b(?=[^,\r\n;&|]*\s-(?:Recurse|r)\b)(?=[^,\r\n;&|]*\s-(?:Force|f)\b)[^,\r\n;&|]*/gi,
  },
  {
    kind: "git-clean-force",
    pattern: /\bgit\s+clean\b(?=[^,\r\n;&|]*\s-(?:[A-Za-z]*[fdx][A-Za-z]*|-force)\b)[^,\r\n;&|]*/gi,
  },
  { kind: "world-writable", pattern: /\bchmod\s+-R\s+777\b/gi },
  {
    kind: "remote-pipe-shell",
    pattern:
      /\b(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)\b[^\r\n;&|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|powershell|pwsh|iex|invoke-expression)\b/gi,
  },
  {
    kind: "registry-publish",
    pattern: /\b(?:(?:npm|pnpm|yarn)\s+publish|gh\s+release\s+(?:create|upload))\b/gi,
  },
  { kind: "privileged-command", pattern: /\bsudo\s+(?:rm|chmod|chown|dd|mkfs|mount|umount)\b/gi },
];

function byOffset(a: Finding, b: Finding): number {
  const offset = a.offset - b.offset;
  if (offset !== 0) return offset;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function takeChars(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join("");
}

function isSafeSourceChar(char: string): boolean {
  const code = char.codePointAt(0);
  return (
    code !== undefined &&
    ((code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      char === "." ||
      char === "_" ||
      char === ":" ||
      char === "@" ||
      char === "/" ||
      char === "#" ||
      char === "-")
  );
}

function sanitizeField(value: string, fallback: string, maxLength = 160): string {
  let normalized = "";
  let pendingDash = false;
  for (const char of value.trim()) {
    if (isSafeSourceChar(char) && char !== "-") {
      if (pendingDash && normalized.length > 0) normalized += "-";
      normalized += char;
      pendingDash = false;
    } else {
      pendingDash = true;
    }
  }
  const base = normalized.length > 0 ? normalized : fallback;
  if (base.length <= maxLength) return base;
  return `${base.slice(0, maxLength - 13)}-${sha256Hex(base).slice(0, 12)}`;
}

function maxCharsFrom(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_SESSION_CHARS;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > HARD_MAX_SESSION_CHARS) {
    throw new AihError(
      `session guard max chars must be a positive integer <= ${HARD_MAX_SESSION_CHARS}`,
      "AIH_CONFIG",
    );
  }
  return parsed;
}

function normalizeSessionGuardInput(input: SessionGuardInput): NormalizedSessionGuardInput {
  if (typeof input.text !== "string") {
    throw new AihError("session guard text is required", "AIH_CONFIG");
  }
  if (!isWellFormedUtf16(input.text)) {
    throw new AihError("session guard text contains malformed UTF-16", "AIH_CONFIG");
  }
  const maxChars = maxCharsFrom(input.maxChars);
  const originalChars = charLength(input.text);
  const inspected = originalChars > maxChars ? takeChars(input.text, maxChars) : input.text;
  const inspectedChars = charLength(inspected);
  return {
    text: inspected,
    source: sanitizeField(input.source ?? DEFAULT_SESSION_SOURCE, DEFAULT_SESSION_SOURCE),
    sha256: sha256Hex(input.text),
    originalChars,
    inspectedChars,
    truncated: originalChars > inspectedChars,
  };
}

function readSessionGuardInput(input: VerificationInput): NormalizedSessionGuardInput | undefined {
  const value = input.context?.[SESSION_CONTEXT_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<NormalizedSessionGuardInput>;
  if (
    typeof record.text !== "string" ||
    typeof record.source !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.originalChars !== "number" ||
    typeof record.inspectedChars !== "number" ||
    typeof record.truncated !== "boolean"
  ) {
    return undefined;
  }
  return record as NormalizedSessionGuardInput;
}

function result(
  passName: SessionGuardrailPassName,
  verdict: VerificationResult["verdict"],
  severity: Severity,
  message: string,
  evidence: Evidence[] = [],
): VerificationResult {
  return {
    passName,
    verdict,
    severity,
    confidence: "high",
    evidence,
    message,
    category: passName === "session-dangerous-action" ? "exec" : "security",
  };
}

function missingInputResult(passName: SessionGuardrailPassName): VerificationResult {
  return result(passName, "fail", "high", "session guard input is missing or malformed");
}

function collectFindings(
  text: string,
  patterns: Array<{ kind: string; pattern: RegExp }>,
): Finding[] {
  const findings: Finding[] = [];
  for (const { kind, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ kind, index: findings.length, offset: match.index ?? 0 });
      if (findings.length >= MAX_FINDINGS_PER_SESSION_PASS) break;
    }
    if (findings.length >= MAX_FINDINGS_PER_SESSION_PASS) break;
  }
  return findings.sort(byOffset).map((finding, index) => ({ ...finding, index }));
}

function evidenceFor(
  passName: SessionGuardrailPassName,
  type: string,
  source: string,
  findings: readonly Finding[],
): Evidence[] {
  return findings.map((finding) => ({
    id: `${passName}:${finding.kind}:${finding.index}`,
    type,
    source: `${source}#${passName === "session-secret-detection" ? "secret" : "action"}[${finding.index}]`,
  }));
}

function sessionInputBoundsPass(): VerificationPass {
  return {
    name: "session-input-bounds",
    category: "security",
    async run(input) {
      const session = readSessionGuardInput(input);
      if (session === undefined) return missingInputResult("session-input-bounds");
      if (!session.truncated) {
        return result("session-input-bounds", "pass", "info", "session input inspected fully");
      }
      return result(
        "session-input-bounds",
        "fail",
        "high",
        "session input exceeded maxChars; only a bounded prefix was inspected",
        [
          {
            id: "session-input-bounds:truncated:0",
            type: "session-truncated",
            source: `${session.source}#truncated`,
          },
        ],
      );
    },
  };
}

function sessionSecretDetectionPass(): VerificationPass {
  return {
    name: "session-secret-detection",
    category: "security",
    async run(input) {
      const session = readSessionGuardInput(input);
      if (session === undefined) return missingInputResult("session-secret-detection");
      const findings = collectFindings(session.text, SECRET_PATTERNS);
      if (findings.length === 0) {
        return result(
          "session-secret-detection",
          "pass",
          "info",
          "no secret-like session text found",
        );
      }
      return result(
        "session-secret-detection",
        "fail",
        "critical",
        `${findings.length} secret-like session value(s) require redaction`,
        evidenceFor("session-secret-detection", "session-secret", session.source, findings),
      );
    },
  };
}

function sessionDangerousActionPass(): VerificationPass {
  return {
    name: "session-dangerous-action",
    category: "exec",
    async run(input) {
      const session = readSessionGuardInput(input);
      if (session === undefined) return missingInputResult("session-dangerous-action");
      const findings = collectFindings(session.text, DANGEROUS_ACTION_PATTERNS);
      if (findings.length === 0) {
        return result(
          "session-dangerous-action",
          "pass",
          "info",
          "no dangerous session actions found",
        );
      }
      return result(
        "session-dangerous-action",
        "fail",
        "high",
        `${findings.length} dangerous session action(s) require explicit human review`,
        evidenceFor("session-dangerous-action", "session-action", session.source, findings),
      );
    },
  };
}

export function createSessionGuardrailPasses(): VerificationPass[] {
  return [sessionInputBoundsPass(), sessionSecretDetectionPass(), sessionDangerousActionPass()];
}

export async function runSessionGuardrails(
  input: SessionGuardInput,
  options: SessionGuardOptions,
): Promise<SessionGuardReport> {
  const session = normalizeSessionGuardInput(input);
  const run = await runVerificationPipeline(
    {
      projectRoot: options.projectRoot,
      context: { [SESSION_CONTEXT_KEY]: session },
    },
    {
      passes: createSessionGuardrailPasses(),
      timeoutMs: options.timeoutMs,
      maxEvidencePerPass: options.maxEvidencePerPass,
    },
  );
  return {
    schemaVersion: 1,
    input: {
      source: session.source,
      sha256: session.sha256,
      originalChars: session.originalChars,
      inspectedChars: session.inspectedChars,
      truncated: session.truncated,
    },
    ...run,
  };
}

function textFromOptions(ctx: PlanContext): string {
  const text = ctx.options.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new AihError("session-guard requires --text <text>", "AIH_CONFIG");
  }
  return text;
}

function sourceFromOptions(ctx: PlanContext): string {
  const source = ctx.options.source;
  return typeof source === "string" ? source : DEFAULT_SESSION_SOURCE;
}

function maxCharsOption(ctx: PlanContext): number | undefined {
  const maxChars = ctx.options.maxChars;
  if (maxChars === undefined) return undefined;
  return maxCharsFrom(maxChars);
}

function reportText(report: SessionGuardReport): string {
  const findings = report.summary.aggregatedEvidence.length;
  return lines(
    `verdict: ${report.summary.finalVerdict}`,
    `trust score: ${report.summary.trustScore}`,
    `input: ${report.input.source} (${report.input.inspectedChars}/${report.input.originalChars} chars${report.input.truncated ? ", truncated" : ""})`,
    `findings: ${findings}`,
    ...report.results.map(
      (entry) => `  - ${entry.passName}: ${entry.verdict} (${entry.severity}) — ${entry.message}`,
    ),
  );
}

function checkFromReport(report: SessionGuardReport): Check {
  const failed = report.results.filter((entry) => entry.verdict === "fail");
  return {
    name: "session guardrails",
    verdict: failed.length > 0 ? "fail" : "pass",
    detail:
      failed.length > 0
        ? failed.map((entry) => `${entry.passName}: ${entry.message}`).join("; ")
        : "no session guardrail findings",
  };
}

async function sessionGuardPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const report = await runSessionGuardrails(
    {
      text: textFromOptions(ctx),
      source: sourceFromOptions(ctx),
      maxChars: maxCharsOption(ctx),
    },
    { projectRoot: ctx.root },
  );
  return plan(
    "session-guard",
    digest("session guardrails", reportText(report), report),
    probe("session guardrails", () => checkFromReport(report)),
  );
}

export const command: CommandSpec = {
  name: "session-guard",
  summary: "Inspect session text for secrets and dangerous local actions",
  readOnly: true,
  options: [
    { flags: "--text <text>", description: "session or action text to inspect", sensitive: true },
    { flags: "--source <label>", description: "source label for evidence", default: "session" },
    {
      flags: "--max-chars <n>",
      description: `maximum session characters to inspect (default ${DEFAULT_MAX_SESSION_CHARS})`,
    },
  ],
  plan: sessionGuardPlan,
};
