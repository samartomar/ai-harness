/**
 * Deterministic weak-model-safety lint for aih's OWN generated markdown (the
 * Layer-2 canon: RULE_ROUTER, bootloaders, adapters, Kiro steering).
 *
 * Regex rules and word lists are ported verbatim from @razroo/isolint v1.4.1
 * (MIT — https://github.com/razroo/isolint, `dist/lint/rules/deterministic.js`):
 * soft-imperative, taste-word, ambiguous-deictic, enum-without-list,
 * trailing-etc, context-budget, placeholder-leftover. Reference resolution is
 * adapted to aih's planned-path model: aih KNOWS the set of files a plan will
 * write, so a forward reference to a not-yet-written canon file resolves on a
 * fresh repo (strictly better than isolint's repo-walk). `skeleton-unfilled` is
 * aih-native (isolint's placeholder rule is a deliberate no-op on aih's
 * `_italic_` skeletons).
 *
 * No AST, no mdast dependency, no LLM — pure regex over content aih authored.
 */

/** A finding's weight. `fail` flips the verify exit code; `info` is report-only. */
export type LintSeverity = "fail" | "info";

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  message: string;
}

/** Context a rule needs: where it lives + how to resolve a file reference. */
export interface LintRuleCtx {
  /** Repo-relative (POSIX) path of the doc being linted. */
  path: string;
  /** Canonical POSIX paths this plan will write (forward refs resolve against it). */
  plannedPaths: ReadonlySet<string>;
  /** existsSync(join(root, relPath)) — for refs to pre-existing repo files. */
  fileExists: (relPath: string) => boolean;
  /**
   * The canon context dir (e.g. `ai-coding`). `canon-ref-resolves` enforces
   * resolution only for CANON references — bare basenames or paths under this dir.
   * A slashed ref pointing elsewhere (`apps/x`, `.claude/y`, `src/z`) is the doc
   * citing repo evidence, not a broken canon link, so it is left alone.
   */
  contextDir: string;
}

export interface LintRule {
  id: string;
  severity: LintSeverity;
  /** Gate a rule to the docs it makes sense for (by repo-relative path). */
  appliesTo: (path: string) => boolean;
  run: (src: string, ctx: LintRuleCtx) => LintFinding[];
}

// ---- skip intervals (ported concept from isolint source.js) ---------------

type Interval = [number, number];

/**
 * Byte ranges a prose rule must NOT scan: fenced code blocks, inline code spans,
 * and HTML comments. Mirrors isolint's `computeSkipIntervals` (fenced + inline)
 * plus HTML comments (aih wraps its managed blocks in `<!-- … -->`).
 */
