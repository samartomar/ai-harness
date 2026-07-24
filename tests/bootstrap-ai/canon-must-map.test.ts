import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adapterNote,
  agentBehaviorCoreDoc,
  bootloaderPaths,
  bootloaderPreamble,
  harnessUpdateDoc,
  otherToolsDoc,
  regenerationDoc,
  ruleRouterDoc,
  sharedBlock,
  sharedCanonicalBlockBody,
} from "../../src/bootstrap-ai/canon.js";
import { BASELINE_SOURCES } from "../../src/internals/baseline-sources.js";
import type { CanonMode } from "../../src/internals/canon-mode.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { RepoStack } from "../../src/profile/scan.js";

const root = resolve(import.meta.dirname, "../..");

/**
 * Issue #507 acceptance: "a MUST-to-enforcing-check map exists". The committed
 * map is the `## Canon MUST Map` section of docs/CONTROL_MATRIX.md. This suite
 * regenerates the reachable canon surface from src/bootstrap-ai/canon.ts,
 * extracts every imperative line by the map's documented token set, and fails
 * closed both ways: an imperative line without a map row, or a map row whose
 * anchors no longer match any generated line.
 */

// ---- the generated canon surface (canon.ts emissions, all reachable modes) --

const DIR = "ai-coding";
const REPO = "fixture-repo";
const MODES: CanonMode[] = ["compact", "legacy"];

function stack(overrides: Partial<RepoStack> = {}): RepoStack {
  return {
    languages: ["TypeScript"],
    frameworks: [],
    cloud: [],
    databases: [],
    deployment: [],
    hasTypeScript: true,
    scripts: {},
    entryPoints: [],
    browserTest: false,
    isMonorepo: false,
    ...overrides,
  };
}

/** The three testRoutingLine branches: verify+test, test-only, no test command. */
const STACKS: RepoStack[] = [
  stack({ verifyCommand: "npm run verify", testRunner: "npm test", typecheckCommand: "tsc" }),
  stack({ testRunner: "npm test" }),
  stack(),
];

/** Every canon doc canon.ts can emit, keyed by a stable descriptor. */
function generatedCanonDocs(): Map<string, string> {
  const docs = new Map<string, string>();
  const bootloaders = bootloaderPaths([...SUPPORTED_CLIS]);
  for (const baseline of BASELINE_SOURCES) {
    for (const canon of MODES) {
      for (const [i, s] of STACKS.entries()) {
        for (const projectExtension of [false, true]) {
          docs.set(
            `router:${canon}:${baseline.id}:stack${i}:ext-${projectExtension}`,
            ruleRouterDoc(DIR, REPO, s, bootloaders, { projectExtension, canon, baseline }),
          );
        }
      }
      for (const cli of SUPPORTED_CLIS) {
        docs.set(`adapter:${cli}:${canon}:${baseline.id}`, adapterNote(cli, DIR, canon, baseline));
      }
      // The as-written bootloader file on a fresh repo: preamble + marker-fenced
      // shared block (the marker note's "do not edit by hand" is in scope).
      for (const rel of bootloaders) {
        docs.set(
          `bootloader:${rel}:${canon}`,
          mergeManagedBlock(undefined, sharedBlock(DIR), bootloaderPreamble(rel, DIR, REPO, canon)),
        );
      }
    }
  }
  docs.set("shared-block", sharedCanonicalBlockBody(DIR));
  docs.set("behavior-core", agentBehaviorCoreDoc(DIR));
  docs.set("regeneration", regenerationDoc(DIR, bootloaders));
  docs.set("harness-update", harnessUpdateDoc(DIR));
  docs.set("other-tools", otherToolsDoc(DIR));
  return docs;
}

// ---- imperative extraction (the token set the map section documents) --------

/**
 * Canonical imperative tokens. Word-anchored so prose like "must-have" cannot
 * misfire; the leading-"No" rule is line-start + capitalized so "none detected"
 * and mid-sentence "not" never match.
 */
const IMPERATIVE_TOKENS: RegExp[] = [
  /\bmust\b(?!-)/i, // must / must not (never "must-have")
  /\bnever\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\brequire[sd]?\b/i,
  /\bneeds?\b/i,
  /^\s*-?\s*No\s/, // hard "No X" bullets ("No secrets in…", "No features…")
  /\bno silent failures\b/i,
];

