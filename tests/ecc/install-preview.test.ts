import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import {
  contingentEccInstallPreviewPlan,
  parseEccInstallPreview,
  readEccInstallPreview,
} from "../../src/ecc/install-preview.js";

describe("shipped ECC install preview", () => {
  it("binds real file operations and runtime operations to the pinned ECC catalog", () => {
    const catalog = baselineCatalogById("ecc");
    const artifact = readEccInstallPreview();
    expect(artifact.source).toEqual({
      owner: catalog.owner,
      repo: catalog.repo,
      pinnedSha: catalog.pinnedSha,
    });
    for (const target of ["claude", "codex", "cursor", "antigravity", "gemini", "zed"] as const) {
      expect(artifact.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target, kind: "copy-file" }),
          expect.objectContaining({
            target,
            kind: "exec",
            componentId: "runtime:ecc-installer",
            contingentOn: "evidence-authorization",
          }),
        ]),
      );
    }
    expect(artifact.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "opencode",
          kind: "exec",
          componentId: "runtime:ecc-installer",
        }),
      ]),
    );
    expect(artifact.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "codex",
          kind: "managed-block",
          source: ".codex/AGENTS.md",
          destination: "<home>/.codex/AGENTS.md",
        }),
        expect.objectContaining({
          target: "codex",
          kind: "managed-block",
          destination: "<home>/.codex/config.toml",
        }),
      ]),
    );
    expect(artifact.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "codex",
          kind: "copy-file",
          destination: "<home>/.codex/AGENTS.md",
        }),
        expect.objectContaining({
          target: "codex",
          kind: "copy-file",
          destination: "<home>/.codex/config.toml",
        }),
      ]),
    );
    expect(artifact.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "claude",
          kind: "merge-json",
          destination: "<project>/.mcp.json",
          componentId: "mcp:sequential-thinking",
        }),
        expect.objectContaining({
          kind: "exec",
          source: "aih ledger-last writer",
          destination: "<home>/.aih/ecc/registration-ledger.json",
        }),
      ]),
    );
    expect(artifact.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "claude",
          destination: expect.stringMatching(/^<home>\/\.claude\//),
        }),
        expect.objectContaining({
          target: "cursor",
          destination: expect.stringMatching(/^<project>\/\.cursor\//),
        }),
      ]),
    );
  });

  it("de-duplicates a physical operation after overlapping component selection", () => {
    const catalog = baselineCatalogById("ecc");
    const operation = {
      target: "claude" as const,
      kind: "copy-file" as const,
      source: "agents/reviewer.md",
      destination: "<home>/.claude/agents/reviewer.md",
      contingentOn: "evidence-authorization" as const,
    };
    const result = contingentEccInstallPreviewPlan({
      catalog,
      clis: ["claude"],
      selection: {
        scope: "scoped",
        components: ["baseline:agents", "agent:reviewer"],
        mcps: [],
        recommendations: [],
      },
      artifact: {
        schemaVersion: 1,
        source: { owner: catalog.owner, repo: catalog.repo, pinnedSha: catalog.pinnedSha },
        operations: [
          { ...operation, componentId: "baseline:agents" },
          { ...operation, componentId: "agent:reviewer" },
        ],
      },
    });
    const data = result.actions[0]?.kind === "digest" ? result.actions[0].data : undefined;
    expect(data).toMatchObject({ operations: [{ componentId: "agent:reviewer" }] });
  });

  it("rejects control characters in shipped operation fields", () => {
    expect(() =>
      parseEccInstallPreview({
        schemaVersion: 1,
        source: { owner: "affaan-m", repo: "ECC", pinnedSha: "a".repeat(40) },
        operations: [
          {
            target: "claude",
            kind: "copy-file",
            source: "rules/safe.md\nspoofed",
            destination: "<home>/.claude/rules/safe.md",
            componentId: "baseline:rules",
            contingentOn: "evidence-authorization",
          },
        ],
      }),
    ).toThrow(/control characters/);
  });
});
