/**
 * Gate-layer visible-typography reclassifier (W5 rule-8 ruling, 2026-07-21 FINAL
 * calibration pass).
 *
 * The shared trust detector flags every non-ASCII occurrence as
 * `trust.hidden-unicode`, and the GATE maps that code to `high` (see
 * `DANGER_SEVERITY` in `scan-gate.ts`). Per the ruling, visible typography in
 * prose, comments, and human-facing strings is ADVISORY, not blocking — but the
 * raw detector evidence and severity must be preserved. This module is a
 * gate-layer OVERLAY that decides, per file, whether a `trust.hidden-unicode`
 * finding may be DEMOTED to advisory. It NEVER edits the detector (the vet lane's
 * vendor-lock reproducibility is untouched) and it is applied by `decide()` ONLY
 * for a seeded selected-profile closure — never for legacy or W4 full-tree paths.
 *
 * The classification is fail-closed and PER-FILE (ruling): a file's finding
 * demotes ONLY if EVERY non-ASCII occurrence in that file is advisory-eligible.
 * A single always-blocking char (bidi/zero-width/control/format/soft-hyphen/
 * suspicious-whitespace/default-ignorable) or a single unproven-context char
 * (code, identifier, key, heredoc, unquoted scalar, unknown) keeps the finding
 * high/blocking.
 *
 * Decorative eligibility is an EXPLICIT allow-list (dashes, box-drawing, block
 * elements, geometric shapes, arrows, check/cross, and four curated punctuation
 * marks) — NOT the broad `\p{S}`/`\p{Pd}` categories — so U+FFFD and unrelated
 * symbols (e.g. U+00A9) never demote. This module ALSO exposes
 * {@link classifySentinelLineShape}, the line-shape helper the rule-8
 * "EXPECTED_SANITIZER_SENTINEL_LITERAL" acceptances are proven against.
 */

import type { ScanSeverity } from "./scan-gate.js";

/** The structured overlay attached to a demoted finding (raw severity stays visible). */
export interface TypographyAdvisory {
  /** The detector/gate severity this finding carried before demotion (always "high"). */
  reclassifiedFrom: ScanSeverity;
  /** The dominant advisory context that justified the demotion (e.g. "comment", "prose"). */
  contextClass: string;
}

/** Per-file verdict from {@link classifyFileTypography}. */
export interface FileTypographyVerdict {
  /** True iff the file has ≥1 non-ASCII occurrence and ALL of them are advisory. */
  demote: boolean;
  /** Total non-ASCII occurrences examined. */
  occurrences: number;
  /** Dominant advisory context (present when `demote`). */
  contextClass?: string;
  /** Why the file stays blocking (present when NOT `demote`) — the first blocker found. */
  blockingReason?: string;
}

// -- Always-blocking chars (ruling point 3) ----------------------------------

// Category-based cover: \p{Cc} (control), \p{Cf} (format — includes bidi controls
// U+061C/200E/F/202A-E/2066-9, zero-width U+200B-D/2060/FEFF, soft hyphen U+00AD),
// and \p{Default_Ignorable_Code_Point} (e.g. the U+FE0F variation selector).
const ALWAYS_BLOCK_CATEGORY = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
// Suspicious Unicode whitespace (category Zs and friends the ruling enumerates).
const SUSPICIOUS_WHITESPACE = new Set<number>([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x202f, 0x205f, 0x3000,
]);
// Defense-in-depth explicit blockers (ruling point 1): U+00AD soft hyphen is
// already \p{Cf}, but the ruling requires it named here too.
const ALWAYS_BLOCK_CODEPOINTS = new Set<number>([0x00ad]);

function isAlwaysBlockingChar(ch: string): boolean {
  if (ALWAYS_BLOCK_CATEGORY.test(ch)) return true;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return SUSPICIOUS_WHITESPACE.has(cp) || ALWAYS_BLOCK_CODEPOINTS.has(cp);
}

