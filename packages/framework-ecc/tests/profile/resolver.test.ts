import "../core-invocation.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveEccProfile,
  eccProfileSchema,
  resolveEccProfile,
  serializeResolvedEccProfile,
} from "../../src/profile/index.js";
import {
  AIH_ECC_PROFILE_TEMPLATE,
  PINNED_SOURCE_EVIDENCE,
  pinnedFixtureDirectory,
} from "./pinned-profile-fixture.js";

const evidence = PINNED_SOURCE_EVIDENCE;
const receiptBytes = await readFile(join(pinnedFixtureDirectory, "review-receipt.json"));
const receipt = AIH_ECC_PROFILE_TEMPLATE.source.reviewReceipt;
const profile = AIH_ECC_PROFILE_TEMPLATE;

function digest(paths: readonly string[]): string {
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

async function fixtureRoots() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "aih-ecc-profile-source-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "aih-ecc-profile-evidence-"));
  const resolved = deriveEccProfile(profile, evidence);
  for (const sourcePath of resolved.consumedSourcePaths) {
    const full = join(sourceRoot, ...sourcePath.split("/"));
    if (extname(sourcePath) || sourcePath === "LICENSE") {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, sourcePath);
    } else await mkdir(full, { recursive: true });
  }
  const fixtureReceipt = join(evidenceRoot, ...receipt.evidencePath.split("/"));
  await mkdir(dirname(fixtureReceipt), { recursive: true });
  await writeFile(fixtureReceipt, receiptBytes);
  return {
    sourceRoot,
    evidenceRoot,
    fixtureReceipt,
    async cleanup() {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    },
  };
}

