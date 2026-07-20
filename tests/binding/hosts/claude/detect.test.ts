import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectClaudeHost } from "../../../../src/binding/hosts/claude/detect.js";
import { fakeRunner, missingToolRunner } from "../../../../src/internals/proc.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-claude-detect-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-claude-detect-home-"));
});

afterEach(() => {
  for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true });
});

const deps = (over: Partial<Parameters<typeof detectClaudeHost>[1]> = {}) => ({
  env: { USERPROFILE: home },
  run: missingToolRunner,
  platform: "windows" as const,
  ...over,
});

describe("detectClaudeHost — install detection (via cli-detect)", () => {
  it("detects a Claude config dir in the home directory", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const report = await detectClaudeHost(root, deps());
    expect(report.install.present).toBe(true);
    expect(report.install.via).toBe("config");
  });

  it("detects the claude binary on PATH when no config dir exists", async () => {
    const report = await detectClaudeHost(
      root,
      deps({
        run: fakeRunner((argv) =>
          argv[0] === "where" ? { code: 0, stdout: "C:/claude" } : undefined,
        ),
      }),
    );
    expect(report.install.present).toBe(true);
    expect(report.install.via).toBe("binary");
  });

  it("reports absent when neither config dir nor binary is found", async () => {
    const report = await detectClaudeHost(root, deps());
    expect(report.install.present).toBe(false);
  });
});

describe("detectClaudeHost — project-root surface presence", () => {
  it("reports the .aih-config.json marker and whether it carries a binding", async () => {
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: [],
        binding: {
          schemaVersion: 1,
          framework: { id: "ecc", mode: "lean", host: "claude" },
          source: {
            kind: "git",
            repository: "affaan-m/ECC",
            commitSha: "c".repeat(40),
            treeDigest: "a".repeat(64),
          },
        },
      }),
    );
    const report = await detectClaudeHost(root, deps());
    expect(report.surfaces.marker.present).toBe(true);
    expect(report.surfaces.marker.hasBinding).toBe(true);
  });

  it("reports a marker without a binding", async () => {
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: [] }),
    );
    const report = await detectClaudeHost(root, deps());
    expect(report.surfaces.marker.present).toBe(true);
    expect(report.surfaces.marker.hasBinding).toBe(false);
  });

  it("reports .claude/ dir and CLAUDE.md presence at the project root", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# bootloader\n");
    const report = await detectClaudeHost(root, deps());
    expect(report.surfaces.claudeDir).toBe(true);
    expect(report.surfaces.bootloader).toBe(true);
  });

  it("reports absent surfaces on a bare project root", async () => {
    const report = await detectClaudeHost(root, deps());
    expect(report.surfaces.marker.present).toBe(false);
    expect(report.surfaces.claudeDir).toBe(false);
    expect(report.surfaces.bootloader).toBe(false);
  });
});

describe("detectClaudeHost — resolved surface paths (D4.3)", () => {
  it("exposes the registry-derived repo-relative surface paths", async () => {
    const report = await detectClaudeHost(root, deps());
    expect(report.paths.settings).toBe(".claude/settings.json");
    expect(report.paths.settingsLocal).toBe(".claude/settings.local.json");
    expect(report.paths.mcp).toBe(".mcp.json");
    expect(report.paths.bootloader).toBe("CLAUDE.md");
    expect(report.paths.ownedFileRoots).toEqual([
      ".claude/rules/",
      ".claude/skills/",
      ".claude/agents/",
    ]);
  });
});
