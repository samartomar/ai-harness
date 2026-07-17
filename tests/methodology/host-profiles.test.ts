import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateSyntheticMethodologyHostMappings,
  SyntheticMethodologyHostAssessmentSchema,
  SyntheticMethodologyHostProfileSchema,
} from "../../src/methodology/host-profiles.js";
import { planSyntheticMethodologyProjection } from "../../src/methodology/projection-planner.js";

const surfaces = [
  "project-projection",
  "host-built-in",
  "user-rules",
  "team-rules",
  "managed-policy",
  "plugin",
  "hook",
  "mcp",
  "compatibility",
  "remote-instruction",
] as const;

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function artifact(id: string, variation = "") {
  const contentDigest = digest(`content-${id}-${variation}`);
  const sourceIdentity = {
    locator: `synthetic://fixture/${id}`,
    digest: digest(`source-${id}-${variation}`),
  };
  return {
    id,
    path: `rules/${id}.md`,
    kind: "regular" as const,
    content: { classification: "passive" as const, digest: contentDigest },
    sourceIdentity,
    evidence: {
      target: { artifact: id, path: `rules/${id}.md`, sourceIdentity, contentDigest },
      source: "exact" as const,
      trust: "admitted" as const,
      license: "allowed" as const,
    },
    dependencies: [],
  };
}

function manifest(ids: string[] = ["review-loop"], variation = "") {
  const artifacts = ids.map((id) => artifact(id, variation));
  const plan = planSyntheticMethodologyProjection({
    schemaVersion: 1,
    classification: { schemaVersion: 1, roots: ids, artifacts },
    mappings: ids.map((id) => ({
      id,
      target: { path: `methodology/v1/rules/${id}.md`, owner: "aih-methodology-v1" as const },
    })),
  });
  if (plan.state !== "planned" || plan.manifest === null) {
    throw new Error("test fixture must create a planned manifest");
  }
  return plan.manifest;
}

const compatibility = {
  host: "claude-code" as const,
  hostVersion: "2.1.183",
  executableSha256: "a".repeat(64),
  os: "win32" as const,
  architecture: "x64" as const,
  runtime: "node-26" as const,
  policyContext: "disposable" as const,
};

function profile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "host-profile-alpha",
    project: "project-alpha",
    hostAdapter: "claude-code-static-v1",
    compatibility,
    posture: "advisory",
    surfaces: surfaces.map((id, index) => ({
      id,
      presence: id === "project-projection" ? "present" : "absent",
      precedence: index,
    })),
    ...overrides,
  };
}

function mapping(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    profile: "host-profile-alpha",
    project: "project-alpha",
    hostAdapter: "claude-code-static-v1",
    compatibility,
    manifestDigest: undefined as string | undefined,
    destination: "project-projection",
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const candidate = {
    schemaVersion: 1,
    profile: profile(),
    manifest: manifest(),
    mappings: [mapping("review-loop")],
    ...overrides,
  };
  return {
    ...candidate,
    mappings: candidate.mappings.map((candidateMapping) => ({
      ...candidateMapping,
      manifestDigest: candidateMapping.manifestDigest ?? candidate.manifest.digest,
    })),
  };
}

