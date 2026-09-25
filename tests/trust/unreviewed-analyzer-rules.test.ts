import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanExecutionAdapterV1 } from "../../src/org-policy/governance-input-v1.js";
import { toFinding } from "../../src/support/findings.js";
import { CISCO_RULE_MAP, MCP_SCANNER_RULE_MAP } from "../../src/trust/detectors.js";
import { dispositionForTrustFinding } from "../../src/trust/evidence.js";
import { TRUST_WARN_CODES } from "../../src/trust/grade.js";
import { scanTrustTreeWithAnalyzers, type TrustScanResult } from "../../src/trust/scan.js";
import {
  isUnreviewedAnalyzerRuleV1,
  UNREVIEWED_ANALYZER_RULES_V1,
} from "../../src/trust/unreviewed-analyzer-rules.js";
import type { FakeScanAnswerV1 } from "./fakes/fake-scan-adapter.js";
import { fakeTrustLintScan } from "./fakes/fake-trust-lint.js";

const installedScan = vi.hoisted(() => ({
  current: undefined as ScanExecutionAdapterV1 | undefined,
}));
vi.mock("../../src/scan-package/load-scan-package.js", async (importOriginal) => {
  const { fakeTrustLintScan: defaultScan } = await import("./fakes/fake-trust-lint.js");
  return {
    ...(await importOriginal<typeof import("../../src/scan-package/load-scan-package.js")>()),
    loadScanExecutionAdapterV1: async () => ({
      ok: true,
      adapter: installedScan.current ?? defaultScan(),
    }),
  };
});
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const CODE = "trust.unreviewed-analyzer-rule";
const LABEL = "new analyzer rule, not yet reviewed";
const SKILLSPECTOR_IDS = UNREVIEWED_ANALYZER_RULES_V1.skillspector?.ruleIds ?? [];
const CISCO_IDS = UNREVIEWED_ANALYZER_RULES_V1.cisco?.ruleIds ?? [];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-unreviewed-rules-"));
  installedScan.current = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

type Row = readonly [ruleId: string, message: string, uri: string, startLine: number];

function sarif(rows: readonly Row[]): FakeScanAnswerV1 {
  return {
    kind: "sarif",
    sarif: JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "scan-sarif (test fixture)" } },
          invocations: [{ executionSuccessful: true }],
          results: rows.map(([ruleId, message, uri, startLine]) => ({
            ruleId,
            message: { text: message },
            locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }],
          })),
        },
      ],
    }),
  };
}

async function scan(answers: {
  skillspector?: readonly Row[];
  cisco?: readonly Row[];
}): Promise<TrustScanResult> {
  installedScan.current = fakeTrustLintScan(
    {},
    {
      ...(answers.skillspector === undefined
        ? {}
        : { "detector.skillspector": sarif(answers.skillspector) }),
      ...(answers.cisco === undefined ? {} : { "detector.cisco": sarif(answers.cisco) }),
    },
  );
  return scanTrustTreeWithAnalyzers(dir, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    requiredDetectors: [
      ...(answers.skillspector === undefined ? [] : (["skillspector"] as const)),
      ...(answers.cisco === undefined ? [] : (["cisco"] as const)),
    ],
  });
}

/** Each finding at `uri`:`line`, with its policy disposition. */
function findingAt(result: TrustScanResult, uri: string, line: number) {
  const findings = result.normalizedFindings ?? [];
  const index = findings.findIndex(
    (finding) => finding.location?.uri === uri && (finding.location?.startLine ?? 1) === line,
  );
  expect(index, `${uri}:${line}`).toBeGreaterThanOrEqual(0);
  return {
    finding: findings[index],
    disposition: (result.policyDispositions ?? [])[index],
    check: result.checks.find(
      (check) =>
        check.location?.uri === uri &&
        (check.location?.startLine ?? 1) === line &&
        check.name.startsWith("trust."),
    ),
  };
}

function expectWarnsWithoutBlocking(
  result: TrustScanResult,
  uri: string,
  line: number,
  id: string,
) {
  const { check, finding, disposition } = findingAt(result, uri, line);
  expect(check).toEqual(
    expect.objectContaining({
      name: CODE,
      verdict: "pass",
      code: CODE,
      detail: expect.stringContaining(`${LABEL} (${id})`),
    }),
  );
  expect(finding?.code).toBe(CODE);
  expect(disposition?.level).toBe("WARN");
  expect(disposition?.reason).toContain(LABEL);
}