// -- Decorative allow-list (ruling point 1: EXPLICIT ranges, not \p{S}\p{Pd}) --

// Curated single code points: em/en/figure/horiz-bar dashes (U+2011 non-breaking
// hyphen deliberately EXCLUDED) plus four curated punctuation marks.
const DECORATIVE_CODEPOINTS = new Set<number>([
  // dashes
  0x2010, 0x2012, 0x2013, 0x2014, 0x2015,
  // curated punctuation: … · • §
  0x2026, 0x00b7, 0x2022, 0x00a7,
  // Display-glyph correction (maintainer-authorized 2026-07-22, option (b) after
  // the official requirement-8 run): the EMOJI-block check/cross/star/warning
  // status glyphs and observed same-class display symbols that the dingbat-only
  // U+2713-2718 range missed. Explicit enumeration, never a broad category —
  // each is a visible pictograph/sign with no invisible or ASCII-confusable
  // rendering: ✅ ❌ ★ ⚠ ⛔ 🤖 🔥 × ≤ ≥.
  0x2705, 0x274c, 0x2605, 0x26a0, 0x26d4, 0x1f916, 0x1f525, 0x00d7, 0x2264, 0x2265,
]);

/**
 * A char that is safe as DISPLAY-only content (fences / inline code / display
 * strings / cat-heredocs): a decorative glyph from the ruling's EXPLICIT ranges —
 * box drawing, block elements, geometric shapes, arrows, check/cross — or one of
 * the curated dash/punctuation code points. Letters, marks, digits, confusable
 * quotes, U+FFFD, and out-of-range symbols (e.g. U+00A9) are NOT decorative here.
 */
function isDisplayDecorative(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (DECORATIVE_CODEPOINTS.has(cp)) return true;
  if (cp >= 0x2500 && cp <= 0x257f) return true; // box drawing
  if (cp >= 0x2580 && cp <= 0x259f) return true; // block elements
  if (cp >= 0x25a0 && cp <= 0x25ff) return true; // geometric shapes
  if (cp >= 0x2190 && cp <= 0x21ff) return true; // arrows
  if (cp >= 0x2713 && cp <= 0x2718) return true; // check / cross marks
  return false;
}

// Letters and combining marks (NOT digits) — advisory only in tsjs-string and
// markdown inline-code (ruling point 2), where notation/CJK content is expected.
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
// Emoji base characters, for the FE0F presentation-selector pair rule.
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const VARIATION_SELECTOR_16 = "️";

// -- Context model -----------------------------------------------------------

// Context labels a tokenizer may emit for a non-ASCII occurrence. HUMAN contexts
// are advisory for ANY non-always-block char; DISPLAY contexts are advisory for
// decorative chars (and, in tsjs-string / markdown inline-code, letters/marks);
// everything else blocks.
type Ctx =
  | "prose"
  | "comment"
  | "string"
  | "tsjs-string" // ts/js string-literal content: DISPLAY (decorative + letters advisory)
  | "fence"
  | "inline-code"
  | "heredoc-display" // cat-fed bash heredoc body: DISPLAY (decorative only)
  | "code"
  | "heredoc"
  | "key"
  | "unquoted"
  | "unknown";

const HUMAN_CONTEXTS: ReadonlySet<Ctx> = new Set<Ctx>(["prose", "comment", "string"]);
const DISPLAY_CONTEXTS: ReadonlySet<Ctx> = new Set<Ctx>([
  "fence",
  "inline-code",
  "tsjs-string",
  "heredoc-display",
]);
// Contexts in which a U+FE0F immediately following an emoji base is the EXPECTED
// emoji-presentation selector rather than a hidden default-ignorable (ruling
// point 2). Python comment/docstring/string map onto "comment"/"string" here.
const FE0F_PAIR_CONTEXTS: ReadonlySet<Ctx> = new Set<Ctx>([
  "prose",
  "comment",
  "string",
  "tsjs-string",
  "fence",
  "inline-code",
  "heredoc-display",
]);

