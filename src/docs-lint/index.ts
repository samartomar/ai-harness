import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { plan, probeMany } from "../internals/plan.js";
import type { Check, CheckCode, Verdict } from "../internals/verify.js";

const SLOP_LINT_REL = join("packs", "docs-quality", "betterdoc", "references", "slop-lint.md");
const CONTROL_MATRIX_REL = join("docs", "CONTROL_MATRIX.md");
const DEFAULT_ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
const DEFAULT_DOC_DIRS = ["docs", "guides"];
const SKIP_REL_DIRS = new Set([join("docs", "specs")]);
const SKIP_DIRS = new Set([".git", ".aih", "node_modules", "dist", "coverage"]);
const MAX_DOC_BYTES = 1_000_000;
const MAX_FINDINGS = 200;
const CLAIM_ID_RE = /^CM-\d{2,}$/;
const CLAIM_MARKER_RE = /<!--\s*aih:claim(?:\s+([A-Za-z0-9-]+))?\s*-->/gi;
const FEATURE_SOURCE_RE = /^src\/(?!commands\/|internals\/).+\.ts$/;
const DOCS_LEDGER_RE = /^(README\.md|CHANGELOG\.md|docs\/.*\.md|guides\/.*\.md)$/;

type DocsLintCode =
  | Extract<CheckCode, "docs.banned-phrase">
  | Extract<CheckCode, "docs.vague-absolute">
  | Extract<CheckCode, "docs.unsupported-callout-claim">
  | Extract<CheckCode, "docs.claim-mapping-missing">
  | Extract<CheckCode, "docs.claim-matrix-row-missing">
  | Extract<CheckCode, "docs.claim-test-missing">
  | Extract<CheckCode, "docs.feature-ledger-drift">;

interface PhraseRuleSpec {
  heading: string;
  cue: string;
  label: string;
}

interface PhraseRule {
  phrase: string;
  label: string;
  heading: string;
}

interface DocsLintRules {
  source: string;
  phrases: PhraseRule[];
}

interface DocsLintFinding {
  code: DocsLintCode;
  verdict: Exclude<Verdict, "pass">;
  relative: string;
  line: number;
  detail: string;
  fingerprint: string;
}

interface MatrixTestRef {
  path: string;
  name: string;
}

interface MatrixRow {
  id: string;
  line: number;
  proof: string;
  refs: MatrixTestRef[];
}

interface ControlMatrix {
  rows: Map<string, MatrixRow>;
  findings: DocsLintFinding[];
}

const PHRASE_RULE_SPECS: PhraseRuleSpec[] = [
  {
    heading: "Cut Throat-Clearing",
    cue: "Usually cut:",
    label: "throat-clearing phrase",
  },
  {
    heading: "Remove Empty Emphasis",
    cue: "Usually cut:",
    label: "empty emphasis phrase",
  },
  {
    heading: "Replace Business Jargon",
    cue: "Prefer concrete verbs over:",
    label: "business jargon",
  },
  {
    heading: "Adverbs and Qualifiers",
    cue: "Cut empty intensifiers:",
    label: "empty intensifier",
  },
  {
    heading: "Rhetorical Setups",
    cue: "Usually cut:",
    label: "rhetorical setup",
  },
];

const HIGH_RISK_CALLOUT_CLAIMS = [
  "production-ready",
  "enterprise-ready",
  "compliant",
  "certified",
  "audited",
  "guaranteed",
  "secure by default",
  "zero risk",
  "slsa",
];

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRelativeTo(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function contained(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ruleSourceLabel(root: string, abs: string): string {
  if (isRelativeTo(root, abs)) return toPosix(relative(root, abs));
  if (isRelativeTo(process.cwd(), abs)) return toPosix(relative(process.cwd(), abs));
  return toPosix(SLOP_LINT_REL);
}

function readText(abs: string): string | undefined {
  const file = readRegularFileWithStats(abs);
  if (file === undefined || file.stats.size > MAX_DOC_BYTES) return undefined;
  return file.contents.toString("utf8");
}

function ruleCandidates(root: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(root, SLOP_LINT_REL),
    join(process.cwd(), SLOP_LINT_REL),
    join(here, "..", "packs", "docs-quality", "betterdoc", "references", "slop-lint.md"),
    join(here, "..", "..", "packs", "docs-quality", "betterdoc", "references", "slop-lint.md"),
  ];
}

function findRuleSource(root: string): { path: string; text: string } | undefined {
  const seen = new Set<string>();
  for (const candidate of ruleCandidates(root).map((p) => resolve(p))) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const text = readText(candidate);
    if (text !== undefined) return { path: candidate, text };
  }
  return undefined;
}

