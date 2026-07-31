import { createHash } from "node:crypto";
import type { Check, CheckCode } from "../internals/verify.js";
import type { LintFinding, LintRule, LintRuleCtx } from "../lint/rules.js";
import { contentFindingFingerprint } from "./fingerprint.js";

type TrustLintCode = Extract<
  CheckCode,
  | "trust.external-egress"
  | "trust.hidden-unicode"
  | "trust.prompt-injection"
  | "trust.visible-unicode"
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
    // `api[\s_-]?keys?` also matches a space-separated "api key"/"api keys"; the
    // old `api[_-]?key` missed that spelling, letting "send the api key to …"
    // slip past the danger floor entirely (security-review #439).
    pattern:
      /\b(?:exfiltrate|leak|steal|send|upload|post)\b[\s\S]{0,180}\b(?:api[\s_-]?keys?|token|secret|password|credential|https?:\/\/)/gim,
  },
];

// Recognition of NEGATED-PROHIBITION guardrails for the secret-exfil rule only.
// A vendor "Prompt Defense Baseline" line such as "Do not reveal confidential
// data, disclose private data, share secrets, leak API keys, or expose
// credentials." is a prohibition, not an exfiltration order, yet the
// verb+credential heuristic still fires on it.
//
// SOUNDNESS MODEL (allow-list, fail-closed). Suppression fires ONLY when the
// entire span the prohibition operator governs — from the operator to the next
// clause terminator — parses as a coordinated list of BARE `verb + credential
// noun-phrase` items. The matched exfil verb is then necessarily one of those
// coordinated peers, because the object vocabulary is a closed set of
// credential/data words that contains no verb. That vocabulary also contains no
// destination preposition (to/into/at/onto/via/…), no URL, no quote, and no
// second negation, and the only list separators are comma / "or" / "and". A
// working exfiltration REQUIRES a destination (send X *to* Y, or a URL), which
// injects a token outside this grammar, so the parse fails and the finding keeps
// BLOCKING. Every non-list shape — a comma-spliced fresh imperative, an
// independent clause, a line-separator splice, a double negation, a meta or
// quoted instruction — fails the parse and blocks. Benign guardrails outside the
// exact list shape stay blocked (a precision loss, acknowledgeable downstream);
// no genuine imperative is ever suppressed.
const EXFIL_URL_IN_CLAUSE = /https?:\/\//i;
// Quotes signal a rule being *referenced/quoted* ("ignore the 'never exfiltrate'
// rule") rather than an actual prohibition, so a quoted scope never suppresses.
// A straight/curly apostrophe only counts as a quote at a token boundary; a
// contraction apostrophe (letter on both sides, e.g. "don't", "can't") does not.
const QUOTE_IN_CLAUSE = /["`‘“”]|(?:^|[^A-Za-z])['’]|['’](?:[^A-Za-z]|$)/;
// Operators that negate a following list of prohibited actions. The governing
// operator is the FIRST one in the verb's clause segment; an inner SECOND
// negation is a double negation the coordinated-list grammar rejects (its words
// are neither verbs, objects, adverbs, nor separators).
const PROHIBITION_OPERATOR =
  /\b(?:do(?:es)?\s+not|do(?:es)?n['’]?t|never|must\s+not|mustn['’]?t|may\s+not|might\s+not|shall\s+not|should\s+not|shouldn['’]?t|will\s+not|won['’]?t|cannot|can\s?not|can['’]?t|refrain\s+from|avoid)\b/gi;

// --- Coordinated-prohibition-list grammar: the ONLY shape that suppresses. ---
// A bare prohibited-action verb. The six exfil verbs the secret-exfil rule
// matches (send/upload/post/leak/steal/exfiltrate) are a subset; the rest are
// the other bare verbs a guardrail coordinates them with.
const GUARD_LIST_VERB =
  "(?:reveal|disclose|share|expose|leak|send|upload|post|transmit|exfiltrate|steal|publish|forward|divulge|email|provide|surrender|give\\s+away|give\\s+out|hand\\s+over)";
// One object word: articles/quantifiers, security modifiers, and credential/data
// head nouns ONLY. No destination noun and no preposition appear here, so a
// destination phrase ("to the collector", "into https://…") can never be parsed
// as an object — that is the property that keeps genuine exfil blocking.
const GUARD_OBJ_WORD =
  "(?:a|an|the|all|any|my|your|our|their|its|no|every|each|this|that|these|those|some|confidential|private|sensitive|personal|secret|internal|raw|plaintext|plain|user|users|customer|customers|account|accounts|api|session|auth|authentication|access|bearer|refresh|security|system|environment|env|database|config|configuration|secrets|credential|credentials|key|keys|token|tokens|password|passwords|apikey|api[_-]?keys?|data|information|info|material|materials|content|contents|detail|details|record|records|variable|variables|setting|settings)";
// An object noun-phrase: one or more object words, optionally joined by or/and.
const GUARD_OBJECT = `${GUARD_OBJ_WORD}(?:['’]s)?(?:\\s+(?:or\\s+|and\\s+)?${GUARD_OBJ_WORD}(?:['’]s)?)*`;
// Manner adverbs that carry NO destination. "never"/"not" are deliberately
// excluded: they are polarity words, and a second one is a double negation that
// must keep blocking.
const GUARD_ADVERB =
  "(?:ever|willingly|knowingly|deliberately|publicly|openly|externally|anywhere|elsewhere)";
// One coordinated action: optional manner adverb, a verb, then its object.
const GUARD_ACTION = `(?:${GUARD_ADVERB}\\s+)?${GUARD_LIST_VERB}\\s+${GUARD_OBJECT}`;
// List separator: a comma and/or a coordinating conjunction.
const GUARD_LIST_SEP = "(?:\\s*,\\s*(?:or\\s+|and\\s+)?|\\s+(?:or|and)\\s+)";
// The governed scope in full: nothing but a coordinated action list, an optional
// trailing manner-adverb run, and an optional single clause terminator.
const COORDINATED_PROHIBITION_LIST = new RegExp(
  `^\\s*${GUARD_ACTION}(?:${GUARD_LIST_SEP}${GUARD_ACTION})*(?:\\s+${GUARD_ADVERB})*\\s*[.!?;:]?\\s*$`,
  "i",
);

// The operator must sit within this many characters of the matched verb, and the
// clause scans are bounded to it so a single long line stays O(n), not O(n^2),
// with no arbitrary-distance terminator walk.
const GOVERNANCE_WINDOW = 160;

// Hard clause terminators. The Unicode line/paragraph separators and NEL are
// \s in JS, so the old ASCII-only set let a separator-spliced imperative ride
// inside the negated clause; they are hard clause boundaries here.
const CLAUSE_TERMINATORS = new Set([
  ".",
  "!",
  "?",
  ";",
  ":",
  "\n",
  "\r",
  "\u2028", // line separator
  "\u2029", // paragraph separator
  "\u0085", // next line (NEL)
  "\u000b", // vertical tab
  "\u000c", // form feed
]);

function isClauseTerminator(ch: string): boolean {
  return CLAUSE_TERMINATORS.has(ch);
}

function isNegatedProhibitionExfil(source: string, match: RegExpExecArray): boolean {
  const matchText = match[0];
  const verbStart = match.index;
  // (1) The verb -> credential span must be a single clause; a match that spans a
  // terminator has its target in a different clause than its verb.
  for (const ch of matchText) if (isClauseTerminator(ch)) return false;
  // (2) Governing operator: the FIRST prohibition operator in the verb's clause
  // segment, searched only within GOVERNANCE_WINDOW chars behind the verb so the
  // backward walk is bounded.
  const backStart = Math.max(0, verbStart - GOVERNANCE_WINDOW);
  let segStart = backStart;
  for (let i = verbStart - 1; i >= backStart; i--) {
    if (isClauseTerminator(source.charAt(i))) {
      segStart = i + 1;
      break;
    }
  }
  const before = source.slice(segStart, verbStart);
  PROHIBITION_OPERATOR.lastIndex = 0;
  const operator = PROHIBITION_OPERATOR.exec(before);
  if (operator === null) return false;
  const operatorEnd = segStart + operator.index + operator[0].length;
  // (3) Scope end: the next terminator at/after the verb, searched only within
  // GOVERNANCE_WINDOW chars ahead of the verb. No terminator in range => the
  // window cap is the scope end and the grammar full-match simply fails (block).
  const forwardEnd = Math.min(source.length, verbStart + GOVERNANCE_WINDOW);
  let scopeEnd = forwardEnd;
  for (let i = verbStart; i < forwardEnd; i++) {
    if (isClauseTerminator(source.charAt(i))) {
      scopeEnd = i;
      break;
    }
  }
  const scope = source.slice(operatorEnd, scopeEnd);
  // (4) A URL target or a quoted rule reference anywhere in the scope voids it
  // (defense-in-depth; the grammar's closed vocabulary already excludes both).
  if (EXFIL_URL_IN_CLAUSE.test(scope) || QUOTE_IN_CLAUSE.test(scope)) return false;
  // (5) Suppress ONLY when the whole governed scope is a coordinated prohibition
  // list; the matched exfil verb is then a coordinated peer by construction.
  return COORDINATED_PROHIBITION_LIST.test(scope);
}

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

interface SourceLines {
  source: string;
  starts: number[];
  textByIndex: Map<number, string>;
  digestByIndex: Map<number, string>;
}

const MAX_FULL_LINE_FINGERPRINT_LENGTH = 4_096;

function indexSourceLines(source: string): SourceLines {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return { source, starts, textByIndex: new Map(), digestByIndex: new Map() };
}

function lineAt(lines: SourceLines, index: number): { line: number; text: string } {
  let low = 0;
  let high = lines.starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lines.starts[middle] ?? 0) <= index) low = middle;
    else high = middle;
  }

  let text = lines.textByIndex.get(low);
  if (text === undefined) {
    const start = lines.starts[low] ?? 0;
    const nextStart = lines.starts[low + 1];
    text = lines.source.slice(start, nextStart === undefined ? lines.source.length : nextStart - 1);
    lines.textByIndex.set(low, text);
  }
  return { line: low + 1, text };
}

