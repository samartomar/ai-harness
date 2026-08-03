import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AIH_ECC_PROFILE_TEMPLATE, deriveEccProfile } from "../../src/ecc-profile/index.js";
import { renderEccProjection, serializeEccProjection } from "../../src/ecc-profile/render.js";

const fixtureDirectory = join(import.meta.dirname, "../fixtures/ecc-profile");
const evidence = JSON.parse(
  await readFile(join(fixtureDirectory, "pinned-source-evidence.json"), "utf8"),
) as unknown;
const receiptBytes = await readFile(join(fixtureDirectory, "review-receipt.json"));
const receipt = {
  id: "pinned-source-evidence-v1",
  evidencePath: "tests/fixtures/ecc-profile/review-receipt.json",
  sourceCommit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
  evidenceSha256: "b4bc069efc8c5eca51e6426feb9d59cc469f2b49b681118a6fd26f5c8fab461c",
};
const profile = {
  ...AIH_ECC_PROFILE_TEMPLATE,
  source: { ...AIH_ECC_PROFILE_TEMPLATE.source, reviewReceipt: receipt },
};
const manifestNames = [
  "install-components.json",
  "install-modules.json",
  "install-profiles.json",
] as const;

function sourceFile(text: string, description: string, body: string): string {
  return [
    "---",
    `name: ${text}`,
    `description: ${description}`,
    "tools: Read, Grep, Glob, Bash",
    "model: sonnet",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function projectionRoots() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "aih-ecc-render-source-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "aih-ecc-render-evidence-"));
  const resolved = deriveEccProfile(profile, evidence);

  for (const sourcePath of resolved.consumedSourcePaths) {
    if (sourcePath.startsWith("manifests/")) continue;
    const fullPath = join(sourceRoot, ...sourcePath.split("/"));
    if (extname(sourcePath) || sourcePath === "LICENSE") {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, `${sourcePath}\n`);
    } else {
      await mkdir(fullPath, { recursive: true });
    }
  }

  for (const skill of resolved.skills) {
    const skillFile = join(sourceRoot, ...skill.sourcePath.split("/"), "SKILL.md");
    await mkdir(dirname(skillFile), { recursive: true });
    await writeFile(
      skillFile,
      sourceFile(skill.id, `Use the ${skill.id} capability.`, `Apply ${skill.id} when relevant.`),
    );
  }
  for (const role of resolved.roles) {
    await writeFile(
      join(sourceRoot, ...role.sourcePath.split("/")),
      sourceFile(role.id, `Review as ${role.id}.`, `Act as the ${role.id} role.`),
    );
  }
  for (const workflow of resolved.workflows) {
    await writeFile(
      join(sourceRoot, ...workflow.sourcePath.split("/")),
      sourceFile(
        workflow.id.slice(1),
        `Run the ${workflow.id} workflow.`,
        `Execute ${workflow.id} with $ARGUMENTS.`,
      ),
    );
  }
  for (const manifestName of manifestNames) {
    const destination = join(sourceRoot, "manifests", manifestName);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(fixtureDirectory, "manifests", manifestName), destination);
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("native ECC profile projection", () => {
  it("renders exact Claude and Codex parity from the verified resolver", async () => {
    const roots = await projectionRoots();
    try {
      const resolved = deriveEccProfile(profile, evidence);
      const projection = await renderEccProjection(profile, evidence, roots);

      for (const client of [projection.clients.claude, projection.clients.codex]) {
        expect(
          client.skills.map(({ id, sourcePath, owner }) => ({ id, sourcePath, owner })),
        ).toEqual(resolved.skills.map(({ id, sourcePath, owner }) => ({ id, sourcePath, owner })));
        expect(
          client.roles.map(({ id, sourcePath, owner }) => ({ id, sourcePath, owner })),
        ).toEqual(resolved.roles);
        expect(
          client.workflows.map(({ id, sourcePath, owner }) => ({ id, sourcePath, owner })),
        ).toEqual(resolved.workflows);
        expect(client.skills).toHaveLength(136);
        expect(client.roles).toHaveLength(67);
        expect(client.workflows).toHaveLength(94);
        expect(client.workflows.filter((entry) => entry.owner === "aih-adaptation")).toHaveLength(
          4,
        );
      }

      expect(projection.clients.claude.skills[0]?.destination).toMatch(/^\.claude\/skills\//);
      expect(projection.clients.claude.roles[0]?.destination).toMatch(/^\.claude\/agents\//);
      expect(projection.clients.claude.workflows[0]?.destination).toMatch(/^\.claude\/commands\//);
      expect(projection.clients.codex.skills[0]?.destination).toMatch(/^\.agents\/skills\//);
      expect(projection.clients.codex.roles[0]?.destination).toMatch(/^\.codex\/agents\//);
      expect(projection.clients.codex.workflows[0]?.destination).toMatch(
        /^\.agents\/skills\/ecc-workflow-/,
      );
      expect(
        projection.files.some(
          (file) =>
            file.destination === ".mcp.json" ||
            file.destination === ".claude/settings.json" ||
            /(^|\/)hooks(\/|$)/.test(file.destination),
        ),
      ).toBe(false);
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("renders current native role and workflow shapes without copying model or tool declarations", async () => {
    const roots = await projectionRoots();
    try {
      const projection = await renderEccProjection(profile, evidence, roots);
      const codexConfig = projection.files.find(
        (file) => file.destination === ".codex/config.toml",
      );
      expect(codexConfig?.mergeStrategy).toBe("toml-merge");
      expect(codexConfig?.content.match(/^\[agents\.[a-z0-9-]+\]$/gm)).toHaveLength(67);
      expect(codexConfig?.content).not.toMatch(/^model\s*=/m);
      expect(codexConfig?.content).not.toMatch(/^tools\s*=/m);

      const codexRole = projection.files.find(
        (file) => file.destination === ".codex/agents/typescript-reviewer.toml",
      );
      expect(codexRole?.content).toContain("developer_instructions = ");
      expect(codexRole?.content).not.toContain("sandbox_mode =");
      expect(codexRole?.content).not.toContain("model =");
      expect(codexRole?.content).not.toContain("tools =");

      const codexWorkflow = projection.files.find(
        (file) => file.destination === ".agents/skills/ecc-workflow-code-review/SKILL.md",
      );
      expect(codexWorkflow?.content).toContain("name: ecc-workflow-code-review");
      expect(codexWorkflow?.content).not.toContain("$ARGUMENTS");
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("replaces only the four ownership-sensitive workflows with AIH adaptations", async () => {
    const roots = await projectionRoots();
    try {
      const projection = await renderEccProjection(profile, evidence, roots);
      const adapted = projection.clients.claude.workflows
        .filter((entry) => entry.owner === "aih-adaptation")
        .map((entry) => entry.id);
      expect(adapted).toEqual(["/auto-update", "/hookify-configure", "/hookify", "/project-init"]);
      for (const workflow of adapted) {
        const id = workflow.slice(1);
        const claudeFile = projection.files.find(
          (file) => file.destination === `.claude/commands/${id}.md`,
        );
        const codexFile = projection.files.find(
          (file) => file.destination === `.agents/skills/ecc-workflow-${id}/SKILL.md`,
        );
        expect(claudeFile?.owner).toBe("aih");
        expect(codexFile?.owner).toBe("aih");
        expect(claudeFile?.capabilityOwner).toBe("aih-adaptation");
        expect(codexFile?.capabilityOwner).toBe("aih-adaptation");
        expect(claudeFile?.content).toContain("AIH-owned adaptation");
        expect(codexFile?.content).toContain("AIH-owned adaptation");
      }
      const upstream = projection.files.find(
        (file) => file.destination === ".claude/commands/code-review.md",
      );
      expect(upstream?.owner).toBe("aih");
      expect(upstream?.capabilityOwner).toBe("upstream");
      expect(upstream?.content).toContain("Execute /code-review with $ARGUMENTS.");
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("is deterministic, collision-free, and byte-stable", async () => {
    const roots = await projectionRoots();
    try {
      const first = await renderEccProjection(profile, evidence, roots);
      const second = await renderEccProjection(profile, evidence, roots);
      expect(serializeEccProjection(first)).toBe(serializeEccProjection(second));
      const destinations = first.files.map((file) => file.destination);
      expect(destinations).toEqual([...destinations].sort());
      expect(new Set(destinations.map((destination) => destination.toLowerCase())).size).toBe(
        destinations.length,
      );
      for (const file of first.files) {
        expect(file.normalizedSha256).toBe(sha256(file.content));
        expect(file.content.endsWith("\n")).toBe(true);
        expect(file.content).not.toContain("\r");
      }
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it.each(["missing", "modified"] as const)(
    "cannot bypass actual review-receipt verification when the receipt is %s",
    async (mode) => {
      const roots = await projectionRoots();
      try {
        if (mode === "missing") await rm(roots.fixtureReceipt);
        else await writeFile(roots.fixtureReceipt, "tampered\n");
        await expect(renderEccProjection(profile, evidence, roots)).rejects.toThrow(/receipt/i);
      } finally {
        await roots.cleanup();
      }
    },
  );

  it("rejects a linked nested skill resource instead of projecting outside bytes", async () => {
    const roots = await projectionRoots();
    const outside = await mkdtemp(join(tmpdir(), "aih-ecc-render-outside-"));
    try {
      await writeFile(join(outside, "outside.md"), "outside\n");
      await symlink(
        outside,
        join(roots.sourceRoot, "skills", "tdd-workflow", "linked-resource"),
        "junction",
      );
      await expect(renderEccProjection(profile, evidence, roots)).rejects.toThrow(
        /symbolic link|linked|escape/i,
      );
    } finally {
      await roots.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
