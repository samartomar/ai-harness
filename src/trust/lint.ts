import type { Check, CheckCode } from "../internals/verify.js";
import type { LintFinding, LintRule, LintRuleCtx } from "../lint/rules.js";
import { contentFindingFingerprint } from "./fingerprint.js";

type TrustLintCode = Extract<
  CheckCode,
  "trust.hidden-unicode" | "trust.prompt-injection" | "trust.visible-unicode"
>;

type UnicodeCategory =
  | "bidi-control"
  | "detector-reported-hidden-unicode"
  | "homoglyph-confusable"
  | "tag-character"
  | "visible-typography"
  | "zero-width";

export interface UnicodeRisk {
  category: UnicodeCategory;
  code: Extract<CheckCode, "trust.hidden-unicode" | "trust.visible-unicode">;
  reason: string;
}

export function detectorReportedHiddenUnicodeRisk(): UnicodeRisk {
  return {
    category: "detector-reported-hidden-unicode",
    code: "trust.hidden-unicode",
    reason: "detector reported hidden Unicode without reviewable visible-typography evidence",
  };
}

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
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EXTRA_CONFUSABLES = new Set([
  0x0131, // latin small dotless i
  0x0142, // latin small l with stroke
  0x017f, // latin small long s
  0x05e1, // hebrew samekh
  0x2044, // fraction slash
  0x2212, // minus sign
  0x0585, // armenian small oh
  0x0578, // armenian small vo
  0x057d, // armenian small seh
  0x0581, // armenian small co
  0x13a2, // cherokee letter i
  0x13a9, // cherokee letter gi
  0x13ce, // cherokee letter se
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

function nextOccurrence(
  occurrences: Map<string, number>,
  code: TrustLintCode,
  path: string,
  ruleId: string,
  content: string,
): number {
  const key = JSON.stringify([code, path, ruleId, content]);
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return occurrence;
}

function finding(
  occurrences: Map<string, number>,
  code: TrustLintCode,
  ruleId: string,
  path: string,
  source: string,
  index: number,
  message: string,
  fingerprintContent?: string,
): TrustLintFinding {
  const line = lineAt(source, index);
  const lineText = lineTextAt(source, index);
  const content = fingerprintContent ?? `${lineText}\0${message}`;
  return {
    ruleId,
    severity: "fail",
    message,
    code,
    line,
    fingerprint: contentFindingFingerprint({
      code,
      path,
      ruleId,
      content,
      occurrence: nextOccurrence(occurrences, code, path, ruleId, content),
      displayLine: line,
    }),
  };
}

function isTagCodePoint(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

function isDecorativeCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2190 && cp <= 0x21ff) ||
    (cp >= 0x2500 && cp <= 0x257f) ||
    EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(cp))
  );
}

function hiddenCategory(cp: number): UnicodeCategory | undefined {
  if (ZERO_WIDTH.has(cp)) return "zero-width";
  if (BIDI_CONTROLS.has(cp)) return "bidi-control";
  if (isTagCodePoint(cp)) return "tag-character";
  if (DEFAULT_IGNORABLE.test(String.fromCodePoint(cp))) return "zero-width";
  return undefined;
}

function isAsciiWordCodeUnit(value: number): boolean {
  return (
    (value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a) ||
    value === 0x5f
  );
}

function isHomoglyphConfusable(cp: number): boolean {
  return (
    EXTRA_CONFUSABLES.has(cp) ||
    (cp >= 0x0370 && cp <= 0x03ff) ||
    (cp >= 0x0400 && cp <= 0x052f) ||
    (cp >= 0x1d400 && cp <= 0x1d7ff) ||
    (cp >= 0xff01 && cp <= 0xff5e)
  );
}

function hasAsciiWordNeighbor(source: string, index: number, width: number): boolean {
  const before = index > 0 ? source.charCodeAt(index - 1) : Number.NaN;
  const after = index + width < source.length ? source.charCodeAt(index + width) : Number.NaN;
  return isAsciiWordCodeUnit(before) || isAsciiWordCodeUnit(after);
}

