import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineAnalyzerVersions } from "../../src/baseline-evidence/analyzer-profile.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  CISCO_SKILL_SCANNER_ANALYZER,
  runTrustDetectors,
  SEMGREP_ANALYZER,
  SNYK_AGENT_SCAN_ANALYZER,
} from "../../src/trust/detectors.js";
import {
  dispositionForTrustFinding,
  normalizeTrustFindings,
  type RawScannerOccurrence,
  TRUST_POLICY_VERSION,
} from "../../src/trust/evidence.js";
import { contentFindingFingerprint } from "../../src/trust/fingerprint.js";
import {
  type CanonicalFindingIdentityV1,
  canonicalSha256V1,
  createCanonicalFindingIdentityV1,
  createRawOccurrenceFingerprintV1,
  deriveNormalizationCompatibilityV1,
  parseNormalizationProfileV1,
  type RawOccurrenceFingerprintV1,
  resolveNormalizationV1,
} from "../../src/trust/normalization-v1.js";
import {
  CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1,
  CURRENT_NORMALIZATION_PROFILE_V1,
  CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1,
} from "../../src/trust/normalization-v1-compatibility.js";

const EXPECTED_SUPPRESSED_SELECTORS = [
  ["cisco", "YARA_command_injection_generic"],
  ["semgrep", "semgrep.malicious-code"],
  ["semgrep", "semgrep.prompt-injection"],
  ["skillspector", "SC4"],
  ["skillspector", "YR4"],
  ["skillspector", "autonomous-decision-making"],
  ["skillspector", "skillspector.auto-exec"],
  ["skillspector", "skillspector.autonomous-decision-making"],
  ["skillspector", "skillspector.prompt-injection"],
  ["skillspector", "unbounded-resource-access"],
  ["snyk-agent-scan", "E001"],
  ["snyk-agent-scan", "W012"],
] as const;

const SC4_MESSAGE =
  "🟡 SC4: OSV.dev unreachable, using static fallback (9 packages). Results may be incomplete. Set SKILLSPECTOR_OSV_TIMEOUT to increase timeout or check network connectivity to api.osv.dev.";
const YR4_MESSAGE =
  "YARA rule 'agent_skill_mcp_tool_poisoning_metadata': MCP/tool metadata poisoning indicators in tool schemas or skill manifests [agent_skills]";
const COREPACK_PACKAGE_MANAGER = `yarn@4.9.2+sha512.${"a".repeat(128)}`;

type CompatibilityGroupingContract =
  | "canonical-code+path+start-line+source-value"
  | "one-retained-finding-per-raw-occurrence";

interface V1SemanticOccurrence {
  readonly rawOccurrence: RawOccurrenceFingerprintV1;
  readonly finding: CanonicalFindingIdentityV1;
  readonly startLine: number;
  readonly sourceValue: string | null;
  readonly currentDisposition: string;
}

function groupV1SemanticOccurrences(
  grouping: CompatibilityGroupingContract,
  occurrences: readonly V1SemanticOccurrence[],
) {
  const groups = new Map<string, V1SemanticOccurrence[]>();
  for (const occurrence of occurrences) {
    const key =
      grouping === "canonical-code+path+start-line+source-value"
        ? JSON.stringify([
            occurrence.finding.canonicalCode,
            occurrence.rawOccurrence.path,
            occurrence.startLine,
            occurrence.sourceValue,
          ])
        : occurrence.rawOccurrence.fingerprint;
    const members = groups.get(key) ?? [];
    members.push(occurrence);
    groups.set(key, members);
  }
  return [...groups.values()].map((members) => ({
    rawMembership: members
      .map((member) => member.rawOccurrence.canonicalOrdinal)
      .sort((left, right) => left - right),
    finalCanonicalCodes: [...new Set(members.map((member) => member.finding.canonicalCode))],
    contextualEvaluationOutcomes: [
      ...new Set(members.map((member) => member.finding.contextualEvaluationOutcome)),
    ],
    currentDispositions: [...new Set(members.map((member) => member.currentDisposition))],
  }));
}

function ordinalPartition(membershipCounts: readonly number[]): number[][] {
  let nextOrdinal = 0;
  return membershipCounts.map((count) =>
    Array.from({ length: count }, () => {
      const ordinal = nextOrdinal;
      nextOrdinal += 1;
      return ordinal;
    }),
  );
}