function oversizedLineDigest(lines: SourceLines, line: number, lineText: string): string {
  const lineIndex = line - 1;
  let digest = lines.digestByIndex.get(lineIndex);
  if (digest === undefined) {
    digest = createHash("sha256").update(lineText).digest("hex");
    lines.digestByIndex.set(lineIndex, digest);
  }
  return digest;
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
  lines: SourceLines,
  index: number,
  message: string,
): TrustLintFinding {
  const { line, text: lineText } = lineAt(lines, index);
  const content =
    lineText.length > MAX_FULL_LINE_FINGERPRINT_LENGTH
      ? `oversized-line-sha256:${oversizedLineDigest(lines, line, lineText)}\0${message}`
      : `${lineText}\0${message}`;
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

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

function hiddenCategory(cp: number): UnicodeCategory | undefined {
  if (ZERO_WIDTH.has(cp)) return "zero-width";
  if (BIDI_CONTROLS.has(cp)) return "bidi-control";
  if (isTagCodePoint(cp)) return "tag-character";
  if (DEFAULT_IGNORABLE.test(String.fromCodePoint(cp))) return "zero-width";
  return undefined;
}

function isHomoglyphConfusable(cp: number): boolean {
  const fullwidthIdentifier =
    (cp >= 0xff10 && cp <= 0xff19) ||
    (cp >= 0xff21 && cp <= 0xff3a) ||
    cp === 0xff3f ||
    (cp >= 0xff41 && cp <= 0xff5a);
  return (
    EXTRA_CONFUSABLES.has(cp) ||
    (cp >= 0x0370 && cp <= 0x03ff) ||
    (cp >= 0x0400 && cp <= 0x052f) ||
    (cp >= 0x1d400 && cp <= 0x1d7ff) ||
    fullwidthIdentifier
  );
}

const IDENTIFIER_CONTINUE_BEFORE = /[\p{ID_Continue}$]*$/u;
const IDENTIFIER_CONTINUE_AFTER = /^[\p{ID_Continue}$]*/u;

function isMixedAsciiIdentifier(source: string, index: number, width: number): boolean {
  const lineStart = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEndIndex = source.indexOf("\n", index);
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
  const before = source.slice(lineStart, index).match(IDENTIFIER_CONTINUE_BEFORE)?.[0] ?? "";
  const after = source.slice(index + width, lineEnd).match(IDENTIFIER_CONTINUE_AFTER)?.[0] ?? "";
  return /[A-Za-z0-9]/.test(`${before}${after}`);
}

function sourceLineAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end);
}