function pathParts(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[\\/#]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function isStrictUnicodeSurface(path: string): boolean {
  const parts = pathParts(path);
  const name = parts.at(-1) ?? "";
  if (path.includes("#")) return true;
  if (["skill.md", "agents.md", "claude.md", "gemini.md"].includes(name)) return true;
  if (parts.includes("agents") || parts.includes("commands")) return true;
  if (["install", "setup", "configure", "bootstrap", "entrypoint"].includes(name)) return true;
  return [
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".go",
    ".h",
    ".hpp",
    ".java",
    ".js",
    ".jsx",
    ".cjs",
    ".kt",
    ".kts",
    ".lua",
    ".mjs",
    ".php",
    ".pl",
    ".py",
    ".rs",
    ".rb",
    ".scala",
    ".swift",
    ".ts",
    ".tsx",
    ".cts",
    ".mts",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".bat",
    ".cmd",
  ].some((suffix) => name.endsWith(suffix));
}

function isReviewableDocumentationPath(path: string): boolean {
  if (isStrictUnicodeSurface(path)) return false;
  const parts = pathParts(path);
  const name = parts.at(-1) ?? "";
  return (
    parts.some((part) =>
      ["docs", "doc", "design", "designs", "reference", "references"].includes(part),
    ) || /(?:^|[-_.])(readme|design|reference|docs?)(?:[-_.]|$)/.test(name)
  );
}

function unicodeRiskForVisibleTypography(path: string): UnicodeRisk {
  if (isReviewableDocumentationPath(path)) {
    return {
      category: "visible-typography",
      code: "trust.visible-unicode",
      reason: "ordinary visible Unicode in documentation",
    };
  }
  return {
    category: "visible-typography",
    code: "trust.hidden-unicode",
    reason: "Unicode appears on instruction/config/executable surface",
  };
}

export function classifyUnicodeRisk(path: string, source: string): UnicodeRisk | undefined {
  let visibleNonAscii = 0;
  const allowDecorative = isReviewableDocumentationPath(path);
  for (let index = 0; index < source.length; ) {
    const cp = source.codePointAt(index);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const hidden = hiddenCategory(cp);
    if (hidden !== undefined) {
      return {
        category: hidden,
        code: "trust.hidden-unicode",
        reason: "invisible/control Unicode can smuggle model-readable instructions",
      };
    }
    if (isHomoglyphConfusable(cp) && hasAsciiWordNeighbor(source, index, width)) {
      return {
        category: "homoglyph-confusable",
        code: "trust.hidden-unicode",
        reason: "Unicode confusable appears inside an ASCII-like token",
      };
    }
    if (
      cp > 0x7f &&
      !/\s/u.test(String.fromCodePoint(cp)) &&
      (!allowDecorative || !isDecorativeCodePoint(cp))
    ) {
      visibleNonAscii++;
    }
    index += width;
  }
  return visibleNonAscii > 0 ? unicodeRiskForVisibleTypography(path) : undefined;
}

function hiddenUnicodeFindings(path: string, source: string): TrustLintFinding[] {
  const out: TrustLintFinding[] = [];
  const occurrences = new Map<string, number>();
  const allowDecorative = isReviewableDocumentationPath(path);
  let sparseNonAscii = 0;
  let sparseIndex = -1;
  for (let index = 0; index < source.length; ) {
    const cp = source.codePointAt(index);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const hidden = hiddenCategory(cp);
    if (hidden !== undefined) {
      out.push(
        finding(
          occurrences,
          "trust.hidden-unicode",
          "trust.hidden-unicode",
          path,
          source,
          index,
          `character category: ${hidden}; reason: invisible/control Unicode can smuggle model-readable instructions; code point U+${cp.toString(16).toUpperCase()}`,
        ),
      );
    } else if (isHomoglyphConfusable(cp) && hasAsciiWordNeighbor(source, index, width)) {
      out.push(
        finding(
          occurrences,
          "trust.hidden-unicode",
          "trust.hidden-unicode",
          path,
          source,
          index,
          `character category: homoglyph-confusable; reason: Unicode confusable appears inside an ASCII-like token; code point U+${cp.toString(16).toUpperCase()}`,
        ),
      );
    } else if (
      cp > 0x7f &&
      !/\s/u.test(String.fromCodePoint(cp)) &&
      (!allowDecorative || !isDecorativeCodePoint(cp))
    ) {
      sparseNonAscii++;
      if (sparseIndex === -1) sparseIndex = index;
    }
    index += width;
  }
  if (sparseIndex >= 0) {
    const visibleRisk = unicodeRiskForVisibleTypography(path);
    out.push(
      finding(
        occurrences,
        visibleRisk.code,
        visibleRisk.code,
        path,
        source,
        sparseIndex,
        `document contains ${sparseNonAscii} non-ASCII characters; character category: ${visibleRisk.category}; reason: ${visibleRisk.reason}`,
      ),
    );
  }
  return out;
}

function promptInjectionFindings(path: string, source: string): TrustLintFinding[] {
  const out: TrustLintFinding[] = [];
  const occurrences = new Map<string, number>();
  for (const rule of PROMPT_INJECTION_PATTERNS) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = re.exec(source); match !== null; match = re.exec(source)) {
      out.push(
        finding(
          occurrences,
          "trust.prompt-injection",
          rule.id,
          path,
          source,
          match.index,
          rule.message,
        ),
      );
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
  return checksFromTrustLintFindings(uri, lintTrustDocument(uri, source));
}

function checksFromTrustLintFindings(uri: string, findings: TrustLintFinding[]): Check[] {
  return findings.map((finding) => ({
    name: finding.code,
    verdict: "fail",
    detail: `${uri}:${finding.line} — ${finding.ruleId}: ${finding.message}`,
    code: finding.code,
    location: { uri, startLine: finding.line },
    fingerprint: finding.fingerprint,
  }));
}

export function scanTrustUnicodeDocument(path: string, source: string): Check[] {
  const uri = safeUri(path);
  return checksFromTrustLintFindings(uri, hiddenUnicodeFindings(uri, source));
}