/** Advisory context classes that outrank a generic context on a roll-up tie. */
const CONTEXT_CLASS_PRIORITY: Record<string, number> = {
  EXPECTED_EMOJI_PRESENTATION_SELECTOR: 3,
  "display-string-letters": 2,
  "notation-letters": 2,
};

interface OccurrenceVerdict {
  blocks: boolean;
  /** The advisory class credited on the file roll-up (present when NOT `blocks`). */
  contextClass?: string;
}

/**
 * Classify ONE non-ASCII occurrence given its tokenizer context and the source
 * code point immediately preceding it (for the FE0F pair rule). Always-block
 * chars override context — except a U+FE0F that is the expected presentation
 * selector of the emoji base right before it, which the pair rule clears first.
 */
function classifyOccurrence(ch: string, ctx: Ctx, prev: string): OccurrenceVerdict {
  // FE0F presentation-selector pair rule (before the always-block cover, since a
  // lone FE0F is default-ignorable and always blocks).
  if (ch === VARIATION_SELECTOR_16) {
    if (FE0F_PAIR_CONTEXTS.has(ctx) && prev !== "" && EXTENDED_PICTOGRAPHIC.test(prev)) {
      return { blocks: false, contextClass: "EXPECTED_EMOJI_PRESENTATION_SELECTOR" };
    }
    return { blocks: true };
  }
  if (isAlwaysBlockingChar(ch)) return { blocks: true };
  if (HUMAN_CONTEXTS.has(ctx)) return { blocks: false, contextClass: ctx };
  if (DISPLAY_CONTEXTS.has(ctx)) {
    if (isDisplayDecorative(ch)) return { blocks: false, contextClass: ctx };
    if (LETTER_OR_MARK.test(ch)) {
      // Letters/marks (not digits) are advisory ONLY in ts/js string literals and
      // markdown inline code; fences and cat-heredocs never permit them.
      if (ctx === "tsjs-string") return { blocks: false, contextClass: "display-string-letters" };
      if (ctx === "inline-code") return { blocks: false, contextClass: "notation-letters" };
    }
    return { blocks: true };
  }
  return { blocks: true };
}