function isInsideMarkdownFence(source: string, index: number): boolean {
  const prefix = source.slice(0, index);
  const fences = prefix.match(/^\s*(?:```|~~~)/gm);
  return (fences?.length ?? 0) % 2 === 1;
}

type LineLexicalContext = "code" | "comment" | "string";

function lineLexicalContext(path: string, source: string, index: number): LineLexicalContext {
  const start = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const before = source.slice(start, index);
  const name = pathParts(path).at(-1) ?? "";
  const hashComments =
    name.endsWith(".py") ||
    name.endsWith(".sh") ||
    name.endsWith(".bash") ||
    name.endsWith(".zsh") ||
    name.endsWith(".ps1") ||
    name.endsWith(".rb") ||
    name.endsWith(".pl") ||
    name.endsWith(".md");
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let offset = 0; offset < before.length; offset++) {
    const ch = before[offset];
    const next = before[offset + 1];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && next === "/") return "comment";
    if (hashComments && ch === "#" && (offset === 0 || /\s/.test(before[offset - 1] ?? ""))) {
      return "comment";
    }
  }
  return quote === undefined ? "code" : "string";
}

function isProseOrCommentOccurrence(path: string, source: string, index: number): boolean {
  const line = sourceLineAt(source, index).trimStart();
  const name = pathParts(path).at(-1) ?? "";
  if (isReviewableDocumentationPath(path)) return true;
  if (name.endsWith(".md") && !isInsideMarkdownFence(source, index)) return true;
  if (lineLexicalContext(path, source, index) === "comment") return true;
  if (/^(?:\/\/|\/\*|\*|<!--|#(?![!]))/.test(line)) return true;
  return false;
}

function isMachineParsedConfigKey(path: string, source: string, index: number): boolean {
  const name = pathParts(path).at(-1) ?? "";
  if (!name.endsWith(".json") && !name.endsWith(".jsonc")) return false;
  const start = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const endIndex = source.indexOf("\n", index);
  const end = endIndex === -1 ? source.length : endIndex;
  const line = source.slice(start, end);
  const relative = index - start;
  const quoteStart = Math.max(line.lastIndexOf('"', relative), line.lastIndexOf("'", relative));
  if (quoteStart < 0) return false;
  const quote = line[quoteStart];
  const quoteEnd = line.indexOf(quote ?? "", relative + 1);
  return quoteEnd > relative && /^\s*:/.test(line.slice(quoteEnd + 1));
}

function isExecutableTokenOccurrence(path: string, source: string, index: number): boolean {
  if (path.includes("#")) return true;
  if (!isStrictUnicodeSurface(path) || isProseOrCommentOccurrence(path, source, index)) {
    return false;
  }
  return (
    lineLexicalContext(path, source, index) !== "string" ||
    isMachineParsedConfigKey(path, source, index)
  );
}

function isBenignVariationSelector(path: string, source: string, index: number): boolean {
  if (!isVariationSelector(source.codePointAt(index) ?? 0)) return false;
  // Variation selectors are expected when they render an emoji, including in
  // quoted shell output and fenced Markdown prompt examples. They are only a
  // hidden-token concern when detached from visible prose/emoji and embedded in
  // a machine-parsed token.
  const prefix = source.slice(0, index);
  const previous = Array.from(prefix).at(-1);
  return (
    isProseOrCommentOccurrence(path, source, index) ||
    (previous !== undefined && EXTENDED_PICTOGRAPHIC.test(previous))
  );
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
  const parts = pathParts(path);
  const name = parts.at(-1) ?? "";
  const inDocumentationTree = parts.some((part) =>
    ["docs", "doc", "design", "designs", "reference", "references"].includes(part),
  );
  if (
    (inDocumentationTree && name.endsWith(".md")) ||
    /(?:^|[-_.])(readme|design|reference|docs?)(?:[-_.]|$)/.test(name)
  ) {
    return true;
  }
  return !isStrictUnicodeSurface(path) && name.endsWith(".md");
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
    code: "trust.visible-unicode",
    reason: "ordinary visible Unicode on instruction/config/executable surface",
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
    if (hidden !== undefined && !isBenignVariationSelector(path, source, index)) {
      return {
        category: hidden,
        code: "trust.hidden-unicode",
        reason: "invisible/control Unicode can smuggle model-readable instructions",
      };
    }
    if (
      isHomoglyphConfusable(cp) &&
      isMixedAsciiIdentifier(source, index, width) &&
      isExecutableTokenOccurrence(path, source, index)
    ) {
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
  const lines = indexSourceLines(source);
  const allowDecorative = isReviewableDocumentationPath(path);
  let sparseNonAscii = 0;
  let sparseIndex = -1;
  for (let index = 0; index < source.length; ) {
    const cp = source.codePointAt(index);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const hidden = hiddenCategory(cp);
    if (hidden !== undefined && !isBenignVariationSelector(path, source, index)) {
      const message = `character category: ${hidden}; reason: invisible/control Unicode can smuggle model-readable instructions; code point U+${cp.toString(16).toUpperCase()}`;
      out.push(
        finding(
          occurrences,
          "trust.hidden-unicode",
          "trust.hidden-unicode",
          path,
          lines,
          index,
          message,
        ),
      );
    } else if (
      isHomoglyphConfusable(cp) &&
      isMixedAsciiIdentifier(source, index, width) &&
      isExecutableTokenOccurrence(path, source, index)
    ) {
      const message = `character category: homoglyph-confusable; reason: Unicode confusable appears inside an ASCII-like token; code point U+${cp.toString(16).toUpperCase()}`;
      out.push(
        finding(
          occurrences,
          "trust.hidden-unicode",
          "trust.hidden-unicode",
          path,
          lines,
          index,
          message,
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
        lines,
        sparseIndex,
        `document contains ${sparseNonAscii} non-ASCII characters; character category: ${visibleRisk.category}; reason: ${visibleRisk.reason}`,
      ),
    );
  }
  return out;
}

const AUTHENTICATED_REQUEST_METHOD =
  /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\b|(?:-X|--request(?:=|\s+))(?:GET|POST|PUT|PATCH|DELETE)\b)/i;
const AUTHENTICATED_BEARER_ENV = /\bAuthorization\s*:\s*Bearer\s+\$(?:\{)?[A-Z_][A-Z0-9_]*(?:\})?/i;
const CURL_UPLOAD_ARGUMENT =
  /(?:^|\s)(?:-d|-F|-T|--data(?:-raw|-binary|-urlencode)?|--form|--upload-file)(?:\s+|=)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\\]+)/gim;
const SENSITIVE_UPLOAD_ENV =
  /\$(?:\{)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*(?:\})?/i;
const SENSITIVE_UPLOAD_FILE =
  /(?:@|[\\/])(?:\.env(?:\.[A-Za-z0-9_.-]+)?|\.ssh[\\/](?:id_[A-Za-z0-9_.-]+|authorized_keys)|[^/\\\s"'=]*(?:secret|credential|private[_-]?key)[^/\\\s"'=]*)/i;
const AUTH_PARAMETER_ENV =
  /\b(?:access_?token|api_?key|token|key)\s*=\s*\$(?:\{)?([A-Z][A-Z0-9_]*)(?:\})?/i;
function shellWords(source: string): string[] | undefined {
  if (/`|\$\(/.test(source)) return undefined;
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const push = (): void => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === "\\") {
        const next = source[index + 1];
        if (next === undefined) return undefined;
        word += next;
        index++;
        continue;
      }
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "\\") {
      const next = source[index + 1];
      if (next === "\n") {
        index++;
        continue;
      }
      if (next === "\r" && source[index + 2] === "\n") {
        index += 2;
        continue;
      }
      if (next === undefined) return undefined;
      word += next;
      started = true;
      index++;
      continue;
    }
    if (/[;|&<>()#$*?[\]{}!~]/.test(char)) return undefined;
    word += char;
    started = true;
  }
  if (quote !== undefined) return undefined;
  push();
  return words;
}

function exactDuckDnsCurlPayloads(context: string): string[] | undefined {
  const words = shellWords(context);
  if (words?.[0]?.toLowerCase() !== "curl") return undefined;
  const flags = new Set<string>();
  const payloads: string[] = [];
  let destinationSeen = false;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as string;
    if (["--fail", "--silent", "--show-error", "--get"].includes(word)) {
      flags.add(word);
      continue;
    }
    if (word === "--max-time" || word.startsWith("--max-time=")) {
      const value = word === "--max-time" ? words[++index] : word.slice("--max-time=".length);
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 60) {
        return undefined;
      }
      flags.add("--max-time");
      continue;
    }
    if (word === "--data-urlencode" || word.startsWith("--data-urlencode=")) {
      const payload =
        word === "--data-urlencode" ? words[++index] : word.slice("--data-urlencode=".length);
      if (payload === undefined || payload.includes("@")) return undefined;
      payloads.push(payload);
      continue;
    }
    if (word === "https://www.duckdns.org/update" && !destinationSeen) {
      destinationSeen = true;
      continue;
    }
    return undefined;
  }
  if (
    !destinationSeen ||
    !["--fail", "--silent", "--show-error", "--get", "--max-time"].every((flag) => flags.has(flag))
  ) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const payload of payloads) {
    const separator = payload.indexOf("=");
    if (separator < 1) return undefined;
    const key = payload.slice(0, separator);
    if (!["domains", "token", "ip"].includes(key) || fields.has(key)) return undefined;
    fields.set(key, payload.slice(separator + 1));
  }
  if (
    fields.size !== 3 ||
    fields.get("domains") !== "myhome" ||
    fields.get("token") !== "${DUCKDNS_TOKEN}" ||
    fields.get("ip") !== ""
  ) {
    return undefined;
  }
  return payloads;
}

