import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AIH_ECC_PROFILE_TEMPLATE,
  eccProfileSchema,
  resolveEccProfile,
  serializeResolvedEccProfile,
} from "../../src/ecc-profile/index.js";

const fixturePath = join(
  import.meta.dirname,
  "../fixtures/ecc-profile/pinned-source-evidence.json",
);
const evidence = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
const receipt = {
  id: "pinned-source-evidence-v1",
  evidencePath: "tests/fixtures/ecc-profile/pinned-source-evidence.json",
  sourceCommit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
};
const profile = {
  ...AIH_ECC_PROFILE_TEMPLATE,
  source: { ...AIH_ECC_PROFILE_TEMPLATE.source, reviewReceipt: receipt },
};

function digest(paths: readonly string[]): string {
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

describe("manifest-derived AIH ECC profile resolution", () => {
  it("parses a caller-supplied durable receipt and names the release ancestor correctly", () => {
    expect(eccProfileSchema.parse(profile).source.reviewReceipt).toEqual(receipt);
    expect(profile.source.releaseAncestorCommit).toBe("4da6deac1888690e7fb8572d097ee23db630f7a0");
    expect(profile.source).not.toHaveProperty("releaseCommit");
  });

  it("derives the exact module closure and complete pinned path sets", () => {
    const resolved = resolveEccProfile(profile, evidence);
    expect(resolved.modules).toEqual([
      "agents-core",
      "commands-core",
      "framework-language",
      "hooks-runtime",
      "platform-configs",
      "rules-core",
      "skill-unified-memory",
      "workflow-quality",
    ]);
    expect(resolved.skills).toHaveLength(136);
    expect(resolved.roles).toHaveLength(67);
    expect(resolved.workflows).toHaveLength(94);
    expect(digest(resolved.skills.map((item) => item.sourcePath))).toBe(
      "e3b38fd2ce0b7f50e47c87355ca3137fffb235b68d1a994a32a49ae7263689d3",
    );
    expect(digest(resolved.roles.map((item) => item.sourcePath))).toBe(
      "2411844ecf87e0a65322ce716a5172cf3e5ab3c121fde95865e2f119e4e1a4f0",
    );
    expect(digest(resolved.workflows.map((item) => item.sourcePath))).toBe(
      "9af2348d39002cbdf10ac5465676b02e6586ec3ab5f82e30b355423b32e6d1ca",
    );
    expect(resolved.skills.find((item) => item.id === "unified-memory")?.selection).toBe(
      "baseline",
    );
    expect(resolved.skills.find((item) => item.id === "workspace-surface-audit")?.selection).toBe(
      "leaf",
    );
    expect(resolved.roles).toContainEqual({
      id: "typescript-reviewer",
      sourcePath: "agents/typescript-reviewer.md",
      owner: "upstream",
    });
  });

  it("adapts only the four real ownership-sensitive commands", () => {
    const workflows = resolveEccProfile(profile, evidence).workflows;
    expect(
      workflows.filter((item) => item.owner === "aih-adaptation").map((item) => item.id),
    ).toEqual(["/auto-update", "/hookify-configure", "/hookify", "/project-init"]);
    expect(workflows.filter((item) => item.owner === "upstream")).toHaveLength(90);
    expect(workflows).toContainEqual({
      id: "/orch-build-mvp",
      sourcePath: "commands/orch-build-mvp.md",
      owner: "upstream",
    });
  });

  it("encodes selected and explicitly disabled MCP defaults without activating them", () => {
    expect(profile.mcpPolicy).toEqual({
      selected: ["code-review-graph", "codebase-memory-mcp", "context7", "serena"],
      disabled: ["ecc-memory-mcp", "github", "sequential-thinking", "token-savior"],
      activation: "future-aih-owned-projection",
    });
  });

  it("rejects cross-field contradictions and overlapping active/reserve ownership", () => {
    const wrongPin = {
      ...profile,
      ownership: [{ ...profile.ownership[0], sourcePin: "b".repeat(40) }],
    };
    expect(() => resolveEccProfile(wrongPin, evidence)).toThrow(/sourcePin/i);
    const wrongPath = {
      ...profile,
      source: { ...profile.source, componentPath: "manifests/other.json" },
    };
    expect(() => resolveEccProfile(wrongPath, evidence)).toThrow(/componentPath/i);
    const overlap = {
      ...profile,
      selections: {
        ...profile.selections,
        warmReserveSkills: [profile.selections.activeSkills[0]],
      },
    };
    expect(() => resolveEccProfile(overlap, evidence)).toThrow(/active.*warm/i);
  });

  it("rejects duplicate or silently omitted pinned source paths", () => {
    const duplicate = structuredClone(evidence) as {
      agentPaths: string[];
      workflowPaths: string[];
    };
    duplicate.workflowPaths[0] = duplicate.agentPaths[0] ?? "";
    expect(() => resolveEccProfile(profile, duplicate)).toThrow(/ambiguous.*source path/i);
    const omitted = structuredClone(evidence) as { workflowPaths: string[] };
    omitted.workflowPaths.pop();
    expect(() => resolveEccProfile(profile, omitted)).toThrow(/workflow.*94/i);
  });

  it.each(["C:escape/file.md", "safe/file.md:stream", "CON/file.md", "safe/trailing. /file.md"])(
    "rejects hostile portable path %s",
    (hostilePath) => {
      const malformed = structuredClone(evidence) as { agentPaths: string[] };
      malformed.agentPaths[0] = hostilePath;
      expect(() => resolveEccProfile(profile, malformed)).toThrow(/path/i);
    },
  );

  it("contains manifests, component paths, modules, roles, workflows, and skills through the strict tree boundary", async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? ".", "aih-ecc-profile-"));
    const outside = await mkdtemp(join(process.env.TEMP ?? ".", "aih-ecc-profile-outside-"));
    try {
      const initial = resolveEccProfile(profile, evidence);
      for (const path of initial.consumedSourcePaths) {
        const full = join(root, ...path.split("/"));
        if (path.includes(".")) {
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, path);
        } else await mkdir(full, { recursive: true });
      }
      await writeFile(join(outside, "install-components.json"), "outside");
      await writeFile(join(outside, "install-modules.json"), "outside");
      await writeFile(join(outside, "install-profiles.json"), "outside");
      await rm(join(root, "manifests"), { recursive: true });
      await symlink(outside, join(root, "manifests"), "junction");
      await expect(resolveEccProfile(profile, evidence, { sourceRoot: root })).rejects.toThrow(
        /symbolic link|escape/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("is deterministic and byte-stable for equivalent manifest ordering", () => {
    const shuffled = structuredClone(evidence) as {
      modulesManifest: { modules: unknown[] };
      agentPaths: string[];
      workflowPaths: string[];
    };
    shuffled.modulesManifest.modules.reverse();
    shuffled.agentPaths.reverse();
    shuffled.workflowPaths.reverse();
    expect(serializeResolvedEccProfile(resolveEccProfile(profile, shuffled))).toBe(
      serializeResolvedEccProfile(resolveEccProfile(profile, evidence)),
    );
  });
});