function codepointLabel(ch: string): string {
  const cp = ch.codePointAt(0);
  return cp === undefined ? "U+????" : `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The full source code point ending immediately before index `i` (surrogate-aware). */
function prevCodePoint(text: string, i: number): string {
  if (i <= 0) return "";
  const before = i - 1;
  const lo = text.charCodeAt(before);
  if (lo >= 0xdc00 && lo <= 0xdfff && before >= 1) {
    const hi = text.charCodeAt(before - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(before - 1, before + 1);
  }
  return text[before] ?? "";
}

// -- File-class resolution ---------------------------------------------------

type FileClass = "tsjs" | "bash" | "markdown" | "yaml" | "json" | "python" | "other";

function fileClassByExt(path: string): FileClass | "unresolved" {
  const base = (path.split("/").at(-1) ?? "").toLowerCase();
  if (base === "package.json" || base.endsWith(".json")) return "json";
  if (base === "skill.md" || base.endsWith(".md") || base.endsWith(".markdown")) return "markdown";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "yaml";
  if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(base)) return "tsjs";
  if (base.endsWith(".py")) return "python";
  if (base.endsWith(".sh")) return "bash";
  return "unresolved";
}

function resolveFileClass(path: string, text: string): FileClass {
  const byExt = fileClassByExt(path);
  if (byExt !== "unresolved") return byExt;
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (/^#!.*\bpython[0-9.]*\b/.test(firstLine)) return "python";
  if (/^#!.*\b(?:bash|sh|zsh|ksh|dash)\b/.test(firstLine)) return "bash";
  if (/^#!.*\b(?:node|bun|deno|ts-node|tsx)\b/.test(firstLine)) return "tsjs";
  return "other";
}

/** A tokenizer callback: reports a non-ASCII char, its context, and the preceding code point. */
type Visit = (ch: string, ctx: Ctx, prev: string) => void;

/** Emit every non-ASCII char of `s` under a single context, tracking source adjacency. */
function emitString(s: string, ctx: Ctx, visit: Visit): void {
  let prev = "";
  for (const ch of s) {
    if (ch.charCodeAt(0) > 127) visit(ch, ctx, prev);
    prev = ch;
  }
}

// -- Tokenizers --------------------------------------------------------------

/**
 * ts/js tokenizer with template-literal interpolation DEPTH tracking (ruling
 * point 3a). A stack of lexical frames distinguishes: content lexically inside a
 * template string (tsjs-string) from code inside `${…}` (code), with strings in
 * that code classified by their own quotes and nested templates handled to any
 * depth. A raw non-ASCII char at a genuine code position stays `code` (blocks).
 * Regex literals are NOT tokenized as strings — their body is `code`, so a
 * detection regex's sentinel chars block here and must be accepted explicitly.
 */
function scanTsJs(text: string, visit: Visit): void {
  type Frame =
    | { kind: "code"; brace: number }
    | { kind: "template" }
    | { kind: "sq" }
    | { kind: "dq" }
    | { kind: "lc" }
    | { kind: "bc" };
  const stack: Frame[] = [{ kind: "code", brace: 0 }];
  let i = 0;
  const n = text.length;
  const visitHi = (ch: string, ctx: Ctx, idx: number): void => {
    if (ch.charCodeAt(0) > 127) visit(ch, ctx, prevCodePoint(text, idx));
  };
  while (i < n) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    const c = text[i];
    if (c === undefined) break;
    if (frame.kind === "code") {
      if (text.startsWith("//", i)) {
        stack.push({ kind: "lc" });
        i += 2;
        continue;
      }
      if (text.startsWith("/*", i)) {
        stack.push({ kind: "bc" });
        i += 2;
        continue;
      }
      if (c === '"') {
        stack.push({ kind: "dq" });
      } else if (c === "'") {
        stack.push({ kind: "sq" });
      } else if (c === "`") {
        stack.push({ kind: "template" });
      } else if (c === "{") {
        frame.brace += 1;
      } else if (c === "}") {
        if (frame.brace > 0) frame.brace -= 1;
        else if (stack.length > 1) stack.pop(); // close a `${…}` interpolation
      } else {
        visitHi(c, "code", i);
      }
      i += 1;
      continue;
    }
    if (frame.kind === "lc") {
      if (c === "\n") stack.pop();
      else visitHi(c, "comment", i);
      i += 1;
      continue;
    }
    if (frame.kind === "bc") {
      if (text.startsWith("*/", i)) {
        stack.pop();
        i += 2;
        continue;
      }
      visitHi(c, "comment", i);
      i += 1;
      continue;
    }
    if (frame.kind === "sq" || frame.kind === "dq") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      const quote = frame.kind === "sq" ? "'" : '"';
      if (c === quote || c === "\n") stack.pop();
      else visitHi(c, "tsjs-string", i);
      i += 1;
      continue;
    }
    // frame.kind === "template"
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      stack.pop();
      i += 1;
      continue;
    }
    if (text.startsWith("${", i)) {
      stack.push({ kind: "code", brace: 0 });
      i += 2;
      continue;
    }
    visitHi(c, "tsjs-string", i);
    i += 1;
  }
}

/** The leading command token of the line containing `opStart` (the `<<` operator). */
function heredocFeedingCommand(text: string, opStart: number): string {
  const lineStart = text.lastIndexOf("\n", opStart) + 1;
  const tokens = text
    .slice(lineStart, opStart)
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return tokens[0] ?? "";
}

/**
 * bash tokenizer. Heredocs are classified by their FEEDING COMMAND (ruling point
 * 3b): a `cat`-fed body (tolerating redirects and quoted/dash delimiters) is
 * "heredoc-display" (DISPLAY); a `python3`-fed body is tokenized with the python
 * scanner; every other feed keeps the blocking "heredoc" context.
 */