/**
 * Some APIs authenticate with a form/query token instead of an Authorization
 * header (for example DuckDNS `token=${DUCKDNS_TOKEN}`). Treat that shape as
 * reviewed authenticated egress only when the credential is service-specific
 * and its prefix equals an exact destination hostname label. Generic secrets,
 * mismatched destinations, sensitive files, and multiple sensitive payloads
 * remain blocking.
 */
function isServiceBoundCredentialRequest(context: string): boolean {
  const payloads = exactDuckDnsCurlPayloads(context);
  if (payloads === undefined) return false;

  const sensitiveVariables = [
    ...context.matchAll(new RegExp(SENSITIVE_UPLOAD_ENV.source, "gi")),
  ].map((match) => match[0].replace(/^\$\{?/, "").replace(/\}?$/, ""));
  if (sensitiveVariables.length !== 1) return false;
  const sensitiveVariable = sensitiveVariables[0] as string;

  const authVariables: string[] = [];
  for (const payload of payloads) {
    const authVariable = AUTH_PARAMETER_ENV.exec(payload)?.[1];
    if (authVariable !== undefined) authVariables.push(authVariable);
  }
  if (authVariables.length !== 1 || authVariables[0] !== sensitiveVariable) return false;

  const service =
    /^([A-Z][A-Z0-9_]*?)_(?:ACCESS_)?TOKEN$/.exec(sensitiveVariable)?.[1] ??
    /^([A-Z][A-Z0-9_]*?)_API_?KEY$/.exec(sensitiveVariable)?.[1];
  return service?.toUpperCase() === "DUCKDNS";
}

