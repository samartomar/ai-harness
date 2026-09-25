import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import { trustCodeClassV1 } from "../../src/trust/evidence.js";
import { promotionBlockingChecks } from "../../src/workspace/acquire.js";

/**
 * D50 sweep: a finding is a label and never stops the consumer. This test reads
 * every Core and framework-package source file and fails when a finding label
 * decides a throw, refusal or non-zero exit, or when a message states a finding
 * as a gate. Integrity refusals stay; each one the detectors see is listed below
 * with the reason it is not finding-based.
 */

const root = resolve(import.meta.dirname, "../..");

interface SourceFile {
  path: string;
  text: string;
}

interface Hit {
  path: string;
  line: number;
  text: string;
}

interface Allowed {
  path: string;
  contains: string;
  why: string;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") walk(full, out);
    } else if (/\.[cm]?ts$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): SourceFile[] {
  const roots = [
    join(root, "src"),
    ...readdirSync(join(root, "packages")).map((name) => join(root, "packages", name, "src")),
  ];
  return roots
    .flatMap((dir) => walk(dir, []))
    .map((full) => ({
      path: relative(root, full).split("\\").join("/"),
      text: readFileSync(full, "utf8"),
    }))
    .filter((file) => file.path !== "src/report/v9-template.ts");
}

// A finding label: vet verdicts, evidence verdicts, gate and disposition levels.
const LABEL =
  '(?:"has-findings"|"no-findings"|"blocked"|"BLOCK"|"block"|"RED"|"UNKNOWN"|"GREEN"|"YELLOW"|"REVIEW"|"fail"|"failed"|"pass"|"allow"|"ALLOW")';
const LABEL_TEST = String.raw`(?:[!=]==\s*${LABEL}|${LABEL}\s*[!=]==|findings\.length\s*>\s*0|hasFindings|!\s*[\w.]*(?:report|scan|result|vet|grade|trust)\.ok\b|[\w.]*(?:report|scan|result|vet|grade|trust)\.ok\s*===\s*false|dangerCodes|DANGER|isDanger|riskClass|\.some\([^)]*${LABEL})`;
const GATE_BRANCH = new RegExp(
  String.raw`if\s*\([^;{}]{0,300}?${LABEL_TEST}[^;{}]{0,200}?\)\s*(\{[^{}]{0,600}?\}|[^;]{0,300};)`,
  "gs",
);
// Any non-zero exit counts, not only 1.
const STOPS =
  /\bthrow\b|refus|process\.exitCode\s*=\s*(?!0\b)[\w.]+|\bexit\(\s*(?!0\s*\))[\w.]+\s*\)/;

// A stop reached from a finding label through a ternary or a short-circuit
// instead of an `if`: `label ? refuse() : x`, `label ? x : fail()`, `label && throwIt()`.
const STOP_EXPR = String.raw`(?:\(\s*\(\)\s*=>\s*\{\s*throw\b|throw\b|new \w*Error\(|refus\w*\(|fail\w*\(|process\.exit\()`;
const EXPR_STOP = new RegExp(
  String.raw`${LABEL_TEST}\s*\)?\s*(?:\?\s*${STOP_EXPR}|&&\s*${STOP_EXPR}|\?[^:;?]{0,160}:\s*${STOP_EXPR})`,
  "g",
);

// A silent drop: a `.filter(` whose predicate keeps only items with a clean label.
// A drop through an intermediate set (the pre-D50 G7 shape, `filter(authorized)`)
// is out of a text detector's reach; the behavioral inclusion tests in
// packages/framework-ecc/tests/ecc/verified.test.ts ("includes a component whose
// exact evidence carries findings, like any other authorization") cover it.
const CLEAN = '(?:"no-findings"|"pass"|"GREEN"|"ALLOW"|"allow")';
const DIRTY =
  '(?:"has-findings"|"blocked"|"BLOCK"|"block"|"RED"|"UNKNOWN"|"REVIEW"|"fail"|"failed")';