function markdownSection(source: string, heading: string): string {
  const pattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m");
  const match = pattern.exec(source);
  if (match === null) return "";
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const next = /^##\s+/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

function normalizeListItem(line: string): string | undefined {
  const item = line
    .replace(/^\s*-\s+/, "")
    .replaceAll("`", "")
    .trim()
    .replace(/[,.]\s*$/, "")
    .replace(/\.{3}\s*$/, "")
    .trim();
  return item.length >= 3 ? item : undefined;
}

function listAfter(section: string, cue: string): string[] {
  const cueIndex = section.indexOf(cue);
  if (cueIndex < 0) return [];
  const out: string[] = [];
  let collecting = false;
  for (const line of section.slice(cueIndex + cue.length).split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line)) {
      const item = normalizeListItem(line);
      if (item !== undefined) out.push(item);
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (line.trim().length === 0) continue;
    break;
  }
  return out;
}

export function loadDocsLintRules(root: string): DocsLintRules | undefined {
  const source = findRuleSource(root);
  if (source === undefined) return undefined;
  const phrases = PHRASE_RULE_SPECS.flatMap((spec) =>
    listAfter(markdownSection(source.text, spec.heading), spec.cue).map((phrase) => ({
      phrase,
      label: spec.label,
      heading: spec.heading,
    })),
  );
  return {
    source: ruleSourceLabel(root, source.path),
    phrases,
  };
}

function isMarkdownFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".md" || ext === ".mdx";
}

function collectMarkdownFiles(root: string): string[] {
  const out = new Set<string>();
  const addFile = (abs: string): void => {
    if (isMarkdownFile(abs)) out.add(abs);
  };
  const walk = (abs: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const child = join(abs, entry);
      if (SKIP_REL_DIRS.has(relative(root, child))) continue;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(child);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) addFile(child);
    }
  };
  for (const rel of DEFAULT_ROOT_DOCS) {
    const abs = join(root, rel);
    if (existsSync(abs)) addFile(abs);
  }
  for (const rel of DEFAULT_DOC_DIRS) {
    const abs = join(root, rel);
    if (!contained(root, abs)) continue;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(abs);
  }
  return [...out].sort();
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9_]/.test(char);
}

function containsPhrase(line: string, phrase: string): boolean {
  const haystack = line.toLowerCase();
  const needle = phrase.toLowerCase();
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = haystack[offset - 1];
    const after = haystack[offset + needle.length];
    if (isBoundary(before) && isBoundary(after)) return true;
    offset = haystack.indexOf(needle, offset + needle.length);
  }
  return false;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function finding(
  code: DocsLintCode,
  relative: string,
  line: number,
  detail: string,
  key: string,
  verdict: Exclude<Verdict, "pass"> = "skip",
): DocsLintFinding {
  return {
    code,
    verdict,
    relative,
    line,
    detail,
    fingerprint: `${code}:${relative}:${line}:${slug(key)}`,
  };
}

function hardFinding(
  code: DocsLintCode,
  relative: string,
  line: number,
  detail: string,
  key: string,
): DocsLintFinding {
  return finding(code, relative, line, detail, key, "fail");
}

function calloutStarts(line: string): boolean {
  return /^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(line);
}

function highRiskCalloutClaim(line: string): string | undefined {
  const lower = line.toLowerCase();
  return HIGH_RISK_CALLOUT_CLAIMS.find((claim) => lower.includes(claim));
}