function externalRequestContext(
  source: string,
  match: RegExpExecArray,
): { context: string; start: number } {
  const start = source.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1;
  let lineEnd = source.indexOf("\n", match.index);
  if (lineEnd === -1) lineEnd = source.length;
  let end = lineEnd;
  while (source.slice(start, end).trimEnd().endsWith("\\") && end < source.length) {
    const nextEnd = source.indexOf("\n", end + 1);
    end = nextEnd === -1 ? source.length : nextEnd;
  }
  return { context: source.slice(start, end), start };
}

function sensitiveUploadPayloadIndex(source: string, match: RegExpExecArray): number | undefined {
  const { context, start } = externalRequestContext(source, match);
  if (isServiceBoundCredentialRequest(context)) return undefined;
  CURL_UPLOAD_ARGUMENT.lastIndex = 0;
  for (
    let payload = CURL_UPLOAD_ARGUMENT.exec(context);
    payload !== null;
    payload = CURL_UPLOAD_ARGUMENT.exec(context)
  ) {
    if (SENSITIVE_UPLOAD_ENV.test(payload[0]) || SENSITIVE_UPLOAD_FILE.test(payload[0])) {
      return start + payload.index;
    }
    if (payload.index === CURL_UPLOAD_ARGUMENT.lastIndex) CURL_UPLOAD_ARGUMENT.lastIndex++;
  }
  return undefined;
}