function assertCompatibilityGroupingContract(
  value: string,
): asserts value is CompatibilityGroupingContract {
  if (
    value !== "canonical-code+path+start-line+source-value" &&
    value !== "one-retained-finding-per-raw-occurrence"
  ) {
    throw new Error(`unsupported compatibility grouping contract: ${value}`);
  }
}

const EXPECTED_LEGACY_SEMANTICS = [
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    nativeRuleId: "skillspector.prompt-injection",
    path: "skills/skillspector-prompt/SKILL.md",
    message: "Prompt Injection",
    level: "warning",
    fileContent: "# Reviewed prose\nSummarize the supplied document.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    nativeRuleId: "skillspector.auto-exec",
    path: "skills/skillspector-auto/SKILL.md",
    message: "Auto Execution",
    level: "warning",
    fileContent: "# Reviewed prose\nDescribe the command without executing it.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    nativeRuleId: "skillspector.autonomous-decision-making",
    path: "skills/skillspector-autonomy-prefixed/SKILL.md",
    message: "Autonomous Decision Making",
    level: "warning",
    fileContent: "# Reviewed prose\nAsk before performing any side effect.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    nativeRuleId: "autonomous-decision-making",
    path: "skills/skillspector-autonomy/SKILL.md",
    message: "Autonomous Decision Making",
    level: "warning",
    fileContent: "# Reviewed prose\nAsk before performing any side effect.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    nativeRuleId: "unbounded-resource-access",
    path: "skills/skillspector-resource/SKILL.md",
    message: "Unbounded Resource Access",
    level: "warning",
    fileContent: "# Review\nTeach why a query should use a bounded LIMIT.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    nativeRuleId: "SC4",
    path: "package.json",
    message: SC4_MESSAGE,
    level: "note",
    fileContent: JSON.stringify({ name: "clean-package" }),
    legacyNormalizedCode: null,
    legacyGrouping: "one-retained-finding-per-raw-occurrence",
    legacyNormalizedGroupCount: 2,
    legacyContextualCase: "advisory-without-normalized-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    nativeRuleId: "YR4",
    path: "package.json",
    message: YR4_MESSAGE,
    level: "error",
    fileContent: JSON.stringify({
      name: "clean-package",
      description: "Agent tools and MCP conventions",
      packageManager: COREPACK_PACKAGE_MANAGER,
    }),
    legacyNormalizedCode: null,
    legacyGrouping: "one-retained-finding-per-raw-occurrence",
    legacyNormalizedGroupCount: 2,
    legacyContextualCase: "advisory-without-normalized-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "semgrep",
    analyzerLabel: "semgrep@uv:1.173.0",
    nativeRuleId: "semgrep.prompt-injection",
    path: "skills/semgrep-prompt/SKILL.md",
    message: "prompt injection shape in trust content",
    level: "warning",
    fileContent: "# Reviewed prose\nSummarize the supplied document.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "semgrep",
    analyzerLabel: "semgrep@uv:1.173.0",
    nativeRuleId: "semgrep.malicious-code",
    path: "skills/semgrep-code/SKILL.md",
    message: "download-and-execute shell shape in trust content",
    level: "warning",
    fileContent: "# Reviewed prose\nExplain the sample without running it.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "snyk-agent-scan",
    analyzerLabel: "snyk-agent-scan@uv:0.5.17",
    nativeRuleId: "E001",
    path: "skills/snyk-prompt/SKILL.md",
    message: "Prompt injection in tool description",
    level: "error",
    fileContent: "# Reviewed prose\nSummarize the supplied document.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "snyk-agent-scan",
    analyzerLabel: "snyk-agent-scan@uv:0.5.17",
    nativeRuleId: "W012",
    path: "skills/snyk-dependency/SKILL.md",
    message: "Unverifiable external dependency",
    level: "warning",
    fileContent: "# Reviewed prose\nDocument a dependency without fetching it.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
  {
    detectorClass: "cisco",
    analyzerLabel: "cisco@uvx",
    nativeRuleId: "YARA_command_injection_generic",
    path: "skills/cisco-command/SKILL.md",
    message: "Generic command injection heuristic",
    level: "error",
    fileContent: "# Reviewed prose\nExplain the command without running it.\n",
    legacyNormalizedCode: "trust.detector-finding",
    legacyGrouping: "canonical-code+path+start-line+source-value",
    legacyNormalizedGroupCount: 1,
    legacyContextualCase: "generic-warning-with-explicit-code",
    rawMultiplicity: 2,
    finalCanonicalCode: "trust.detector-finding",
    contextualEvaluationOutcome: "suppressed-non-actionable",
    currentDisposition: "SUPPRESSED",
  },
] as const;

