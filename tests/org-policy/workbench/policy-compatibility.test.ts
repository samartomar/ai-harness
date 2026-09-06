import { describe, expect, it } from "vitest";
import { parseOrgPolicy } from "../../../src/org-policy/schema.js";
import { WORKBENCH_MINIMUM_CORE_VERSION } from "../../../src/org-policy/workbench/contracts.js";

const base = { minimumPosture: "vibe", references: { repoContract: "repo" } };
describe("policy schema compatibility", () => {
  it("accepts unchanged schema v2 and requires strict v3 authoring selections", () => {
    expect(parseOrgPolicy({ schemaVersion: 2, ...base }).schemaVersion).toBe(2);
    expect(() => parseOrgPolicy({ schemaVersion: 3, ...base })).toThrow();
    expect(
      parseOrgPolicy({
        schemaVersion: 3,
        ...base,
        minimumCoreVersion: WORKBENCH_MINIMUM_CORE_VERSION,
        authoringSelections: {
          selectionVersion: "workbench-selection/v1",
          roots: [],
          exclusions: [],
          requests: [],
          drafts: [],
        },
      }).schemaVersion,
    ).toBe(3);
  });
  it("requires the exact unreleased Core version floor for V3", () => {
    const authoringSelections = {
      selectionVersion: "workbench-selection/v1",
      roots: [],
      exclusions: [],
      requests: [],
      drafts: [],
    };
    expect(() => parseOrgPolicy({ schemaVersion: 3, ...base, authoringSelections })).toThrow();
    expect(() =>
      parseOrgPolicy({
        schemaVersion: 3,
        ...base,
        minimumCoreVersion: "0.6.1",
        authoringSelections,
      }),
    ).toThrow();
  });
  it("rejects malformed root pins", () => {
    expect(() =>
      parseOrgPolicy({
        schemaVersion: 3,
        ...base,
        minimumCoreVersion: WORKBENCH_MINIMUM_CORE_VERSION,
        authoringSelections: {
          selectionVersion: "workbench-selection/v1",
          roots: [
            {
              assetId: "x",
              sourceId: "s",
              sourceRevisionId: "r",
              contentDigest: "bad",
              mode: "select",
              includeOptionalMembers: false,
              origin: { kind: "administrator" },
              resolvedItems: [],
            },
          ],
          exclusions: [],
          requests: [],
          drafts: [],
        },
      }),
    ).toThrow();
  });
});