function curlCommandContexts(source: string): Array<{ context: string; start: number }> {
  const commands: Array<{ context: string; start: number }> = [];
  const linePattern = /(^|\n)([^\n]*\bcurl\b[^\n]*)/gim;
  for (let line = linePattern.exec(source); line !== null; line = linePattern.exec(source)) {
    const start = line.index + (line[1]?.length ?? 0);
    let end = start + (line[2]?.length ?? 0);
    while (source.slice(start, end).trimEnd().endsWith("\\") && end < source.length) {
      const nextEnd = source.indexOf("\n", end + 1);
      end = nextEnd === -1 ? source.length : nextEnd;
    }
    commands.push({ context: source.slice(start, end), start });
    if (line.index === linePattern.lastIndex) linePattern.lastIndex++;
  }
  return commands;
}

function sensitiveCurlUploadIndices(source: string): number[] {
  const indices: number[] = [];
  for (const { context, start } of curlCommandContexts(source)) {
    if (isServiceBoundCredentialRequest(context)) continue;
    CURL_UPLOAD_ARGUMENT.lastIndex = 0;
    for (
      let payload = CURL_UPLOAD_ARGUMENT.exec(context);
      payload !== null;
      payload = CURL_UPLOAD_ARGUMENT.exec(context)
    ) {
      if (SENSITIVE_UPLOAD_ENV.test(payload[0]) || SENSITIVE_UPLOAD_FILE.test(payload[0])) {
        indices.push(start + payload.index);
      }
      if (payload.index === CURL_UPLOAD_ARGUMENT.lastIndex) CURL_UPLOAD_ARGUMENT.lastIndex++;
    }
  }
  return [...new Set(indices)];
}

function authenticatedCurlRequests(
  source: string,
): Array<{ findingIndex: number; lineStart: number }> {
  const requests: Array<{ findingIndex: number; lineStart: number }> = [];
  for (const { context, start } of curlCommandContexts(source)) {
    CURL_UPLOAD_ARGUMENT.lastIndex = 0;
    const requestShaped =
      AUTHENTICATED_REQUEST_METHOD.test(context) || CURL_UPLOAD_ARGUMENT.test(context);
    if (
      requestShaped &&
      /https?:\/\//i.test(context) &&
      (AUTHENTICATED_BEARER_ENV.test(context) || isServiceBoundCredentialRequest(context))
    ) {
      requests.push({
        findingIndex: start + Math.max(0, context.search(/\bcurl\b/i)),
        lineStart: start,
      });
    }
  }
  return requests;
}

/**
 * The secret-exfil heuristic also matches ordinary `curl -X POST` examples
 * because POST is an exfil verb and the command contains both a URL and an API
 * token variable. Keep that behavior visible, but classify the narrow,
 * authenticated-request shape as reviewed egress instead of credential theft.
 * Literal credentials, imperative "send the key" text, and requests without an
 * Authorization header remain prompt-injection danger findings.
 */
