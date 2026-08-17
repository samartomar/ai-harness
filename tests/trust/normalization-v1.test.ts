import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import { applyTrustAcknowledgements } from "../../src/trust/acknowledge.js";
import {
  canonicalBytesV1,
  canonicalFindingCanonicalBytesV1,
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

function parsedEntry(
  overrides: Partial<NormalizationProfileV1["mappings"][number]> = {},
): NormalizationProfileV1["mappings"][number] {
  const entry = parseNormalizationProfileV1(profile([mapping(overrides)])).mappings[0];
  if (entry === undefined) throw new Error("expected parsed normalization entry");
  return entry;
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

  it("rejects lone surrogates recursively in canonical JSON keys and values", () => {
    for (const invalid of ["\ud800", "\udfff", "ok\ud800x", "ok\udfffx"]) {
      expect(() => canonicalBytesV1({ value: invalid })).toThrow(/Unicode|surrogate/i);
      expect(() => canonicalBytesV1({ [invalid]: "value" })).toThrow(/Unicode|surrogate/i);
    }
    expect(() => canonicalBytesV1({ value: "😀" })).not.toThrow();
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
        `{"protocol":"NormalizationProfileV1","mappings":[],"re\u0300gle":"value"}`,
      ),
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
        parsedEntry({ compatibility: alternateCompatibility }),
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
    const parsedEntryInOriginalOrder = parsedEntry();
    const parsedEntryInPropertyOrder = parseNormalizationProfileV1(profile([reorderedEntry]))
      .mappings[0];
    if (parsedEntryInPropertyOrder === undefined) throw new Error("expected reordered entry");
    expect(normalizationEntryDigestV1(parsedEntryInOriginalOrder)).toBe(
      normalizationEntryDigestV1(parsedEntryInPropertyOrder),
    );

    const first = profile([
      mapping({ detectorClass: "semgrep", nativeRuleId: "semgrep.malicious-code" }),
      entry,
    ]);
    const second = {
      mappings: [reorderedEntry, first.mappings[0] as NormalizationProfileV1["mappings"][number]],
      protocol: "NormalizationProfileV1" as const,
    };
    const parsedFirst = parseNormalizationProfileV1(first);
    const parsedSecond = parseNormalizationProfileV1(second);
    expect(normalizationProfileDigestV1(parsedFirst)).toBe(
      normalizationProfileDigestV1(parsedSecond),
    );
    expect(normalizationEntryDigestV1(parsedEntryInOriginalOrder)).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizationProfileDigestV1(parsedFirst)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deep-copies and deeply freezes parsed profiles, mappings, and compatibility objects", () => {
    const callerInput = profile();
    const parsed = parseNormalizationProfileV1(callerInput);
    const firstParsedMapping = parsed.mappings[0];
    if (firstParsedMapping === undefined) throw new Error("expected parsed mapping");
    (callerInput.mappings[0] as { nativeRuleId: string }).nativeRuleId = "caller-mutated";
    (
      callerInput.mappings[0]?.compatibility as {
        analyzerIdentitySha256: string;
      }
    ).analyzerIdentitySha256 = sha256("caller-mutated");
    expect(parsed.mappings[0]?.nativeRuleId).toBe("skillspector.prompt-injection");
    expect(parsed.mappings[0]?.compatibility).toEqual(compatibility);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.mappings)).toBe(true);
    expect(Object.isFrozen(parsed.mappings[0])).toBe(true);
    expect(Object.isFrozen(parsed.mappings[0]?.compatibility)).toBe(true);
    expect(() => {
      (parsed.mappings[0] as { nativeRuleId: string }).nativeRuleId = "in-place mutation";
    }).toThrow();
    expect(() => {
      (parsed.mappings as NormalizationProfileV1["mappings"]).push(firstParsedMapping);
    }).toThrow();
  });

  it("rejects unparsed, spread, malformed, unknown, and non-NFC digest inputs", () => {
    const parsed = parseNormalizationProfileV1(profile());
    const parsedMapping = parsed.mappings[0];
    if (parsedMapping === undefined) throw new Error("expected parsed mapping");
    expect(() => normalizationEntryDigestV1(mapping())).toThrow(/parsed|validated/i);
    expect(() => normalizationEntryDigestV1({ ...parsedMapping })).toThrow(/parsed|validated/i);
    expect(() => normalizationProfileDigestV1(profile())).toThrow(/parsed|validated/i);
    expect(() => normalizationProfileDigestV1({ ...parsed })).toThrow(/parsed|validated/i);
    expect(() => normalizationEntryDigestV1({ ...mapping(), unexpected: true } as never)).toThrow(
      /parsed|unknown|unrecognized/i,
    );
    expect(() => normalizationEntryDigestV1(mapping({ nativeRuleId: "re\u0300gle" }))).toThrow(
      /parsed|NFC/i,
    );
    expect(() => normalizationProfileDigestV1({ ...profile(), unexpected: true } as never)).toThrow(
      /parsed|unknown|unrecognized/i,
    );
  });

  it("orders equal selectors by manifest, analyzer, then configuration digest tie-breakers", () => {
    const compatA = {
      scannerManifestSha256: "1".repeat(64),
      analyzerIdentitySha256: "1".repeat(64),
      normalizationConfigurationSha256: "1".repeat(64),
    };
    const compatConfigLater = {
      ...compatA,
      normalizationConfigurationSha256: "2".repeat(64),
    };
    const compatAnalyzerLater = {
      ...compatA,
      analyzerIdentitySha256: "2".repeat(64),
    };
    const compatManifestLater = {
      ...compatA,
      scannerManifestSha256: "2".repeat(64),
    };
    const forward = parseNormalizationProfileV1(
      profile([
        mapping({ compatibility: compatA }),
        mapping({ compatibility: compatConfigLater }),
        mapping({ compatibility: compatAnalyzerLater }),
        mapping({ compatibility: compatManifestLater }),
      ]),
    );
    const reverse = parseNormalizationProfileV1(
      profile([
        mapping({ compatibility: compatManifestLater }),
        mapping({ compatibility: compatAnalyzerLater }),
        mapping({ compatibility: compatConfigLater }),
        mapping({ compatibility: compatA }),
      ]),
    );
    expect(forward.mappings.map((entry) => entry.compatibility)).toEqual([
      compatA,
      compatConfigLater,
      compatAnalyzerLater,
      compatManifestLater,
    ]);
    expect(reverse.mappings).toEqual(forward.mappings);
    expect(normalizationProfileDigestV1(reverse)).toBe(normalizationProfileDigestV1(forward));
  });

  it("binds every mapping entry field in the entry digest", () => {
    const base = normalizationEntryDigestV1(parsedEntry());
    const mutations: Array<Partial<NormalizationProfileV1["mappings"][number]>> = [
      { detectorClass: "semgrep" },
      { nativeRuleId: "skillspector.auto-exec" },
      { canonicalCode: "trust.prompt-injection" },
      {
        compatibility: {
          ...compatibility,
          scannerManifestSha256: alternateCompatibility.scannerManifestSha256,
        },
      },
      {
        compatibility: {
          ...compatibility,
          analyzerIdentitySha256: alternateCompatibility.analyzerIdentitySha256,
        },
      },
      {
        compatibility: {
          ...compatibility,
          normalizationConfigurationSha256: alternateCompatibility.normalizationConfigurationSha256,
        },
      },
    ];
    for (const mutation of mutations) {
      expect(normalizationEntryDigestV1(parsedEntry(mutation))).not.toBe(base);
    }
  });
});

