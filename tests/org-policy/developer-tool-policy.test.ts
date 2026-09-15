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
  it("uses the six defaults for no policy and preserves legacy V3 omission semantics", () => {
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

  it.each([
    { selected: ["unknown"] },
    { selected: ["serena", "serena"] },
    { excluded: ["context7", "context7"] },
    { selected: ["context7"], excluded: ["context7"] },
  ])("rejects malformed explicit selections %#", (developerTools) => {
    expect(() => parseOrgPolicy(v3Policy({ developerTools }))).toThrow(/org-policy is invalid/);
  });
});