function lintMarkdown(relative: string, text: string, rules: DocsLintRules): DocsLintFinding[] {
  const findings: DocsLintFinding[] = [];
  let inFence = false;
  let inCallout = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const line = lines[index] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (calloutStarts(line)) inCallout = true;
    else if (inCallout && line.trim().length > 0 && !line.trimStart().startsWith(">")) {
      inCallout = false;
    }
    for (const rule of rules.phrases) {
      if (!containsPhrase(line, rule.phrase)) continue;
      findings.push(
        finding(
          "docs.banned-phrase",
          relative,
          lineNo,
          `${rule.label} from ${rule.heading}: "${rule.phrase}"`,
          rule.phrase,
        ),
      );
      if (findings.length >= MAX_FINDINGS) return findings;
    }
    if (
      /\b(?:every|always|never)\s+(?:team|company|organization|developer|user|project|repo|workflow)s?\s+(?:needs?|must|should|can|will)\b/i.test(
        line,
      )
    ) {
      findings.push(
        finding(
          "docs.vague-absolute",
          relative,
          lineNo,
          "vague absolute claim from slop-lint Absolutes guidance",
          "vague-absolute",
        ),
      );
    }
    const claim = inCallout ? highRiskCalloutClaim(line) : undefined;
    if (claim !== undefined) {
      findings.push(
        finding(
          "docs.unsupported-callout-claim",
          relative,
          lineNo,
          `high-risk callout claim "${claim}" needs explicit evidence or scope`,
          claim,
        ),
      );
    }
    if (findings.length >= MAX_FINDINGS) return findings;
  }
  return findings;
}

function checkFromFinding(f: DocsLintFinding): Check {
  return {
    name: "docs lint",
    verdict: f.verdict,
    code: f.code,
    detail: f.detail,
    location: { uri: f.relative, startLine: f.line },
    fingerprint: f.fingerprint,
  };
}

function splitTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeClaimId(value: string): string | undefined {
  const text = value
    .replace(/<a\s+id=["']?([^"'>\s]+)["']?\s*><\/a>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ");
  const match = /\bCM-\d{2,}\b/i.exec(text);
  return match?.[0].toUpperCase();
}

function extractTestRefs(proof: string): MatrixTestRef[] {
  const refs: MatrixTestRef[] = [];
  const files = [...proof.matchAll(/`(tests\/[^`]+\.test\.ts)`/g)];
  for (const match of files) {
    const path = match[1];
    if (path === undefined) continue;
    const segment = parenthesizedProofSegment(proof, (match.index ?? 0) + match[0].length);
    const names = [...segment.matchAll(/`([^`]+)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    for (const name of names) refs.push({ path, name });
  }
  return refs;
}

function parenthesizedProofSegment(proof: string, offset: number): string {
  let cursor = offset;
  while (cursor < proof.length && /\s/.test(proof[cursor] ?? "")) cursor++;
  if (proof[cursor] !== "(") return "";
  const start = cursor + 1;
  let inBacktick = false;
  for (cursor = start; cursor < proof.length; cursor++) {
    const char = proof[cursor];
    if (char === "`") inBacktick = !inBacktick;
    if (!inBacktick && char === ")") return proof.slice(start, cursor);
  }
  return "";
}

function parseControlMatrix(root: string): ControlMatrix {
  const relativeMatrix = toPosix(CONTROL_MATRIX_REL);
  const text = readText(join(root, CONTROL_MATRIX_REL));
  if (text === undefined) {
    return {
      rows: new Map(),
      findings: [],
    };
  }

  const rows = new Map<string, MatrixRow>();
  const findings: DocsLintFinding[] = [];
  let inClaimTable = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const cells = splitTableRow(lines[index] ?? "");
    if (cells === undefined) {
      if (inClaimTable && (lines[index] ?? "").trim().startsWith("## ")) inClaimTable = false;
      continue;
    }
    const header = cells.map((cell) => cell.toLowerCase());
    if (
      header.includes("id") &&
      header.includes("public claim") &&
      header.includes("implementation seam") &&
      header.includes("regression proof")
    ) {
      inClaimTable = true;
      continue;
    }
    if (!inClaimTable || isTableSeparator(cells)) continue;
    if (cells.length < 4) continue;

    const id = normalizeClaimId(cells[0] ?? "");
    if (id === undefined) {
      findings.push(
        hardFinding(
          "docs.claim-mapping-missing",
          relativeMatrix,
          lineNo,
          "control matrix claim rows must declare a stable CM-xx ID",
          `matrix-row-${lineNo}`,
        ),
      );
      continue;
    }
    if (rows.has(id)) {
      findings.push(
        hardFinding(
          "docs.claim-mapping-missing",
          relativeMatrix,
          lineNo,
          `duplicate control matrix claim ID ${id}`,
          `matrix-duplicate-${id}`,
        ),
      );
      continue;
    }
    const proof = cells[3] ?? "";
    rows.set(id, { id, line: lineNo, proof, refs: extractTestRefs(proof) });
  }

  return { rows, findings };
}

export function controlMatrixClaimIds(root: string): string[] {
  return [...parseControlMatrix(root).rows.keys()].sort((a, b) => a.localeCompare(b));
}

function validateMatrixProofs(root: string, matrix: ControlMatrix): DocsLintFinding[] {
  const findings: DocsLintFinding[] = [];
  const relativeMatrix = toPosix(CONTROL_MATRIX_REL);
  for (const row of matrix.rows.values()) {
    if (row.refs.length === 0) {
      findings.push(
        hardFinding(
          "docs.claim-test-missing",
          relativeMatrix,
          row.line,
          `${row.id} must cite at least one named regression test`,
          `${row.id}-missing-test-ref`,
        ),
      );
      continue;
    }
    for (const ref of row.refs) {
      const absTest = join(root, ref.path);
      if (!contained(root, absTest)) {
        findings.push(
          hardFinding(
            "docs.claim-test-missing",
            relativeMatrix,
            row.line,
            `${row.id} cites a test path outside the repo root: ${ref.path}`,
            `${row.id}-${ref.path}`,
          ),
        );
        continue;
      }
      const testText = readText(absTest);
      if (testText === undefined) {
        findings.push(
          hardFinding(
            "docs.claim-test-missing",
            relativeMatrix,
            row.line,
            `${row.id} cites missing test file ${ref.path}`,
            `${row.id}-${ref.path}`,
          ),
        );
        continue;
      }
      if (!testText.includes(ref.name)) {
        findings.push(
          hardFinding(
            "docs.claim-test-missing",
            relativeMatrix,
            row.line,
            `${row.id} cites missing named test "${ref.name}" in ${ref.path}`,
            `${row.id}-${ref.path}-${ref.name}`,
          ),
        );
      }
    }
  }
  return findings;
}

function validateClaimMarkers(
  files: string[],
  root: string,
  matrixRows: Map<string, MatrixRow>,
): DocsLintFinding[] {
  const findings: DocsLintFinding[] = [];
  for (const abs of files) {
    if (!contained(root, abs)) continue;
    const text = readText(abs);
    if (text === undefined) continue;
    const relativeFile = toPosix(relative(root, abs));
    const lines = text.split(/\r?\n/);
    let inFence = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const scanLine = line.replace(/`[^`]*`/g, "");
      CLAIM_MARKER_RE.lastIndex = 0;
      for (const match of scanLine.matchAll(CLAIM_MARKER_RE)) {
        const raw = match[1];
        const id = raw?.toUpperCase();
        const lineNo = index + 1;
        if (id === undefined || !CLAIM_ID_RE.test(id)) {
          findings.push(
            hardFinding(
              "docs.claim-mapping-missing",
              relativeFile,
              lineNo,
              "public claim marker must name a CM-xx control matrix row",
              `claim-marker-${relativeFile}-${lineNo}`,
            ),
          );
          continue;
        }
        if (!matrixRows.has(id)) {
          findings.push(
            hardFinding(
              "docs.claim-matrix-row-missing",
              relativeFile,
              lineNo,
              `public claim marker references missing control matrix row ${id}`,
              `claim-marker-${relativeFile}-${lineNo}-${id}`,
            ),
          );
        }
      }
    }
  }
  return findings;
}

function lines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => toPosix(line.trim()))
    .filter((line) => line.length > 0);
}

async function changedPaths(ctx: PlanContext): Promise<string[] | undefined> {
  const out = new Set<string>();
  const worktree = await ctx.run(
    ["git", "-C", ctx.root, "diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--"],
    { cwd: ctx.root, timeoutMs: 5_000 },
  );
  if (worktree.spawnError || worktree.code !== 0) return undefined;
  for (const line of lines(worktree.stdout)) out.add(line);

  const base = await ctx.run(["git", "-C", ctx.root, "merge-base", "HEAD", "origin/main"], {
    cwd: ctx.root,
    timeoutMs: 5_000,
  });
  if (base.spawnError || base.code !== 0) return undefined;
  const mergeBase = base.stdout.trim();
  if (mergeBase.length > 0) {
    const committed = await ctx.run(
      [
        "git",
        "-C",
        ctx.root,
        "diff",
        "--name-only",
        "--diff-filter=ACMRTUXB",
        `${mergeBase}...HEAD`,
        "--",
      ],
      { cwd: ctx.root, timeoutMs: 5_000 },
    );
    if (committed.spawnError || committed.code !== 0) return undefined;
    for (const line of lines(committed.stdout)) out.add(line);
  }

  return [...out].sort();
}

async function featureLedgerFindings(ctx: PlanContext): Promise<DocsLintFinding[]> {
  const changed = await changedPaths(ctx);
  if (changed === undefined) {
    return [
      hardFinding(
        "docs.feature-ledger-drift",
        toPosix(CONTROL_MATRIX_REL),
        1,
        "could not determine changed paths; docs drift check failed closed",
        "changed-paths-unavailable",
      ),
    ];
  }
  if (changed.length === 0) return [];
  const featurePaths = changed.filter((path) => FEATURE_SOURCE_RE.test(path));
  if (featurePaths.length === 0) return [];
  if (changed.some((path) => DOCS_LEDGER_RE.test(path))) return [];
  return [
    hardFinding(
      "docs.feature-ledger-drift",
      toPosix(CONTROL_MATRIX_REL),
      1,
      `changed feature file(s) need a docs or control-matrix update: ${featurePaths.join(", ")}`,
      featurePaths.join(","),
    ),
  ];
}

export async function docsLintChecks(ctx: PlanContext): Promise<Check[]> {
  const rules = loadDocsLintRules(ctx.root);
  if (rules === undefined) {
    return [
      {
        name: "docs lint rules",
        verdict: "fail",
        code: "docs.rules-missing",
        detail: `could not find ${toPosix(SLOP_LINT_REL)}`,
      },
    ];
  }
  const files = collectMarkdownFiles(ctx.root);
  const findings = files.flatMap((abs) => {
    if (!contained(ctx.root, abs)) return [];
    const text = readText(abs);
    if (text === undefined) return [];
    return lintMarkdown(toPosix(relative(ctx.root, abs)), text, rules);
  });
  const matrix = parseControlMatrix(ctx.root);
  findings.push(...matrix.findings);
  findings.push(...validateMatrixProofs(ctx.root, matrix));
  findings.push(...validateClaimMarkers(files, ctx.root, matrix.rows));
  findings.push(...(await featureLedgerFindings(ctx)));
  if (findings.length === 0) {
    return [
      {
        name: "docs lint",
        verdict: "pass",
        detail: `scanned ${files.length} Markdown file(s); rules: ${rules.source}`,
      },
    ];
  }
  return findings.map(checkFromFinding);
}

export const command: CommandSpec = {
  name: "docs-lint",
  summary: "Lint docs for BetterDoc banned phrases and unsupported claim patterns",
  readOnly: true,
  options: [],
  plan: () => plan("docs-lint", probeMany("docs lint", docsLintChecks)),
};