function imperativeLines(docs: Map<string, string>): Map<string, string[]> {
  const lines = new Map<string, string[]>();
  for (const [id, text] of docs) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (!IMPERATIVE_TOKENS.some((t) => t.test(line))) continue;
      const sources = lines.get(line) ?? [];
      sources.push(id);
      lines.set(line, sources);
    }
  }
  return lines;
}

// ---- the committed map --------------------------------------------------------

const MAP_HEADING = "## Canon MUST Map";
const CLASSES = new Set(["generation-invariant", "governance", "agent-directed"]);
const AGENT_DIRECTED_LABEL = "agent-directed, not aih-gated";

interface CanonMapRow {
  id: string;
  /** Backticked anchor snippets from the directive cell (exact substrings). */
  anchors: string[];
  cls: string;
  enforcing: string;
  line: number;
}

function canonMustMapSection(): { text: string; startLine: number } {
  const matrix = readFileSync(resolve(root, "docs", "CONTROL_MATRIX.md"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const start = matrix.indexOf(`${MAP_HEADING}\n`);
  if (start < 0) return { text: "", startLine: 0 };
  const startLine = matrix.slice(0, start).split("\n").length;
  const rest = matrix.slice(start + MAP_HEADING.length);
  const next = rest.search(/^## /m);
  return { text: next < 0 ? rest : rest.slice(0, next), startLine };
}

function parseCanonMustMap(): CanonMapRow[] {
  const { text, startLine } = canonMustMapSection();
  const rows: CanonMapRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    const id = cells[0] ?? "";
    if (!/^CANON-\d{2,}$/.test(id)) continue; // header / separator rows
    const anchors = [...(cells[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    rows.push({
      id,
      anchors,
      cls: cells[2] ?? "",
      enforcing: cells[3] ?? "",
      line: startLine + i,
    });
  }
  return rows;
}

// ---- the gate ---------------------------------------------------------------

describe("canon MUST map (docs/CONTROL_MATRIX.md § Canon MUST Map)", () => {
  const docs = generatedCanonDocs();
  const lines = imperativeLines(docs);
  const rows = parseCanonMustMap();

  it("maps every generated imperative line to a map row (fail closed on unmapped)", () => {
    expect(rows.length).toBeGreaterThan(0);
    const unmapped = [...lines.entries()]
      .filter(([line]) => !rows.some((r) => r.anchors.some((a) => line.includes(a))))
      .map(([line, sources]) => `[${[...new Set(sources)].join(", ")}] ${line}`);
    expect(unmapped, `imperative canon line(s) missing from the Canon MUST Map`).toEqual([]);
  });

  it("keeps every map row anchored to a line the canon still generates (no stale rows)", () => {
    const stale = rows.flatMap((r) =>
      r.anchors
        .filter((a) => ![...lines.keys()].some((line) => line.includes(a)))
        .map((a) => `${r.id}: \`${a}\``),
    );
    expect(stale, "map anchor(s) matching no generated canon line").toEqual([]);
    const anchorless = rows.filter((r) => r.anchors.length === 0).map((r) => r.id);
    expect(anchorless, "map row(s) with no backticked anchor").toEqual([]);
  });

  it("classifies every row, labels agent-directed rows, and cites real seams", () => {
    const badClass = rows.filter((r) => !CLASSES.has(r.cls)).map((r) => `${r.id}: ${r.cls}`);
    expect(
      badClass,
      "row class must be generation-invariant | governance | agent-directed",
    ).toEqual([]);

    // Agent-behavioral MUSTs are not aih-enforceable and must say so explicitly.
    const unlabeled = rows
      .filter((r) => r.cls === "agent-directed" && !r.enforcing.includes(AGENT_DIRECTED_LABEL))
      .map((r) => r.id);
    expect(unlabeled, `agent-directed rows must carry "${AGENT_DIRECTED_LABEL}"`).toEqual([]);

    // Enforced classes must cite at least one existing src/ seam file.
    const missingSeam: string[] = [];
    for (const r of rows) {
      if (r.cls === "agent-directed") continue;
      const cited = [...r.enforcing.matchAll(/`(src\/[^`]+\.ts)`/g)].map((m) => m[1] as string);
      if (cited.length === 0) {
        missingSeam.push(`${r.id}: cites no src/ seam file`);
        continue;
      }
      for (const seam of cited) {
        if (!existsSync(resolve(root, seam))) missingSeam.push(`${r.id}: missing seam ${seam}`);
      }
    }
    expect(missingSeam, "enforced rows must cite existing src/ seam files").toEqual([]);
  });
});
