import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  GovernanceDecisionRevocationV2Schema,
  GovernanceDecisionV2Schema,
  governanceDecisionDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";

const root = join(import.meta.dirname, "../..");

function decision(overrides: Record<string, unknown> = {}) {
  return {
    format: "aih-governance-decision",
    version: 2,
    id: "decision-platform-tool",
    qualification: "organization-qualified",
    subject: {
      kind: "tool",
      id: "platform-review-tool",
      source: {
        type: "github",
        repository: "acme/review-tool",
        commit: "a".repeat(40),
        path: "tool.json",
      },
      sourceDigest: `sha256:${"a".repeat(64)}`,
      subjectDigest: `sha256:${"b".repeat(64)}`,
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
      { ...valid, qualification: "unqualified" },
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
    ]) {
      expect(GovernanceDecisionV2Schema.safeParse(invalid).success).toBe(false);
    }
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
        registry: "https://registry.npmjs.org",
        package: "review-tool",
        version: "1.2.3",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
      {
        type: "pypi",
        registry: "https://pypi.org",
        package: "review-tool",
        version: "1.2.3",
        filename: "review_tool-1.2.3.whl",
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
    ];
    for (const [index, kind] of ["tool", "skill", "mcp", "package", "profile"].entries()) {
      expect(
        GovernanceDecisionV2Schema.safeParse(
          decision({
            subject: {
              ...GovernanceDecisionV2Schema.parse(decision()).subject,
              kind,
              source: sources[index % sources.length],
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
  });
});