describe("the explicit list of analyzer rules not yet reviewed", () => {
  it("lists only ids the detector's rule map does not already classify", () => {
    for (const id of CISCO_IDS) {
      expect(Object.hasOwn(CISCO_RULE_MAP, id), id).toBe(false);
      expect(Object.hasOwn(MCP_SCANNER_RULE_MAP, id), id).toBe(false);
    }
    // Existing ids that U1 observed are not new, and a mapped danger rule is never listed.
    for (const id of ["E1", "LP3", "P1", "YR4", "P2"])
      expect(isUnreviewedAnalyzerRuleV1("skillspector", id), id).toBe(false);
    expect(isUnreviewedAnalyzerRuleV1("cisco", "PROMPT_INJECTION_IGNORE_INSTRUCTIONS")).toBe(false);
    // Exact and per detector: no case folding, no prefix match, no cross-detector reach.
    expect(isUnreviewedAnalyzerRuleV1("skillspector", "sc9")).toBe(false);
    expect(isUnreviewedAnalyzerRuleV1("skillspector", "SC9x")).toBe(false);
    expect(isUnreviewedAnalyzerRuleV1("cisco", "SC9")).toBe(false);
    expect(isUnreviewedAnalyzerRuleV1("mcp-scanner", "ACTIVE_DYNAMIC_EXECUTION")).toBe(false);
    expect(SKILLSPECTOR_IDS).toHaveLength(19);
    expect(CISCO_IDS).toHaveLength(24);
  });

  it("names the code as a non-blocking warning with a next route", () => {
    expect(TRUST_WARN_CODES.has(CODE)).toBe(true);
    const policy = toFinding({ name: CODE, verdict: "fail", code: CODE, detail: "x" }, "trust");
    expect(policy?.title).toBe(LABEL);
    expect(policy?.severity).toBe("degraded");
    expect(policy?.recommendedAction).toMatch(/^Next: /u);
    const disposition = dispositionForTrustFinding({
      fingerprint: "finding:x",
      code: CODE,
      checkVerdict: "pass",
      detail: "x",
      rawOccurrenceFingerprints: ["raw:x"],
    });
    expect(disposition.level).toBe("WARN");
    expect(disposition.reason).toMatch(new RegExp(`^${LABEL}; next: `, "u"));
  });

  it("warns and does not block on every listed SkillSpector id", async () => {
    write("skills/clean/SKILL.md", `# Clean\n${"line\n".repeat(SKILLSPECTOR_IDS.length)}`);
    const rows = SKILLSPECTOR_IDS.map(
      (id, index) =>
        [id, `SkillSpector ${id} fixture`, "skills/clean/SKILL.md", index + 1] as const,
    );
    const result = await scan({ skillspector: rows });
    expect(result.checks.filter((check) => check.verdict === "fail")).toEqual([]);
    for (const [id, , uri, line] of rows) expectWarnsWithoutBlocking(result, uri, line, id);
  });

  it("warns and does not block on every listed Cisco id", async () => {
    write("skills/clean/SKILL.md", `# Clean\n${"line\n".repeat(CISCO_IDS.length)}`);
    const rows = CISCO_IDS.map(
      (id, index) => [id, `Cisco ${id} fixture`, "skills/clean/SKILL.md", index + 1] as const,
    );
    const result = await scan({ cisco: rows });
    expect(result.checks.filter((check) => check.verdict === "fail")).toEqual([]);
    for (const [id, , uri, line] of rows) expectWarnsWithoutBlocking(result, uri, line, id);
  });

  it("warns and does not block on SC9 in .env.example, .npmrc, .claude/settings.json and .mcp.json", async () => {
    write("skills/clean/SKILL.md", "# Clean\n");
    write(".env.example", "EXAMPLE_SETTING=placeholder\n");
    write(".npmrc", "fund=false\n");
    write(".claude/settings.json", "{}\n");
    write(".mcp.json", '{"mcpServers":{}}\n');
    const uris = [".env.example", ".npmrc", ".claude/settings.json", ".mcp.json"];
    const result = await scan({
      skillspector: uris.map((uri) => ["SC9", "Concealed Executable Artifact", uri, 1] as const),
    });
    expect(result.checks.filter((check) => check.verdict === "fail")).toEqual([]);
    for (const uri of uris) expectWarnsWithoutBlocking(result, uri, 1, "SC9");
  });

  it("keeps an unlisted unknown id on its generic route, unchanged", async () => {
    write("skills/clean/SKILL.md", "# Clean\nline\n");
    const skillspector = await scan({
      skillspector: [["ZZ99", "unknown SkillSpector rule", "skills/clean/SKILL.md", 1]],
    });
    const generic = findingAt(skillspector, "skills/clean/SKILL.md", 1);
    expect(generic.check).toEqual(
      expect.objectContaining({ name: "trust.detector-finding", verdict: "pass", code: undefined }),
    );
    expect(generic.check?.detail).not.toContain(LABEL);
    expect(generic.disposition?.level).toBe("SUPPRESSED");

    const cisco = await scan({
      cisco: [["UNKNOWN_FUTURE_RULE", "unknown Cisco rule", "skills/clean/SKILL.md", 1]],
    });
    const ciscoGeneric = findingAt(cisco, "skills/clean/SKILL.md", 1);
    expect(ciscoGeneric.check).toEqual(
      expect.objectContaining({ name: "trust.cisco-finding", code: "trust.cisco-finding" }),
    );
    expect(ciscoGeneric.disposition).toEqual(
      expect.objectContaining({
        level: "WARN",
        reason: "meaningful non-blocking third-party condition requiring operator attention",
      }),
    );
  });

  it("keeps a mapped danger rule blocking: a listed id never outranks the rule map", async () => {
    write("skills/clean/SKILL.md", "# Clean\n");
    const result = await scan({
      cisco: [["YARA_command_injection_generic", "command injection", "skills/clean/SKILL.md", 1]],
    });
    expect(result.checks.some((check) => check.code === CODE)).toBe(false);
  });
});