describe("synthetic methodology host profiles", () => {
  it("returns only a tuple-bound advisory mapping with false runtime claims", () => {
    const candidate = input();
    const result = evaluateSyntheticMethodologyHostMappings(candidate);

    expect(result).toEqual({
      schemaVersion: 1,
      state: "advisory",
      manifestDigest: candidate.manifest.digest,
      subject: {
        profile: "host-profile-alpha",
        project: "project-alpha",
        hostAdapter: "claude-code-static-v1",
        compatibility,
      },
      mappings: [
        {
          id: "review-loop",
          sourceTarget: "methodology/v1/rules/review-loop.md",
          destination: "project-projection",
        },
      ],
      findings: [],
      claims: {
        installed: false,
        active: false,
        isolated: false,
        switchable: false,
        concurrent: false,
        conflictFree: false,
      },
      boundary: {
        providerExecution: false,
        providerFetch: false,
        hostExecution: false,
        filesystem: false,
        writes: false,
        cli: false,
        executor: false,
        network: false,
        packageManager: false,
        hostNativeWrites: false,
      },
    });
  });

  it("is deterministic when caller ordering changes", () => {
    const first = evaluateSyntheticMethodologyHostMappings(
      input({
        manifest: manifest(["review-loop", "method-routing"]),
        mappings: [mapping("review-loop"), mapping("method-routing")],
      }),
    );
    const second = evaluateSyntheticMethodologyHostMappings(
      input({
        profile: profile({ surfaces: [...profile().surfaces].reverse() }),
        manifest: manifest(["method-routing", "review-loop"]),
        mappings: [mapping("method-routing"), mapping("review-loop")],
      }),
    );

    expect(second).toEqual(first);
  });

  it("blocks unsupported tuples and never promotes them to a runtime claim", () => {
    const result = evaluateSyntheticMethodologyHostMappings(
      input({ profile: profile({ posture: "unsupported" }) }),
    );

    expect(result.state).toBe("blocked");
    expect(result.mappings).toEqual([]);
    expect(result.findings).toEqual([
      { code: "METHODOLOGY_SYNTHETIC_HOST_TUPLE_UNSUPPORTED", disposition: "blocked" },
    ]);
    expect(result.claims.active).toBe(false);
  });

  it("blocks mapping/profile project, adapter, and exact compatibility mismatches", () => {
    const result = evaluateSyntheticMethodologyHostMappings(
      input({
        mappings: [
          mapping("review-loop", {
            profile: "host-profile-beta",
            project: "project-beta",
            hostAdapter: "codex-static-v1",
            compatibility: { ...compatibility, hostVersion: "2.1.184" },
          }),
        ],
      }),
    );

    expect(result).toMatchObject({
      state: "blocked",
      mappings: [],
      findings: [
        { code: "METHODOLOGY_SYNTHETIC_HOST_MAPPING_ADAPTER_MISMATCH", disposition: "blocked" },
        {
          code: "METHODOLOGY_SYNTHETIC_HOST_MAPPING_COMPATIBILITY_MISMATCH",
          disposition: "blocked",
        },
        { code: "METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROFILE_MISMATCH", disposition: "blocked" },
        { code: "METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROJECT_MISMATCH", disposition: "blocked" },
      ],
    });
  });

  it("requires declarative mappings to exactly cover the supplied manifest", () => {
    const result = evaluateSyntheticMethodologyHostMappings(
      input({
        manifest: manifest(["review-loop", "method-routing"]),
        mappings: [mapping("review-loop"), mapping("not-in-manifest")],
      }),
    );

    expect(result).toMatchObject({
      state: "blocked",
      mappings: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_HOST_MANIFEST_MAPPING_MISMATCH",
          component: "method-routing",
        },
        {
          code: "METHODOLOGY_SYNTHETIC_HOST_MANIFEST_MAPPING_MISMATCH",
          component: "not-in-manifest",
        },
      ],
    });
  });

  it("returns a bounded blocked assessment for the maximal hostile mapping set", () => {
    const manifestIds = Array.from({ length: 32 }, (_, index) => `manifest-${index}`);
    const mappingIds = Array.from({ length: 32 }, (_, index) => `mapping-${index}`);
    const result = evaluateSyntheticMethodologyHostMappings(
      input({
        profile: profile({
          posture: "unsupported",
          surfaces: profile().surfaces.map((surface) =>
            surface.id === "project-projection"
              ? { ...surface, precedence: 1 }
              : { ...surface, presence: "present", precedence: 0 },
          ),
        }),
        manifest: manifest(manifestIds),
        mappings: mappingIds.map((id) =>
          mapping(id, {
            profile: "host-profile-beta",
            project: "project-beta",
            hostAdapter: "codex-static-v1",
            compatibility: { ...compatibility, hostVersion: "2.1.184" },
            manifestDigest: digest(`replayed-${id}`),
          }),
        ),
      }),
    );

    expect(result.state).toBe("blocked");
    expect(result.mappings).toEqual([]);
    expect(result.findings).toHaveLength(234);
    expect(SyntheticMethodologyHostAssessmentSchema.parse(result)).toEqual(result);
  });

  it("binds every mapping and assessment to the exact Phase 3 manifest digest", () => {
    const firstInput = input();
    const first = evaluateSyntheticMethodologyHostMappings(firstInput);
    const changedInput = input({ manifest: manifest(["review-loop"], "changed") });
    const changed = evaluateSyntheticMethodologyHostMappings(changedInput);
    const replay = evaluateSyntheticMethodologyHostMappings(
      input({
        manifest: changedInput.manifest,
        mappings: [mapping("review-loop", { manifestDigest: firstInput.manifest.digest })],
      }),
    );

    expect(first.state).toBe("advisory");
    expect(changed.state).toBe("advisory");
    expect(first.manifestDigest).not.toBe(changed.manifestDigest);
    expect(replay).toMatchObject({
      state: "blocked",
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_HOST_MANIFEST_DIGEST_MISMATCH",
          component: "review-loop",
          disposition: "blocked",
        },
      ],
    });
  });

  it("blocks a present equal-or-higher precedence competitor rather than claiming isolation", () => {
    const result = evaluateSyntheticMethodologyHostMappings(
      input({
        profile: profile({
          surfaces: profile().surfaces.map((surface) =>
            surface.id === "host-built-in"
              ? { ...surface, presence: "present", precedence: 0 }
              : surface.id === "project-projection"
                ? { ...surface, precedence: 1 }
                : surface,
          ),
        }),
      }),
    );

    expect(result).toMatchObject({
      state: "blocked",
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_HOST_PRECEDENCE_CONFLICT",
          disposition: "blocked",
          surface: "host-built-in",
        },
      ],
    });
    expect(result.claims.isolated).toBe(false);
  });

  it("blocks unknown competing surfaces and unavailable logical projection destinations", () => {
    const unknown = evaluateSyntheticMethodologyHostMappings(
      input({
        profile: profile({
          surfaces: profile().surfaces.map((surface) =>
            surface.id === "user-rules" ? { ...surface, presence: "unknown" } : surface,
          ),
        }),
      }),
    );
    const unavailable = evaluateSyntheticMethodologyHostMappings(
      input({
        profile: profile({
          surfaces: profile().surfaces.map((surface) =>
            surface.id === "project-projection" ? { ...surface, presence: "absent" } : surface,
          ),
        }),
      }),
    );

    expect(unknown.findings).toEqual([
      {
        code: "METHODOLOGY_SYNTHETIC_HOST_SURFACE_UNKNOWN",
        disposition: "blocked",
        surface: "user-rules",
      },
    ]);
    expect(unavailable.findings).toEqual([
      {
        code: "METHODOLOGY_SYNTHETIC_HOST_DESTINATION_UNAVAILABLE",
        disposition: "blocked",
        surface: "project-projection",
      },
    ]);
  });

  it("keeps profile and result records closed, complete, and internally consistent", () => {
    expect(() =>
      SyntheticMethodologyHostProfileSchema.parse({ ...profile(), surfaces: surfaces.slice(1) }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyHostProfileSchema.parse({
        ...profile(),
        surfaces: [...profile().surfaces, profile().surfaces[0]],
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyHostProfileSchema.parse({ ...profile(), injected: true }),
    ).toThrow();
    const advisory = evaluateSyntheticMethodologyHostMappings(input());
    expect(() =>
      SyntheticMethodologyHostAssessmentSchema.parse({
        ...advisory,
        state: "advisory",
        findings: [
          { code: "METHODOLOGY_SYNTHETIC_HOST_TUPLE_UNSUPPORTED", disposition: "blocked" },
        ],
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyHostAssessmentSchema.parse({
        ...advisory,
        claims: { ...advisory.claims, active: true },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyHostAssessmentSchema.parse({
        ...advisory,
        subject: { ...advisory.subject, hostAdapter: "codex-static-v1" },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyHostAssessmentSchema.parse({
        ...advisory,
        state: "blocked",
        mappings: [],
        findings: [
          {
            code: "METHODOLOGY_SYNTHETIC_HOST_TUPLE_UNSUPPORTED",
            disposition: "blocked",
            component: "review-loop",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyHostAssessmentSchema.parse({
        ...advisory,
        mappings: [{ ...advisory.mappings[0], sourceTarget: "rules/unowned.md" }],
      }),
    ).toThrow();
  });
});
