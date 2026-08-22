import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  GovernanceDecisionRevocationV2Schema,
  GovernanceDecisionV2Schema,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";

const root = join(import.meta.dirname, "../..");

function decision(overrides: Record<string, unknown> = {}) {
  const source = {
    type: "github" as const,
    repository: "acme/review-tool",
    commit: "a".repeat(40),
    path: "tool.json",
  };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  return {
    format: "aih-governance-decision",
    version: 2,
    id: "decision-platform-tool",
    qualificationBasis: {
      kind: "organization-qualified",
      evidenceDigest: `sha256:${"e".repeat(64)}`,
      attestor: "scanner-service",
    },
    subject: {
      kind: "tool",
      id: "platform-review-tool",
      source,
      sourceDigest,
      subjectDigest: governanceDecisionSubjectDigestV2({
        kind: "tool",
        id: "platform-review-tool",
        sourceDigest,
      }),
    },
    targets: ["claude", "codex"],
    allowedEffects: ["configure", "use"],
    policy: {
      id: "platform-policy",
      version: "2026.08",
      digest: `sha256:${"c".repeat(64)}`,
    },
    control: { id: "review-control", digest: `sha256:${"d".repeat(64)}` },
    evidence: {
      id: "scan-record",
      digest: `sha256:${"e".repeat(64)}`,
      attestor: "scanner-service",
    },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The exact pinned subject passed the reviewed control.",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-10T00:00:00+00:00",
    disposition: "approved",
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
    ...overrides,
  };
}

