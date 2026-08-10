import { describe, expect, it } from "vitest";
import {
  type PromotedSkillArtifactProjection,
  projectPromotedSkillArtifacts,
} from "../../src/skill/promoted-artifacts.js";
import type { TrustLockSource } from "../../src/trust/lock.js";

function source(overrides: Partial<TrustLockSource> = {}): TrustLockSource {
  return {
    id: "owner-repo",
    kind: "github",
    source: "owner/repo",
    ref: "main",
    pinnedSha: "a".repeat(40),
    promotedAt: "2026-08-09T00:00:00.000Z",
    promotedSkills: ["clean"],
    analyzersRun: ["aih-native"],
    artifactHashes: [
      {
        path: "skills/clean/SKILL.md",
        sha256: "b".repeat(64),
      },
    ],
    findings: [],
    ...overrides,
  };
}

function expectRefused(
  result: PromotedSkillArtifactProjection,
  code: "invalid-source-receipt" | "ambiguous-artifact-route",
): void {
  expect(result).toEqual({ status: "refused", code });
  expect(Object.isFrozen(result)).toBe(true);
}

describe("promoted skill artifact projection", () => {
  it("projects exact prefixed and source-root artifacts deterministically", () => {
    const prefixed = projectPromotedSkillArtifacts("ai-coding", source());
    expect(prefixed).toEqual({
      status: "resolved",
      targets: [
        {
          skill: "clean",
          artifactPath: "skills/clean/SKILL.md",
          targetPath: "ai-coding/skills/owner-repo/clean/SKILL.md",
          sha256: "b".repeat(64),
        },
      ],
    });
    expect(Object.isFrozen(prefixed)).toBe(true);
    if (prefixed.status === "resolved") {
      expect(Object.isFrozen(prefixed.targets)).toBe(true);
      expect(Object.isFrozen(prefixed.targets[0])).toBe(true);
    }

    const root = projectPromotedSkillArtifacts(
      "ai-coding",
      source({
        id: "vendor",
        kind: "local",
        source: "/tmp/vendor",
        ref: undefined,
        pinnedSha: undefined,
        promotedSkills: ["vendor"],
        artifactHashes: [
          { path: "README.md", sha256: "c".repeat(64) },
          { path: "SKILL.md", sha256: "d".repeat(64) },
        ],
      }),
    );
    expect(root).toEqual({
      status: "resolved",
      targets: [
        {
          skill: "vendor",
          artifactPath: "README.md",
          targetPath: "ai-coding/skills/vendor/vendor/README.md",
          sha256: "c".repeat(64),
        },
        {
          skill: "vendor",
          artifactPath: "SKILL.md",
          targetPath: "ai-coding/skills/vendor/vendor/SKILL.md",
          sha256: "d".repeat(64),
        },
      ],
    });

    const shuffled = projectPromotedSkillArtifacts(
      "ai-coding",
      source({
        artifactHashes: [...source().artifactHashes].reverse(),
        promotedSkills: [...source().promotedSkills].reverse(),
      }),
    );
    expect(shuffled).toEqual(prefixed);
  });

  it("refuses duplicate and unsafe receipt identities", () => {
    for (const candidate of [
      source({ promotedSkills: ["clean", "clean"] }),
      source({ promotedSkills: ["clean", "Clean"] }),
      source({
        artifactHashes: [
          { path: "skills/clean/SKILL.md", sha256: "b".repeat(64) },
          { path: "skills/clean/SKILL.md", sha256: "b".repeat(64) },
        ],
      }),
      source({
        artifactHashes: [{ path: "../escape.md", sha256: "b".repeat(64) }],
      }),
      source({
        artifactHashes: [{ path: "safe:stream", sha256: "b".repeat(64) }],
      }),
    ]) {
      expectRefused(
        projectPromotedSkillArtifacts("ai-coding", candidate),
        "invalid-source-receipt",
      );
    }
    expectRefused(projectPromotedSkillArtifacts("C:/escape", source()), "invalid-source-receipt");
  });

  it("refuses zero, multiple, and case-fold-colliding artifact routes", () => {
    expectRefused(
      projectPromotedSkillArtifacts(
        "ai-coding",
        source({
          promotedSkills: ["one", "two"],
          artifactHashes: [{ path: "unmatched/file.md", sha256: "b".repeat(64) }],
        }),
      ),
      "ambiguous-artifact-route",
    );
    expectRefused(
      projectPromotedSkillArtifacts(
        "ai-coding",
        source({
          promotedSkills: ["parent", "parent/child"],
          artifactHashes: [{ path: "skills/parent/child/SKILL.md", sha256: "b".repeat(64) }],
        }),
      ),
      "ambiguous-artifact-route",
    );
    expectRefused(
      projectPromotedSkillArtifacts(
        "ai-coding",
        source({
          promotedSkills: ["one", "two"],
          artifactHashes: [
            { path: "skills/one/A.md", sha256: "b".repeat(64) },
            { path: "skills/one/a.md", sha256: "c".repeat(64) },
            { path: "skills/two/SKILL.md", sha256: "d".repeat(64) },
          ],
        }),
      ),
      "ambiguous-artifact-route",
    );
  });
});
