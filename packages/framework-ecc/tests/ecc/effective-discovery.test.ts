import "../core-invocation.js";
import { describe, expect, it } from "vitest";
import { type OrgPolicy, parseOrgPolicy } from "../../../../src/org-policy/schema.js";
import { WORKBENCH_MINIMUM_CORE_VERSION } from "../../../../src/org-policy/workbench/contracts.js";
import { describeEccEffectiveDiscovery } from "../../src/ecc/effective-discovery.js";

const policy = {
  schemaVersion: 2,
  governance: {
    externalSelections: [
      {
        framework: "ecc",
        roots: ["skill:feature"],
        unattributedItems: ["skill:legacy"],
        items: [],
      },
    ],
  },
} as unknown as OrgPolicy;

function component(id: string, path: string) {
  return {
    id,
    provenance: {
      repository: "affaan-m/ECC",
      commit: "a".repeat(40),
      componentPath: `skills/${id.slice(id.indexOf(":") + 1)}`,
    },
    files: [{ path }],
    targets: ["codex" as const],
    ownership: "planned" as const,
  };
}

describe("effective ECC selection and discovery description", () => {
  it("explains roots, optional items, dependencies, exact owners and native paths", () => {
    const report = describeEccEffectiveDiscovery({
      policy,
      targets: ["codex"],
      components: [
        component("skill:feature", ".agents/skills/feature/SKILL.md"),
        component("module:core", ".codex/rules/core.md"),
        component("skill:optional", ".agents/skills/optional/SKILL.md"),
        component("skill:legacy", ".agents/skills/legacy/SKILL.md"),
      ],
      relations: {
        mandatoryRequirementsById: new Map([["skill:feature", ["module:core"]]]),
      },
    });

    expect(
      report.components.map(({ id, requirement, selectionReason, retainedBy, destinations }) => ({
        id,
        requirement,
        selectionReason,
        retainedBy,
        destinations,
      })),
    ).toEqual([
      {
        id: "skill:feature",
        requirement: "required",
        selectionReason: "selected-root",
        retainedBy: [],
        destinations: [
          { path: ".agents/skills/feature/SKILL.md", discovery: "project-skill-entry" },
        ],
      },
      {
        id: "module:core",
        requirement: "required",
        selectionReason: "required-dependency",
        retainedBy: ["skill:feature"],
        destinations: [{ path: ".codex/rules/core.md", discovery: "projected-content" }],
      },
      {
        id: "skill:optional",
        requirement: "required",
        selectionReason: "selected-choice",
        retainedBy: [],
        destinations: [
          { path: ".agents/skills/optional/SKILL.md", discovery: "project-skill-entry" },
        ],
      },
      {
        id: "skill:legacy",
        requirement: "required",
        selectionReason: "legacy-unattributed",
        retainedBy: [],
        destinations: [
          { path: ".agents/skills/legacy/SKILL.md", discovery: "project-skill-entry" },
        ],
      },
    ]);
    expect(report.components.every((row) => row.owner === "aih-materialization")).toBe(true);
    expect(report.components.every((row) => row.ownership === "planned")).toBe(true);
    expect(report.dependencyAuthority).toBe("qualified-source-relations");
    expect(report.otherOwners.map((row) => row.owner)).toEqual([
      "native-plugin",
      "legacy-or-user-content",
    ]);
  });

  it("retains exact schema-v3 authoring exclusions without inferring dependency authority", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const v3 = parseOrgPolicy({
      schemaVersion: 3,
      minimumPosture: "vibe",
      minimumCoreVersion: WORKBENCH_MINIMUM_CORE_VERSION,
      references: { repoContract: "repo" },
      authoringSelections: {
        selectionVersion: "workbench-selection/v1",
        roots: [],
        requests: [],
        drafts: [],
        exclusions: [
          {
            assetId: "ecc/skill:frontend-patterns",
            origin: { kind: "administrator" },
            sourceId: "source:ecc",
            sourceRevisionId: "5caf398a",
            contentDigest: digest,
          },
        ],
      },
    });

    const report = describeEccEffectiveDiscovery({
      policy: v3,
      targets: ["codex"],
      components: [],
    });

    expect(report.authoringExclusions).toEqual([
      {
        assetId: "ecc/skill:frontend-patterns",
        sourceId: "source:ecc",
        sourceRevisionId: "5caf398a",
        contentDigest: digest,
      },
    ]);
    expect(report.dependencyAuthority).toBe("unverified");
  });
});