export function skipIntervals(src: string): Interval[] {
  const intervals: Interval[] = [];
  const push = (re: RegExp): void => {
    re.lastIndex = 0;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      intervals.push([m.index, m.index + m[0].length]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  };
  push(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1[^\S\n]*$/gm); // fenced code
  push(/`[^`\n]+`/g); // inline code
  push(/<!--[\s\S]*?-->/g); // HTML comments (managed-block markers)
  return intervals;
}

function inSkip(index: number, intervals: readonly Interval[]): boolean {
  return intervals.some(([start, end]) => index >= start && index < end);
}

/** Iterate a global regex's matches, skipping any inside a skip interval. */
function* scanMatches(
  src: string,
  pattern: RegExp,
  skips: readonly Interval[],
): Generator<RegExpExecArray> {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m.index === re.lastIndex) re.lastIndex++;
    if (!inSkip(m.index, skips)) yield m;
  }
}

// ---- word lists / regexes (lifted verbatim from isolint deterministic.js) --

/** soft-imperative (deterministic.js) — replace with MUST/ALWAYS/NEVER. */
const SOFT_WORDS = [
  "should",
  "could",
  "might",
  "may want to",
  "consider",
  "perhaps",
  "probably",
  "ideally",
  "preferably",
];

/** taste-word builtin list (deterministic.js) — untestable adjectives. */
const TASTE_WORDS = [
  "creative",
  "engaging",
  "appropriate",
  "polished",
  "natural",
  "nice",
  "good",
  "great",
  "feel free",
  "as needed",
  "when relevant",
  "if appropriate",
  "as appropriate",
  "passionate",
  "leveraged",
  "utilized",
  "spearheaded",
  "cutting-edge",
  "world-class",
  "best-in-class",
];

const SOFT_RE = new RegExp(`\\b(${SOFT_WORDS.join("|")})\\b`, "gi");
const TASTE_RE = new RegExp(`\\b(${TASTE_WORDS.join("|")})\\b`, "gi");
const DEICTIC_RE =
  /\b(the section above|section below|above section|below section|as mentioned above|as noted above|as described below|the table above|the table below)\b/gi;
const ENUM_RE =
  /\bone of (?:the )?(?:usual|standard|typical|common|known) (?:categories|values|options|types)\b/gi;
const TRAILING_ETC_RE = /\b(etc\.?|and so on|and such)\b/gi;
const PLACEHOLDER_KEYWORDS_RE = /\b(TODO|FIXME|TBD|XXX|HACK|WIP)\b/g;
const PLACEHOLDER_ANGLE_RE =
  /<(insert[^>\n]*|placeholder[^>\n]*|your [^>\n]+|fill in[^>\n]*|TBD|TODO)>/gi;
const PLACEHOLDER_SQUARE_RE =
  /\[(INSERT[^\]\n]*|PLACEHOLDER[^\]\n]*|YOUR [^\]\n]+|FILL IN[^\]\n]*|TBD|TODO)\]/g;

// ---- reference resolution (adapted from missing-file/stale-link rules) ------

/** A backtick-wrapped pure path: `` `ai-coding/RULE_ROUTER.md` `` (not a command). */
const BACKTICK_PATH_RE = /`([\w\-./]+\.(?:md|mdc|mdx|json|ya?ml|txt))`/g;
/** Kiro live-reference: `#[[file:ai-coding/RULE_ROUTER.md]]`. */
const KIRO_REF_RE = /#\[\[file:([^\]\n]+)\]\]/g;
const LOCAL_FILE_URL_RE = /\bfile:\/\/\/[^\s)]+/gi;
const WINDOWS_ABSOLUTE_PATH_RE = /(?:^|[`(\s])([A-Za-z]:[\\/][^\s`)]+)/g;

/**
 * Canon files the harness's own context system emits across SIBLING commands
 * (`aih scaffold` / `aih workspace`) that `bootstrap-ai` legitimately references
 * but does not itself write. A reference to one of these is valid by
 * construction even on a fresh repo where only `bootstrap-ai` has run. Keyed by
 * basename so a `ai-coding/architecture.md` ref resolves regardless of contextDir.
 */
const KNOWN_SIBLING_CANON: ReadonlySet<string> = new Set([
  // The compact repo contract — emitted by the sibling `aih contract` phase, which
  // the compact RULE_ROUTER / bootloaders reference but bootstrap-ai does not write.
  "project.json",
  "project.md",
  "setup.md",
  // The legacy doc family — emitted by `aih scaffold --canon legacy`.
  "INDEX.md",
  "architecture.md",
  "conventions.md",
  "tasks.md",
  "SETUP-TASKS.md",
  "project-guardrails.md",
  "cross-repo-architecture.md",
  "repo-discipline.md",
]);

/**
 * Tool entry files that aih's canon docs (`other-tools.md`, `harness-update.md`,
 * the adapters) legitimately reference as "here is where tool X keeps its config" —
 * the root bootloaders plus other tools' native config paths. These are
 * illustrative cross-tool mentions, NOT intra-canon links: aih writes a bootloader
 * only for a TARGETED tool, so a claude-only repo names `GEMINI.md` / Copilot /
 * Kiro paths without them existing. A bounded, curated vocabulary — a genuine typo
 * in an `ai-coding/…` path (or a misspelled bootloader) is still caught.
 */
const KNOWN_TOOL_NATIVE: ReadonlySet<string> = new Set([
  // root bootloaders (written only for the targeted tool)
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  // other tools' native entry files
  ".github/copilot-instructions.md",
  ".kiro/steering/00-canon.md",
  ".windsurfrules",
]);

