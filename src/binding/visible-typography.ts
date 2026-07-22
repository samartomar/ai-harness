/**
 * Gate-layer visible-typography reclassifier (W5 rule-8 ruling, 2026-07-21).
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

function isAlwaysBlockingChar(ch: string): boolean {
  if (ALWAYS_BLOCK_CATEGORY.test(ch)) return true;
  const cp = ch.codePointAt(0);
  return cp !== undefined && SUSPICIOUS_WHITESPACE.has(cp);
}

// A char that is safe as DISPLAY-only content (markdown code fences / inline code):
// a decorative symbol (\p{S}: box-drawing, block elements, arrows, stars) or a dash
// (\p{Pd}: em/en dash). Letters, digits, marks, and confusable quotes are NOT safe
// here — a homoglyph attack in a copy-pasteable fenced command needs one of those.
const DISPLAY_DECORATIVE = /[\p{S}\p{Pd}]/u;

function isDisplayDecorative(ch: string): boolean {
  return DISPLAY_DECORATIVE.test(ch);
}

// -- Context model -----------------------------------------------------------

// Context labels a tokenizer may emit for a non-ASCII occurrence. HUMAN contexts
// are advisory for ANY non-always-block char; DISPLAY contexts are advisory only
// for decorative chars; everything else blocks.
type Ctx =
  | "prose"
  | "comment"
  | "string"
  | "tsjs-string" // ts/js string-literal content: blocking (ruling), labeled distinctly for calibration evidence
  | "fence"
  | "inline-code"
  | "code"
  | "heredoc"
  | "key"
  | "unquoted"
  | "unknown";

const HUMAN_CONTEXTS: ReadonlySet<Ctx> = new Set<Ctx>(["prose", "comment", "string"]);
const DISPLAY_CONTEXTS: ReadonlySet<Ctx> = new Set<Ctx>(["fence", "inline-code"]);

/** Whether one occurrence blocks. Always-block chars override context entirely. */
function occurrenceBlocks(ch: string, ctx: Ctx): boolean {
  if (isAlwaysBlockingChar(ch)) return true;
  if (HUMAN_CONTEXTS.has(ctx)) return false;
  if (DISPLAY_CONTEXTS.has(ctx)) return !isDisplayDecorative(ch);
  return true;
}

function codepointLabel(ch: string): string {
  const cp = ch.codePointAt(0);
  return cp === undefined ? "U+????" : `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

// -- File-class resolution ---------------------------------------------------

type FileClass = "tsjs" | "bash" | "markdown" | "yaml" | "json" | "other";

function fileClassByExt(path: string): FileClass | "unresolved" {
  const base = (path.split("/").at(-1) ?? "").toLowerCase();
  if (base === "package.json" || base.endsWith(".json")) return "json";
  if (base === "skill.md" || base.endsWith(".md") || base.endsWith(".markdown")) return "markdown";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "yaml";
  if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(base)) return "tsjs";
  if (base.endsWith(".sh")) return "bash";
  return "unresolved";
}

function resolveFileClass(path: string, text: string): FileClass {
  const byExt = fileClassByExt(path);
  if (byExt !== "unresolved") return byExt;
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (/^#!.*\b(?:bash|sh|zsh|ksh|dash)\b/.test(firstLine)) return "bash";
  if (/^#!.*\b(?:node|bun|deno|ts-node|tsx)\b/.test(firstLine)) return "tsjs";
  return "other";
}

type Visit = (ch: string, ctx: Ctx) => void;

// -- Tokenizers --------------------------------------------------------------

function scanTsJs(text: string, visit: Visit): void {
  let i = 0;
  const n = text.length;
  let state: "code" | "lc" | "bc" | "sq" | "dq" | "tp" = "code";
  while (i < n) {
    const c = text[i];
    if (c === undefined) break;
    if (state === "code") {
      if (text.startsWith("//", i)) {
        state = "lc";
        i += 2;
        continue;
      }
      if (text.startsWith("/*", i)) {
        state = "bc";
        i += 2;
        continue;
      }
      if (c === '"') {
        state = "dq";
      } else if (c === "'") {
        state = "sq";
      } else if (c === "`") {
        state = "tp";
      } else if (c.charCodeAt(0) > 127) {
        visit(c, "code");
      }
      i += 1;
      continue;
    }
    if (state === "lc") {
      if (c === "\n") state = "code";
      else if (c.charCodeAt(0) > 127) visit(c, "comment");
      i += 1;
      continue;
    }
    if (state === "bc") {
      if (text.startsWith("*/", i)) {
        state = "code";
        i += 2;
        continue;
      }
      // Block-comment body — including `*`-prefixed continuation lines and JSDoc/
      // banner lines — is comment. This is the case the coarse report missed.
      if (c.charCodeAt(0) > 127) visit(c, "comment");
      i += 1;
      continue;
    }
    // string states: sq / dq / tp
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (state === "dq" && c === '"') state = "code";
    else if (state === "sq" && c === "'") state = "code";
    else if (state === "tp" && c === "`") state = "code";
    else if ((state === "dq" || state === "sq") && c === "\n") state = "code";
    else if (c.charCodeAt(0) > 127) visit(c, "tsjs-string"); // NOT advisory (ruling); distinct label for evidence
    i += 1;
  }
}