const EXPECTED_COMPATIBILITY_DESCRIPTORS = [
  {
    detectorClass: "skillspector",
    analyzerLabel: "skillspector@docker",
    analyzerIdentity:
      "2d198ab910add401cad658d1087e7c7ba24fd640@sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800",
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "skillspector",
      analyzerLabel: "skillspector@docker",
      analyzerIdentity:
        "2d198ab910add401cad658d1087e7c7ba24fd640@sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800",
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "skillspector",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: [
        "SC4",
        "YR4",
        "autonomous-decision-making",
        "skillspector.auto-exec",
        "skillspector.autonomous-decision-making",
        "skillspector.prompt-injection",
        "unbounded-resource-access",
      ],
    },
  },
  {
    detectorClass: "semgrep",
    analyzerLabel: "semgrep@uv:1.173.0",
    analyzerIdentity: "1.173.0+uvlock.77f2bf3e7525",
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "semgrep",
      analyzerLabel: "semgrep@uv:1.173.0",
      analyzerIdentity: "1.173.0+uvlock.77f2bf3e7525",
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "semgrep",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: ["semgrep.malicious-code", "semgrep.prompt-injection"],
    },
  },
  {
    detectorClass: "snyk-agent-scan",
    analyzerLabel: "snyk-agent-scan@uv:0.5.17",
    analyzerIdentity: "0.5.17+uvlock.49064889ec53",
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "snyk-agent-scan",
      analyzerLabel: "snyk-agent-scan@uv:0.5.17",
      analyzerIdentity: "0.5.17+uvlock.49064889ec53",
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "snyk-agent-scan",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: ["E001", "W012"],
    },
  },
  {
    detectorClass: "cisco",
    analyzerLabel: "cisco@uvx",
    analyzerIdentity: "2.0.14+uvlock.aaba1f326049",
    scannerManifestIdentityDescriptor: {
      protocol: "NormalizationCompatibilityScannerIdentityV1",
      detectorClass: "cisco",
      analyzerLabel: "cisco@uvx",
      analyzerIdentity: "2.0.14+uvlock.aaba1f326049",
      adapterIdentity: "aih.trust.sarif-normalizer.current",
    },
    normalizationConfigurationIdentityDescriptor: {
      protocol: "NormalizationCompatibilityConfigurationIdentityV1",
      detectorClass: "cisco",
      evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3",
      nativeRuleIds: ["YARA_command_injection_generic"],
    },
  },
] as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function selectorKey(detectorClass: string, nativeRuleId: string): string {
  return `${detectorClass}\u0000${nativeRuleId}`;
}

function sha256(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function sortedDescriptors(
  descriptors: readonly (typeof EXPECTED_COMPATIBILITY_DESCRIPTORS)[number][],
) {
  return [...descriptors].sort((left, right) =>
    left.detectorClass.localeCompare(right.detectorClass),
  );
}

async function currentLegacySemantics(expected: (typeof EXPECTED_LEGACY_SEMANTICS)[number]) {
  const root = mkdtempSync(join(tmpdir(), "aih-normalization-v1-compatibility-"));
  roots.push(root);
  const target = join(root, ...expected.path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected.fileContent, "utf8");

  const result = {
    ruleId: expected.nativeRuleId,
    level: expected.level,
    message: { text: expected.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: expected.path },
          region: { startLine: 1 },
        },
      },
    ],
  };
  const scan = await runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    run: fakeRunner(() => undefined),
    detectors: [expected.detectorClass],
    precomputedSarif: {
      [expected.detectorClass]: JSON.stringify({
        version: "2.1.0",
        runs: [{ results: [result, result] }],
      }),
    },
    corroboratedChecks: [],
  });
  const matchingRaw = scan.rawOccurrences.filter(
    (occurrence) =>
      occurrence.ruleId === expected.nativeRuleId &&
      occurrence.location?.uri === expected.path &&
      occurrence.location.startLine === 1,
  );
  const normalized = normalizeTrustFindings(root, scan.checks, scan.rawOccurrences).filter(
    (finding) => finding.location?.uri === expected.path && finding.location.startLine === 1,
  );
  const normalizedCodes = normalized.map((finding) => finding.code ?? null);
  const rawMembership = normalized.map((finding) => finding.rawOccurrenceFingerprints.length);
  const rawDetectorClass = EXPECTED_COMPATIBILITY_DESCRIPTORS.find(
    (descriptor) => descriptor.analyzerLabel === matchingRaw[0]?.analyzer,
  )?.detectorClass;
  const contextualCase =
    normalized.length === 1 &&
    normalizedCodes[0] === "trust.detector-finding" &&
    rawMembership[0] === 2
      ? "generic-warning-with-explicit-code"
      : normalized.length === 2 &&
          normalizedCodes.every((code) => code === null) &&
          rawMembership.every((count) => count === 1)
        ? "advisory-without-normalized-code"
        : "unexpected-legacy-shape";

  return {
    selector: [rawDetectorClass, matchingRaw[0]?.ruleId],
    analyzerLabels: matchingRaw.map((occurrence) => occurrence.analyzer),
    rawMultiplicity: matchingRaw.length,
    rawSelectors: matchingRaw.map((occurrence) => [occurrence.analyzer, occurrence.ruleId]),
    normalizedCodes,
    grouping:
      contextualCase === "generic-warning-with-explicit-code"
        ? "canonical-code+path+start-line+source-value"
        : contextualCase === "advisory-without-normalized-code"
          ? "one-retained-finding-per-raw-occurrence"
          : "unexpected",
    normalizedGroupCount: normalized.length,
    rawMembership,
    contextualCase,
    dispositions: normalized.map((finding) => dispositionForTrustFinding(finding).level),
  };
}

