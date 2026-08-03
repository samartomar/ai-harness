import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { deriveEccProfile } from "../../src/ecc-profile/index.js";
import {
  PROJECTED_SOURCE_LIMITS,
  renderEccProjection,
  renderEccProjectionWithTrust,
  serializeEccProjection,
} from "../../src/ecc-profile/render.js";
import {
  evidence,
  type ProjectionRoots,
  profile,
  projectionRoots,
  setExecutable,
} from "./render-fixture.js";

async function renderFixture(roots: ProjectionRoots) {
  return renderEccProjectionWithTrust(profile, evidence, roots, await roots.createTrust());
}

async function renderWithExistingTrust(
  roots: ProjectionRoots,
  trust: Awaited<ReturnType<ProjectionRoots["createTrust"]>>,
) {
  return renderEccProjectionWithTrust(profile, evidence, roots, trust);
}

function frontmatter(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  const closing = lines.indexOf("---", 1);
  expect(lines[0]).toBe("---");
  expect(closing).toBeGreaterThan(0);
  return parseYaml(lines.slice(1, closing).join("\n")) as Record<string, unknown>;
}

function firstSkillSourcePath(roots: ProjectionRoots): string {
  const skill = roots.resolved.skills[0];
  if (!skill) throw new Error("fixture has no selected skill");
  return skill.sourcePath;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("native ECC profile projection", () => {
  it("renders exact Claude and Codex parity from the verified resolver", async () => {
    const roots = await projectionRoots();
    try {
      const resolved = deriveEccProfile(profile, evidence);
      const projection = await renderFixture(roots);

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
      const projection = await renderFixture(roots);
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
      const projection = await renderFixture(roots);
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
      const trust = await roots.createTrust();
      const first = await renderEccProjectionWithTrust(profile, evidence, roots, trust);
      const second = await renderEccProjectionWithTrust(profile, evidence, roots, trust);
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
        await expect(renderFixture(roots)).rejects.toThrow(/receipt/i);
      } finally {
        await roots.cleanup();
      }
    },
  );

  it("rejects a linked nested skill resource instead of projecting outside bytes", async () => {
    const roots = await projectionRoots();
    const outside = await mkdtemp(join(tmpdir(), "aih-ecc-render-outside-"));
    try {
      const trust = await roots.createTrust();
      await writeFile(join(outside, "outside.md"), "outside\n");
      await symlink(
        outside,
        join(roots.sourceRoot, "skills", "tdd-workflow", "linked-resource"),
        "junction",
      );
      await expect(renderWithExistingTrust(roots, trust)).rejects.toThrow(
        /symbolic link|linked|escape/i,
      );
    } finally {
      await roots.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not let the public filesystem entry point trust a caller-built closure pin", async () => {
    const roots = await projectionRoots();
    try {
      await roots.createTrust();
      await expect(renderEccProjection(profile, evidence, roots)).rejects.toThrow(
        /trusted projected source|closure receipt/i,
      );
    } finally {
      await roots.cleanup();
    }
  });

  it.each(["modified", "missing", "extra", "type-changed"] as const)(
    "rejects a %s projected input after the closure was authenticated",
    async (mode) => {
      const roots = await projectionRoots();
      try {
        const skillPath = join(
          roots.sourceRoot,
          ...firstSkillSourcePath(roots).split("/"),
          "SKILL.md",
        );
        const trust = await roots.createTrust();
        if (mode === "modified") await writeFile(skillPath, "changed after receipt\n");
        if (mode === "missing") await rm(skillPath);
        if (mode === "extra")
          await writeFile(join(skillPath, "..", "unreviewed-resource.md"), "extra\n");
        if (mode === "type-changed") {
          await rm(skillPath);
          await mkdir(skillPath);
        }
        await expect(renderWithExistingTrust(roots, trust)).rejects.toThrow(
          /closure|projected source|regular file|inventory/i,
        );
      } finally {
        await roots.cleanup();
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "rejects a projected input whose executable mode changed after authentication",
    async () => {
      const roots = await projectionRoots();
      try {
        const skillPath = join(
          roots.sourceRoot,
          ...firstSkillSourcePath(roots).split("/"),
          "SKILL.md",
        );
        const trust = await roots.createTrust();
        await setExecutable(skillPath, true);
        await expect(renderWithExistingTrust(roots, trust)).rejects.toThrow(/mode/i);
      } finally {
        await roots.cleanup();
      }
    },
    30_000,
  );

  it("enforces the per-file projected-source byte limit", async () => {
    const roots = await projectionRoots();
    try {
      const extra = join(
        roots.sourceRoot,
        ...firstSkillSourcePath(roots).split("/"),
        "oversized.txt",
      );
      await writeFile(extra, Buffer.alloc(PROJECTED_SOURCE_LIMITS.maxFileBytes + 1, 0x61));
      const trust = await roots.createTrust();
      await expect(renderWithExistingTrust(roots, trust)).rejects.toThrow(/file byte limit/i);
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("enforces the aggregate projected-source byte limit", async () => {
    const roots = await projectionRoots();
    try {
      const directory = join(
        roots.sourceRoot,
        ...firstSkillSourcePath(roots).split("/"),
        "aggregate",
      );
      await mkdir(directory);
      const chunkBytes = Math.floor(PROJECTED_SOURCE_LIMITS.maxFileBytes / 2);
      const chunks = Math.ceil(PROJECTED_SOURCE_LIMITS.maxAggregateBytes / chunkBytes) + 1;
      for (let index = 0; index < chunks; index += 1) {
        await writeFile(join(directory, `${index}.txt`), Buffer.alloc(chunkBytes, 0x61));
      }
      const trust = await roots.createTrust();
      await expect(renderWithExistingTrust(roots, trust)).rejects.toThrow(/aggregate byte limit/i);
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("enforces the projected-source file-count limit", async () => {
    const roots = await projectionRoots();
    try {
      const base = await roots.createTrust();
      const directory = join(roots.sourceRoot, ...firstSkillSourcePath(roots).split("/"), "many");
      await mkdir(directory);
      for (let index = base.fileCount; index <= PROJECTED_SOURCE_LIMITS.maxFiles; index += 1) {
        await writeFile(join(directory, `${index}.txt`), "x\n");
      }
      const trust = await roots.createTrust();
      await expect(renderWithExistingTrust(roots, trust)).rejects.toThrow(/file-count limit/i);
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("keeps source-integrity diagnostics bounded and relative to the trusted root", async () => {
    const roots = await projectionRoots();
    try {
      const relative = `${firstSkillSourcePath(roots)}/${"x".repeat(120)}.md`;
      const absolute = join(roots.sourceRoot, ...relative.split("/"));
      await writeFile(absolute, "before\n");
      const trust = await roots.createTrust();
      await writeFile(absolute, "after\n");
      const error = await renderWithExistingTrust(roots, trust).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(relative);
      expect((error as Error).message).not.toContain(roots.sourceRoot);
      expect((error as Error).message.length).toBeLessThan(512);
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("classifies and context-normalizes every workflow transport without changing ownership", async () => {
    const roots = await projectionRoots({
      workflowBodies: {
        "/code-review": [
          "Review $ARGUMENTS and then run /security-scan.",
          "",
          "```sh",
          'mv "$ARGUMENTS" ".claude/reviews/$ARGUMENTS.md"',
          "```",
          "",
          "Use AskUserQuestion, then Agent with subagent_type: security-reviewer.",
          "Call mcp__context7__query-docs when available.",
        ].join("\n"),
        "/save-session": "Persist the session under .claude/sessions/$ARGUMENTS.",
      },
    });
    try {
      const projection = await renderFixture(roots);
      for (const client of [projection.clients.claude, projection.clients.codex]) {
        expect(client.workflows.every((workflow) => workflow.transport !== undefined)).toBe(true);
        expect(client.workflows.map((workflow) => workflow.owner)).toEqual(
          roots.resolved.workflows.map((workflow) => workflow.owner),
        );
      }

      const claudeReview = projection.clients.claude.workflows.find(
        (workflow) => workflow.id === "/code-review",
      );
      const codexReview = projection.clients.codex.workflows.find(
        (workflow) => workflow.id === "/code-review",
      );
      expect(claudeReview?.transport).toBe("native");
      expect(codexReview?.transport).toBe("normalized");
      expect(codexReview?.owner).toBe("upstream");

      const codexReviewFile = projection.files.find(
        (file) => file.destination === ".agents/skills/ecc-workflow-code-review/SKILL.md",
      );
      expect(codexReviewFile?.content).toContain("supplied workflow arguments");
      expect(codexReviewFile?.content).toContain('mv "<workflow-arguments>"');
      expect(codexReviewFile?.content).toContain("ecc-workflow-security-scan");
      expect(codexReviewFile?.content).toContain("Ask the user");
      expect(codexReviewFile?.content).toContain("security-reviewer role");
      expect(codexReviewFile?.content).toContain("Optional MCP fallback");
      expect(codexReviewFile?.content).not.toMatch(
        /\$ARGUMENTS|\.claude\/|mcp__|AskUserQuestion|subagent_type/,
      );

      const unavailable = projection.clients.codex.workflows.find(
        (workflow) => workflow.id === "/save-session",
      );
      expect(unavailable?.transport).toBe("unavailable");
      expect(unavailable?.unavailableReason).toMatch(/continuity|state/i);
      expect(unavailable?.fallback).toBeTruthy();
      const unavailableFile = projection.files.find(
        (file) => file.destination === ".agents/skills/ecc-workflow-save-session/SKILL.md",
      );
      expect(unavailableFile?.content).toContain("Unavailable in this projection");
      expect(unavailableFile?.content).not.toMatch(/\.claude\/|\$ARGUMENTS/);
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("emits reviewed Claude role policy and client-safe Codex role instructions", async () => {
    const roots = await projectionRoots({
      roleBodies: {
        "docs-lookup":
          "Call mcp__context7__query-docs when Context7 exists; otherwise use official docs.",
        "chief-of-staff": "Assume .claude/rules/*.md always loads automatically.",
      },
    });
    try {
      const projection = await renderFixture(roots);
      const claudeRoles = projection.files.filter((file) =>
        file.destination.startsWith(".claude/agents/"),
      );
      for (const role of claudeRoles) {
        const attributes = frontmatter(role.content);
        expect(Object.keys(attributes).sort()).toEqual(["description", "model", "name", "tools"]);
        expect(attributes.model).toBe("inherit");
        expect(attributes.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
        expect(attributes).not.toHaveProperty("permissionMode");
        expect(attributes).not.toHaveProperty("hooks");
      }

      const docsLookup = projection.files.find(
        (file) => file.destination === ".codex/agents/docs-lookup.toml",
      );
      expect(docsLookup?.content).toContain("official documentation fallback");
      expect(docsLookup?.content).not.toContain("mcp__");
      const chief = projection.files.find(
        (file) => file.destination === ".codex/agents/chief-of-staff.toml",
      );
      expect(chief?.content).not.toContain(".claude/rules");
      expect(chief?.content).toContain("current client");
    } finally {
      await roots.cleanup();
    }
  }, 30_000);

  it("records pinned-file versus derived provenance honestly and validates generated frontmatter", async () => {
    const roots = await projectionRoots();
    try {
      const projection = await renderFixture(roots);
      const config = projection.files.find((file) => file.destination === ".codex/config.toml");
      expect(config?.provenance.kind).toBe("derived");
      if (config?.provenance.kind === "derived") {
        expect(config.provenance.derivation).toBe("codex-agent-registry");
        expect(config.provenance.inputs.map((input) => input.path)).toEqual(
          roots.resolved.roles.map((role) => role.sourcePath),
        );
        expect(config.provenance.aggregateSha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(config).not.toHaveProperty("sourcePath");
      for (const file of projection.files.filter(
        (entry) => entry.destination !== ".codex/config.toml",
      )) {
        expect(file.provenance.kind).toBe("pinned-file");
      }

      const documents = projection.files.filter(
        (file) =>
          file.destination.startsWith(".claude/agents/") ||
          file.destination.startsWith(".claude/commands/") ||
          file.destination.endsWith("/SKILL.md"),
      );
      for (const document of documents) expect(frontmatter(document.content)).toBeTypeOf("object");
    } finally {
      await roots.cleanup();
    }
  }, 30_000);
});