/** Normalize a reference to a repo-relative POSIX path for set lookup. */
function normalizeRef(ref: string): string {
  return ref.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** A placeholder/glob, not a concrete file — e.g. `#[[file:...]]`, `<your-tool>.md`, `*.mdc`. */
function isPlaceholderRef(ref: string): boolean {
  const norm = normalizeRef(ref);
  return /[<>*]/.test(ref) || norm.split("/").some((part) => part.includes("..."));
}

/** A concrete reference that escapes the repo/context boundary, not a placeholder. */
function isEscapingRef(ref: string): boolean {
  const norm = normalizeRef(ref);
  return norm.startsWith("/") || /^[A-Za-z]:\//.test(norm) || norm.split("/").includes("..");
}

/**
 * Does a referenced path resolve? Adapts isolint's missing-file rule (which does a
 * basename fallback "for leniency") to aih's model: aih emits paths both
 * dir-prefixed (`ai-coding/RULE_ROUTER.md`) and bare (`RULE_ROUTER.md`), so an
 * exact-OR-basename match against the planned/on-disk set — plus the known
 * sibling-canon vocabulary — is what avoids false positives without losing the
 * ability to catch a genuine typo (`RULE_ROUTERR.md`).
 */
function refResolves(ref: string, ctx: LintRuleCtx): boolean {
  const norm = normalizeRef(ref);
  if (ctx.plannedPaths.has(norm) || ctx.fileExists(norm)) return true;
  if (KNOWN_TOOL_NATIVE.has(norm)) return true; // illustrative other-tool entry file
  const base = basename(norm);
  if (KNOWN_SIBLING_CANON.has(base)) return true;
  for (const p of ctx.plannedPaths) if (basename(p) === base) return true;
  return false;
}

// ---- the rule set ----------------------------------------------------------

const PROSE = (): boolean => true; // every canon doc aih emits is prose
const isScaffoldContext = (path: string): boolean =>
  /(?:^|\/)(architecture|conventions|project-guardrails)\.md$/i.test(path);

/** Count words after stripping fenced code + frontmatter (isolint context-budget). */
function proseWordCount(src: string): number {
  const stripped = src
    .replace(/^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1\r?\n/, "")
    .replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1[^\S\n]*$/gm, "");
  const words = stripped.match(/\S+/g);
  return words ? words.length : 0;
}

/** info at 1500 words, the isolint default lower bound (weak models drop the middle). */
const CONTEXT_BUDGET_INFO_WORDS = 1500;

function wordRule(id: string, re: RegExp, severity: LintSeverity, hint: string): LintRule {
  return {
    id,
    severity,
    appliesTo: PROSE,
    run: (src) => {
      const skips = skipIntervals(src);
      const seen = new Set<string>();
      const out: LintFinding[] = [];
      for (const m of scanMatches(src, re, skips)) {
        const word = m[0].toLowerCase();
        if (seen.has(word)) continue; // one finding per distinct phrase, keeps detail short
        seen.add(word);
        out.push({ ruleId: id, severity, message: `"${m[0]}" — ${hint}` });
      }
      return out;
    },
  };
}

