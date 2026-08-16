import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  CISCO_SKILL_SCANNER_ANALYZER,
  SEMGREP_ANALYZER,
  SNYK_AGENT_SCAN_ANALYZER,
} from "../../src/baseline-evidence/analyzer-profile.js";
import {
  dispositionForTrustFinding,
  normalizeTrustFindings,
  type RawScannerOccurrence,
  TRUST_POLICY_VERSION,
} from "../../src/trust/evidence.js";
import { contentFindingFingerprint } from "../../src/trust/fingerprint.js";
import {
  canonicalSha256V1,
  createCanonicalFindingIdentityV1,
  createRawOccurrenceFingerprintV1,
  deriveNormalizationCompatibilityV1,
  parseNormalizationProfileV1,
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

function selectorKey(detectorClass: string, nativeRuleId: string): string {
  return `${detectorClass}\u0000${nativeRuleId}`;
}

function sha256(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

describe("current suppressed native-rule compatibility corpus", () => {
  it("contains exactly Luna's twelve independently enumerated rows", () => {
    const actual = CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1.map((row) => [
      row.detectorClass,
      row.nativeRuleId,
    ]).sort((left, right) => selectorKey(...left).localeCompare(selectorKey(...right)));
    const expected = [...EXPECTED_SUPPRESSED_SELECTORS].sort((left, right) =>
      selectorKey(...left).localeCompare(selectorKey(...right)),
    );
    expect(actual).toEqual(expected);
    expect(new Set(actual.map((selector) => selectorKey(...selector))).size).toBe(12);
  });

  it("has a one-to-one selector/grouping/final-code/context/disposition equivalence row", () => {
    const expectedSelectors = new Set(
      EXPECTED_SUPPRESSED_SELECTORS.map((selector) => selectorKey(...selector)),
    );
    const seen = new Set<string>();
    for (const row of CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1) {
      const key = selectorKey(row.detectorClass, row.nativeRuleId);
      expect(expectedSelectors.has(key)).toBe(true);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(row).toEqual(
        expect.objectContaining({
          grouping: "canonical-code+path+start-line+source-value",
          finalCanonicalCode: "trust.detector-finding",
          contextualEvaluationOutcome: "suppressed-non-actionable",
          currentDisposition: "SUPPRESSED",
        }),
      );
    }
    expect(seen).toEqual(expectedSelectors);
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

  it("resolves every corpus row to the exact final code and current disposition", () => {
    const parsed = parseNormalizationProfileV1(CURRENT_NORMALIZATION_PROFILE_V1);
    for (const [index, row] of CURRENT_SUPPRESSED_RULE_COMPATIBILITY_CORPUS_V1.entries()) {
      const resolution = resolveNormalizationV1(parsed, {
        detectorClass: row.detectorClass,
        nativeRuleId: row.nativeRuleId,
        compatibility: row.compatibility,
      });
      expect(resolution).toEqual(
        expect.objectContaining({
          kind: "mapped",
          canonicalCode: row.finalCanonicalCode,
          acceptanceRequired: false,
          normalizationEntryDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      );

      const path = `compatibility/${String(index).padStart(2, "0")}.md`;
      const sourceValue = `reviewed non-actionable occurrence ${String(index)}`;
      const legacyFinding = {
        fingerprint: `legacy:${String(index)}`,
        code: row.finalCanonicalCode,
        checkVerdict: "pass" as const,
        detail: `${row.detectorClass}: ${row.nativeRuleId}`,
        location: { uri: path, startLine: index + 1 },
        sourceValue,
        rawOccurrenceFingerprints: [`legacy-raw:${String(index)}`],
      };
      expect(dispositionForTrustFinding(legacyFinding).level).toBe(row.currentDisposition);

      const rawOccurrence = createRawOccurrenceFingerprintV1({
        protocol: "RawOccurrenceFingerprintV1",
        detectorClass: row.detectorClass,
        nativeRuleId: row.nativeRuleId,
        path,
        fileSha256: sha256(sourceValue),
        canonicalOrdinal: 0,
        diagnostics: {
          analyzerVersion: "current-corpus",
          severity: "warning",
          message: legacyFinding.detail,
          displayLine: index + 1,
        },
      });
      const v1Finding = createCanonicalFindingIdentityV1({
        rawOccurrence,
        normalizationResolution: resolution,
        contextualEvaluationOutcome: row.contextualEvaluationOutcome,
      });
      expect(v1Finding).toEqual(
        expect.objectContaining({
          kind: "mapped",
          canonicalCode: row.finalCanonicalCode,
          normalizationEntryDigest: resolution.normalizationEntryDigest,
          contextualEvaluationOutcome: row.contextualEvaluationOutcome,
          acceptanceRequired: false,
        }),
      );
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
    const descriptorByClass = new Map(
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
