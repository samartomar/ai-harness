import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AIH_ECC_PROFILE,
  type EccCatalog,
  eccProfileSchema,
  resolveEccProfile,
  serializeResolvedEccProfile,
} from "../../src/ecc-profile/index.js";

function catalog(skillCount = 136): EccCatalog {
  const skills: EccCatalog["skills"] = AIH_ECC_PROFILE.selections.activeSkills.map((id) => ({
    id,
    sourcePath: `skills/${id}/SKILL.md`,
    selection: "leaf",
  }));
  while (skills.length < skillCount) {
    const id = `baseline-${String(skills.length).padStart(3, "0")}`;
    skills.push({ id, sourcePath: `skills/${id}/SKILL.md`, selection: "baseline" });
  }
  return {
    skills,
    roles: Array.from({ length: 67 }, (_, index) => ({
      id: `role-${String(index).padStart(2, "0")}`,
      sourcePath: `agents/role-${String(index).padStart(2, "0")}.md`,
    })),
    workflows: Array.from({ length: 94 }, (_, index) => {
      const adapted = AIH_ECC_PROFILE.aihAdaptedWorkflows[index];
      const id = adapted ?? `/workflow-${String(index).padStart(2, "0")}`;
      return { id, sourcePath: `commands/${id.slice(1)}.md` };
    }),
  };
}

describe("AIH ECC profile schema and resolver", () => {
  it("encodes the immutable source, exact selections, lifecycle intent, and separated local capabilities", () => {
    expect(eccProfileSchema.parse(AIH_ECC_PROFILE)).toEqual(AIH_ECC_PROFILE);
    expect(AIH_ECC_PROFILE.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(AIH_ECC_PROFILE.selections.activeSkills).toHaveLength(23);
    expect(AIH_ECC_PROFILE.expected).toEqual({ skills: 136, roles: 67, workflows: 94 });
    expect(AIH_ECC_PROFILE.profileFlags.defaultOn).toEqual([
      "continuity",
      "mcp-health",
      "repository-protection",
    ]);
    expect(AIH_ECC_PROFILE.mcpPolicy.activation).toBe("future-aih-owned-projection");
    expect(AIH_ECC_PROFILE.state.lifecycle).toBe("implementation-pending");
    expect(AIH_ECC_PROFILE.aihAdaptedWorkflows).toEqual([
      "/auto-update",
      "/hookify",
      "/hookify-configure",
      "/project-init",
    ]);
    expect(AIH_ECC_PROFILE.localPlannedSkills).toEqual(["learn-eval", "session-continuity"]);
    expect(AIH_ECC_PROFILE.repoCuratedSkills).toEqual(["betterdoc", "decision-partner"]);
  });

  it("resolves exactly 136 skills and accounts for every role and workflow without suppressing automation", () => {
    const resolved = resolveEccProfile(AIH_ECC_PROFILE, catalog());
    expect(resolved.skills).toHaveLength(136);
    expect(resolved.roles).toHaveLength(67);
    expect(resolved.workflows).toHaveLength(94);
    expect(
      resolved.workflows.filter((item) => item.owner === "aih-adaptation").map((item) => item.id),
    ).toEqual(AIH_ECC_PROFILE.aihAdaptedWorkflows);
  });

  it("is deterministic and byte-stable across catalog ordering", () => {
    const first = catalog();
    const reversed: EccCatalog = {
      skills: [...first.skills].reverse(),
      roles: [...first.roles].reverse(),
      workflows: [...first.workflows].reverse(),
    };
    expect(serializeResolvedEccProfile(resolveEccProfile(AIH_ECC_PROFILE, first))).toBe(
      serializeResolvedEccProfile(resolveEccProfile(AIH_ECC_PROFILE, reversed)),
    );
  });

  it.each([
    ["moving main", { source: { ...AIH_ECC_PROFILE.source, commit: "main" } }],
    ["traversal", { source: { ...AIH_ECC_PROFILE.source, componentPath: "../escape" } }],
    [
      "ambiguous ownership",
      { ownership: [...AIH_ECC_PROFILE.ownership, { ...AIH_ECC_PROFILE.ownership[0] }] },
    ],
  ])("rejects %s", (_label, override) => {
    expect(() => resolveEccProfile({ ...AIH_ECC_PROFILE, ...override }, catalog())).toThrow();
  });

  it("rejects malformed selections and silent catalog omission", () => {
    expect(() => resolveEccProfile(AIH_ECC_PROFILE, catalog(135))).toThrow(
      /accounting expected 113/i,
    );
    const malformed = {
      ...AIH_ECC_PROFILE,
      selections: { ...AIH_ECC_PROFILE.selections, activeSkills: ["missing-leaf"] },
    };
    expect(() => resolveEccProfile(malformed, catalog())).toThrow(/missing-leaf/);
  });

  it("rejects a source path that escapes the supplied root through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "aih-ecc-profile-"));
    const outside = await mkdtemp(join(tmpdir(), "aih-ecc-profile-outside-"));
    try {
      const escaped = catalog();
      for (const entry of [...escaped.skills, ...escaped.roles, ...escaped.workflows]) {
        const path = join(root, ...entry.sourcePath.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, entry.id);
      }
      await writeFile(join(outside, "SKILL.md"), "outside");
      await mkdir(join(root, "skills"), { recursive: true });
      const firstSkill = escaped.skills[0];
      if (!firstSkill) throw new Error("fixture catalog unexpectedly has no skills");
      await rm(join(root, "skills", firstSkill.id), { recursive: true });
      await symlink(outside, join(root, "skills", "escape"), "junction");
      escaped.skills[0] = { ...firstSkill, sourcePath: "skills/escape/SKILL.md" };
      await expect(
        resolveEccProfile(AIH_ECC_PROFILE, escaped, { sourceRoot: root }),
      ).rejects.toThrow(/escape/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