function scanBash(text: string, visit: Visit): void {
  let i = 0;
  const n = text.length;
  let state: "code" | "lc" | "sq" | "dq" = "code";
  let atLineStart = true;
  const visitHi = (ch: string, ctx: Ctx, idx: number): void => {
    if (ch.charCodeAt(0) > 127) visit(ch, ctx, prevCodePoint(text, idx));
  };
  while (i < n) {
    const c = text[i];
    if (c === undefined) break;
    if (state === "lc") {
      if (c === "\n") {
        state = "code";
        atLineStart = true;
      } else visitHi(c, "comment", i);
      i += 1;
      continue;
    }
    if (state === "sq") {
      if (c === "'") state = "code";
      else visitHi(c, "string", i);
      atLineStart = false;
      i += 1;
      continue;
    }
    if (state === "dq") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') state = "code";
      else visitHi(c, "string", i);
      atLineStart = false;
      i += 1;
      continue;
    }
    // code
    if (c === "#" && (atLineStart || /\s/.test(text[i - 1] ?? " "))) {
      state = "lc";
      atLineStart = false;
      i += 1;
      continue;
    }
    if (c === "'") {
      state = "sq";
      atLineStart = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      state = "dq";
      atLineStart = false;
      i += 1;
      continue;
    }
    if (text.startsWith("<<", i)) {
      const heredoc = /^<<[-~]?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i, i + 80));
      if (heredoc) {
        const delim = heredoc[2] ?? "";
        const cmd = heredocFeedingCommand(text, i);
        const isPython = /^python[0-9.]*$/.test(cmd);
        const bodyCtx: Ctx = cmd === "cat" ? "heredoc-display" : "heredoc";
        i += heredoc[0].length;
        const opLineEnd = text.indexOf("\n", i);
        if (opLineEnd < 0) {
          i = n;
          continue;
        }
        const bodyStart = opLineEnd + 1;
        let bodyEnd = n;
        let resumeAt = n;
        let k = bodyStart;
        while (k <= n) {
          const nl = text.indexOf("\n", k);
          const lineEnd = nl < 0 ? n : nl;
          if (text.slice(k, lineEnd).trim() === delim) {
            bodyEnd = k;
            resumeAt = nl < 0 ? n : nl;
            break;
          }
          if (nl < 0) break;
          k = nl + 1;
        }
        const body = text.slice(bodyStart, bodyEnd);
        if (isPython) scanPython(body, visit);
        else emitString(body, bodyCtx, visit);
        i = resumeAt;
        atLineStart = true;
        state = "code";
        continue;
      }
    }
    if (c === "\n") {
      atLineStart = true;
      i += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      i += 1; // leading whitespace preserves atLineStart
      continue;
    }
    atLineStart = false;
    visitHi(c, "code", i);
    i += 1;
  }
}

/**
 * Minimal python tokenizer (ruling point 3c), for `*.py` / python-shebang files
 * and python-fed heredoc bodies. `#` line comments and triple-quoted strings
 * (docstrings included) emit "comment"; single/double-quoted strings (f-strings
 * included) emit "string"; everything else is "code". Ambiguity fails to code.
 */