const KEEP_CLEAN = String.raw`(?:===\s*${CLEAN}|${CLEAN}\s*===|!==\s*${DIRTY}|${DIRTY}\s*!==|findings\.length\s*===\s*0|!\s*[\w.]*hasFindings|[\w.]*(?:report|scan|result|vet|grade|trust)\.ok\b(?!\s*===\s*false))`;
const FILTER_DROP = new RegExp(
  String.raw`\.filter\(\s*(?:\([^()]*\)|\w+)\s*=>[^;]{0,200}?${KEEP_CLEAN}`,
  "g",
);

const GATE_PHRASE =
  /(blocked, do not install|do not install|only (GREEN|approvable)|is not authorized|NOT AUTHORIZED|not authorized until|is blocked by|blocked by (genuine|finding|danger)|requested policy is blocked|vet-blocked|NOT installable|refusing to provision|failed trust scan|Reject the external source|excluded from ECC Lean|Permit only with|promote only after|must pass before|cannot be approved|findings? (block|blocks|blocked)\b|\bblocks? (install|promotion|approval|export|provision))/i;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function findGateBranches(files: readonly SourceFile[]): Hit[] {
  return files.flatMap((file) =>
    [...file.text.matchAll(GATE_BRANCH)]
      .filter((match) => STOPS.test(match[1] ?? ""))
      .map((match) => ({
        path: file.path,
        line: lineOf(file.text, match.index ?? 0),
        text: match[0].replace(/\s+/g, " "),
      })),
  );
}

function findMatches(files: readonly SourceFile[], pattern: RegExp): Hit[] {
  return files.flatMap((file) =>
    [...file.text.matchAll(pattern)].map((match) => ({
      path: file.path,
      line: lineOf(file.text, match.index ?? 0),
      text: match[0].replace(/\s+/g, " "),
    })),
  );
}

function findGatePhrases(files: readonly SourceFile[]): Hit[] {
  return files.flatMap((file) =>
    file.text
      .split("\n")
      .flatMap((text, index) =>
        GATE_PHRASE.test(text) ? [{ path: file.path, line: index + 1, text: text.trim() }] : [],
      ),
  );
}

const ALLOWED_BRANCHES: readonly Allowed[] = [
  {
    path: "src/binding/hosts/claude/surfaces.ts",
    contains: "DANGEROUS_KEYS.has(key)",
    why: "hostile object key in host settings input (integrity)",
  },
  {
    path: "src/binding/scan-binding-gate.ts",
    contains: "must state a reason and carry no findings",
    why: "malformed scan report: a missing dimension that still carries findings (integrity)",
  },
  {
    path: "src/ecc-profile/hook-core.ts",
    contains: "DANGEROUS_JSON_KEYS.has(key)",
    why: "hostile key in hook input (integrity)",
  },
  {
    path: "src/ecc-profile/hook-core.ts",
    contains: '.action === "block"',
    why: "ECC hook runtime protocol: a handler returned a block decision for an event that cannot be blocked",
  },
  {
    path: "src/governance-doctor/repair-outcome-v1.ts",
    contains: 'verification.outcome === "failed"',
    why: "aih's own repair did not verify after applying (integrity)",
  },
  {
    path: "src/internals/check-repo-docs.ts",
    contains: 'check.verdict === "fail"',
    why: "repository-owned documentation check exit code, not a trust finding",
  },
  {
    path: "src/internals/ci-impact.ts",
    contains: "riskClass",
    why: "CI impact receipt structure (its own risk class), not a vet label",
  },
  {
    path: "src/internals/delivery-governance-command.ts",
    contains: "findings.length > 0",
    why: "repository release-preparation validation, not a trust finding",
  },
  {
    path: "src/tools/developer-tools-runtime.ts",
    contains: 'result.state !== "blocked"',
    why: "internal consistency of the token-optimizer exclusion report",
  },
  {
    path: "src/verification/legacy.ts",
    contains: 'warnAs !== "pass"',
    why: "input validation of a legacy verdict option",
  },
];

