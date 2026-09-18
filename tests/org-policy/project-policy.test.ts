import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkProjectPolicyNarrowsV1,
  ProjectPolicyError,
  parseProjectPolicyV1,
} from "../../src/org-policy/project-policy.js";
import { type OrgPolicy, parseOrgPolicy } from "../../src/org-policy/schema.js";

function minimalOrgPolicyJson() {
  return {
    schemaVersion: 3,
    minimumPosture: "vibe",
    minimumCoreVersion: "0.6.0",
    references: { repoContract: "ai-coding/project.json" },
    authoringSelections: {
      selectionVersion: "workbench-selection/v1",
      roots: [
        {
          assetId: "skills/example",
          mode: "select",
          includeOptionalMembers: false,
          origin: { kind: "administrator" },
          sourceId: "src-1",
          sourceRevisionId: "rev-1",
          contentDigest: `sha256:${"a".repeat(64)}`,
          resolvedItems: [
            {
              assetId: "skills/example",
              sourceId: "src-1",
              sourceRevisionId: "rev-1",
              contentDigest: `sha256:${"a".repeat(64)}`,
            },
          ],
        },
      ],
      exclusions: [],
      requests: [],
      drafts: [],
    },
  };
}

function orgPolicyAndDigest(): { orgPolicy: OrgPolicy; sha256: string; bytes: string } {
  const bytes = JSON.stringify(minimalOrgPolicyJson());
  const orgPolicy = parseOrgPolicy(JSON.parse(bytes));
  const sha256 = createHash("sha256").update(bytes, "utf8").digest("hex");
  return { orgPolicy, sha256, bytes };
}

function minimalProjectPolicyJson(sha256: string) {
  return {
    schemaVersion: 1,
    kind: "aih-project-policy",
    cutFrom: { schemaVersion: 3, sha256 },
    for: { type: "project", name: "widgets" },
    aiTools: ["claude"],
    items: [{ assetId: "skills/example", origin: { kind: "administrator" }, use: "required" }],
  };
}

describe("parseProjectPolicyV1", () => {
  it("accepts a valid minimal file", () => {
    const { sha256 } = orgPolicyAndDigest();
    const parsed = parseProjectPolicyV1(minimalProjectPolicyJson(sha256));
    expect(parsed.kind).toBe("aih-project-policy");
    expect(parsed.items).toHaveLength(1);
  });

  it("rejects an unknown top-level field", () => {
    const { sha256 } = orgPolicyAndDigest();
    const json = { ...minimalProjectPolicyJson(sha256), allow: ["*"] };
    expect(() => parseProjectPolicyV1(json)).toThrow(ProjectPolicyError);
  });

  it("rejects duplicate assetId in items", () => {
    const { sha256 } = orgPolicyAndDigest();
    const json = minimalProjectPolicyJson(sha256);
    json.items = [
      { assetId: "skills/example", origin: { kind: "administrator" }, use: "required" },
      { assetId: "skills/example", origin: { kind: "administrator" }, use: "optional" },
    ];
    expect(() => parseProjectPolicyV1(json)).toThrow(ProjectPolicyError);
  });

  it("rejects a bad sha256", () => {
    const json = minimalProjectPolicyJson("not-a-digest");
    expect(() => parseProjectPolicyV1(json)).toThrow(ProjectPolicyError);
  });

  it("rejects empty aiTools", () => {
    const { sha256 } = orgPolicyAndDigest();
    const json = { ...minimalProjectPolicyJson(sha256), aiTools: [] };
    expect(() => parseProjectPolicyV1(json)).toThrow(ProjectPolicyError);
  });

  it("rejects an unknown aiTool", () => {
    const { sha256 } = orgPolicyAndDigest();
    const json = { ...minimalProjectPolicyJson(sha256), aiTools: ["not-a-real-cli"] };
    expect(() => parseProjectPolicyV1(json)).toThrow(ProjectPolicyError);
  });
});

describe("checkProjectPolicyNarrowsV1", () => {
  it("ok when every item is present and the digest matches", () => {
    const { orgPolicy, sha256 } = orgPolicyAndDigest();
    const projectPolicy = parseProjectPolicyV1(minimalProjectPolicyJson(sha256));

    const result = checkProjectPolicyNarrowsV1(projectPolicy, orgPolicy, sha256);

    expect(result).toEqual({ ok: true });
  });

  it("flags an item not present in the org policy", () => {
    const { orgPolicy, sha256 } = orgPolicyAndDigest();
    const json = minimalProjectPolicyJson(sha256);
    json.items = [
      { assetId: "skills/missing", origin: { kind: "administrator" }, use: "required" },
    ];
    const projectPolicy = parseProjectPolicyV1(json);

    const result = checkProjectPolicyNarrowsV1(projectPolicy, orgPolicy, sha256);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((reason) => reason.includes("skills/missing"))).toBe(true);
    }
  });

  it("flags a digest mismatch as 'org policy changed'", () => {
    const { orgPolicy, sha256 } = orgPolicyAndDigest();
    const projectPolicy = parseProjectPolicyV1(minimalProjectPolicyJson(sha256));

    const result = checkProjectPolicyNarrowsV1(projectPolicy, orgPolicy, `${"b".repeat(64)}`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("org policy changed");
    }
  });
});
