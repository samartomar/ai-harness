import { describe, expect, it } from "vitest";
import { parseOrgPolicy, STRIX_POLICY_LIMITS } from "../../src/org-policy/schema.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    ...overrides,
  };
}

function strix(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    required: false,
    targetKind: "local-fixture",
    mode: "standard",
    maxBudgetCents: 500,
    maxTurns: 10,
    timeoutMs: 120_000,
    telemetry: "off",
    imageDigest: DIGEST,
    ...overrides,
  };
}

describe("Strix org-policy grammar", () => {
  it("preserves old policies and parses a bounded local-only Strix declaration", () => {
    expect(parseOrgPolicy(policy())).not.toHaveProperty("security");

    expect(parseOrgPolicy(policy({ security: { strix: strix() } })).security).toEqual({
      strix: {
        ...strix(),
        allowLiveTargets: false,
        allowMounts: false,
      },
    });
  });

  it("accepts the conservative compile-time maxima", () => {
    expect(() =>
      parseOrgPolicy(
        policy({
          security: {
            strix: strix({
              maxBudgetCents: STRIX_POLICY_LIMITS.maxBudgetCents,
              maxTurns: STRIX_POLICY_LIMITS.maxTurns,
              timeoutMs: STRIX_POLICY_LIMITS.timeoutMs,
            }),
          },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ["tag-only image", { imageDigest: "ghcr.io/usesecurity/strix:latest" }],
    ["uppercase digest", { imageDigest: `sha256:${"A".repeat(64)}` }],
    ["live target", { targetKind: "live" }],
    ["live-target opt-in", { allowLiveTargets: true }],
    ["mount opt-in", { allowMounts: true }],
    ["required but disabled", { enabled: false, required: true }],
    ["zero budget", { maxBudgetCents: 0 }],
    ["zero turns", { maxTurns: 0 }],
    ["zero timeout", { timeoutMs: 0 }],
    ["over-max budget", { maxBudgetCents: STRIX_POLICY_LIMITS.maxBudgetCents + 1 }],
    ["over-max turns", { maxTurns: STRIX_POLICY_LIMITS.maxTurns + 1 }],
    ["over-max timeout", { timeoutMs: STRIX_POLICY_LIMITS.timeoutMs + 1 }],
    ["fractional budget", { maxBudgetCents: 1.5 }],
    ["hostile mode", { mode: "standard\u202E" }],
    ["invented ROE", { roe: { approved: true } }],
    ["invented mounts", { mounts: ["/workspace"] }],
  ])("rejects %s", (_name, invalid) => {
    expect(() => parseOrgPolicy(policy({ security: { strix: strix(invalid) } }))).toThrow(
      /org-policy is invalid/,
    );
  });

  it("keeps required declarative because no posture enforcement consumer exists", () => {
    expect(() =>
      parseOrgPolicy(
        policy({
          minimumPosture: "enterprise",
          governance: { supportedClis: ["claude"] },
          security: { strix: strix({ enabled: false, required: false }) },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects unknown fields at both strict security boundaries", () => {
    expect(() => parseOrgPolicy(policy({ security: { strix: strix(), unknown: true } }))).toThrow(
      /org-policy is invalid/,
    );
    expect(() => parseOrgPolicy(policy({ security: { strix: strix({ unknown: true }) } }))).toThrow(
      /org-policy is invalid/,
    );
  });
});
