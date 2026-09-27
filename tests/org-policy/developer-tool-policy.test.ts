import { describe, expect, it } from "vitest";

import { resolveDeveloperToolSelectionForOrgPolicyV1 } from "../../src/org-policy/developer-tool-policy.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";

function v3Policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    minimumCoreVersion: "0.6.0",
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    authoringSelections: {
      selectionVersion: "workbench-selection/v1",
      roots: [],
      exclusions: [],
      requests: [],
      drafts: [],
    },
    ...overrides,
  };
}

describe("developer tool policy selection", () => {
  it("selects Headroom for no policy and preserves legacy V3 omission semantics", () => {
    expect(resolveDeveloperToolSelectionForOrgPolicyV1(undefined)).toMatchObject({
      accepted: true,
      source: "default",
      selected: [
        "code-review-graph",
        "codebase-memory-mcp",
        "serena",
        "token-optimizer",
        "context7",
        "markitdown",
        "playwright",
        "headroom",
      ],
    });
    expect(resolveDeveloperToolSelectionForOrgPolicyV1(parseOrgPolicy(v3Policy()))).toMatchObject({
      accepted: true,
      source: "legacy-unspecified",
      selected: [
        "code-review-graph",
        "codebase-memory-mcp",
        "serena",
        "token-optimizer",
        "context7",
        "markitdown",
        "playwright",
        "headroom",
      ],
    });
    expect(
      resolveDeveloperToolSelectionForOrgPolicyV1(
        parseOrgPolicy({
          schemaVersion: 2,
          minimumPosture: "vibe",
          references: { repoContract: "ai-coding/project.json" },
        }),
      ),
    ).toMatchObject({
      accepted: true,
      source: "default",
      selected: [
        "code-review-graph",
        "codebase-memory-mcp",
        "serena",
        "token-optimizer",
        "context7",
        "markitdown",
        "playwright",
        "headroom",
      ],
    });
  });

  it("fails closed for supplied malformed, null, and unsupported policies", () => {
    for (const policy of [
      null,
      {},
      { schemaVersion: 1 },
      { schemaVersion: 2 },
      { schemaVersion: 2, developerTools: {} },
      { schemaVersion: 3 },
    ]) {
      expect(resolveDeveloperToolSelectionForOrgPolicyV1(policy)).toMatchObject({
        accepted: false,
        source: "fail-closed",
        selected: [],
      });
    }
    expect(
      resolveDeveloperToolSelectionForOrgPolicyV1({
        schemaVersion: 3,
        developerTools: { selected: [], unknown: true },
      }),
    ).toMatchObject({ accepted: false, source: "fail-closed", selected: [] });
  });

  it("keeps explicit subsets, exclusions, and an explicit empty selection intact", () => {
    const subset = parseOrgPolicy(
      v3Policy({
        developerTools: { selected: ["context7", "serena"], excluded: ["token-optimizer"] },
      }),
    );
    expect(resolveDeveloperToolSelectionForOrgPolicyV1(subset)).toMatchObject({
      accepted: true,
      source: "explicit",
      selected: ["serena", "context7"],
      excluded: ["token-optimizer"],
    });
    expect(subset.schemaVersion).toBe(3);
    if (subset.schemaVersion !== 3) throw new Error("expected a V3 policy");
    expect(Object.hasOwn(subset.developerTools ?? {}, "selected")).toBe(true);

    const empty = parseOrgPolicy(v3Policy({ developerTools: { selected: [] } }));
    expect(resolveDeveloperToolSelectionForOrgPolicyV1(empty)).toMatchObject({
      accepted: true,
      source: "explicit",
      selected: [],
    });
  });

  it("keeps an existing six-tool policy unchanged and round-trips a Playwright exclusion", () => {
    const priorSelection = [
      "code-review-graph",
      "codebase-memory-mcp",
      "serena",
      "token-optimizer",
      "context7",
      "markitdown",
    ];
    const existing = parseOrgPolicy(v3Policy({ developerTools: { selected: priorSelection } }));
    expect(resolveDeveloperToolSelectionForOrgPolicyV1(existing).selected).toEqual(priorSelection);
    const excluded = parseOrgPolicy(v3Policy({ developerTools: { excluded: ["playwright"] } }));
    const reopened = parseOrgPolicy(JSON.parse(JSON.stringify(excluded)));
    expect(resolveDeveloperToolSelectionForOrgPolicyV1(reopened)).toMatchObject({
      accepted: true,
      selected: [...priorSelection, "headroom"],
      excluded: ["playwright"],
    });
  });

  it("requires the candidate 0.7.0 floor for an explicit Headroom decision", () => {
    for (const developerTools of [{ selected: ["headroom"] }, { excluded: ["headroom"] }]) {
      expect(() => parseOrgPolicy(v3Policy({ developerTools }))).toThrow(/0\.7\.0/);
      const policy = parseOrgPolicy(v3Policy({ minimumCoreVersion: "0.7.0", developerTools }));
      expect(resolveDeveloperToolSelectionForOrgPolicyV1(policy).accepted).toBe(true);
    }
    expect(
      resolveDeveloperToolSelectionForOrgPolicyV1(
        v3Policy({ developerTools: { selected: ["headroom"] } }),
      ),
    ).toMatchObject({ accepted: false, source: "fail-closed" });
  });

  it.each([
    { selected: ["unknown"] },
    { selected: ["serena", "serena"] },
    { excluded: ["context7", "context7"] },
    { selected: ["context7"], excluded: ["context7"] },
  ])("rejects malformed explicit selections %#", (developerTools) => {
    expect(() => parseOrgPolicy(v3Policy({ developerTools }))).toThrow(/org-policy is invalid/);
  });

  it.each(["code-review-graph", "codebase-memory-mcp"])(
    "records %s as the enterprise primary code graph behind the 0.7.0 floor",
    (primary) => {
      const developerTools = { primaryCodeGraph: primary };
      expect(() => parseOrgPolicy(v3Policy({ developerTools }))).toThrow(/0\.7\.0/);
      const policy = parseOrgPolicy(v3Policy({ minimumCoreVersion: "0.7.0", developerTools }));
      expect(resolveDeveloperToolSelectionForOrgPolicyV1(policy)).toMatchObject({
        accepted: true,
        source: "legacy-unspecified",
        primaryCodeGraph: primary,
      });
      expect(
        resolveDeveloperToolSelectionForOrgPolicyV1(parseOrgPolicy(v3Policy())),
      ).not.toHaveProperty("primaryCodeGraph");
    },
  );

  it.each([
    { primaryCodeGraph: "serena" },
    { primaryCodeGraph: "headroom" },
    { primaryCodeGraph: "" },
    { primaryCodeGraph: "code-review-graph", excluded: ["code-review-graph"] },
    {
      primaryCodeGraph: "codebase-memory-mcp",
      selected: ["code-review-graph", "serena"],
    },
  ])("rejects a primary code graph that is unsupported or not selected %#", (developerTools) => {
    expect(() => parseOrgPolicy(v3Policy({ minimumCoreVersion: "0.7.0", developerTools }))).toThrow(
      /org-policy is invalid/,
    );
    expect(
      resolveDeveloperToolSelectionForOrgPolicyV1(
        v3Policy({ minimumCoreVersion: "0.7.0", developerTools }),
      ),
    ).toMatchObject({ accepted: false, source: "fail-closed", selected: [] });
  });

  it("cannot activate Headroom or any tool on the user's behalf", () => {
    for (const developerTools of [
      { selected: ["headroom"], activateHeadroom: true },
      { selected: ["headroom"], activated: ["headroom"] },
      { selected: ["headroom"], acceptHeadroomEgress: true },
    ]) {
      expect(() =>
        parseOrgPolicy(v3Policy({ minimumCoreVersion: "0.7.0", developerTools })),
      ).toThrow(/org-policy is invalid/);
      expect(
        resolveDeveloperToolSelectionForOrgPolicyV1(
          v3Policy({ minimumCoreVersion: "0.7.0", developerTools }),
        ),
      ).toMatchObject({ accepted: false, source: "fail-closed" });
    }
  });
});