function scanPython(text: string, visit: Visit): void {
  let i = 0;
  const n = text.length;
  let state: "code" | "lc" | "sq" | "dq" | "tsq" | "tdq" = "code";
  const visitHi = (ch: string, ctx: Ctx, idx: number): void => {
    if (ch.charCodeAt(0) > 127) visit(ch, ctx, prevCodePoint(text, idx));
  };
  while (i < n) {
    const c = text[i];
    if (c === undefined) break;
    if (state === "code") {
      if (c === "#") {
        state = "lc";
        i += 1;
        continue;
      }
      if (text.startsWith("'''", i)) {
        state = "tsq";
        i += 3;
        continue;
      }
      if (text.startsWith('"""', i)) {
        state = "tdq";
        i += 3;
        continue;
      }
      if (c === "'") {
        state = "sq";
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "dq";
        i += 1;
        continue;
      }
      visitHi(c, "code", i);
      i += 1;
      continue;
    }
    if (state === "lc") {
      if (c === "\n") state = "code";
      else visitHi(c, "comment", i);
      i += 1;
      continue;
    }
    if (state === "tsq" || state === "tdq") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      const close = state === "tsq" ? "'''" : '"""';
      if (text.startsWith(close, i)) {
        state = "code";
        i += 3;
        continue;
      }
      visitHi(c, "comment", i);
      i += 1;
      continue;
    }
    // single/double-quoted string
    if (c === "\\") {
      i += 2;
      continue;
    }
    const quote = state === "sq" ? "'" : '"';
    if (c === quote || c === "\n") state = "code";
    else visitHi(c, "string", i);
    i += 1;
  }
}

function scanMarkdown(text: string, visit: Visit): void {
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      emitString(line, "fence", visit);
      continue;
    }
    if (inFence) {
      emitString(line, "fence", visit);
      continue;
    }
    let inInline = false;
    let prev = "";
    for (const ch of line) {
      if (ch === "`") {
        inInline = !inInline;
        prev = ch;
        continue;
      }
      if (ch.charCodeAt(0) > 127) visit(ch, inInline ? "inline-code" : "prose", prev);
      prev = ch;
    }
  }
}

function yamlCommentIndex(line: string): number {
  for (let k = 0; k < line.length; k += 1) {
    if (line[k] === "#" && (k === 0 || /\s/.test(line[k - 1] ?? " "))) return k;
  }
  return -1;
}

function scanYaml(text: string, visit: Visit): void {
  for (const rawLine of text.split("\n")) {
    const commentIdx = yamlCommentIndex(rawLine);
    const code = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const comment = commentIdx >= 0 ? rawLine.slice(commentIdx) : "";
    const colon = /:(?:\s|$)/.exec(code);
    const keyPart = colon ? code.slice(0, colon.index) : code;
    const valuePart = colon ? code.slice(colon.index + 1) : "";
    const trimmedValue = valuePart.trim();
    const quoted = trimmedValue.startsWith('"') || trimmedValue.startsWith("'");
    emitString(keyPart, "key", visit);
    emitString(valuePart, quoted ? "string" : "unquoted", visit);
    emitString(comment, "comment", visit);
  }
}

// JSON string values whose KEY is clearly human-facing are advisory; every other
// string (keys, and values of non-human-facing keys) blocks.
const HUMAN_JSON_KEYS: ReadonlySet<string> = new Set([
  "description",
  "short_description",
  "shortdescription",
  "title",
  "summary",
  "detail",
  "message",
  "text",
  "label",
  "hint",
  "placeholder",
  "note",
  "displayname",
]);

