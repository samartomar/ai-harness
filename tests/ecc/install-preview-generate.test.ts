import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateEccInstallPreviewArtifact } from "../../src/ecc/install-preview-generate.js";

const PIN = "1234567890abcdef1234567890abcdef12345678";

describe("ECC install preview generation", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("expands the upstream manifest planner and applies harness-owned safe transforms", () => {
    root = mkdtempSync(resolve(tmpdir(), "aih-ecc-preview-generator-"));
    mkdirSync(resolve(root, "scripts/lib/install-targets"), { recursive: true });
    writeFileSync(resolve(root, "package.json"), '{"name":"ecc-fixture","type":"commonjs"}\n');
    writeFileSync(
      resolve(root, "scripts/lib/install-manifests.js"),
      `exports.listInstallComponents = () => [
        { id: "baseline:rules" },
        { id: "unknown:ignored" },
      ];\n`,
    );
    writeFileSync(
      resolve(root, "scripts/lib/install-executor.js"),
      `exports.createManifestInstallPlan = (input) => {
        if (input.target === "opencode") throw new Error("compiled plugin payload is unavailable");
        const operations = [
          {
            kind: "copy-file",
            moduleId: input.moduleIds[0],
            sourceRelativePath: "rules/core.md",
            destinationPath: input.homeDir + "/." + input.target + "/rules/core.md",
          },
          {
            kind: "copy-file",
            moduleId: input.moduleIds[0],
            sourceRelativePath: "AGENTS.md",
            destinationPath: input.homeDir + "/." + input.target + "/AGENTS.md",
          },
        ];
        return { operations, statePreview: { operations: operations.map((operation) => ({ ...operation })) } };
      };\n`,
    );
    writeFileSync(
      resolve(root, "scripts/lib/install-targets/registry.js"),
      `exports.getInstallTargetAdapter = (target) => ({
        resolveRoot: ({ homeDir }) => homeDir + "/." + target,
      });\n`,
    );

    const result = generateEccInstallPreviewArtifact(root, PIN);

    expect(result.source).toEqual({ owner: "affaan-m", repo: "ECC", pinnedSha: PIN });
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        target: "claude",
        componentId: "baseline:rules",
        kind: "copy-file",
        source: "rules/core.md",
        destination: "<home>/.claude/rules/core.md",
      }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ target: "codex", kind: "copy-file", source: "AGENTS.md" }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        target: "codex",
        componentId: "runtime:ecc-installer",
        kind: "managed-block",
        destination: "<home>/.codex/AGENTS.md",
      }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ target: "opencode", componentId: "baseline:rules" }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ componentId: "unknown:ignored" }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({ target: "kiro", componentId: "runtime:ecc-kiro", kind: "exec" }),
    );
  });
});
