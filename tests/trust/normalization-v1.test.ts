import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import { applyTrustAcknowledgements } from "../../src/trust/acknowledge.js";
import {
  canonicalBytesV1,
  canonicalSha256V1,
  createCanonicalFindingIdentityV1,
  createRawOccurrenceFingerprintV1,
  NORMALIZATION_TARGET_CODES_V1,
  type NormalizationCompatibilityV1,
  type NormalizationProfileV1,
  normalizationEntryDigestV1,
  normalizationProfileDigestV1,
  parseNormalizationProfileV1,
  parseNormalizationProfileV1Json,
  type RawOccurrenceFingerprintV1Input,
  rawOccurrenceCanonicalBytesV1,
  resolveNormalizationV1,
} from "../../src/trust/normalization-v1.js";

function sha256(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

const compatibility: NormalizationCompatibilityV1 = {
  scannerManifestSha256: sha256("scanner-manifest"),
  analyzerIdentitySha256: sha256("analyzer-identity"),
  normalizationConfigurationSha256: sha256("normalization-configuration"),
};

const alternateCompatibility: NormalizationCompatibilityV1 = {
  scannerManifestSha256: sha256("scanner-manifest-next"),
  analyzerIdentitySha256: sha256("analyzer-identity-next"),
  normalizationConfigurationSha256: sha256("normalization-configuration-next"),
};

function mapping(
  overrides: Partial<NormalizationProfileV1["mappings"][number]> = {},
): NormalizationProfileV1["mappings"][number] {
  return {
    detectorClass: "skillspector",
    nativeRuleId: "skillspector.prompt-injection",
    canonicalCode: "trust.detector-finding",
    compatibility,
    ...overrides,
  };
}

function profile(
  mappings: NormalizationProfileV1["mappings"] = [mapping()],
): NormalizationProfileV1 {
  return {
    protocol: "NormalizationProfileV1",
    mappings,
  };
}

function rawInput(
  overrides: Partial<RawOccurrenceFingerprintV1Input> = {},
): RawOccurrenceFingerprintV1Input {
  return {
    protocol: "RawOccurrenceFingerprintV1",
    detectorClass: "skillspector",
    nativeRuleId: "skillspector.prompt-injection",
    path: "skills/reviewer/SKILL.md",
    fileSha256: sha256("exact file bytes"),
    canonicalOrdinal: 0,
    diagnostics: {
      analyzerVersion: "skillspector@current",
      severity: "warning",
      message: "display-only scanner message",
      timestamp: "2026-08-16T12:00:00.000Z",
      runIdentifier: "run-local-1",
      rawFormatting: "scanner-native formatting",
      displayLine: 41,
    },
    ...overrides,
  };
}

function resolveBase() {
  return resolveNormalizationV1(parseNormalizationProfileV1(profile()), {
    detectorClass: "skillspector",
    nativeRuleId: "skillspector.prompt-injection",
    compatibility,
  });
}

describe("RFC 8785 canonical bytes for normalization v1", () => {
  it("is deterministic across object property order while preserving array order", () => {
    const left = {
      z: [3, 2, 1],
      a: { beta: true, alpha: "value" },
    };
    const right = {
      a: { alpha: "value", beta: true },
      z: [3, 2, 1],
    };

    expect(canonicalBytesV1(left)).toEqual(canonicalBytesV1(right));
    expect(canonicalBytesV1(left).toString("utf8")).toBe(
      '{"a":{"alpha":"value","beta":true},"z":[3,2,1]}',
    );
    expect(canonicalSha256V1(left)).toBe(canonicalSha256V1(right));
  });

  it("matches RFC 8785-oriented number serialization vectors", () => {
    expect(
      canonicalBytesV1({
        numbers: [Number("333333333.33333329"), 1e30, 4.5, 2e-3, 1e-27],
      }).toString("utf8"),
    ).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  });

  it("sorts property names by UTF-16 code units, including supplementary characters", () => {
    const value = {
      "\ufb33": "hebrew presentation form",
      "😀": "grinning face",
      "€": "euro sign",
      ö: "latin small o diaeresis",
      "\u0080": "control",
      "1": "ascii digit",
      "\r": "carriage return",
    };

    expect(canonicalBytesV1(value).toString("utf8")).toBe(
      '{"\\r":"carriage return","1":"ascii digit","\u0080":"control","ö":"latin small o diaeresis","€":"euro sign","😀":"grinning face","דּ":"hebrew presentation form"}',
    );
  });

  it("rejects unsupported canonical JSON values instead of coercing them", () => {
    expect(() => canonicalBytesV1({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalBytesV1({ value: Number.POSITIVE_INFINITY })).toThrow(/finite/i);
    expect(() => canonicalBytesV1({ value: -0 })).toThrow(/negative zero/i);
    expect(() => canonicalBytesV1({ value: undefined })).toThrow(/undefined/i);
  });
});

describe("NormalizationProfileV1 strict parsing and canonical identity", () => {
  it("rejects duplicate keys recursively, including escaped-equivalent names", () => {
    expect(() =>
      parseNormalizationProfileV1Json(
        `{"protocol":"NormalizationProfileV1","mappings":[],"mappings":[]}`,
      ),
    ).toThrow(/duplicate.*mappings/i);
    expect(() =>
      parseNormalizationProfileV1Json(
        `{"protocol":"NormalizationProfileV1","mappings":[{"detectorClass":"skillspector","nativeRuleId":"one","native\\u0052uleId":"two","canonicalCode":"trust.detector-finding","compatibility":${JSON.stringify(
          compatibility,
        )}}]}`,
      ),
    ).toThrow(/duplicate.*nativeRuleId/i);
    expect(() =>
      parseNormalizationProfileV1Json(
        `{"protocol":"NormalizationProfileV1","mappings":[{"detectorClass":"skillspector","nativeRuleId":"one","canonicalCode":"trust.detector-finding","compatibility":{"scannerManifestSha256":"${compatibility.scannerManifestSha256}","analyzerIdentitySha256":"${compatibility.analyzerIdentitySha256}","analyzer\\u0049dentitySha256":"${alternateCompatibility.analyzerIdentitySha256}","normalizationConfigurationSha256":"${compatibility.normalizationConfigurationSha256}"}}]}`,
      ),
    ).toThrow(/duplicate.*analyzerIdentitySha256/i);
  });

  it("rejects comments, trailing commas, and a non-object JSON root", () => {
    expect(() =>
      parseNormalizationProfileV1Json(
        `{"protocol":"NormalizationProfileV1",/* comment */"mappings":[]}`,
      ),
    ).toThrow(/JSON|comment/i);
    expect(() =>
      parseNormalizationProfileV1Json(`{"protocol":"NormalizationProfileV1","mappings":[],}`),
    ).toThrow(/JSON|trailing/i);
    expect(() => parseNormalizationProfileV1Json("[]")).toThrow(/object/i);
    expect(() => parseNormalizationProfileV1Json('"NormalizationProfileV1"')).toThrow(/object/i);
  });

  it("rejects unknown properties at the profile, mapping, and compatibility levels", () => {
    expect(() => parseNormalizationProfileV1({ ...profile(), unexpected: true })).toThrow(
      /unexpected|unrecognized/i,
    );
    expect(() =>
      parseNormalizationProfileV1(profile([{ ...mapping(), unexpected: true } as never])),
    ).toThrow(/unexpected|unrecognized/i);
    expect(() =>
      parseNormalizationProfileV1(
        profile([
          mapping({
            compatibility: { ...compatibility, unexpected: true } as never,
          }),
        ]),
      ),
    ).toThrow(/unexpected|unrecognized/i);
  });

  it("rejects lone, reversed, and partial surrogate sequences recursively", () => {
    for (const invalid of ["\ud800", "\udfff", "\udfff\ud800", "ok\ud800x", "ok\udfffx"]) {
      expect(() =>
        parseNormalizationProfileV1(profile([mapping({ nativeRuleId: invalid })])),
      ).toThrow(/Unicode|surrogate/i);
    }
    expect(
      parseNormalizationProfileV1(profile([mapping({ nativeRuleId: "skillspector.😀" })]))
        .mappings[0]?.nativeRuleId,
    ).toBe("skillspector.😀");
  });

  it("rejects every non-NFC identity-bearing key or value and never normalizes it", () => {
    const composed = "règle";
    const decomposed = "re\u0300gle";
    expect(decomposed.normalize("NFC")).toBe(composed);
    expect(
      parseNormalizationProfileV1(profile([mapping({ nativeRuleId: composed })])).mappings[0]
        ?.nativeRuleId,
    ).toBe(composed);
    expect(() =>
      parseNormalizationProfileV1(profile([mapping({ nativeRuleId: decomposed })])),
    ).toThrow(/NFC/i);
    expect(() =>
      parseNormalizationProfileV1(profile([mapping({ detectorClass: "se\u0301mgrep" })])),
    ).toThrow(/NFC/i);
    expect(() =>
      parseNormalizationProfileV1Json(
        `{"protocol":"NormalizationProfileV1","ma\\u0070pings":${JSON.stringify([mapping()])}}`,
      ),
    ).not.toThrow();
  });

  it("accepts only the exact bounded normalization target-code set", () => {
    expect(NORMALIZATION_TARGET_CODES_V1).toEqual([
      "trust.auto-exec-hook",
      "trust.cisco-finding",
      "trust.dependency-confusion",
      "trust.detector-finding",
      "trust.external-egress",
      "trust.hidden-unicode",
      "trust.legal-text-detector-finding",
      "trust.malicious-code",
      "trust.prompt-injection",
      "trust.skill-metadata-license",
      "trust.typosquat",
      "trust.visible-unicode",
    ]);
    for (const canonicalCode of [
      "baseline.evidence-blocked",
      "trust.arbitrary-future-code",
      "trust.*",
      "trust.unmapped-external-rule",
    ]) {
      expect(() =>
        parseNormalizationProfileV1(profile([mapping({ canonicalCode: canonicalCode as never })])),
      ).toThrow(/canonical|target|trust/i);
    }
  });

  it("rejects wildcard, regex-shaped, empty, or generic mapping selectors", () => {
    for (const detectorClass of ["", "*", "skillspector*", ".*", "/skillspector/"]) {
      expect(() => parseNormalizationProfileV1(profile([mapping({ detectorClass })]))).toThrow(
        /detector|selector/i,
      );
    }
    for (const nativeRuleId of ["", "*", "skillspector.*", ".+", "/prompt.*/"]) {
      expect(() => parseNormalizationProfileV1(profile([mapping({ nativeRuleId })]))).toThrow(
        /rule|selector/i,
      );
    }
  });

  it("bounds profile and selector sizes", () => {
    expect(() =>
      parseNormalizationProfileV1(
        profile([mapping({ nativeRuleId: `rule.${"x".repeat(2_048)}` })]),
      ),
    ).toThrow(/rule|length|small/i);
    expect(() =>
      parseNormalizationProfileV1(
        profile(
          Array.from({ length: 4_097 }, (_, index) =>
            mapping({ nativeRuleId: `rule-${String(index)}` }),
          ),
        ),
      ),
    ).toThrow(/mapping|bounded|many/i);
  });

  it("rejects malformed, duplicate, and ambiguous mappings", () => {
    expect(() =>
      parseNormalizationProfileV1(
        profile([mapping({ compatibility: { ...compatibility, analyzerIdentitySha256: "bad" } })]),
      ),
    ).toThrow(/digest|sha256/i);
    expect(() => parseNormalizationProfileV1(profile([mapping(), mapping()]))).toThrow(
      /duplicate/i,
    );
    expect(() =>
      parseNormalizationProfileV1(
        profile([mapping(), mapping({ canonicalCode: "trust.prompt-injection" })]),
      ),
    ).toThrow(/ambiguous/i);
  });

  it("allows one selector to have non-overlapping exact compatibility identities", () => {
    const parsed = parseNormalizationProfileV1(
      profile([mapping({ compatibility: alternateCompatibility }), mapping()]),
    );
    expect(parsed.mappings).toHaveLength(2);
    expect(
      resolveNormalizationV1(parsed, {
        detectorClass: "skillspector",
        nativeRuleId: "skillspector.prompt-injection",
        compatibility: alternateCompatibility,
      }),
    ).toEqual({
      kind: "mapped",
      canonicalCode: "trust.detector-finding",
      acceptanceRequired: false,
      normalizationEntryDigest: normalizationEntryDigestV1(
        mapping({ compatibility: alternateCompatibility }),
      ),
    });
  });

  it("sorts mappings by schema-defined selector and compatibility order", () => {
    const parsed = parseNormalizationProfileV1(
      profile([
        mapping({
          detectorClass: "snyk-agent-scan",
          nativeRuleId: "W012",
          compatibility: alternateCompatibility,
        }),
        mapping({ detectorClass: "semgrep", nativeRuleId: "semgrep.prompt-injection" }),
        mapping({ detectorClass: "semgrep", nativeRuleId: "semgrep.malicious-code" }),
        mapping({
          detectorClass: "semgrep",
          nativeRuleId: "semgrep.malicious-code",
          compatibility: alternateCompatibility,
        }),
      ]),
    );
    expect(
      parsed.mappings.map((entry) => [
        entry.detectorClass,
        entry.nativeRuleId,
        entry.compatibility.scannerManifestSha256,
      ]),
    ).toEqual([
      ["semgrep", "semgrep.malicious-code", compatibility.scannerManifestSha256],
      ["semgrep", "semgrep.malicious-code", alternateCompatibility.scannerManifestSha256],
      ["semgrep", "semgrep.prompt-injection", compatibility.scannerManifestSha256],
      ["snyk-agent-scan", "W012", alternateCompatibility.scannerManifestSha256],
    ]);
  });

  it("keeps mapping-entry and profile digests stable across input property and mapping order", () => {
    const entry = mapping();
    const reorderedEntry = {
      compatibility: {
        normalizationConfigurationSha256: compatibility.normalizationConfigurationSha256,
        analyzerIdentitySha256: compatibility.analyzerIdentitySha256,
        scannerManifestSha256: compatibility.scannerManifestSha256,
      },
      canonicalCode: "trust.detector-finding" as const,
      nativeRuleId: "skillspector.prompt-injection",
      detectorClass: "skillspector",
    };
    expect(normalizationEntryDigestV1(entry)).toBe(normalizationEntryDigestV1(reorderedEntry));

    const first = profile([
      mapping({ detectorClass: "semgrep", nativeRuleId: "semgrep.malicious-code" }),
      entry,
    ]);
    const second = {
      mappings: [reorderedEntry, first.mappings[0] as NormalizationProfileV1["mappings"][number]],
      protocol: "NormalizationProfileV1" as const,
    };
    expect(normalizationProfileDigestV1(first)).toBe(normalizationProfileDigestV1(second));
    expect(normalizationEntryDigestV1(entry)).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizationProfileDigestV1(first)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("NormalizationProfileV1 exact resolution", () => {
  it("returns a closed mapped resolution for one exact compatible entry", () => {
    expect(resolveBase()).toEqual({
      kind: "mapped",
      canonicalCode: "trust.detector-finding",
      acceptanceRequired: false,
      normalizationEntryDigest: normalizationEntryDigestV1(mapping()),
    });
  });

  it("returns the exact closed acceptance-required unmapped state for a novel rule", () => {
    const resolution = resolveNormalizationV1(parseNormalizationProfileV1(profile()), {
      detectorClass: "skillspector",
      nativeRuleId: "skillspector.synthetic-future-rule",
      compatibility,
    });
    expect(resolution).toEqual({
      kind: "unmapped",
      canonicalCode: "trust.unmapped-external-rule",
      acceptanceRequired: true,
      normalizationEntryDigest: null,
    });
    expect(Object.keys(resolution).sort()).toEqual([
      "acceptanceRequired",
      "canonicalCode",
      "kind",
      "normalizationEntryDigest",
    ]);
    expect(JSON.stringify(resolution)).not.toMatch(
      /PASS|SUPPRESSED|trust\.detector-finding|trust\.cisco-finding/,
    );
  });

  it("distinguishes a novel selector from each exact compatibility mismatch", () => {
    const parsed = parseNormalizationProfileV1(profile());
    expect(
      resolveNormalizationV1(parsed, {
        detectorClass: "semgrep",
        nativeRuleId: "semgrep.synthetic-future-rule",
        compatibility,
      }),
    ).toEqual(expect.objectContaining({ kind: "unmapped" }));

    for (const field of [
      "scannerManifestSha256",
      "analyzerIdentitySha256",
      "normalizationConfigurationSha256",
    ] as const) {
      expect(() =>
        resolveNormalizationV1(parsed, {
          detectorClass: "skillspector",
          nativeRuleId: "skillspector.prompt-injection",
          compatibility: {
            ...compatibility,
            [field]: alternateCompatibility[field],
          },
        }),
      ).toThrow(new RegExp(`compatibility.*${field}|${field}.*mismatch`, "i"));
    }
  });
});

describe("RawOccurrenceFingerprintV1 strict identity", () => {
  it("models exactly six identity fields plus a closed diagnostics object", () => {
    const result = createRawOccurrenceFingerprintV1(rawInput());
    expect(result).toEqual({
      ...rawInput(),
      fingerprint: expect.stringMatching(/^raw-occurrence-v1:[0-9a-f]{64}$/),
    });
    expect(Object.keys(result).sort()).toEqual([
      "canonicalOrdinal",
      "detectorClass",
      "diagnostics",
      "fileSha256",
      "fingerprint",
      "nativeRuleId",
      "path",
      "protocol",
    ]);
    expect(rawOccurrenceCanonicalBytesV1(result).toString("utf8")).toBe(
      `{"canonicalOrdinal":0,"detectorClass":"skillspector","fileSha256":"${rawInput().fileSha256}","nativeRuleId":"skillspector.prompt-injection","path":"skills/reviewer/SKILL.md","protocol":"RawOccurrenceFingerprintV1"}`,
    );
  });

  it("changes identity when any variable identity field changes", () => {
    const base = createRawOccurrenceFingerprintV1(rawInput()).fingerprint;
    for (const changed of [
      rawInput({ detectorClass: "semgrep" }),
      rawInput({ nativeRuleId: "skillspector.auto-exec" }),
      rawInput({ path: "skills/other/SKILL.md" }),
      rawInput({ fileSha256: sha256("different exact file bytes") }),
      rawInput({ canonicalOrdinal: 1 }),
    ]) {
      expect(createRawOccurrenceFingerprintV1(changed).fingerprint).not.toBe(base);
    }
    expect(() =>
      createRawOccurrenceFingerprintV1({
        ...rawInput(),
        protocol: "RawOccurrenceFingerprintV2",
      } as never),
    ).toThrow(/protocol|version/i);
  });

  it("excludes every diagnostic field from identity", () => {
    const base = createRawOccurrenceFingerprintV1(rawInput()).fingerprint;
    const variants: RawOccurrenceFingerprintV1Input["diagnostics"][] = [
      { ...rawInput().diagnostics, analyzerVersion: "another analyzer" },
      { ...rawInput().diagnostics, severity: "error" },
      { ...rawInput().diagnostics, message: "rewritten message" },
      { ...rawInput().diagnostics, timestamp: "2099-01-01T00:00:00.000Z" },
      { ...rawInput().diagnostics, runIdentifier: "another-run" },
      { ...rawInput().diagnostics, rawFormatting: "totally different formatting" },
      { ...rawInput().diagnostics, displayLine: 9_999 },
    ];
    for (const diagnostics of variants) {
      expect(createRawOccurrenceFingerprintV1(rawInput({ diagnostics })).fingerprint).toBe(base);
    }
  });

  it("uses the caller-supplied canonical ordinal and distinguishes repeated identical emissions", () => {
    const first = createRawOccurrenceFingerprintV1(rawInput({ canonicalOrdinal: 0 }));
    const repeated = createRawOccurrenceFingerprintV1(rawInput({ canonicalOrdinal: 1 }));
    expect(first.fingerprint).not.toBe(repeated.fingerprint);
    expect(first.canonicalOrdinal).toBe(0);
    expect(repeated.canonicalOrdinal).toBe(1);
  });

  it.each([
    ["empty", ""],
    ["POSIX absolute", "/etc/passwd"],
    ["Windows drive absolute", "C:/Windows/System32/config"],
    ["Windows drive relative", "C:evil"],
    ["UNC", "\\\\server\\share\\file"],
    ["Win32 device drive", "\\\\?\\C:\\x"],
    ["Win32 named pipe", "\\\\.\\pipe\\x"],
    ["backslash", "skills\\x\\SKILL.md"],
    ["leading dot segment", "./skills/x/SKILL.md"],
    ["embedded dot segment", "skills/./x/SKILL.md"],
    ["leading traversal", "../skills/x/SKILL.md"],
    ["embedded traversal", "skills/../x/SKILL.md"],
    ["doubled empty segment", "skills//x/SKILL.md"],
    ["trailing slash", "skills/x/"],
    ["NUL", "skills/x\u0000/SKILL.md"],
    ["control", "skills/x\u001f/SKILL.md"],
    ["file URI", "file:///tmp/SKILL.md"],
    ["HTTP URI", "https://example.test/SKILL.md"],
    ["query", "skills/x/SKILL.md?copy=1"],
    ["fragment", "skills/x/SKILL.md#section"],
    ["encoded traversal", "skills/%2e%2e/x/SKILL.md"],
  ])("rejects the %s path class", (_label, path) => {
    expect(() => createRawOccurrenceFingerprintV1(rawInput({ path }))).toThrow(/path/i);
  });

  it("rejects hostile paths rather than collapsing distinct inputs to a placeholder", () => {
    expect(() => createRawOccurrenceFingerprintV1(rawInput({ path: "../one" }))).toThrow(/path/i);
    expect(() => createRawOccurrenceFingerprintV1(rawInput({ path: "../two" }))).toThrow(/path/i);
  });

  it("accepts a safe NFC POSIX relative path with a valid supplementary pair", () => {
    expect(createRawOccurrenceFingerprintV1(rawInput({ path: "skills/😀/SKILL.md" })).path).toBe(
      "skills/😀/SKILL.md",
    );
  });

  it.each([
    ["uppercase", "A".repeat(64)],
    ["algorithm prefix", `sha256:${"a".repeat(64)}`],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["non-hex", `${"a".repeat(63)}g`],
  ])("rejects the %s file digest", (_label, fileSha256) => {
    expect(() => createRawOccurrenceFingerprintV1(rawInput({ fileSha256 }))).toThrow(
      /file.*sha256|digest/i,
    );
  });

  it.each([
    ["string", "1"],
    ["null", null],
    ["fraction", 1.5],
    ["negative", -1],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
  ])("rejects the %s canonical ordinal", (_label, canonicalOrdinal) => {
    expect(() =>
      createRawOccurrenceFingerprintV1(rawInput({ canonicalOrdinal: canonicalOrdinal as never })),
    ).toThrow(/ordinal/i);
  });

  it("rejects a missing canonical ordinal", () => {
    const { canonicalOrdinal: _canonicalOrdinal, ...withoutOrdinal } = rawInput();
    expect(() => createRawOccurrenceFingerprintV1(withoutOrdinal as never)).toThrow(/ordinal/i);
  });

  it("rejects unknown raw and diagnostics fields and an absolute-machine-path diagnostic", () => {
    expect(() =>
      createRawOccurrenceFingerprintV1({ ...rawInput(), unexpected: true } as never),
    ).toThrow(/unexpected|unrecognized/i);
    expect(() =>
      createRawOccurrenceFingerprintV1(
        rawInput({ diagnostics: { ...rawInput().diagnostics, unexpected: true } as never }),
      ),
    ).toThrow(/unexpected|unrecognized/i);
    expect(() =>
      createRawOccurrenceFingerprintV1(
        rawInput({
          diagnostics: {
            ...rawInput().diagnostics,
            absoluteMachinePath: "C:\\Users\\operator\\source\\SKILL.md",
          },
        }),
      ),
    ).toThrow(/absolute.*path|machine.*path/i);
  });
});

describe("CanonicalFindingIdentityV1", () => {
  it("binds a validated mapped resolution, raw occurrence, and contextual outcome", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const normalizationResolution = resolveBase();
    const finding = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution,
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    expect(finding).toEqual({
      kind: "mapped",
      canonicalCode: "trust.detector-finding",
      rawOccurrenceFingerprint: rawOccurrence.fingerprint,
      normalizationEntryDigest: normalizationEntryDigestV1(mapping()),
      contextualEvaluationOutcome: "suppressed-non-actionable",
      acceptanceRequired: false,
      fingerprint: expect.stringMatching(/^canonical-finding-v1:mapped:[0-9a-f]{64}$/),
    });
  });

  it("binds unmapped visibility without fabricating a mapping digest or disposition", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(
      rawInput({ nativeRuleId: "skillspector.synthetic-future-rule" }),
    );
    const normalizationResolution = resolveNormalizationV1(parseNormalizationProfileV1(profile()), {
      detectorClass: rawOccurrence.detectorClass,
      nativeRuleId: rawOccurrence.nativeRuleId,
      compatibility,
    });
    const finding = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution,
      contextualEvaluationOutcome: "mapping-required",
    });
    expect(finding).toEqual({
      kind: "unmapped",
      canonicalCode: "trust.unmapped-external-rule",
      rawOccurrenceFingerprint: rawOccurrence.fingerprint,
      normalizationEntryDigest: null,
      contextualEvaluationOutcome: "mapping-required",
      acceptanceRequired: true,
      fingerprint: expect.stringMatching(/^canonical-finding-v1:unmapped:[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(finding)).not.toMatch(/PASS|SUPPRESSED/);
  });

  it("requires the exact branded resolver result rather than arbitrary code and digest data", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const valid = resolveBase();
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence,
        normalizationResolution: { ...valid } as never,
        contextualEvaluationOutcome: "suppressed-non-actionable",
      }),
    ).toThrow(/validated.*resolution|resolver/i);
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence,
        normalizationResolution: {
          kind: "mapped",
          canonicalCode: "trust.prompt-injection",
          acceptanceRequired: false,
          normalizationEntryDigest: sha256("forged"),
        } as never,
        contextualEvaluationOutcome: "suppressed-non-actionable",
      }),
    ).toThrow(/validated.*resolution|resolver/i);
  });

  it("rejects using a resolution for a different raw selector", () => {
    const resolution = resolveBase();
    const differentRaw = createRawOccurrenceFingerprintV1(
      rawInput({ nativeRuleId: "skillspector.auto-exec" }),
    );
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence: differentRaw,
        normalizationResolution: resolution,
        contextualEvaluationOutcome: "suppressed-non-actionable",
      }),
    ).toThrow(/selector|resolution.*occurrence/i);
  });

  it("domain-separates mapped and unmapped finding identities", () => {
    const mappedRaw = createRawOccurrenceFingerprintV1(rawInput());
    const mapped = createCanonicalFindingIdentityV1({
      rawOccurrence: mappedRaw,
      normalizationResolution: resolveBase(),
      contextualEvaluationOutcome: "same-outcome",
    });
    const unmappedRaw = createRawOccurrenceFingerprintV1(
      rawInput({ nativeRuleId: "skillspector.synthetic-future-rule" }),
    );
    const unmappedResolution = resolveNormalizationV1(parseNormalizationProfileV1(profile()), {
      detectorClass: unmappedRaw.detectorClass,
      nativeRuleId: unmappedRaw.nativeRuleId,
      compatibility,
    });
    const unmapped = createCanonicalFindingIdentityV1({
      rawOccurrence: unmappedRaw,
      normalizationResolution: unmappedResolution,
      contextualEvaluationOutcome: "same-outcome",
    });
    expect(mapped.fingerprint).not.toBe(unmapped.fingerprint);
    expect(mapped.fingerprint).toMatch(/^canonical-finding-v1:mapped:/);
    expect(unmapped.fingerprint).toMatch(/^canonical-finding-v1:unmapped:/);
  });

  it("changes finding identity for every included policy-aware field", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const resolution = resolveBase();
    const base = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolution,
      contextualEvaluationOutcome: "suppressed-non-actionable",
    }).fingerprint;
    const changedOutcome = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolution,
      contextualEvaluationOutcome: "review-required",
    }).fingerprint;
    expect(changedOutcome).not.toBe(base);

    const changedRaw = createRawOccurrenceFingerprintV1(rawInput({ canonicalOrdinal: 1 }));
    const changedRawResolution = resolveNormalizationV1(parseNormalizationProfileV1(profile()), {
      detectorClass: changedRaw.detectorClass,
      nativeRuleId: changedRaw.nativeRuleId,
      compatibility,
    });
    expect(
      createCanonicalFindingIdentityV1({
        rawOccurrence: changedRaw,
        normalizationResolution: changedRawResolution,
        contextualEvaluationOutcome: "suppressed-non-actionable",
      }).fingerprint,
    ).not.toBe(base);
  });

  it("keeps legacy and V1 fingerprints unequal and non-authoritative across acknowledgement domains", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const v1 = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolveBase(),
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    const legacyFingerprint = `trust-detector-finding:skills/reviewer/SKILL.md:${sha256("legacy")}`;
    expect(v1.fingerprint).not.toBe(legacyFingerprint);

    const legacyCheck: Check = {
      name: "trust.external-egress",
      code: "trust.external-egress",
      verdict: "fail",
      detail: "legacy review finding",
      fingerprint: legacyFingerprint,
    };
    const v1Check: Check = { ...legacyCheck, fingerprint: v1.fingerprint };
    const context = (acknowledge: string) =>
      ({
        options: { acknowledge, reason: "reviewed" },
        env: { USER: "reviewer" },
      }) as never;
    expect(applyTrustAcknowledgements([legacyCheck], context(v1.fingerprint))).toEqual({
      checks: [legacyCheck],
      acceptedFingerprints: [],
    });
    expect(applyTrustAcknowledgements([v1Check], context(legacyFingerprint))).toEqual({
      checks: [v1Check],
      acceptedFingerprints: [],
    });
  });
});