export const RULES: LintRule[] = [
  // Bucket A — reference resolution (the highest-value, aih-specific). FAIL.
  {
    id: "canon-ref-resolves",
    severity: "fail",
    appliesTo: PROSE,
    run: (src, ctx) => {
      const out: LintFinding[] = [];
      const check = (ref: string): void => {
        if (/^(https?|mailto|tel|data):/i.test(ref) || ref.startsWith("#")) return;
        if (isEscapingRef(ref)) {
          out.push({
            ruleId: "canon-ref-resolves",
            severity: "fail",
            message: `references \`${ref}\` outside the target repository/context root`,
          });
          return;
        }
        if (isPlaceholderRef(ref)) return; // syntax-doc placeholder / glob, not a real path
        // Only CANON refs are enforced: a bare basename (`RULE_ROUTER.md`) or a path
        // under the context dir. A slashed ref elsewhere (`apps/web/package.json`,
        // `.claude/rules/x.mdc`) is the doc citing repo evidence — adopted/migrated
        // user content does this constantly — not a broken canon link to police.
        const refNorm = normalizeRef(ref);
        if (refNorm.includes("/") && !refNorm.startsWith(`${ctx.contextDir}/`)) return;
        if (!refResolves(ref, ctx)) {
          out.push({
            ruleId: "canon-ref-resolves",
            severity: "fail",
            message: `references \`${ref}\` which the harness neither writes nor finds on disk`,
          });
        }
      };
      for (const m of src.matchAll(BACKTICK_PATH_RE)) check(m[1] as string);
      for (const m of src.matchAll(KIRO_REF_RE)) check(m[1] as string);
      return out;
    },
  },
  {
    id: "portable-repo-paths",
    severity: "fail",
    appliesTo: PROSE,
    run: (src) => {
      const out: LintFinding[] = [];
      const add = (ref: string): void => {
        out.push({
          ruleId: "portable-repo-paths",
          severity: "fail",
          message: `uses machine-local path \`${ref}\` — cite repo-relative paths only`,
        });
      };
      for (const m of src.matchAll(LOCAL_FILE_URL_RE)) add(m[0]);
      for (const m of src.matchAll(WINDOWS_ABSOLUTE_PATH_RE)) add(m[1] as string);
      return out;
    },
  },

  // Bucket B — weak-model prose safety. Advisory (info → report-only `skip`): these
  // are a regression signal on FUTURE edits, not a CI blocker on aih's existing
  // hand-tuned canon (which predates this standard and legitimately uses "should").
  // Promote to `fail` only after a deliberate canon-prose cleanup pass.
  wordRule(
    "soft-imperative",
    SOFT_RE,
    "info",
    "prefer MUST / ALWAYS / NEVER over a soft imperative",
  ),
  wordRule("taste-word", TASTE_RE, "info", "untestable taste word; prefer a measurable constraint"),
  wordRule("enum-without-list", ENUM_RE, "info", "list the allowed values inline"),
  wordRule(
    "trailing-etc",
    TRAILING_ETC_RE,
    "info",
    "close the set; weak models invent values past it",
  ),
  wordRule(
    "ambiguous-deictic",
    DEICTIC_RE,
    "info",
    "prefer an explicit reference over above/below",
  ),
  {
    id: "context-budget",
    severity: "info",
    appliesTo: PROSE,
    run: (src) => {
      const words = proseWordCount(src);
      return words > CONTEXT_BUDGET_INFO_WORDS
        ? [
            {
              ruleId: "context-budget",
              severity: "info",
              message: `~${words} words of prose — weak models drop the middle of long context`,
            },
          ]
        : [];
    },
  },

  // Bucket C — placeholder / skeleton.
  // placeholder-leftover: belt-and-suspenders FAIL (aih never emits these). Verbatim isolint.
  {
    id: "placeholder-leftover",
    severity: "fail",
    appliesTo: PROSE,
    run: (src) => {
      const skips = skipIntervals(src);
      const out: LintFinding[] = [];
      const add = (m: RegExpExecArray): void => {
        out.push({
          ruleId: "placeholder-leftover",
          severity: "fail",
          message: `"${m[0]}" is leftover scaffolding — weak models echo it verbatim`,
        });
      };
      for (const m of scanMatches(src, PLACEHOLDER_KEYWORDS_RE, skips)) add(m);
      for (const m of scanMatches(src, PLACEHOLDER_ANGLE_RE, skips)) add(m);
      for (const m of scanMatches(src, PLACEHOLDER_SQUARE_RE, skips)) add(m);
      return out;
    },
  },
  // skeleton-unfilled: aih-native. A scaffolded context file still carrying the
  // literal italic skeleton sentinels aih emits means setup hasn't run. INFO
  // (you can't fail a user for not having filled context yet).
  {
    id: "skeleton-unfilled",
    severity: "info",
    appliesTo: isScaffoldContext,
    run: (src) => {
      const skips = skipIntervals(src);
      // A line that is ONLY an italic placeholder, e.g. `_Expand: what this does…_`
      const re = /^_[^_\n].*_$/gm;
      const hits = [...scanMatches(src, re, skips)];
      return hits.length > 0
        ? [
            {
              ruleId: "skeleton-unfilled",
              severity: "info",
              message: "context still carries skeleton placeholders — run the SETUP-TASKS playbook",
            },
          ]
        : [];
    },
  },
];

/** Run every applicable rule over one doc. */
export function lintDoc(path: string, source: string, ctx: LintRuleCtx): LintFinding[] {
  return RULES.filter((r) => r.appliesTo(path)).flatMap((r) => r.run(source, ctx));
}