function scanBash(text: string, visit: Visit): void {
  let i = 0;
  const n = text.length;
  let state: "code" | "lc" | "sq" | "dq" | "heredoc" = "code";
  let heredocDelim = "";
  let atLineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === undefined) break;
    if (state === "heredoc") {
      if (atLineStart) {
        const nl = text.indexOf("\n", i);
        const line = (nl < 0 ? text.slice(i) : text.slice(i, nl)).trim();
        if (line === heredocDelim) {
          state = "code";
          i = nl < 0 ? n : nl;
          atLineStart = false;
          continue;
        }
      }
      if (c === "\n") atLineStart = true;
      else {
        atLineStart = false;
        if (c.charCodeAt(0) > 127) visit(c, "heredoc");
      }
      i += 1;
      continue;
    }
    if (state === "lc") {
      if (c === "\n") {
        state = "code";
        atLineStart = true;
      } else if (c.charCodeAt(0) > 127) visit(c, "comment");
      i += 1;
      continue;
    }
    if (state === "sq") {
      if (c === "'") state = "code";
      else if (c.charCodeAt(0) > 127) visit(c, "string");
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
      else if (c.charCodeAt(0) > 127) visit(c, "string");
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
        heredocDelim = heredoc[2] ?? "";
        state = "heredoc";
        atLineStart = false;
        i += heredoc[0].length;
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
    if (c.charCodeAt(0) > 127) visit(c, "code");
    i += 1;
  }
}

function scanMarkdown(text: string, visit: Visit): void {
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      for (const ch of line) if (ch.charCodeAt(0) > 127) visit(ch, "fence");
      continue;
    }
    if (inFence) {
      for (const ch of line) if (ch.charCodeAt(0) > 127) visit(ch, "fence");
      continue;
    }
    let inInline = false;
    for (const ch of line) {
      if (ch === "`") {
        inInline = !inInline;
        continue;
      }
      if (ch.charCodeAt(0) > 127) visit(ch, inInline ? "inline-code" : "prose");
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
    for (const ch of keyPart) if (ch.charCodeAt(0) > 127) visit(ch, "key");
    const trimmedValue = valuePart.trim();
    const quoted = trimmedValue.startsWith('"') || trimmedValue.startsWith("'");
    for (const ch of valuePart)
      if (ch.charCodeAt(0) > 127) visit(ch, quoted ? "string" : "unquoted");
    for (const ch of comment) if (ch.charCodeAt(0) > 127) visit(ch, "comment");
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
        for (const ch of str) if (ch.charCodeAt(0) > 127) visit(ch, "key");
      } else {
        const human = HUMAN_JSON_KEYS.has(lastKey.toLowerCase());
        for (const ch of str) if (ch.charCodeAt(0) > 127) visit(ch, human ? "string" : "unquoted");
      }
      i = j + 1;
      continue;
    }
    if (c.charCodeAt(0) > 127) visit(c, "code");
    i += 1;
  }
}

function scanOther(text: string, visit: Visit): void {
  // Unrecognized file class: no way to prove any occurrence is prose/comment/
  // string, so every non-ASCII char is unknown-context and blocks.
  for (const ch of text) if (ch.charCodeAt(0) > 127) visit(ch, "unknown");
}

function scanByClass(path: string, text: string, visit: Visit): void {
  switch (resolveFileClass(path, text)) {
    case "tsjs":
      scanTsJs(text, visit);
      return;
    case "bash":
      scanBash(text, visit);
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
 * typography in a proven prose/comment/human-facing-string context, or a
 * decorative display char in a markdown fence). One always-blocking char or one
 * unproven-context char yields `demote: false` with the first `blockingReason`.
 */
export function classifyFileTypography(path: string, text: string): FileTypographyVerdict {
  let occurrences = 0;
  let blockingReason: string | undefined;
  const advisoryContexts = new Map<string, number>();
  scanByClass(path, text, (ch, ctx) => {
    occurrences += 1;
    if (occurrenceBlocks(ch, ctx)) {
      if (blockingReason === undefined) {
        blockingReason = isAlwaysBlockingChar(ch)
          ? `always-block ${codepointLabel(ch)}`
          : `${ctx} ${codepointLabel(ch)}`;
      }
      return;
    }
    advisoryContexts.set(ctx, (advisoryContexts.get(ctx) ?? 0) + 1);
  });
  const demote = occurrences > 0 && blockingReason === undefined;
  let contextClass: string | undefined;
  if (demote) {
    let best = "visible-typography";
    let bestCount = -1;
    for (const [ctx, count] of advisoryContexts) {
      if (count > bestCount) {
        best = ctx;
        bestCount = count;
      }
    }
    contextClass = best;
  }
  return { demote, occurrences, contextClass, blockingReason };
}