describe("GovernanceDecisionV2 public contract", () => {
  it("publishes a strict, standalone DecisionV2 JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(join(root, "schemas/aih-governance-decision-v2.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const valid = decision();

    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      { ...valid, qualification: "organization-qualified" },
      {
        ...valid,
        subject: {
          ...valid.subject,
          source: { type: "github", repository: "acme/review-tool", path: "tool.json" },
        },
      },
      { ...valid, unsignedApproved: true },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
    expect(
      GovernanceDecisionV2Schema.safeParse({
        ...valid,
        qualificationBasis: {
          kind: "aih-supported",
          catalogIssuer: "aih-catalog",
          catalogDigest: `sha256:${"0".repeat(64)}`,
          catalogHeadDigest: `sha256:${"1".repeat(64)}`,
          memberDigest: `sha256:${"2".repeat(64)}`,
          subjectKind: "skill",
          subjectDigest: valid.subject.subjectDigest,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects mutable sources and preserves canonical digest identity across round trips", () => {
    const parsed = GovernanceDecisionV2Schema.parse(decision());
    expect(governanceDecisionDigestV2(parsed)).toBe(
      governanceDecisionDigestV2(structuredClone(parsed)),
    );
    for (const invalid of [
      decision({
        subject: {
          ...parsed.subject,
          source: {
            type: "github",
            repository: "acme/review-tool",
            commit: "main",
            path: "tool.json",
          },
        },
      }),
      decision({
        subject: {
          ...parsed.subject,
          source: { ...parsed.subject.source, path: "tool/../tool.json" },
        },
      }),
      decision({
        subject: {
          ...parsed.subject,
          source: { ...parsed.subject.source, path: "tool\\tool.json" },
        },
      }),
      decision({
        subject: { ...parsed.subject, sourceDigest: `sha256:${"f".repeat(64)}` },
        extra: true,
      }),
      decision({ targets: ["codex", "claude"] }),
      decision({ allowedEffects: ["use", "configure"] }),
      decision({ issuedAt: "2026-08-02T00:00:00+00:00" }),
      decision({ qualification: "unqualified" }),
      decision({ qualificationBasis: { kind: "aih-supported" } }),
      decision({
        qualificationBasis: {
          kind: "organization-qualified",
          evidenceDigest: `sha256:${"0".repeat(64)}`,
          attestor: "unsigned-admin",
        },
      }),
      decision({
        qualificationBasis: {
          kind: "aih-supported",
          catalogIssuer: "aih-catalog",
          catalogDigest: `sha256:${"0".repeat(64)}`,
          catalogHeadDigest: `sha256:${"1".repeat(64)}`,
          memberDigest: `sha256:${"2".repeat(64)}`,
          subjectKind: "skill",
          subjectDigest: `sha256:${"b".repeat(64)}`,
        },
      }),
    ]) {
      expect(GovernanceDecisionV2Schema.safeParse(invalid).success).toBe(false);
    }
    expect(
      GovernanceDecisionV2Schema.safeParse(
        decision({
          qualificationBasis: {
            kind: "aih-supported",
            catalogIssuer: "aih-catalog",
            catalogDigest: `sha256:${"0".repeat(64)}`,
            catalogHeadDigest: `sha256:${"1".repeat(64)}`,
            memberDigest: `sha256:${"2".repeat(64)}`,
            subjectKind: "tool",
            subjectDigest: decision().subject.subjectDigest,
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      GovernanceDecisionV2Schema.safeParse(
        decision({
          qualificationBasis: {
            kind: "aih-supported",
            catalogIssuer: "aih-catalog",
            catalogDigest: `sha256:${"0".repeat(64)}`,
            catalogHeadDigest: `sha256:${"1".repeat(64)}`,
            memberDigest: `sha256:${"2".repeat(64)}`,
            subjectKind: "tool",
            subjectDigest: `sha256:${"0".repeat(64)}`,
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      GovernanceDecisionRevocationV2Schema.safeParse({
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(parsed),
        issuer: parsed.issuer,
        revokedAt: "2026-08-02T00:00:00+00:00",
        reason: "The binding was withdrawn.",
      }).success,
    ).toBe(true);
  });

  it("accepts exact GitHub, npm, PyPI, and OCI identities for every governed subject kind", () => {
    const sources = [
      { type: "github", repository: "acme/review-tool", commit: "a".repeat(40), path: "tool.json" },
      {
        type: "npm",
        registry: "https://registry.npmjs.org/",
        package: "review-tool",
        version: "1.2.3",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
      {
        type: "pypi",
        registry: "https://pypi.org/",
        package: "review-tool",
        version: "1.2.3",
        filename: "review_tool+build-1.2.3.whl",
        sha256: `sha256:${"c".repeat(64)}`,
      },
      {
        type: "oci",
        registry: "ghcr.io",
        repository: "acme/review-tool",
        indexDigest: `sha256:${"d".repeat(64)}`,
        platform: { os: "linux", architecture: "amd64" },
        manifestDigest: `sha256:${"e".repeat(64)}`,
      },
      {
        type: "remote",
        endpoint: "https://mcp.example.test/api/review",
        contentDigest: `sha256:${"f".repeat(64)}`,
      },
      { type: "aih", release: "6.1.0", revision: `sha256:${"0".repeat(64)}` },
    ];
    for (const [index, kind] of ["tool", "skill", "mcp", "package", "profile"].entries()) {
      const source = sources[index % sources.length];
      const sourceDigest = governanceDecisionSourceDigestV2(source as never);
      expect(
        GovernanceDecisionV2Schema.safeParse(
          decision({
            subject: {
              ...GovernanceDecisionV2Schema.parse(decision()).subject,
              kind,
              source,
              sourceDigest,
              subjectDigest: governanceDecisionSubjectDigestV2({
                kind: kind as never,
                id: "platform-review-tool",
                sourceDigest,
              }),
            },
          }),
        ).success,
      ).toBe(true);
    }
    for (const source of sources.slice(4)) {
      const sourceDigest = governanceDecisionSourceDigestV2(source as never);
      expect(
        GovernanceDecisionV2Schema.safeParse(
          decision({
            subject: {
              ...GovernanceDecisionV2Schema.parse(decision()).subject,
              source,
              sourceDigest,
              subjectDigest: governanceDecisionSubjectDigestV2({
                kind: "tool",
                id: "platform-review-tool",
                sourceDigest,
              }),
            },
          }),
        ).success,
      ).toBe(true);
    }
    expect(
      GovernanceDecisionV2Schema.safeParse(
        decision({
          subject: {
            ...GovernanceDecisionV2Schema.parse(decision()).subject,
            source: { ...sources[1], integrity: `sha256:${"a".repeat(64)}` },
          },
        }),
      ).success,
    ).toBe(false);
    for (const integrity of [
      "sha512-AAAA",
      `sha512-${Buffer.alloc(64).toString("base64").replace(/=$/, "")}`,
    ]) {
      expect(
        GovernanceDecisionV2Schema.safeParse(
          decision({
            subject: {
              ...GovernanceDecisionV2Schema.parse(decision()).subject,
              source: { ...sources[1], integrity },
            },
          }),
        ).success,
      ).toBe(false);
    }
  });

  it("accepts durable canonical provider identities without treating locator labels as digests", () => {
    const parsed = GovernanceDecisionV2Schema.parse(decision());
    const cases = [
      { ...parsed.subject.source, commit: "a".repeat(64) },
      {
        type: "npm",
        registry: "https://packages.example.test/npm/private/",
        package: "review-tool",
        version: "1.2.3+build.7",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
      {
        type: "pypi",
        registry: "https://packages.example.test/pypi/simple/",
        package: "review-tool",
        version: "1!2.0rc1.post2",
        filename: "review_tool+build-1.2.3.whl",
        sha256: `sha256:${"c".repeat(64)}`,
      },
      {
        type: "remote",
        endpoint: "https://mcp.example.test/api/v1/servers/review",
        contentDigest: `sha256:${"f".repeat(64)}`,
      },
    ];
    for (const source of cases) {
      const sourceDigest = governanceDecisionSourceDigestV2(source as never);
      expect(
        GovernanceDecisionV2Schema.safeParse(
          decision({
            subject: {
              ...parsed.subject,
              source,
              sourceDigest,
              subjectDigest: governanceDecisionSubjectDigestV2({
                kind: "tool",
                id: "platform-review-tool",
                sourceDigest,
              }),
            },
          }),
        ).success,
      ).toBe(true);
    }
    expect(
      GovernanceDecisionV2Schema.safeParse(
        decision({
          subject: {
            ...parsed.subject,
            source: {
              type: "pypi",
              registry: "https://packages.example.test/pypi/simple/",
              package: "review-tool",
              version: "1.0/../escape",
              filename: "review_tool-1.0.whl",
              sha256: `sha256:${"c".repeat(64)}`,
            },
          },
        }),
      ).success,
    ).toBe(false);
  });
});