describe("NormalizationProfileV1 exact resolution", () => {
  it("returns a closed mapped resolution for one exact compatible entry", () => {
    expect(resolveBase()).toEqual({
      kind: "mapped",
      canonicalCode: "trust.detector-finding",
      acceptanceRequired: false,
      normalizationEntryDigest: normalizationEntryDigestV1(parsedEntry()),
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

  it("requires a parsed branded profile and rejects unparsed or spread copies", () => {
    const parsed = parseNormalizationProfileV1(profile());
    const selector = {
      detectorClass: "skillspector",
      nativeRuleId: "skillspector.prompt-injection",
      compatibility,
    };
    expect(() => resolveNormalizationV1(profile(), selector)).toThrow(/parsed|validated/i);
    expect(() => resolveNormalizationV1({ ...parsed }, selector)).toThrow(/parsed|validated/i);
  });

  it("strictly rejects malformed resolver lookup requests instead of returning unmapped", () => {
    const parsed = parseNormalizationProfileV1(profile());
    const validLookup = {
      detectorClass: "skillspector",
      nativeRuleId: "skillspector.prompt-injection",
      compatibility,
    };

    expect(() =>
      resolveNormalizationV1(parsed, { ...validLookup, unexpected: true } as never),
    ).toThrow(/lookup|unexpected|unrecognized/i);
    expect(() =>
      resolveNormalizationV1(parsed, {
        nativeRuleId: validLookup.nativeRuleId,
        compatibility,
      } as never),
    ).toThrow(/detector|lookup|selector/i);
    expect(() =>
      resolveNormalizationV1(parsed, {
        detectorClass: validLookup.detectorClass,
        compatibility,
      } as never),
    ).toThrow(/rule|lookup|selector/i);
    expect(() =>
      resolveNormalizationV1(parsed, {
        detectorClass: validLookup.detectorClass,
        nativeRuleId: validLookup.nativeRuleId,
      } as never),
    ).toThrow(/compatibility|lookup/i);

    for (const detectorClass of [
      "",
      " ",
      "*",
      ".*",
      "/skillspector/",
      `d${"x".repeat(1_024)}`,
      "se\u0301mgrep",
      "x\ud800y",
      "x\udfffy",
    ]) {
      expect(() => resolveNormalizationV1(parsed, { ...validLookup, detectorClass })).toThrow(
        /detector|lookup|selector|NFC|Unicode|surrogate/i,
      );
    }
    for (const nativeRuleId of [
      "",
      " ",
      "*",
      ".+",
      "/prompt.*/",
      `r${"x".repeat(4_096)}`,
      "re\u0300gle",
      "x\ud800y",
      "x\udfffy",
    ]) {
      expect(() => resolveNormalizationV1(parsed, { ...validLookup, nativeRuleId })).toThrow(
        /rule|lookup|selector|NFC|Unicode|surrogate/i,
      );
    }

    expect(() =>
      resolveNormalizationV1(parsed, {
        ...validLookup,
        compatibility: { ...compatibility, unexpected: true } as never,
      }),
    ).toThrow(/compatibility|unexpected|unrecognized/i);
    for (const field of [
      "scannerManifestSha256",
      "analyzerIdentitySha256",
      "normalizationConfigurationSha256",
    ] as const) {
      const missing = Object.fromEntries(
        Object.entries(compatibility).filter(([key]) => key !== field),
      );
      expect(() =>
        resolveNormalizationV1(parsed, {
          ...validLookup,
          compatibility: missing as never,
        }),
      ).toThrow(new RegExp(`compatibility|${field}|digest|sha256`, "i"));
      for (const invalid of [42, "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
        expect(() =>
          resolveNormalizationV1(parsed, {
            ...validLookup,
            compatibility: { ...compatibility, [field]: invalid } as never,
          }),
        ).toThrow(new RegExp(`compatibility|${field}|digest|sha256`, "i"));
      }
    }
  });

  it("distinguishes a novel selector from each exact compatibility mismatch", () => {
    const parsed = parseNormalizationProfileV1(profile());
    const novelRule = "skillspector.synthetic-future-rule";
    expect(
      resolveNormalizationV1(parsed, {
        detectorClass: "skillspector",
        nativeRuleId: novelRule,
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
          nativeRuleId: novelRule,
          compatibility: {
            ...compatibility,
            [field]: alternateCompatibility[field],
          },
        }),
      ).toThrow(new RegExp(`compatibility.*${field}|${field}.*mismatch`, "i"));
    }

    expect(
      resolveNormalizationV1(parsed, {
        detectorClass: "entirely-unknown-detector",
        nativeRuleId: "future-rule",
        compatibility: alternateCompatibility,
      }),
    ).toEqual(expect.objectContaining({ kind: "unmapped" }));
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
    const bytes = rawOccurrenceCanonicalBytesV1(result);
    expect(bytes.toString("utf8")).toBe(
      `{"canonicalOrdinal":0,"detectorClass":"skillspector","fileSha256":"${rawInput().fileSha256}","nativeRuleId":"skillspector.prompt-injection","path":"skills/reviewer/SKILL.md","protocol":"RawOccurrenceFingerprintV1"}`,
    );
    expect(result.fingerprint).toBe(
      `raw-occurrence-v1:${createHash("sha256").update(bytes).digest("hex")}`,
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
    ["mixed-case encoded traversal", "skills/%2E%2e/x/SKILL.md"],
    ["encoded slash", "skills/x%2fchild/SKILL.md"],
    ["encoded backslash", "skills/x%5Cchild/SKILL.md"],
    ["encoded percent", "skills/x%25child/SKILL.md"],
    ["literal percent", "skills/100%/SKILL.md"],
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

  it("rejects non-NFC and malformed Unicode in every raw identity string", () => {
    for (const field of ["detectorClass", "nativeRuleId", "path"] as const) {
      expect(() => createRawOccurrenceFingerprintV1(rawInput({ [field]: "re\u0300gle" }))).toThrow(
        /NFC/i,
      );
      for (const invalid of ["\ud800", "\udfff", "x\ud800y", "x\udfffy"]) {
        expect(() => createRawOccurrenceFingerprintV1(rawInput({ [field]: invalid }))).toThrow(
          /Unicode|surrogate/i,
        );
      }
    }
  });

  it("rejects empty, oversized, and malformed raw detector/rule selectors", () => {
    for (const detectorClass of ["", " ", "*", "/scanner/", `d${"x".repeat(1_024)}`]) {
      expect(() => createRawOccurrenceFingerprintV1(rawInput({ detectorClass }))).toThrow(
        /detector|selector/i,
      );
    }
    for (const nativeRuleId of ["", " ", "*", "/rule.*/", `r${"x".repeat(4_096)}`]) {
      expect(() => createRawOccurrenceFingerprintV1(rawInput({ nativeRuleId }))).toThrow(
        /rule|selector/i,
      );
    }
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

  it("strictly validates diagnostics types and Unicode even though diagnostics are not identity", () => {
    for (const diagnostics of [null, [], "diagnostics", 42]) {
      expect(() =>
        createRawOccurrenceFingerprintV1(rawInput({ diagnostics: diagnostics as never })),
      ).toThrow(/diagnostics|object/i);
    }
    const stringFields = [
      "analyzerVersion",
      "severity",
      "message",
      "timestamp",
      "runIdentifier",
      "rawFormatting",
    ] as const;
    for (const field of stringFields) {
      expect(() =>
        createRawOccurrenceFingerprintV1(
          rawInput({ diagnostics: { ...rawInput().diagnostics, [field]: 42 } as never }),
        ),
      ).toThrow(new RegExp(field, "i"));
      expect(() =>
        createRawOccurrenceFingerprintV1(
          rawInput({ diagnostics: { ...rawInput().diagnostics, [field]: "re\u0300gle" } }),
        ),
      ).toThrow(/NFC/i);
      expect(() =>
        createRawOccurrenceFingerprintV1(
          rawInput({ diagnostics: { ...rawInput().diagnostics, [field]: "x\ud800y" } }),
        ),
      ).toThrow(/Unicode|surrogate/i);
    }
    for (const displayLine of [
      "1",
      null,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        createRawOccurrenceFingerprintV1(
          rawInput({
            diagnostics: { ...rawInput().diagnostics, displayLine: displayLine as never },
          }),
        ),
      ).toThrow(/displayLine|line/i);
    }
  });

  it("deeply freezes raw results and rejects spread or forged canonical-byte inputs", () => {
    const raw = createRawOccurrenceFingerprintV1(rawInput());
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen(raw.diagnostics)).toBe(true);
    expect(() => {
      (raw as { fingerprint: string }).fingerprint = `raw-occurrence-v1:${"0".repeat(64)}`;
    }).toThrow();
    expect(() => {
      (raw.diagnostics as { message?: string }).message = "mutated";
    }).toThrow();
    expect(() => rawOccurrenceCanonicalBytesV1({ ...raw })).toThrow(/validated|raw result/i);
    expect(() =>
      rawOccurrenceCanonicalBytesV1({
        ...raw,
        fingerprint: `raw-occurrence-v1:${"0".repeat(64)}`,
      }),
    ).toThrow(/validated|fingerprint|raw result/i);
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
      protocol: "CanonicalFindingIdentityV1",
      kind: "mapped",
      canonicalCode: "trust.detector-finding",
      rawOccurrenceFingerprint: rawOccurrence.fingerprint,
      normalizationEntryDigest: normalizationEntryDigestV1(parsedEntry()),
      contextualEvaluationOutcome: "suppressed-non-actionable",
      acceptanceRequired: false,
      fingerprint: expect.stringMatching(/^canonical-finding-v1:mapped:[0-9a-f]{64}$/),
    });
    const bytes = canonicalFindingCanonicalBytesV1(finding);
    expect(bytes.toString("utf8")).toBe(
      `{"canonicalCode":"trust.detector-finding","contextualEvaluationOutcome":"suppressed-non-actionable","kind":"mapped","normalizationEntryDigest":"${normalizationEntryDigestV1(parsedEntry())}","protocol":"CanonicalFindingIdentityV1","rawOccurrenceFingerprint":"${rawOccurrence.fingerprint}"}`,
    );
    expect(finding.fingerprint).toBe(
      `canonical-finding-v1:mapped:${createHash("sha256").update(bytes).digest("hex")}`,
    );
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
      protocol: "CanonicalFindingIdentityV1",
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
    expect(Object.isFrozen(valid)).toBe(true);
    expect(() => {
      (valid as { canonicalCode: string }).canonicalCode = "trust.prompt-injection";
    }).toThrow();
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

  it("rejects spread-forged raw results and unknown finding-input properties", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const resolution = resolveBase();
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence: { ...rawOccurrence },
        normalizationResolution: resolution,
        contextualEvaluationOutcome: "suppressed-non-actionable",
      }),
    ).toThrow(/validated.*raw|raw.*result/i);
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence: {
          ...rawOccurrence,
          fingerprint: `raw-occurrence-v1:${"0".repeat(64)}`,
        },
        normalizationResolution: resolution,
        contextualEvaluationOutcome: "suppressed-non-actionable",
      }),
    ).toThrow(/validated.*raw|fingerprint/i);
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence,
        normalizationResolution: resolution,
        contextualEvaluationOutcome: "suppressed-non-actionable",
        unexpected: true,
      } as never),
    ).toThrow(/unexpected|unrecognized/i);
  });

  it("permits only closed contextual outcomes for mapped and unmapped findings", () => {
    const mappedRaw = createRawOccurrenceFingerprintV1(rawInput());
    const mappedResolution = resolveBase();
    for (const outcome of ["suppressed-non-actionable", "review-required"] as const) {
      expect(() =>
        createCanonicalFindingIdentityV1({
          rawOccurrence: mappedRaw,
          normalizationResolution: mappedResolution,
          contextualEvaluationOutcome: outcome,
        }),
      ).not.toThrow();
    }
    const unmappedRaw = createRawOccurrenceFingerprintV1(
      rawInput({ nativeRuleId: "skillspector.synthetic-future-rule" }),
    );
    const unmappedResolution = resolveNormalizationV1(parseNormalizationProfileV1(profile()), {
      detectorClass: unmappedRaw.detectorClass,
      nativeRuleId: unmappedRaw.nativeRuleId,
      compatibility,
    });
    expect(Object.isFrozen(unmappedResolution)).toBe(true);
    expect(() => {
      (unmappedResolution as { canonicalCode: string }).canonicalCode = "trust.detector-finding";
    }).toThrow();
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence: unmappedRaw,
        normalizationResolution: { ...unmappedResolution } as never,
        contextualEvaluationOutcome: "mapping-required",
      }),
    ).toThrow(/validated.*resolution|resolver/i);
    expect(() =>
      createCanonicalFindingIdentityV1({
        rawOccurrence: unmappedRaw,
        normalizationResolution: unmappedResolution,
        contextualEvaluationOutcome: "mapping-required",
      }),
    ).not.toThrow();

    for (const outcome of [
      "same-outcome",
      "",
      "x".repeat(4_096),
      "re\u0300view-required",
      "x\ud800y",
      "PASS",
      "SUPPRESSED",
      "BLOCK",
      "WARN",
      "mapping-required",
    ]) {
      expect(() =>
        createCanonicalFindingIdentityV1({
          rawOccurrence: mappedRaw,
          normalizationResolution: mappedResolution,
          contextualEvaluationOutcome: outcome as never,
        }),
      ).toThrow(/context|outcome|NFC|Unicode|surrogate/i);
    }
    for (const outcome of ["suppressed-non-actionable", "review-required", "PASS", "unknown"]) {
      expect(() =>
        createCanonicalFindingIdentityV1({
          rawOccurrence: unmappedRaw,
          normalizationResolution: unmappedResolution,
          contextualEvaluationOutcome: outcome as never,
        }),
      ).toThrow(/mapping-required|context|outcome/i);
    }
  });

  it("uses the same raw occurrence to produce distinct mapped and unmapped identities", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const mapped = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolveBase(),
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    const unmappedResolution = resolveNormalizationV1(parseNormalizationProfileV1(profile([])), {
      detectorClass: rawOccurrence.detectorClass,
      nativeRuleId: rawOccurrence.nativeRuleId,
      compatibility,
    });
    const unmapped = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: unmappedResolution,
      contextualEvaluationOutcome: "mapping-required",
    });
    expect(mapped.rawOccurrenceFingerprint).toBe(unmapped.rawOccurrenceFingerprint);
    expect(mapped.fingerprint).not.toBe(unmapped.fingerprint);
    expect(canonicalFindingCanonicalBytesV1(mapped)).not.toEqual(
      canonicalFindingCanonicalBytesV1(unmapped),
    );
  });

  it("binds raw fingerprint, canonical code, entry digest, outcome, protocol, and kind", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const base = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolveBase(),
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    const changedCodeResolution = resolveNormalizationV1(
      parseNormalizationProfileV1(profile([mapping({ canonicalCode: "trust.prompt-injection" })])),
      {
        detectorClass: rawOccurrence.detectorClass,
        nativeRuleId: rawOccurrence.nativeRuleId,
        compatibility,
      },
    );
    const changedCode = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: changedCodeResolution,
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    const changedEntryResolution = resolveNormalizationV1(
      parseNormalizationProfileV1(profile([mapping({ compatibility: alternateCompatibility })])),
      {
        detectorClass: rawOccurrence.detectorClass,
        nativeRuleId: rawOccurrence.nativeRuleId,
        compatibility: alternateCompatibility,
      },
    );
    const changedEntry = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: changedEntryResolution,
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    const changedOutcome = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolveBase(),
      contextualEvaluationOutcome: "review-required",
    });
    const changedRaw = createRawOccurrenceFingerprintV1(rawInput({ canonicalOrdinal: 1 }));
    const changedRawResolution = resolveNormalizationV1(parseNormalizationProfileV1(profile()), {
      detectorClass: changedRaw.detectorClass,
      nativeRuleId: changedRaw.nativeRuleId,
      compatibility,
    });
    const changedOccurrence = createCanonicalFindingIdentityV1({
      rawOccurrence: changedRaw,
      normalizationResolution: changedRawResolution,
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    expect(
      new Set(
        [base, changedCode, changedEntry, changedOutcome, changedOccurrence].map(
          (finding) => finding.fingerprint,
        ),
      ).size,
    ).toBe(5);
    expect(canonicalFindingCanonicalBytesV1(base).toString("utf8")).toContain(
      '"protocol":"CanonicalFindingIdentityV1"',
    );
    expect(canonicalFindingCanonicalBytesV1(base).toString("utf8")).toContain('"kind":"mapped"');
  });

  it("domain-separates mapped and unmapped finding identities", () => {
    const mappedRaw = createRawOccurrenceFingerprintV1(rawInput());
    const mapped = createCanonicalFindingIdentityV1({
      rawOccurrence: mappedRaw,
      normalizationResolution: resolveBase(),
      contextualEvaluationOutcome: "suppressed-non-actionable",
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
      contextualEvaluationOutcome: "mapping-required",
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

  it("deeply freezes canonical findings and rejects spread copies in canonical-byte helpers", () => {
    const rawOccurrence = createRawOccurrenceFingerprintV1(rawInput());
    const finding = createCanonicalFindingIdentityV1({
      rawOccurrence,
      normalizationResolution: resolveBase(),
      contextualEvaluationOutcome: "suppressed-non-actionable",
    });
    expect(Object.isFrozen(finding)).toBe(true);
    expect(() => {
      (finding as { fingerprint: string }).fingerprint =
        `canonical-finding-v1:mapped:${"0".repeat(64)}`;
    }).toThrow();
    expect(() => canonicalFindingCanonicalBytesV1({ ...finding })).toThrow(
      /validated|canonical finding/i,
    );
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
