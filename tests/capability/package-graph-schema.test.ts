import { describe, expect, it } from "vitest";
import {
  PackageGraphDetectorSchema,
  PackageGraphSchema,
  PackageGraphSourceDigestSchema,
  PackageGraphSourceSchema,
  PackageIdSchema,
  SurfaceIdSchema,
} from "../../src/capability/package-graph/index.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);
const UNSAFE_DETECTOR_VERSIONS = [
  "5.0.0\u000a",
  "5.0.0\u0085",
  "5.0.0\u200b",
  "5.0.0\u200c",
  "5.0.0\u200d",
  "5.0.0\u202e",
  "5.0.0\u2060",
  "5.0.0\u2028",
  "5.0.0\u2029",
  "5.0.0\ufeff",
];

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "github",
    repository: "acme/security-skills",
    ...overrides,
  };
}

function surface(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "skill:security-review",
    source: source(),
    sourceDigest: { algorithm: "git-sha1", value: SHA1 },
    declaredRisk: [
      { axis: "egress", value: "none" },
      { axis: "supply-chain", value: "pinned" },
    ],
    observedRisk: [
      {
        detector: { name: "aih-native", version: "5.0.0" },
        evidence: {
          sha256: SHA256,
          subjectDigest: { algorithm: "git-sha1", value: SHA1 },
        },
        verdict: "pass",
        findings: [],
      },
    ],
    ...overrides,
  };
}

function pkg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "package:baseline/ecc",
    source: source(),
    sourceDigest: { algorithm: "sha256", value: SHA256 },
    members: ["skill:security-review"],
    declaredRisk: [],
    observedRisk: [],
    ...overrides,
  };
}

function graph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    surfaces: [surface()],
    packages: [pkg()],
    ...overrides,
  };
}

