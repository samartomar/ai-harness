import { describe, expect, it } from "vitest";
import { defaultStudioPolicy } from "../../src/org-policy/studio-model.js";
import type { ResolvedGithubSkillV1 } from "../../src/org-policy/workbench/core/bounded-github-skill-resolver.js";
import { bridgeConnectedGithubSkillV1 } from "../../src/org-policy/workbench/core/connected-github-skill-bridge.js";

const first: ResolvedGithubSkillV1 = {
  version: "aih-connected-github-skill/v1",
  state: "resolved-not-scanned",
  skill: "frontend-design",
  source: {
    type: "github",
    repository: "anthropics/skills",
    commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
    path: "skills/frontend-design/SKILL.md",
  },
};

describe("connected GitHub Skill bridge", () => {
  it("adds a Core-prepared declaration-only Skill selection without evidence or approval", () => {
    const bridge = bridgeConnectedGithubSkillV1(defaultStudioPolicy(), first);
    const policy = bridge.policy as {
      authoringSelections: { roots: Array<Record<string, unknown>> };
      authoringSources: Array<{ bytesBase64: string }>;
      governance: { authority: { approvals: unknown[] } };
    };

    expect(bridge.state).toBe("prepared-pending-evidence");
    expect(bridge.root.sourceId).toMatch(/^source:connected-github-skill-[a-f0-9]{64}$/);
    expect(bridge.root).toMatchObject({
      origin: { kind: "administrator" },
      sourceRevisionId: first.source.commit,
    });
    expect(bridge.root).not.toHaveProperty("rationale");
    expect(policy.authoringSelections.roots).toContainEqual(
      expect.objectContaining({ assetId: bridge.root.assetId }),
    );
    expect(policy.authoringSources).toHaveLength(1);
    const declaration = Buffer.from(
      policy.authoringSources[0]?.bytesBase64 ?? "",
      "base64",
    ).toString("utf8");
    expect(declaration).toContain(first.source.repository);
    expect(declaration).toContain(first.source.commit);
    expect(declaration).toContain("Pending security review");
    expect(declaration).toContain("saved choice only");
    expect(policy.governance.authority.approvals).toEqual([]);
    expect(JSON.stringify(policy)).not.toContain('"scanSubject"');
  });

  it("keeps an identical existing root and its user rationale on repeat", () => {
    const initial = bridgeConnectedGithubSkillV1(defaultStudioPolicy(), first);
    const policy = structuredClone(initial.policy) as {
      authoringSelections: { roots: Array<Record<string, unknown>> };
    };
    const existingRoot = policy.authoringSelections.roots[0];
    if (existingRoot === undefined) throw new Error("expected the initial pending Skill root");
    existingRoot.rationale = "Needed for documented frontend reviews.";

    const repeated = bridgeConnectedGithubSkillV1(policy, first);
    expect(repeated.policy).toMatchObject({
      authoringSelections: {
        roots: [expect.objectContaining({ rationale: "Needed for documented frontend reviews." })],
      },
    });
    expect(repeated.manifestBytes).toHaveLength(1);
  });

  it("keeps distinct repository pins with the same Skill name in separate source identities", () => {
    const another = {
      ...first,
      source: {
        ...first.source,
        repository: "acme/skills",
        commit: "a".repeat(40),
      },
    } satisfies ResolvedGithubSkillV1;
    const one = bridgeConnectedGithubSkillV1(defaultStudioPolicy(), first);
    const two = bridgeConnectedGithubSkillV1(one.policy, another);

    expect(two.manifestBytes).toHaveLength(2);
    expect(two.policy).toMatchObject({ authoringSelections: { roots: expect.any(Array) } });
    const roots = (two.policy.authoringSelections as { roots: unknown[] }).roots;
    expect(roots).toHaveLength(2);
  });
});
