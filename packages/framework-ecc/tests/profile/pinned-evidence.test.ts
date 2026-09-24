import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEccDescriptor } from "../../src/descriptor.js";
import { PACKAGED_ECC_PROFILE_INSTALLATION_TRUST } from "../../src/profile/command.js";
import { readEccProfileEvidenceV1 } from "../../src/profile/descriptor-evidence.js";
import { deriveEccProfile } from "../../src/profile/index.js";
import {
  claudeRolePolicy,
  claudeRoleTools,
  skillProjectionPolicies,
  workflowProjectionPolicies,
} from "../../src/profile/projection-policy.js";
import { PINNED_COMMIT, pinnedDescriptor } from "../context.js";
import { pinnedFixtureDirectory } from "./pinned-profile-fixture.js";

/** Catalog's profileEvidence section at the pinned commit, as the plugin reads it from Core-verified bytes. */
function pinnedEvidence() {
  const descriptor = readEccDescriptor(pinnedDescriptor());
  return readEccProfileEvidenceV1(descriptor.sections.profileEvidence);
}

describe("Catalog's ECC profileEvidence at the pinned commit (ECC v2.2.1)", () => {
  it("is accepted: profile, pinned evidence, receipt and closure documents all validate", () => {
    const read = pinnedEvidence();
    expect(read.sourceCommit).toBe(PINNED_COMMIT);
    expect(read.profile.source.releaseAncestorCommit).toBe(PINNED_COMMIT);
    expect(read.profile.source.packageVersion).toBe("2.2.1");
    expect(read.profile.expected).toEqual({ skills: 140, roles: 68, workflows: 94 });
    expect(read.trust).toMatchObject({
      sourceCommit: PINNED_COMMIT,
      fileCount: 406,
      totalBytes: 2_828_596,
      aggregateSha256: "17d2c510c63ce5566b48f96b3182e80f0e38b8262cdc191ae86e40dfa14f901b",
    });
    expect([...read.documents.keys()].sort()).toEqual([
      "evidence/ecc/pinned-source-evidence-review-v1.json",
      "evidence/ecc/projected-source-closure-v1.json",
    ]);
  });

  it("accounts 117 baseline skills and keeps the 23 active and 11 warm-reserve selections", () => {
    const read = pinnedEvidence();
    const resolved = deriveEccProfile(read.profile, read.evidence);
    const baseline = resolved.skills.filter((skill) => skill.selection === "baseline");
    expect(baseline).toHaveLength(117);
    expect(resolved.skills.filter((skill) => skill.selection === "leaf")).toHaveLength(23);
    expect(read.profile.selections.warmReserveSkills).toHaveLength(11);
    for (const id of [
      "council-multi-model",
      "dev-team",
      "living-docs-governance",
      "skill-comply",
    ]) {
      expect(baseline.map((skill) => skill.id)).toContain(id);
      expect(read.profile.selections.activeSkills).not.toContain(id);
      expect(read.profile.selections.warmReserveSkills).not.toContain(id);
    }
    expect(resolved.roles.map((role) => role.id)).toContain("rag-pipeline-reviewer");
  });
});

describe("projection policy for the items ECC v2.2.1 adds (review D18)", () => {
  const resolved = () => {
    const read = pinnedEvidence();
    return deriveEccProfile(read.profile, read.evidence);
  };

  it("covers the exact pinned skill, workflow and role surfaces", () => {
    const profile = resolved();
    expect(skillProjectionPolicies(profile.skills).size).toBe(140);
    expect(workflowProjectionPolicies(profile.workflows).size).toBe(94);
    expect(claudeRolePolicy(profile.roles).size).toBe(68);
  });

  it("projects dev-team and living-docs-governance, and council-multi-model and skill-comply as unavailable", () => {
    const policies = skillProjectionPolicies(resolved().skills);
    expect(policies.get("dev-team")).toEqual({
      claude: { transport: "native" },
      codex: { transport: "normalized" },
    });
    expect(policies.get("living-docs-governance")).toEqual({
      claude: { transport: "native" },
      codex: { transport: "native" },
    });
    for (const id of ["council-multi-model", "skill-comply"]) {
      const policy = policies.get(id);
      expect(policy?.claude.transport, id).toBe("unavailable");
      expect(policy?.codex.transport, id).toBe("unavailable");
      expect(policy?.claude.unavailableReason, id).toBeTruthy();
      expect(policy?.claude.fallback, id).toBeTruthy();
    }
    expect(policies.get("council-multi-model")?.claude.unavailableReason).toMatch(/OpenAI/);
    expect(policies.get("skill-comply")?.claude.unavailableReason).toMatch(/pre-approved Bash/);
  });

  it("projects rag-pipeline-reviewer read-only, without upstream's Bash", () => {
    const policy = claudeRolePolicy(resolved().roles).get("rag-pipeline-reviewer");
    expect(policy).toBe("read-only");
    expect(claudeRoleTools(policy ?? "editor")).toEqual(["Read", "Grep", "Glob"]);
  });
});

describe("installations rendered at the pinned commit", () => {
  it("are anchored in the append-only installation trust record by the actual projection receipt", () => {
    const receipt = JSON.parse(
      readFileSync(join(pinnedFixtureDirectory, "projection-receipt.json"), "utf8"),
    ) as Record<string, string>;
    expect(receipt.sourceCommit).toBe(PINNED_COMMIT);
    expect(PACKAGED_ECC_PROFILE_INSTALLATION_TRUST).toContainEqual({
      repository: "affaan-m/ECC",
      commit: receipt.sourceCommit,
      sourceClosureId: receipt.sourceClosureId,
      sourceClosureSha256: receipt.sourceClosureSha256,
      projectionSha256: receipt.projectionSha256,
    });
    expect(PACKAGED_ECC_PROFILE_INSTALLATION_TRUST[0]?.commit).toBe(
      "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    );
  });
});