function isAuthenticatedExternalRequest(source: string, match: RegExpExecArray): boolean {
  const { context } = externalRequestContext(source, match);
  if (
    /\b(?:send|upload|post|leak|steal|exfiltrate)\s+(?:the\s+)?(?:credential|secret|token|password|api[\s_-]?key)\b[\s\S]{0,160}https?:\/\//i.test(
      match[0],
    )
  ) {
    return false;
  }
  return (
    /\bcurl\b/i.test(context) &&
    (AUTHENTICATED_REQUEST_METHOD.test(context) ||
      (() => {
        CURL_UPLOAD_ARGUMENT.lastIndex = 0;
        return CURL_UPLOAD_ARGUMENT.test(context);
      })()) &&
    /https?:\/\//i.test(context) &&
    (AUTHENTICATED_BEARER_ENV.test(context) || isServiceBoundCredentialRequest(context))
  );
}

const DIRECT_NEGATION_BEFORE_VERB =
  /(?:\b(?:do(?:es)?\s+not|do(?:es)?n['’]?t|never|must\s+not|mustn['’]?t|may\s+not|might\s+not|shall\s+not|should\s+not|shouldn['’]?t|will\s+not|won['’]?t|cannot|can\s?not|can['’]?t)\s+)$/i;

function isDirectlyNegatedExfil(source: string, match: RegExpExecArray): boolean {
  const prefix = source.slice(Math.max(0, match.index - 120), match.index);
  const negation = DIRECT_NEGATION_BEFORE_VERB.exec(prefix);
  if (negation === null) return false;
  const before = prefix[negation.index - 1];
  if (before !== undefined && /["'`‘’“”]/.test(before)) return false;
  const beforeNegation = prefix.slice(Math.max(0, negation.index - 40), negation.index);
  if (
    /\b(?:do(?:es)?\s+not|do(?:es)?n['’]?t|never|must\s+not|cannot|can['’]?t)\s*$/i.test(
      beforeNegation,
    )
  ) {
    return false;
  }
  return !/(?:[,.!?;:\u0085\u2028\u2029]|\bthen\b)\s*(?:then\s+)?(?:send|upload|post|leak|steal|exfiltrate)\b/i.test(
    match[0],
  );
}

function isHttpDeclarationOrLexicalExample(source: string, match: RegExpExecArray): boolean {
  const line = sourceLineAt(source, match.index).trim();
  return (
    /(?:@\w+(?:\.\w+)*|\b\w+(?:\.\w+)+)\.(?:get|post|put|patch|delete)\s*\(/i.test(line) ||
    /\b\w+(?:\.\w+)*\.upload\s*\(/i.test(line) ||
    /\bfunction\s+(?:GET|POST|PUT|PATCH|DELETE)\s*\(/.test(line) ||
    /^#{1,6}\s+.*\b(?:post|upload)\b/i.test(line) ||
    /https?:\/\/upload\.[^\s"'`]+/i.test(line) ||
    /^(?:post a tweet|upload coverage)\b/i.test(line)
  );
}

const EXFIL_CREDENTIAL =
  /\b(?:api[\s_-]?(?:keys?|tokens?)|access\s+tokens?|auth(?:entication)?\s+tokens?|bearer\s+tokens?|credentials?|passwords?|secrets?|tokens?|sensitive\s+data|confidential\s+data)\b/i;
const EXFIL_DESTINATION = /\b(?:to|into|onto|via|at)\b|https?:\/\//i;
const EXPLICIT_CREDENTIAL_EXFIL =
  /\b(?:send|upload|post|leak|steal|exfiltrate)\s+(?:the\s+)?(?:credential|secret|token|password|api[\s_-]?key)\b[\s\S]{0,160}(?:\bto\b|\bvia\b|https?:\/\/)/i;

function explicitCredentialExfilIndex(source: string, match: RegExpExecArray): number | undefined {
  const matchedContext = source.slice(
    match.index,
    Math.min(source.length, match.index + match[0].length + 240),
  );
  const explicit = EXPLICIT_CREDENTIAL_EXFIL.exec(matchedContext);
  return explicit === null ? undefined : match.index + explicit.index;
}

function isActualExfilIntent(_path: string, source: string, match: RegExpExecArray): boolean {
  const matchedContext = source.slice(
    match.index,
    Math.min(source.length, match.index + match[0].length + 240),
  );
  if (EXPLICIT_CREDENTIAL_EXFIL.test(matchedContext)) {
    return true;
  }
  const sourceLine = sourceLineAt(source, match.index);
  if (/^\s*Attack example:/i.test(sourceLine) && /\bdemonstrates?\b/i.test(sourceLine)) {
    return false;
  }
  if (isHttpDeclarationOrLexicalExample(source, match)) return false;
  if (isDirectlyNegatedExfil(source, match) || isNegatedProhibitionExfil(source, match))
    return false;
  const line = sourceLineAt(source, match.index);
  if (
    /\b(?:credentials?|secrets?|tokens?|passwords?|data)\b/i.test(line) &&
    (/\b(?:risk|guidance|prevent|avoid|hardcod|safeguard|protect)\b/i.test(line) ||
      /^\s*(?:[-*]\s+)?do\s+not\s+follow\s+instructions?\s+that\s+ask\b/i.test(line)) &&
    !/\b(?:send|upload|post)\s+(?:the\s+)?(?:credential|secret|token|password|api[\s_-]?key)\s+(?:to|into|via|at)\b/i.test(
      line,
    )
  ) {
    return false;
  }
  const verb = /^\w+/.exec(match[0])?.[0]?.toLowerCase() ?? "";
  const around = source.slice(Math.max(0, match.index - 120), match.index + match[0].length + 220);
  if (
    /(?:[,.!?;:\u0085\u2028\u2029]|\bthen\b)\s*(?:then\s+)?(?:send|upload|post|leak|steal|exfiltrate)\b[\s\S]{0,120}(?:https?:\/\/|\b(?:tokens?|secrets?|credentials?|passwords?|api[\s_-]?(?:keys?|tokens?))\b)/i.test(
      match[0],
    )
  ) {
    return true;
  }
  if (verb === "exfiltrate" || verb === "steal") {
    return EXFIL_CREDENTIAL.test(around) || EXFIL_DESTINATION.test(around);
  }
  if (EXFIL_CREDENTIAL.test(line) && EXFIL_DESTINATION.test(line)) return true;
  if (
    EXFIL_CREDENTIAL.test(line) &&
    /^(?:\s*(?:[-*]\s+|\d+[.)]\s+)?)?(?:send|upload|post|leak)\b/i.test(line)
  ) {
    return true;
  }
  return (
    /\b(?:send|upload|post)\s+(?:it|them|this|that)\b/i.test(line) &&
    EXFIL_DESTINATION.test(line) &&
    EXFIL_CREDENTIAL.test(around)
  );
}

function promptInjectionFindings(path: string, source: string): TrustLintFinding[] {
  const out: TrustLintFinding[] = [];
  const occurrences = new Map<string, number>();
  const lines = indexSourceLines(source);
  const sensitiveCurlIndices = new Set(sensitiveCurlUploadIndices(source));
  const authenticatedRequests = authenticatedCurlRequests(source);
  const authenticatedRequestLines = new Set(
    authenticatedRequests.map((request) => request.lineStart),
  );
  for (const index of sensitiveCurlIndices) {
    out.push(
      finding(
        occurrences,
        "trust.prompt-injection",
        "prompt-injection.secret-exfil",
        path,
        lines,
        index,
        "instruction may cause secret exfiltration",
      ),
    );
  }
  for (const request of authenticatedRequests) {
    const contextMatch = {
      index: request.lineStart,
      0: sourceLineAt(source, request.lineStart),
    } as RegExpExecArray;
    if (sensitiveUploadPayloadIndex(source, contextMatch) !== undefined) continue;
    out.push(
      finding(
        occurrences,
        "trust.external-egress",
        "external-egress.authenticated-request",
        path,
        lines,
        request.findingIndex,
        "authenticated external request uses an environment-provided credential; requires reviewed egress",
      ),
    );
  }
  for (const rule of PROMPT_INJECTION_PATTERNS) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = re.exec(source); match !== null; match = re.exec(source)) {
      const sensitivePayloadIndex =
        rule.id === "prompt-injection.secret-exfil"
          ? sensitiveUploadPayloadIndex(source, match)
          : undefined;
      if (sensitivePayloadIndex !== undefined && sensitiveCurlIndices.has(sensitivePayloadIndex)) {
        if (match.index === re.lastIndex) re.lastIndex++;
        continue;
      }
      const authenticatedEgress =
        rule.id === "prompt-injection.secret-exfil" &&
        sensitivePayloadIndex === undefined &&
        isAuthenticatedExternalRequest(source, match);
      if (
        authenticatedEgress &&
        authenticatedRequestLines.has(externalRequestContext(source, match).start)
      ) {
        if (match.index === re.lastIndex) re.lastIndex++;
        continue;
      }
      const isRecognizedGuardrail =
        rule.id === "prompt-injection.secret-exfil" &&
        sensitivePayloadIndex === undefined &&
        !authenticatedEgress &&
        !isActualExfilIntent(path, source, match);
      if (!isRecognizedGuardrail) {
        const findingIndex =
          sensitivePayloadIndex ??
          (!authenticatedEgress && rule.id === "prompt-injection.secret-exfil"
            ? (explicitCredentialExfilIndex(source, match) ?? match.index)
            : match.index);
        out.push(
          finding(
            occurrences,
            authenticatedEgress ? "trust.external-egress" : "trust.prompt-injection",
            authenticatedEgress ? "external-egress.authenticated-request" : rule.id,
            path,
            lines,
            findingIndex,
            authenticatedEgress
              ? "authenticated external request uses an environment-provided credential; requires reviewed egress"
              : rule.message,
          ),
        );
      }
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
