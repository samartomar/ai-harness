import { createHash } from "node:crypto";
import type { Check, CheckCode } from "../internals/verify.js";
import type { LintFinding, LintRule, LintRuleCtx } from "../lint/rules.js";

type TrustLintCode = Extract<CheckCode, "trust.hidden-unicode" | "trust.prompt-injection">;

export interface TrustLintFinding extends LintFinding {
  code: TrustLintCode;
  line: number;
  fingerprint: string;
}

interface PatternRule {
  id: string;
  message: string;
  pattern: RegExp;
}

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const BIDI_CONTROLS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const PROMPT_INJECTION_PATTERNS: readonly PatternRule[] = [
  {
    id: "prompt-injection.important-tag",
    message: "instruction-looking tag paired with override or exfiltration language",
    pattern:
      /<\s*(?:important|system|developer|instruction|instructions)\b[\s\S]{0,300}?(?:ignore|disregard|override|secret|token|exfiltrat|send|upload|https?:\/\/)/gim,
  },
  {
    id: "prompt-injection.ignore-instructions",
    message: "attempts to override prior/system instructions",
    pattern:
      /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|above|earlier|system|developer)\s+instructions?\b/gim,
  },
  {
    id: "prompt-injection.secret-exfil",
    message: "secret exfiltration language paired with a credential or URL",
    pattern:
      /\b(?:exfiltrate|leak|steal|send|upload|post)\b[\s\S]{0,180}\b(?:api[_-]?key|token|secret|password|credential|https?:\/\/)/gim,
  },
];

function safeUri(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return "untrusted-document";
  }
  return normalized;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function lineTextAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end);
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(code: TrustLintCode, path: string, line: number, content: string): string {
  return `${code.replace(/\./g, "-")}:${path}:${line}:${contentHash(content).slice(0, 8)}`;
}

function finding(
  code: TrustLintCode,
  ruleId: string,
  path: string,
  source: string,
  index: number,
  message: string,
): TrustLintFinding {
  const line = lineAt(source, index);
  const lineText = lineTextAt(source, index);
  return {
    ruleId,
    severity: "fail",
    message,
    code,
    line,
    fingerprint: fingerprint(code, path, line, lineText),
  };
}

function isTagCodePoint(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

function isHiddenCodePoint(cp: number): boolean {
  return ZERO_WIDTH.has(cp) || BIDI_CONTROLS.has(cp) || isTagCodePoint(cp);
}

function hiddenUnicodeFindings(path: string, source: string): TrustLintFinding[] {
  const out: TrustLintFinding[] = [];
  let sparseNonAscii = 0;
  let sparseIndex = -1;
  for (let index = 0; index < source.length; ) {
    const cp = source.codePointAt(index);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    if (isHiddenCodePoint(cp)) {
      out.push(
        finding(
          "trust.hidden-unicode",
          "trust.hidden-unicode",
          path,
          source,
          index,
          `hidden Unicode code point U+${cp.toString(16).toUpperCase()} can smuggle model-readable instructions`,
        ),
      );
    } else if (cp > 0x7f && !/\s/u.test(String.fromCodePoint(cp))) {
      sparseNonAscii++;
      if (sparseIndex === -1) sparseIndex = index;
    }
    index += width;
  }
  if (sparseNonAscii > 100 && sparseIndex >= 0) {
    out.push(
      finding(
        "trust.hidden-unicode",
        "trust.hidden-unicode",
        path,
        source,
        sparseIndex,
        `document contains ${sparseNonAscii} non-ASCII characters; review for Unicode smuggling`,
      ),
    );
  }
  return out;
}

function promptInjectionFindings(path: string, source: string): TrustLintFinding[] {
  const out: TrustLintFinding[] = [];
  for (const rule of PROMPT_INJECTION_PATTERNS) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = re.exec(source); match !== null; match = re.exec(source)) {
      out.push(finding("trust.prompt-injection", rule.id, path, source, match.index, rule.message));
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

const TRUST_RULES: LintRule[] = [
  {
    id: "trust.hidden-unicode",
    severity: "fail",
    appliesTo: () => true,
    run: (source, ctx) => hiddenUnicodeFindings(ctx.path, source),
  },
  {
    id: "trust.prompt-injection",
    severity: "fail",
    appliesTo: () => true,
    run: (source, ctx) => promptInjectionFindings(ctx.path, source),
  },
];

function lintCtx(path: string): LintRuleCtx {
  return {
    path,
    plannedPaths: new Set(),
    fileExists: () => false,
    contextDir: "",
  };
}

export function lintTrustDocument(path: string, source: string): TrustLintFinding[] {
  const uri = safeUri(path);
  const ctx = lintCtx(uri);
  return TRUST_RULES.filter((rule) => rule.appliesTo(uri)).flatMap(
    (rule) => rule.run(source, ctx) as TrustLintFinding[],
  );
}

export function scanTrustDocument(path: string, source: string): Check[] {
  const uri = safeUri(path);
  return lintTrustDocument(uri, source).map((finding) => ({
    name: finding.code,
    verdict: "fail",
    detail: `${uri}:${finding.line} — ${finding.ruleId}: ${finding.message}`,
    code: finding.code,
    location: { uri, startLine: finding.line },
    fingerprint: finding.fingerprint,
  }));
}