describe("manifest-derived AIH ECC profile resolution", () => {
  it("parses a caller-supplied durable receipt and names the release ancestor correctly", () => {
    expect(eccProfileSchema.parse(profile).source.reviewReceipt).toEqual(receipt);
    expect(createHash("sha256").update(receiptBytes).digest("hex")).toBe(receipt.evidenceSha256);
    expect(profile.source.releaseAncestorCommit).toBe("5064474d4d762dc9640234a41617cccb79185cec");
    expect(profile.source).not.toHaveProperty("releaseCommit");
    expect(profile.state.lifecycle).toBe("active");
    expect(profile.mcpPolicy.activation).toBe("aih-owned-native-registration");
  });

  it("derives the exact module closure and complete pinned path sets", () => {
    const resolved = deriveEccProfile(profile, evidence);
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
    expect(resolved.skills).toHaveLength(140);
    expect(resolved.roles).toHaveLength(68);
    expect(resolved.workflows).toHaveLength(94);
    expect(digest(resolved.skills.map((item) => item.sourcePath))).toBe(
      "c6c9b2efad96b919fce91f9e43be795b5aa64655a7bf40fb09f8d570f6556ec3",
    );
    expect(digest(resolved.roles.map((item) => item.sourcePath))).toBe(
      "0167d3b237716f86f9209f34da013bb66d26d25e11a886ab4ab3a533da7d4c88",
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
    const workflows = deriveEccProfile(profile, evidence).workflows;
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

  it("encodes selected and explicitly disabled MCP defaults under AIH native registration", () => {
    expect(profile.mcpPolicy).toEqual({
      selected: ["code-review-graph", "codebase-memory-mcp", "context7", "serena"],
      disabled: ["ecc-memory-mcp", "github", "sequential-thinking", "token-savior"],
      activation: "aih-owned-native-registration",
    });
  });

  it("rejects cross-field contradictions and overlapping active/reserve ownership", () => {
    const wrongPin = {
      ...profile,
      ownership: [{ ...profile.ownership[0], sourcePin: "b".repeat(40) }],
    };
    expect(() => deriveEccProfile(wrongPin, evidence)).toThrow(/sourcePin/i);
    const wrongPath = {
      ...profile,
      source: { ...profile.source, componentPath: "manifests/other.json" },
    };
    expect(() => deriveEccProfile(wrongPath, evidence)).toThrow(/componentPath/i);
    const overlap = {
      ...profile,
      selections: {
        ...profile.selections,
        warmReserveSkills: [profile.selections.activeSkills[0]],
      },
    };
    expect(() => deriveEccProfile(overlap, evidence)).toThrow(/active.*warm/i);
  });

  it("rejects duplicate or silently omitted pinned source paths", () => {
    const duplicate = structuredClone(evidence) as {
      agentPaths: string[];
      workflowPaths: string[];
    };
    duplicate.workflowPaths[0] = duplicate.agentPaths[0] ?? "";
    expect(() => deriveEccProfile(profile, duplicate)).toThrow(/ambiguous.*source path|namespace/i);
    const omitted = structuredClone(evidence) as { workflowPaths: string[] };
    omitted.workflowPaths.pop();
    expect(() => deriveEccProfile(profile, omitted)).toThrow(/workflow.*94/i);
  });

  it("rejects an invented active leaf absent from pinned skill inventory", () => {
    const invented = structuredClone(profile);
    invented.selections.activeSkills[0] = "made-up-leaf";
    expect(() => deriveEccProfile(invented, evidence)).toThrow(/made-up-leaf|inventory/i);
  });

  it("rejects an altered embedded manifest payload", () => {
    const altered = structuredClone(evidence) as {
      componentsManifest: { components: Array<{ modules: string[] }> };
    };
    altered.componentsManifest.components[0]?.modules.push("invented-module");
    expect(() => deriveEccProfile(profile, altered)).toThrow(/payload hash/i);
  });

  it.each(["modulesManifest", "profilesManifest"] as const)(
    "rejects caller-rehashed %s content that is not independently pinned",
    (manifestKey) => {
      const altered = structuredClone(evidence) as {
        source: {
          manifestHashes: Record<string, string>;
          manifestPayloadHashes: Record<string, string>;
        };
        modulesManifest: { modules: Array<{ paths: string[] }> };
        profilesManifest: { profiles: { core: { modules: string[] } } };
      };
      const sourcePath =
        manifestKey === "modulesManifest"
          ? "manifests/install-modules.json"
          : "manifests/install-profiles.json";
      if (manifestKey === "modulesManifest")
        altered.modulesManifest.modules.at(-1)?.paths.splice(0, 1, "skills/pin-bypass");
      else altered.profilesManifest.profiles.core.modules.reverse();
      altered.source.manifestHashes[sourcePath] = "b".repeat(64);
      altered.source.manifestPayloadHashes[sourcePath] = digest([
        canonicalJson(altered[manifestKey]),
      ]);
      expect(() => deriveEccProfile(profile, altered)).toThrow(/trusted.*manifest|pin/i);
    },
  );

  it.each(["missing", "extra", "mismatched"])("rejects %s trusted manifest pin fields", (mode) => {
    const malformed = structuredClone(profile) as {
      source: { manifestPins: Record<string, { rawSha256: string; canonicalSha256: string }> };
    };
    if (mode === "missing") delete malformed.source.manifestPins["manifests/install-modules.json"];
    if (mode === "extra")
      malformed.source.manifestPins["manifests/extra.json"] = {
        rawSha256: "a".repeat(64),
        canonicalSha256: "a".repeat(64),
      };
    if (mode === "mismatched")
      malformed.source.manifestPins["manifests/install-profiles.json"] = {
        rawSha256: "b".repeat(64),
        canonicalSha256: "b".repeat(64),
      };
    expect(() => deriveEccProfile(malformed, evidence)).toThrow();
  });

  it.each([
    ["agent namespace", "agentPaths", "other/code-reviewer.md"],
    ["workflow namespace", "workflowPaths", "other/code-review.md"],
    ["duplicate agent identity", "agentPaths", "agents/nested/code-reviewer.md"],
    ["duplicate workflow identity", "workflowPaths", "commands/nested/code-review.md"],
  ] as const)("rejects ambiguous derived identity: %s", (_label, collection, path) => {
    const malformed = structuredClone(evidence) as Record<"agentPaths" | "workflowPaths", string[]>;
    const paths = malformed[collection];
    paths[0] = path;
    expect(() => deriveEccProfile(profile, malformed)).toThrow(/namespace|identity/i);
  });

  it("rejects malformed review receipt evidence hashes", () => {
    const malformed = {
      ...profile,
      source: {
        ...profile.source,
        reviewReceipt: { ...profile.source.reviewReceipt, evidenceSha256: "ABC" },
      },
    };
    expect(() => eccProfileSchema.parse(malformed)).toThrow(/sha|invalid/i);
    const contradictory = structuredClone(evidence) as {
      reviewReceipt: { evidenceSha256: string };
    };
    contradictory.reviewReceipt.evidenceSha256 = "b".repeat(64);
    expect(() => deriveEccProfile(profile, contradictory)).toThrow(/receipt/i);
  });

  it("rejects altered manifest bytes under a supplied source root", async () => {
    const roots = await fixtureRoots();
    try {
      await writeFile(
        join(roots.sourceRoot, "manifests", "install-components.json"),
        '{"version":1}',
      );
      await expect(
        resolveEccProfile(profile, evidence, {
          sourceRoot: roots.sourceRoot,
          evidenceRoot: roots.evidenceRoot,
        }),
      ).rejects.toThrow(/hash|manifest/i);
    } finally {
      await roots.cleanup();
    }
  });

  it.each(["C:escape/file.md", "safe/file.md:stream", "CON/file.md", "safe/trailing. /file.md"])(
    "rejects hostile portable path %s",
    (hostilePath) => {
      const malformed = structuredClone(evidence) as { agentPaths: string[] };
      malformed.agentPaths[0] = hostilePath;
      expect(() => deriveEccProfile(profile, malformed)).toThrow(/path/i);
    },
  );

  it("contains manifests, component paths, modules, roles, workflows, and skills through the strict tree boundary", async () => {
    const roots = await fixtureRoots();
    const outside = await mkdtemp(join(tmpdir(), "aih-ecc-profile-outside-"));
    try {
      await writeFile(join(outside, "install-components.json"), "outside");
      await writeFile(join(outside, "install-modules.json"), "outside");
      await writeFile(join(outside, "install-profiles.json"), "outside");
      await rm(join(roots.sourceRoot, "manifests"), { recursive: true });
      await symlink(outside, join(roots.sourceRoot, "manifests"), "junction");
      await expect(
        resolveEccProfile(profile, evidence, {
          sourceRoot: roots.sourceRoot,
          evidenceRoot: roots.evidenceRoot,
        }),
      ).rejects.toThrow(/symbolic link|escape|hash/i);
    } finally {
      await roots.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a relative source root before filesystem acquisition", async () => {
    const relativeTemporaryRoot = relative(tmpdir(), join(tmpdir(), "aih-ecc-relative-root"));
    expect(isAbsolute(relativeTemporaryRoot)).toBe(false);
    await expect(
      resolveEccProfile(profile, evidence, {
        sourceRoot: relativeTemporaryRoot,
        evidenceRoot: join(tmpdir(), "aih-ecc-unused-evidence-root"),
      }),
    ).rejects.toThrow(/source root.*absolute/i);
  });

  it.each(["missing", "modified", "substituted", "symlinked", "hash-mismatched"])(
    "rejects a %s review receipt file",
    async (mode) => {
      const roots = await fixtureRoots();
      const outside = await mkdtemp(join(tmpdir(), "aih-ecc-profile-receipt-outside-"));
      try {
        let checkedProfile: unknown = profile;
        let checkedEvidence: unknown = evidence;
        if (mode === "missing") await rm(roots.fixtureReceipt);
        if (mode === "modified") await writeFile(roots.fixtureReceipt, "modified");
        if (mode === "substituted") await writeFile(roots.fixtureReceipt, '{"receiptVersion":1}');
        if (mode === "symlinked") {
          const outsideReceipt = join(outside, "review-receipt.json");
          await writeFile(outsideReceipt, receiptBytes);
          const receiptParent = dirname(roots.fixtureReceipt);
          await rm(receiptParent, { recursive: true });
          await symlink(outside, receiptParent, "junction");
        }
        if (mode === "hash-mismatched") {
          checkedProfile = structuredClone(profile);
          checkedEvidence = structuredClone(evidence);
          const forgedHash = "b".repeat(64);
          (checkedProfile as typeof profile).source.reviewReceipt.evidenceSha256 = forgedHash;
          (
            checkedEvidence as { reviewReceipt: { evidenceSha256: string } }
          ).reviewReceipt.evidenceSha256 = forgedHash;
        }
        await expect(
          resolveEccProfile(checkedProfile, checkedEvidence, {
            sourceRoot: roots.sourceRoot,
            evidenceRoot: roots.evidenceRoot,
          }),
        ).rejects.toThrow(/receipt/i);
      } finally {
        await roots.cleanup();
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["agent", "agents/a11y-architect.md"],
    ["workflow", "commands/aside.md"],
    ["baseline skill", "skills/unified-memory"],
    ["selected leaf", "skills/workspace-surface-audit"],
  ] as const)(
    "rejects one missing declared %s path",
    async (_label, missingPath) => {
      const roots = await fixtureRoots();
      try {
        await rm(join(roots.sourceRoot, ...missingPath.split("/")), {
          recursive: true,
          force: true,
        });
        await expect(
          resolveEccProfile(profile, evidence, {
            sourceRoot: roots.sourceRoot,
            evidenceRoot: roots.evidenceRoot,
          }),
        ).rejects.toThrow(/declared source path.*missing/i);
      } finally {
        await roots.cleanup();
      }
    },
    15_000,
  );

  it("is deterministic and byte-stable for equivalent manifest ordering", () => {
    const shuffled = structuredClone(evidence) as {
      agentPaths: string[];
      workflowPaths: string[];
    };
    shuffled.agentPaths.reverse();
    shuffled.workflowPaths.reverse();
    expect(serializeResolvedEccProfile(deriveEccProfile(profile, shuffled))).toBe(
      serializeResolvedEccProfile(deriveEccProfile(profile, evidence)),
    );
  });
});