const ALLOWED_PHRASES: readonly Allowed[] = [
  {
    path: "src/binding/scan-gate.ts",
    contains: "MUST pass before running any",
    why: "documents the integrity check every provision runs",
  },
  {
    path: "src/binding/scan-gate.ts",
    contains: "refusing to provision: scan disposition is forged",
    why: "forged disposition (integrity)",
  },
  {
    path: "src/binding/scan-gate.ts",
    contains: "does not match the resolved source digest",
    why: "digest mismatch (integrity)",
  },
  {
    path: "src/binding/scan-gate.ts",
    contains: "was altered after the scan gate produced it",
    why: "altered disposition (integrity)",
  },
  {
    path: "src/bootstrap-ai/canon.ts",
    contains: "do not install broad defaults to fill it",
    why: "agent guidance about delivery gaps, not a finding",
  },
  {
    path: "src/governance-doctor/repair-custody-v1.ts",
    contains: "repair mutation grant is not authorized",
    why: "repair grant authority (integrity)",
  },
  {
    path: "src/guardrails/taxonomy.ts",
    contains: "required status checks must pass before merge",
    why: "generated guardrail guidance for the user's repository",
  },
  {
    path: "src/internals/bugbounty-report.ts",
    contains: "structured finding block(s)",
    why: "'block' is a noun here",
  },
  {
    path: "src/internals/check-baseline-installable.ts",
    contains: "not installable: evidence missing or mismatched",
    why: "missing or mismatched evidence, ledger mismatch or preview escape (integrity)",
  },
  {
    path: "src/internals/verify.ts",
    contains: "cisco-finding block",
    why: "'block' is a noun here",
  },
  {
    path: "src/trust/detectors.ts",
    contains: "cisco-finding block",
    why: "'block' is a noun here",
  },
  {
    path: "src/scaffold/templates.ts",
    contains: "must pass before",
    why: "generated quality-gate guidance for the user's repository",
  },
  {
    path: "src/support/findings.ts",
    contains: "Do not install the changed bytes",
    why: "baseline.evidence-mismatch: bytes differ from signed evidence (integrity)",
  },
  {
    path: "src/support/findings.ts",
    contains: "Do not install against older evidence",
    why: "baseline.evidence-schema-unsupported: evidence this build cannot read (integrity)",
  },
  {
    path: "packages/framework-ecc/src/hooks.ts",
    contains: "Next route: do not install ECC's",
    why: "a next route offered for an ECC hook aih cannot switch off; the item stays selectable",
  },
];

const ALLOWED_FILTERS: readonly Allowed[] = [
  {
    path: "src/heal/cert-verify.ts",
    contains: 'os.verdict === "pass"',
    why: "TLS certificate probe results, not a trust finding",
  },
  {
    path: "src/mcp/policy.ts",
    contains: 'p.verdict === "allow"',
    why: "partitions MCP policy results for display; denied and warned servers are listed beside it",
  },
  {
    path: "src/report/mcp-governance.ts",
    contains: 'p.verdict === "allow"',
    why: "partitions MCP policy results for display; denied and warned servers are listed beside it",
  },
  {
    path: "src/trust/acknowledge.ts",
    contains: 'check.verdict !== "fail"',
    why: "selects the failing checks the consumer asked to acknowledge; keeps findings, drops passes",
  },
];

function isAllowed(hit: Hit, allowed: readonly Allowed[]): boolean {
  return allowed.some((entry) => entry.path === hit.path && hit.text.includes(entry.contains));
}

function unexplained(hits: readonly Hit[], allowed: readonly Allowed[]): string[] {
  return hits
    .filter((hit) => !isAllowed(hit, allowed))
    .map((hit) => `${hit.path}:${hit.line}: ${hit.text.slice(0, 200)}`);
}