describe("Package Graph v1 schema", () => {
  it("parses human-readable surfaces, shallow packages, and separate risk records", () => {
    const parsed = PackageGraphSchema.parse(graph());

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      surfaces: [
        {
          id: "skill:security-review",
          source: { provider: "github", repository: "acme/security-skills" },
          sourceDigest: { algorithm: "git-sha1", value: SHA1 },
          declaredRisk: [
            { axis: "egress", value: "none" },
            { axis: "supply-chain", value: "pinned" },
          ],
          observedRisk: [
            {
              detector: { name: "aih-native", version: "5.0.0" },
              evidence: {
                sha256: SHA256,
                subjectDigest: { algorithm: "git-sha1", value: SHA1 },
              },
              verdict: "pass",
              findings: [],
            },
          ],
        },
      ],
      packages: [{ id: "package:baseline/ecc", members: ["skill:security-review"] }],
    });
  });

  it("keeps the source identity provider-neutral", () => {
    expect(
      PackageGraphSourceSchema.parse({
        provider: "self-hosted-git",
        repository: "platform/security-skills",
      }),
    ).toEqual({
      provider: "self-hosted-git",
      repository: "platform/security-skills",
    });
  });

  it.each([
    "Skill:security-review",
    "package:baseline/ecc",
    "skill:",
    "skill:../escape",
    "skill:security//review",
    "skill:security/..",
    "skill:-security",
    "skill:security-",
  ])("rejects unsafe or reserved surface id %s", (id) => {
    expect(SurfaceIdSchema.safeParse(id).success).toBe(false);
  });

  it.each([
    "baseline:ecc",
    "Package:baseline/ecc",
    "package:baseline",
    "package:baseline/../ecc",
    "package:baseline/ecc//full",
    "package:-baseline/ecc",
  ])("rejects malformed package id %s", (id) => {
    expect(PackageIdSchema.safeParse(id).success).toBe(false);
  });

  it("rejects package-to-package composition", () => {
    expect(
      PackageGraphSchema.safeParse(
        graph({ packages: [pkg({ members: ["package:baseline/other"] })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects unresolved direct surface references", () => {
    expect(
      PackageGraphSchema.safeParse(graph({ packages: [pkg({ members: ["skill:not-declared"] })] }))
        .success,
    ).toBe(false);
  });

  it("normalizes omitted risk arrays to empty arrays", () => {
    const parsed = PackageGraphSchema.parse({
      schemaVersion: 1,
      surfaces: [
        {
          id: "skill:security-review",
          source: source(),
          sourceDigest: { algorithm: "git-sha1", value: SHA1 },
        },
      ],
      packages: [
        {
          id: "package:baseline/ecc",
          source: source(),
          sourceDigest: { algorithm: "sha256", value: SHA256 },
          members: ["skill:security-review"],
        },
      ],
    });

    expect(parsed.surfaces[0]).toMatchObject({ declaredRisk: [], observedRisk: [] });
    expect(parsed.packages[0]).toMatchObject({ declaredRisk: [], observedRisk: [] });
  });

  it("rejects observed evidence reused across source digests", () => {
    const surfaceMismatch = graph({
      surfaces: [
        surface({
          observedRisk: [
            {
              detector: { name: "aih-native", version: "5.0.0" },
              evidence: {
                sha256: SHA256,
                subjectDigest: { algorithm: "sha256", value: SHA256 },
              },
              verdict: "pass",
              findings: [],
            },
          ],
        }),
      ],
    });
    const packageMismatch = graph({
      packages: [
        pkg({
          observedRisk: [
            {
              detector: { name: "aih-native", version: "5.0.0" },
              evidence: {
                sha256: SHA256,
                subjectDigest: { algorithm: "git-sha1", value: SHA1 },
              },
              verdict: "pass",
              findings: [],
            },
          ],
        }),
      ],
    });

    expect([
      PackageGraphSchema.safeParse(surfaceMismatch).success,
      PackageGraphSchema.safeParse(packageMismatch).success,
    ]).toEqual([false, false]);
  });

  it.each(UNSAFE_DETECTOR_VERSIONS)("rejects unsafe detector version identity %#", (version) => {
    expect(PackageGraphDetectorSchema.safeParse({ name: "aih-native", version }).success).toBe(
      false,
    );
  });

  it("keeps every validation issue message free of controls and directional formatting", () => {
    for (const version of [...UNSAFE_DETECTOR_VERSIONS, "5.0.0"]) {
      const risk = {
        detector: { name: "aih-native", version },
        evidence: {
          sha256: SHA256,
          subjectDigest: { algorithm: "git-sha1", value: SHA1 },
        },
        verdict: "pass",
        findings: [],
      };
      const result = PackageGraphSchema.safeParse(
        graph({ surfaces: [surface({ observedRisk: [risk, risk] })] }),
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected observed risk rejection");
      for (const issue of result.error.issues) {
        expect(issue.message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
      }
    }
  });

  it("does not execute inherited array toJSON while distinguishing observed-risk identities", () => {
    const originalToJSON = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const observedRisk = [
      {
        detector: { name: "a", version: "bc" },
        evidence: {
          sha256: SHA256,
          subjectDigest: { algorithm: "git-sha1", value: SHA1 },
        },
        verdict: "pass",
        findings: [],
      },
      {
        detector: { name: "ab", version: "c" },
        evidence: {
          sha256: SHA256,
          subjectDigest: { algorithm: "git-sha1", value: SHA1 },
        },
        verdict: "pass",
        findings: [],
      },
    ];
    let hookCalls = 0;
    let parsedSuccessfully = false;

    try {
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value() {
          hookCalls += 1;
          return "polluted-array";
        },
      });
      parsedSuccessfully = PackageGraphSchema.safeParse(
        graph({ surfaces: [surface({ observedRisk })] }),
      ).success;
    } finally {
      if (originalToJSON === undefined) Reflect.deleteProperty(Array.prototype, "toJSON");
      else Object.defineProperty(Array.prototype, "toJSON", originalToJSON);
    }

    expect(hookCalls).toBe(0);
    expect(parsedSuccessfully).toBe(true);
  });

  it.each([
    { algorithm: "git-sha1", value: "a".repeat(39) },
    { algorithm: "git-sha1", value: "A".repeat(40) },
    { algorithm: "sha256", value: "b".repeat(63) },
    { algorithm: "sha256", value: "B".repeat(64) },
    { algorithm: "sha512", value: "b".repeat(128) },
    { algorithm: "sha256", value: SHA256, extra: true },
  ])("rejects malformed source digest %#", (digest) => {
    expect(PackageGraphSourceDigestSchema.safeParse(digest).success).toBe(false);
  });

  it("rejects duplicate graph, member, and risk identities", () => {
    for (const candidate of [
      graph({ surfaces: [surface(), surface()] }),
      graph({ packages: [pkg(), pkg()] }),
      graph({ packages: [pkg({ members: ["skill:a", "skill:a"] })] }),
      graph({
        surfaces: [
          surface({
            declaredRisk: [
              { axis: "egress", value: "none" },
              { axis: "egress", value: "third-party" },
            ],
          }),
        ],
      }),
      graph({
        surfaces: [
          surface({
            observedRisk: [
              {
                detector: { name: "aih-native", version: "5.0.0" },
                evidence: {
                  sha256: SHA256,
                  subjectDigest: { algorithm: "git-sha1", value: SHA1 },
                },
                verdict: "pass",
                findings: [],
              },
              {
                detector: { name: "aih-native", version: "5.0.0" },
                evidence: {
                  sha256: SHA256,
                  subjectDigest: { algorithm: "git-sha1", value: SHA1 },
                },
                verdict: "blocked",
                findings: [{ code: "trust.hidden-unicode" }],
              },
            ],
          }),
        ],
      }),
      graph({
        surfaces: [
          surface({
            observedRisk: [
              {
                detector: { name: "aih-native", version: "5.0.0" },
                evidence: {
                  sha256: SHA256,
                  subjectDigest: { algorithm: "git-sha1", value: SHA1 },
                },
                verdict: "blocked",
                findings: [
                  { code: "trust.hidden-unicode" },
                  { code: "trust.hidden-unicode", count: 2 },
                ],
              },
            ],
          }),
        ],
      }),
    ]) {
      expect(PackageGraphSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects unknown fields at every object boundary", () => {
    const candidates = [
      { ...graph(), extra: true },
      graph({ surfaces: [surface({ extra: true })] }),
      graph({ surfaces: [surface({ source: source({ extra: true }) })] }),
      graph({
        surfaces: [surface({ declaredRisk: [{ axis: "egress", value: "none", extra: true }] })],
      }),
      graph({
        surfaces: [
          surface({
            observedRisk: [
              {
                detector: { name: "aih-native", version: "5.0.0", extra: true },
                evidence: {
                  sha256: SHA256,
                  subjectDigest: { algorithm: "git-sha1", value: SHA1 },
                },
                verdict: "pass",
                findings: [],
              },
            ],
          }),
        ],
      }),
      graph({
        surfaces: [
          surface({
            observedRisk: [
              {
                detector: { name: "aih-native", version: "5.0.0" },
                evidence: {
                  sha256: SHA256,
                  subjectDigest: { algorithm: "git-sha1", value: SHA1 },
                  extra: true,
                },
                verdict: "pass",
                findings: [],
              },
            ],
          }),
        ],
      }),
      graph({
        surfaces: [
          surface({
            observedRisk: [
              {
                detector: { name: "aih-native", version: "5.0.0" },
                evidence: {
                  sha256: SHA256,
                  subjectDigest: { algorithm: "git-sha1", value: SHA1 },
                },
                verdict: "blocked",
                findings: [{ code: "trust.hidden-unicode", extra: true }],
                extra: true,
              },
            ],
          }),
        ],
      }),
      graph({ packages: [pkg({ extra: true })] }),
    ];

    for (const candidate of candidates) {
      expect(PackageGraphSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