describe("current suppressed native-rule compatibility corpus", () => {
  it("contains exactly Luna's twelve independently enumerated rows", () => {
    const actual = CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1.map(
      (row) => [row.detectorClass, row.nativeRuleId] as const,
    ).sort((left, right) => selectorKey(...left).localeCompare(selectorKey(...right)));
    const expected = [...EXPECTED_SUPPRESSED_SELECTORS].sort((left, right) =>
      selectorKey(left[0], left[1]).localeCompare(selectorKey(right[0], right[1])),
    );
    expect(actual).toEqual(expected);
    expect(new Set(actual.map((selector) => selectorKey(...selector))).size).toBe(12);
  });

  it("has a one-to-one selector/grouping/final-code/context/disposition equivalence row", () => {
    const expectedBySelector = new Map(
      EXPECTED_LEGACY_SEMANTICS.map((expected) => [
        selectorKey(expected.detectorClass, expected.nativeRuleId),
        expected,
      ]),
    );
    const seen = new Set<string>();
    for (const row of CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1) {
      const key = selectorKey(row.detectorClass, row.nativeRuleId);
      const expected = expectedBySelector.get(key);
      expect(expected, key).toBeDefined();
      if (expected === undefined) throw new Error(`unexpected compatibility row ${key}`);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(row).toEqual(
        expect.objectContaining({
          grouping: expected.legacyGrouping,
          finalCanonicalCode: expected.finalCanonicalCode,
          contextualEvaluationOutcome: expected.contextualEvaluationOutcome,
          currentDisposition: expected.currentDisposition,
        }),
      );
    }
    expect(seen).toEqual(new Set(expectedBySelector.keys()));
  });

  it("has exactly one explicit profile entry for every corpus row and no extra entry", () => {
    const parsed = parseNormalizationProfileV1(CURRENT_NORMALIZATION_PROFILE_V1);
    const profileSelectors = parsed.mappings.map((entry) =>
      selectorKey(entry.detectorClass, entry.nativeRuleId),
    );
    const corpusSelectors = CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1.map((row) =>
      selectorKey(row.detectorClass, row.nativeRuleId),
    );
    expect(profileSelectors.sort()).toEqual(corpusSelectors.sort());
    for (const selector of corpusSelectors) {
      expect(profileSelectors.filter((candidate) => candidate === selector)).toHaveLength(1);
    }
  });

  it("proves every row through duplicate current-detector SARIF and the strict V1 contract", async () => {
    const parsed = parseNormalizationProfileV1(CURRENT_NORMALIZATION_PROFILE_V1);
    const corpusBySelector = new Map(
      CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1.map((row) => [
        selectorKey(row.detectorClass, row.nativeRuleId),
        row,
      ]),
    );
    for (const expected of EXPECTED_LEGACY_SEMANTICS) {
      const key = selectorKey(expected.detectorClass, expected.nativeRuleId);
      const row = corpusBySelector.get(key);
      if (row === undefined) throw new Error(`missing compatibility row ${key}`);
      const legacy = await currentLegacySemantics(expected);
      expect(legacy).toEqual({
        selector: [expected.detectorClass, expected.nativeRuleId],
        analyzerLabels: [expected.analyzerLabel, expected.analyzerLabel],
        rawMultiplicity: expected.rawMultiplicity,
        rawSelectors: [
          [expected.analyzerLabel, expected.nativeRuleId],
          [expected.analyzerLabel, expected.nativeRuleId],
        ],
        normalizedCodes: Array.from(
          { length: expected.legacyNormalizedGroupCount },
          () => expected.legacyNormalizedCode,
        ),
        grouping: expected.legacyGrouping,
        normalizedGroupCount: expected.legacyNormalizedGroupCount,
        rawMembership:
          expected.legacyNormalizedGroupCount === 1 ? [2] : Array.from({ length: 2 }, () => 1),
        contextualCase: expected.legacyContextualCase,
        dispositions: Array.from(
          { length: expected.legacyNormalizedGroupCount },
          () => expected.currentDisposition,
        ),
      });
      expect(row).toEqual(
        expect.objectContaining({
          detectorClass: expected.detectorClass,
          nativeRuleId: expected.nativeRuleId,
          grouping: expected.legacyGrouping,
          finalCanonicalCode: expected.finalCanonicalCode,
          contextualEvaluationOutcome: expected.contextualEvaluationOutcome,
          currentDisposition: expected.currentDisposition,
        }),
      );
      const resolution = resolveNormalizationV1(parsed, {
        detectorClass: row.detectorClass,
        nativeRuleId: row.nativeRuleId,
        compatibility: row.compatibility,
      });
      expect(resolution).toEqual(
        expect.objectContaining({
          kind: "mapped",
          canonicalCode: expected.finalCanonicalCode,
          acceptanceRequired: false,
          normalizationEntryDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      );
      const sourceValue = expected.fileContent.split(/\r?\n/u)[0] ?? null;
      const rawOccurrences = [0, 1].map((canonicalOrdinal) =>
        createRawOccurrenceFingerprintV1({
          protocol: "RawOccurrenceFingerprintV1",
          detectorClass: row.detectorClass,
          nativeRuleId: row.nativeRuleId,
          path: expected.path,
          fileSha256: sha256(expected.fileContent),
          canonicalOrdinal,
          diagnostics: {
            analyzerVersion: "current-corpus",
            severity: expected.level,
            message: expected.message,
            displayLine: 1,
          },
        }),
      );
      const v1Findings = rawOccurrences.map((rawOccurrence) =>
        createCanonicalFindingIdentityV1({
          rawOccurrence,
          normalizationResolution: resolution,
          contextualEvaluationOutcome: expected.contextualEvaluationOutcome,
        }),
      );
      expect(new Set(rawOccurrences.map((occurrence) => occurrence.fingerprint))).toHaveLength(2);
      expect(new Set(v1Findings.map((finding) => finding.fingerprint))).toHaveLength(2);
      for (const v1Finding of v1Findings) {
        expect(v1Finding).toEqual(
          expect.objectContaining({
            kind: "mapped",
            canonicalCode: expected.finalCanonicalCode,
            normalizationEntryDigest: resolution.normalizationEntryDigest,
            contextualEvaluationOutcome: expected.contextualEvaluationOutcome,
            acceptanceRequired: false,
          }),
        );
      }

      const disposition = legacy.dispositions[0];
      if (disposition === undefined) throw new Error(`missing legacy disposition for ${key}`);
      assertCompatibilityGroupingContract(row.grouping);
      const v1Groups = groupV1SemanticOccurrences(
        row.grouping,
        rawOccurrences.map((rawOccurrence) => {
          const finding = v1Findings[rawOccurrence.canonicalOrdinal];
          if (finding === undefined) throw new Error(`missing V1 finding for ${key}`);
          return {
            rawOccurrence,
            finding,
            startLine: 1,
            sourceValue,
            currentDisposition: disposition,
          };
        }),
      );
      const legacyPartition = ordinalPartition(legacy.rawMembership);
      const legacySemanticGroups = legacyPartition.map((rawMembership, groupIndex) => ({
        rawMembership,
        // Advisory legacy rows have no textual canonical code. The reviewed V1 row makes
        // that semantic class explicit without aliasing the two V1 occurrence identities.
        finalCanonicalCodes: [expected.finalCanonicalCode],
        contextualEvaluationOutcomes: [expected.contextualEvaluationOutcome],
        currentDispositions: [legacy.dispositions[groupIndex]],
      }));
      expect(v1Groups).toHaveLength(legacy.normalizedGroupCount);
      expect(v1Groups).toEqual(legacySemanticGroups);
    }
  });

  it("does not treat synthetic future rules or MCP-scanner as proven suppressed rows", () => {
    const parsed = parseNormalizationProfileV1(CURRENT_NORMALIZATION_PROFILE_V1);
    const byDetector = new Map(
      CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1.map((descriptor) => [
        descriptor.detectorClass,
        deriveNormalizationCompatibilityV1(descriptor),
      ]),
    );
    for (const detectorClass of ["skillspector", "semgrep", "snyk-agent-scan", "cisco"] as const) {
      const detectorCompatibility = byDetector.get(detectorClass);
      if (detectorCompatibility === undefined)
        throw new Error(`missing ${detectorClass} descriptor`);
      expect(
        resolveNormalizationV1(parsed, {
          detectorClass,
          nativeRuleId: `${detectorClass}.synthetic-future-rule`,
          compatibility: detectorCompatibility,
        }),
      ).toEqual({
        kind: "unmapped",
        canonicalCode: "trust.unmapped-external-rule",
        acceptanceRequired: true,
        normalizationEntryDigest: null,
      });
    }
    expect(parsed.mappings.some((entry) => entry.detectorClass === "mcp-scanner")).toBe(false);
  });

  it("has no wildcard or generic fallback capable of suppressing a novel rule", () => {
    for (const entry of CURRENT_NORMALIZATION_PROFILE_V1.mappings) {
      expect(entry.detectorClass).not.toMatch(/[*/]/);
      expect(entry.nativeRuleId).not.toMatch(/[*/]/);
      expect(entry.nativeRuleId).not.toBe("unknown-rule");
    }
  });
});

describe("current compatibility identities", () => {
  it("matches independently frozen manifest and normalization descriptors exactly", () => {
    expect(
      sortedDescriptors(
        CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1 as readonly (typeof EXPECTED_COMPATIBILITY_DESCRIPTORS)[number][],
      ),
    ).toEqual(sortedDescriptors(EXPECTED_COMPATIBILITY_DESCRIPTORS));
  });

  it("uses exact current analyzer identity strings from checked-in analyzer ownership", () => {
    const current = baselineAnalyzerVersions();
    const expected = new Map([
      ["skillspector", ["skillspector@docker", current["skillspector@docker"]]],
      ["semgrep", [SEMGREP_ANALYZER, current[SEMGREP_ANALYZER]]],
      ["snyk-agent-scan", [SNYK_AGENT_SCAN_ANALYZER, current[SNYK_AGENT_SCAN_ANALYZER]]],
      ["cisco", [CISCO_SKILL_SCANNER_ANALYZER, current[CISCO_SKILL_SCANNER_ANALYZER]]],
    ]);
    for (const descriptor of CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1) {
      const exact = expected.get(descriptor.detectorClass);
      expect(exact, descriptor.detectorClass).toBeDefined();
      expect([descriptor.analyzerLabel, descriptor.analyzerIdentity]).toEqual(exact);
    }
  });

  it("derives all three opaque digests from domain-separated checked-in descriptors", () => {
    for (const descriptor of CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1) {
      const derived = deriveNormalizationCompatibilityV1(descriptor);
      expect(derived).toEqual({
        scannerManifestSha256: canonicalSha256V1({
          domain: "aih.normalization-profile-v1.compatibility.scanner-manifest",
          descriptor: descriptor.scannerManifestIdentityDescriptor,
        }),
        analyzerIdentitySha256: canonicalSha256V1({
          domain: "aih.normalization-profile-v1.compatibility.analyzer",
          analyzerLabel: descriptor.analyzerLabel,
          analyzerIdentity: descriptor.analyzerIdentity,
        }),
        normalizationConfigurationSha256: canonicalSha256V1({
          domain: "aih.normalization-profile-v1.compatibility.normalization-configuration",
          descriptor: descriptor.normalizationConfigurationIdentityDescriptor,
        }),
      });
      expect(Object.values(derived)).toEqual([
        expect.stringMatching(/^[0-9a-f]{64}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ]);
      expect(Object.values(derived)).not.toContain("0".repeat(64));
    }
  });

  it("uses each derived descriptor identity in every matching profile/corpus row", () => {
    const descriptorByClass = new Map<
      string,
      ReturnType<typeof deriveNormalizationCompatibilityV1>
    >(
      CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1.map((descriptor) => [
        descriptor.detectorClass,
        deriveNormalizationCompatibilityV1(descriptor),
      ]),
    );
    for (const entry of CURRENT_NORMALIZATION_PROFILE_V1.mappings) {
      expect(entry.compatibility).toEqual(descriptorByClass.get(entry.detectorClass));
    }
    for (const row of CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1) {
      expect(row.compatibility).toEqual(descriptorByClass.get(row.detectorClass));
    }
  });

  it("does not define ScannerManifestV1 while binding its opaque compatibility identity", () => {
    for (const descriptor of CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1) {
      expect(Object.keys(descriptor)).not.toContain("scannerManifest");
      expect(JSON.stringify(descriptor)).not.toContain("ScannerManifestV1");
      expect(descriptor.scannerManifestIdentityDescriptor).toEqual(
        expect.objectContaining({
          detectorClass: descriptor.detectorClass,
          analyzerLabel: descriptor.analyzerLabel,
        }),
      );
    }
  });
});

describe("legacy/V1 compatibility boundary", () => {
  it("keeps current runtime suppression untouched while strict V1 exposes the same novel rule", () => {
    const descriptor = CURRENT_NORMALIZATION_COMPATIBILITY_DESCRIPTORS_V1.find(
      (candidate) => candidate.detectorClass === "skillspector",
    );
    if (descriptor === undefined) throw new Error("missing skillspector compatibility descriptor");
    const nativeRuleId = "skillspector.synthetic-future-rule";
    const raw: RawScannerOccurrence = {
      fingerprint: "legacy-raw:future",
      analyzer: descriptor.analyzerLabel,
      ruleId: nativeRuleId,
      message: "future scanner finding",
      location: { uri: "skills/future/SKILL.md", startLine: 1 },
    };
    const [legacy] = normalizeTrustFindings(".", [], [raw]);
    if (legacy === undefined) throw new Error("expected retained legacy raw finding");
    expect(dispositionForTrustFinding(legacy)).toEqual(
      expect.objectContaining({ level: "SUPPRESSED", policyVersion: TRUST_POLICY_VERSION }),
    );

    expect(
      resolveNormalizationV1(parseNormalizationProfileV1(CURRENT_NORMALIZATION_PROFILE_V1), {
        detectorClass: "skillspector",
        nativeRuleId,
        compatibility: deriveNormalizationCompatibilityV1(descriptor),
      }),
    ).toEqual({
      kind: "unmapped",
      canonicalCode: "trust.unmapped-external-rule",
      acceptanceRequired: true,
      normalizationEntryDigest: null,
    });
  });

  it("proves legacy and V1 occurrence/finding strings are deliberately not aliases", () => {
    const row = CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1[0];
    if (row === undefined) throw new Error("expected compatibility row");
    const rawOccurrence = createRawOccurrenceFingerprintV1({
      protocol: "RawOccurrenceFingerprintV1",
      detectorClass: row.detectorClass,
      nativeRuleId: row.nativeRuleId,
      path: "compatibility/legacy-alias.md",
      fileSha256: sha256("same exact bytes"),
      canonicalOrdinal: 0,
      diagnostics: { displayLine: 7 },
    });
    const resolution = resolveNormalizationV1(
      parseNormalizationProfileV1(CURRENT_NORMALIZATION_PROFILE_V1),
      {
        detectorClass: row.detectorClass,
        nativeRuleId: row.nativeRuleId,
        compatibility: row.compatibility,
      },
    );
    const v1Finding = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolution,
      contextualEvaluationOutcome: row.contextualEvaluationOutcome,
    });
    const legacy = contentFindingFingerprint({
      code: row.finalCanonicalCode,
      path: "compatibility/legacy-alias.md",
      ruleId: `${row.detectorClass}:${row.nativeRuleId}`,
      content: "same exact bytes",
      occurrence: 0,
      displayLine: 7,
    });
    expect(rawOccurrence.fingerprint).not.toBe(legacy);
    expect(v1Finding.fingerprint).not.toBe(legacy);
    expect(v1Finding.fingerprint).not.toBe(rawOccurrence.fingerprint);
  });
});