// Verbatim sites from c00248ef, before D50. The detectors must keep seeing them.
const REMOVED_GATE_BRANCHES: readonly string[] = [
  'if (evidenceRuntime.verdict !== "pass") {\n  throw new Error("runtime:ecc-installer must pass before preview generation");\n}',
  'if (gate === "BLOCK") {\n  throw new BindingScanError(\n    `refusing to provision: selected-profile gate is "BLOCK"`,\n  );\n}',
  'if (evidence.verdict === "RED") {\n  throw refuse(`vet verdict is RED — blocked, do not install`);\n}',
  'if (evidence.verdict === "UNKNOWN") {\n  throw refuse(`vet verdict is UNKNOWN — evidence insufficient`);\n}',
  'if (!report.ok) {\n  throw new AihError("workspace add failed trust scan; source was not promoted", "AIH_TRUST");\n}',
];

const REMOVED_GATE_PHRASES: readonly string[] = [
  'held.routeCode === "baseline.evidence-blocked" ? "vet-blocked" : "no-evidence";',
  '? `${catalogReport.ok ? "installable" : "NOT installable"} from its own evidence`',
  "detail: `${label} carries verdict ${verdict} — only GREEN/YELLOW skills are distributable`,",
  "`requested policy is blocked: ${blockedDetail(effective)}`,",
  'RED: "blocked — do not install",',
  '"active profile is blocked by genuine executable, integrity, or mandatory-coverage danger"',
  'authorization: isSelected && verdict === "PASS" ? "AUTHORIZED" : "NOT AUTHORIZED",',
  '"REVIEW for the full profile; excluded from ECC Lean. Permit only with an explicit X API egress and credential decision."',
  '"Reject the external source until the hidden Unicode is removed."',
  'summary: "Fetch or scan an external skill source, then promote only after trust verification",',
];

// Shapes no pre-D50 site used, pinned so the added detectors cannot go blunt.
const SYNTHETIC_FILTER_DROPS: readonly string[] = [
  'const kept = components.filter((component) => component.verdict === "no-findings");',
  'const kept = skills.filter((skill) => skill.verdict !== "RED");',
  "const kept = scans.filter((scan) => scan.findings.length === 0);",
];

const SYNTHETIC_EXPR_STOPS: readonly string[] = [
  'return evidence.verdict === "has-findings" ? refuse("has findings") : proceed();',
  'const next = gate !== "BLOCK" ? proceed() : fail("blocked");',
  '!report.ok && (() => { throw new Error("x"); })();',
];

const SYNTHETIC_EXIT_BRANCHES: readonly string[] = [
  'if (verdict === "RED") {\n  process.exitCode = 2;\n}',
  "if (hasFindings) process.exit(EXIT_FINDINGS);",
];

/** The trust code class table, read from its source text. */
function trustCodeTable(): { code: string; trustClass: string }[] {
  const text = readFileSync(join(root, "src/trust/evidence.ts"), "utf8");
  const start = text.indexOf("const TRUST_CODE_CLASSES_V1");
  const end = text.indexOf("};", start);
  const table = [
    ...text
      .slice(start, end)
      .matchAll(/"(trust\.[a-z-]+)":\s*"(finding|evidence-problem|integrity)"/g),
  ].map((match) => ({ code: match[1] as string, trustClass: match[2] as string }));
  if (table.length === 0)
    throw new Error("trust code class table not found in src/trust/evidence.ts");
  return table;
}