function scanJson(text: string, visit: Visit): void {
  let i = 0;
  const n = text.length;
  let lastKey = "";
  while (i < n) {
    const c = text[i];
    if (c === undefined) break;
    if (c === '"') {
      let j = i + 1;
      let str = "";
      while (j < n) {
        const d = text[j];
        if (d === undefined) break;
        if (d === "\\") {
          str += text[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === '"') break;
        str += d;
        j += 1;
      }
      let k = j + 1;
      while (k < n && /\s/.test(text[k] ?? "")) k += 1;
      if (text[k] === ":") {
        lastKey = str;
        emitString(str, "key", visit);
      } else {
        const human = HUMAN_JSON_KEYS.has(lastKey.toLowerCase());
        emitString(str, human ? "string" : "unquoted", visit);
      }
      i = j + 1;
      continue;
    }
    if (c.charCodeAt(0) > 127) visit(c, "code", prevCodePoint(text, i));
    i += 1;
  }
}

function scanOther(text: string, visit: Visit): void {
  // Unrecognized file class: no way to prove any occurrence is prose/comment/
  // string, so every non-ASCII char is unknown-context and blocks.
  emitString(text, "unknown", visit);
}

function scanByClass(path: string, text: string, visit: Visit): void {
  switch (resolveFileClass(path, text)) {
    case "tsjs":
      scanTsJs(text, visit);
      return;
    case "bash":
      scanBash(text, visit);
      return;
    case "python":
      scanPython(text, visit);
      return;
    case "markdown":
      scanMarkdown(text, visit);
      return;
    case "yaml":
      scanYaml(text, visit);
      return;
    case "json":
      scanJson(text, visit);
      return;
    default:
      scanOther(text, visit);
  }
}

// -- Public entry ------------------------------------------------------------

/** One non-ASCII occurrence as the tokenizer saw it (read-only enumeration). */
export interface TypographyOccurrence {
  char: string;
  codepoint: string;
  context: string;
  alwaysBlocking: boolean;
  displayDecorative: boolean;
}

/**
 * Enumerate every non-ASCII occurrence with the SAME tokenizer contexts the
 * verdict uses. Read-only reporting/calibration API — carries no policy of its
 * own (the policy lives in {@link classifyFileTypography}); exists so evidence
 * tooling can analyze rule variants against the real tokenizer instead of
 * approximating contexts.
 */
export function enumerateTypography(path: string, text: string): TypographyOccurrence[] {
  const out: TypographyOccurrence[] = [];
  scanByClass(path, text, (ch, ctx) => {
    out.push({
      char: ch,
      codepoint: codepointLabel(ch),
      context: ctx,
      alwaysBlocking: isAlwaysBlockingChar(ch),
      displayDecorative: isDisplayDecorative(ch),
    });
  });
  return out;
}

/**
 * Classify a file's visible typography. Returns `demote: true` only when the file
 * has ≥1 non-ASCII occurrence and EVERY one is advisory-eligible (visible
 * typography in a proven prose/comment/human-facing-string context, a decorative
 * display char in a fence/inline-code/display-string/cat-heredoc, a letter in a
 * ts/js string or markdown inline code, or an expected emoji presentation
 * selector). One always-blocking char or one unproven-context char yields
 * `demote: false` with the first `blockingReason`.
 */
export function classifyFileTypography(path: string, text: string): FileTypographyVerdict {
  let occurrences = 0;
  let blockingReason: string | undefined;
  const advisoryContexts = new Map<string, number>();
  scanByClass(path, text, (ch, ctx, prev) => {
    occurrences += 1;
    const verdict = classifyOccurrence(ch, ctx, prev);
    if (verdict.blocks) {
      if (blockingReason === undefined) {
        blockingReason = isAlwaysBlockingChar(ch)
          ? `always-block ${codepointLabel(ch)}`
          : `${ctx} ${codepointLabel(ch)}`;
      }
      return;
    }
    const cls = verdict.contextClass ?? ctx;
    advisoryContexts.set(cls, (advisoryContexts.get(cls) ?? 0) + 1);
  });
  const demote = occurrences > 0 && blockingReason === undefined;
  let contextClass: string | undefined;
  if (demote) {
    // Dominant advisory class: highest count, with the specialized classes
    // (emoji-selector, notation/display-string letters) winning a tie so the
    // demotion reason names the rule that actually applied.
    let best = "visible-typography";
    let bestCount = -1;
    let bestPriority = -1;
    for (const [cls, count] of advisoryContexts) {
      const priority = CONTEXT_CLASS_PRIORITY[cls] ?? 0;
      if (count > bestCount || (count === bestCount && priority > bestPriority)) {
        best = cls;
        bestCount = count;
        bestPriority = priority;
      }
    }
    contextClass = best;
  }
  return { demote, occurrences, contextClass, blockingReason };
}

// -- Sentinel-literal line-shape proof (ruling point 5) ----------------------

/** The verdict of {@link classifySentinelLineShape}. */
export type SentinelLineShape = "detection-replacement" | "other";

function hasQuotedString(s: string): boolean {
  return /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/.test(s);
}

/** A `/[ … ]/flags` regex character class anywhere on the line. */
function hasCharClassRegex(s: string): boolean {
  return /\/\[[^\n]*?\][a-z]*/.test(s);
}

/** A `.replace(...)` / `.replaceAll(...)` whose sentinel is a regex or string VALUE. */
function isReplaceCall(s: string): boolean {
  if (!/\.replace(?:All)?\s*\(/.test(s)) return false;
  return hasCharClassRegex(s) || /\/[^/\n]+\/[a-z]*/.test(s) || hasQuotedString(s);
}

/** A regex literal in detection position (character class, or `= /…/` / `return /…/`). */
function isDetectionRegex(s: string): boolean {
  if (hasCharClassRegex(s)) return true;
  return /(?:[=(,:]|\breturn\b)\s*\/[^/\n*][^\n]*\/[a-z]*\s*[);,]?/.test(s);
}

/**
 * A named DATA constant whose value is a string / char / array-of-strings literal
 * — a sentinel marker or lookup/replacement table (e.g. `const ENVELOPE_BEGIN =
 * '═══ … ═══'`). The RHS must START with a string, template, or array literal, so
 * an identifier/call/path/key/expression assignment is NOT a table.
 */
function isNamedConstantValue(s: string): boolean {
  const match =
    /^\s*(?:export\s+)?(?:const|let|var|readonly|static|public|private)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(.+)$/.exec(
      s,
    );
  if (match === null) return false;
  const rhs = (match[1] ?? "").trim();
  if (/^\[/.test(rhs) && hasQuotedString(rhs)) return true; // array table
  if (/^["'`]/.test(rhs)) return true; // scalar string / char sentinel
  return false;
}

/** A shell command or an import/require/module-path line (special char in NON-value position). */
function isCommandOrPathShape(s: string): boolean {
  if (/^\s*(?:import|export)\b[^=]*\bfrom\b/.test(s)) return true;
  if (/\brequire\s*\(/.test(s)) return true;
  if (/<<[-~]?\s*["']?[A-Za-z_]/.test(s)) return true; // heredoc operator
  if (
    /^\s*(?:sudo\s+)?(?:cat|rm|cp|mv|ln|curl|wget|bash|sh|zsh|echo|export|source|eval|exec|chmod|chown|mkdir|ssh|scp|git|npm|pnpm|yarn|node|deno|python[0-9.]*)\b/.test(
      s,
    ) &&
    !/\.replace(?:All)?\s*\(/.test(s) &&
    !hasCharClassRegex(s)
  ) {
    return true;
  }
  return false;
}

/**
 * Classify a single source LINE as carrying its special/hidden characters as an
 * explicit detection/replacement VALUE ("detection-replacement") or not
 * ("other"), the rule-8 proof that an EXPECTED_SANITIZER_SENTINEL_LITERAL
 * acceptance rests on: acceptance is valid ONLY where the characters are regex
 * literals, `.replace(...)` operands, or named string/char-constant tables — and
 * NOT executable identifiers, commands, paths, keys, or syntax. Fails closed to
 * "other" for anything unrecognized, and treats command/import/path shapes as
 * "other" even if they superficially resemble a value.
 */
export function classifySentinelLineShape(line: string): SentinelLineShape {
  const s = line.trim();
  if (s.length === 0) return "other";
  // Explicit non-value shapes first: a special char used as command/import/path
  // is never a benign sentinel value.
  if (isCommandOrPathShape(s)) return "other";
  if (isReplaceCall(s)) return "detection-replacement";
  if (isDetectionRegex(s)) return "detection-replacement";
  if (isNamedConstantValue(s)) return "detection-replacement";
  return "other";
}