describe("nothing blocks (D50 sweep)", () => {
  const files = sourceFiles();

  it("reads the Core and framework-package sources", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((file) => file.path.startsWith("packages/framework-ecc/src/"))).toBe(true);
  });

  it("has no branch where a finding label throws, refuses or exits non-zero", () => {
    expect(unexplained(findGateBranches(files), ALLOWED_BRANCHES)).toEqual([]);
  });

  it("has no message that states a finding as a gate", () => {
    expect(unexplained(findGatePhrases(files), ALLOWED_PHRASES)).toEqual([]);
  });

  it("has no ternary or short-circuit where a finding label stops the consumer", () => {
    expect(unexplained(findMatches(files, EXPR_STOP), [])).toEqual([]);
  });

  it("drops no item from a list because of its finding label", () => {
    expect(unexplained(findMatches(files, FILTER_DROP), ALLOWED_FILTERS)).toEqual([]);
  });

  it("keeps every allowlisted integrity site live, so the allowlist cannot go stale", () => {
    const branches = findGateBranches(files);
    const phrases = findGatePhrases(files);
    const filters = findMatches(files, FILTER_DROP);
    const stale = [
      ...ALLOWED_BRANCHES.filter((entry) => !branches.some((hit) => isAllowed(hit, [entry]))),
      ...ALLOWED_PHRASES.filter((entry) => !phrases.some((hit) => isAllowed(hit, [entry]))),
      ...ALLOWED_FILTERS.filter((entry) => !filters.some((hit) => isAllowed(hit, [entry]))),
    ].map((entry) => `${entry.path}: ${entry.contains}`);
    expect(stale).toEqual([]);
  });

  it("still recognises every gate D50 removed", () => {
    for (const [index, text] of REMOVED_GATE_BRANCHES.entries()) {
      expect(findGateBranches([{ path: `removed-${index}.ts`, text }])).toHaveLength(1);
    }
    for (const [index, text] of REMOVED_GATE_PHRASES.entries()) {
      expect(findGatePhrases([{ path: `removed-${index}.ts`, text }])).toHaveLength(1);
    }
  });

  it("recognises filter drops, expression stops and any non-zero exit", () => {
    for (const [index, text] of SYNTHETIC_FILTER_DROPS.entries()) {
      expect(findMatches([{ path: `drop-${index}.ts`, text }], FILTER_DROP), text).toHaveLength(1);
    }
    for (const [index, text] of SYNTHETIC_EXPR_STOPS.entries()) {
      expect(findMatches([{ path: `expr-${index}.ts`, text }], EXPR_STOP), text).toHaveLength(1);
    }
    for (const [index, text] of SYNTHETIC_EXIT_BRANCHES.entries()) {
      expect(findGateBranches([{ path: `exit-${index}.ts`, text }]), text).toHaveLength(1);
    }
  });

  it("decides a requested org-policy candidate's effect from no finding label", () => {
    const text = readFileSync(join(root, "src/org-policy/effective.ts"), "utf8");
    const match = text.match(/const hasFencedDanger = ([^;]+);\s*const effective =([^;]+);/);
    expect(match, "effective computation not found in src/org-policy/effective.ts").not.toBeNull();
    expect(match?.[1]).toContain("isFencedPrerequisite");
    expect(match?.[2]).not.toMatch(
      /\b(findings|evidenceProblems|decisionNotes|uniqueDangerCodes|verdict|riskState)\b/,
    );
  });

  it("promotes past every finding and evidence problem in the trust class table", () => {
    const orgConfigured = new Set(["trust.untrusted-publisher", "trust.unsigned-source"]);
    const table = trustCodeTable();
    for (const { code, trustClass } of table) {
      expect(trustCodeClassV1(code)).toBe(trustClass);
      const check: Check = {
        name: code,
        code: code as Check["code"],
        verdict: "fail",
        detail: "x",
      };
      const stops = promotionBlockingChecks([check]).length > 0;
      // Integrity refuses; the org's own configured source requirements hold; nothing else stops.
      expect(stops, code).toBe(trustClass === "integrity" || orgConfigured.has(code));
    }
    expect(table.some((entry) => entry.trustClass === "finding")).toBe(true);
    expect(table.some((entry) => entry.trustClass === "integrity")).toBe(true);
  });
});
