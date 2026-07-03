import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmps: string[] = [];

function fresh(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  while (tmps.length > 0) {
    const dir = tmps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function runAih(args: string[]) {
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const detectorFreePath = dirname(process.execPath);
  return spawnSync(process.execPath, [tsx, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIH_TRUST_INTERNAL_SCOPES: "",
      Path: detectorFreePath,
      PATH: detectorFreePath,
    },
    encoding: "utf8",
  });
}

describe("T3 real CLI trust gate", () => {
  it("promotes a clean local source", () => {
    const workspace = fresh("aih-cli-clean-root-");
    const source = fresh("aih-cli-clean-source-");
    write(source, "skills/clean/SKILL.md", "# Clean\n");

    const result = runAih([
      "workspace",
      "add",
      source,
      "--root",
      workspace,
      "--context-dir",
      "ai-coding",
      "--apply",
      "--force",
    ]);

    const sourceId = basename(source).toLowerCase();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(join(workspace, "ai-coding", "skills", sourceId, "clean", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(workspace, ".aih", "trust-lock.json"))).toBe(true);
  }, 30000);

  it("blocks an auto-exec local source without promoting", () => {
    const workspace = fresh("aih-cli-auto-root-");
    const source = fresh("aih-cli-auto-source-");
    write(source, "skills/evil/SKILL.md", "# Evil\n");
    write(source, "package.json", JSON.stringify({ scripts: { postinstall: "node setup.js" } }));

    const result = runAih([
      "workspace",
      "add",
      source,
      "--root",
      workspace,
      "--context-dir",
      "ai-coding",
      "--apply",
      "--force",
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("trust.auto-exec-hook");
    expect(existsSync(join(workspace, "ai-coding", "skills"))).toBe(false);
    expect(existsSync(join(workspace, ".aih", "trust-lock.json"))).toBe(false);
  }, 30000);

  it("blocks a third-party incoming MCP server at enterprise posture", () => {
    const workspace = fresh("aih-cli-mcp-root-");
    const source = fresh("aih-cli-mcp-source-");
    write(source, "skills/clean/SKILL.md", "# Clean\n");
    write(
      source,
      ".mcp.json",
      JSON.stringify({ mcpServers: { hosted: { url: "https://mcp.vendor.example/mcp" } } }),
    );

    const result = runAih([
      "workspace",
      "add",
      source,
      "--root",
      workspace,
      "--context-dir",
      "ai-coding",
      "--posture",
      "enterprise",
      "--apply",
      "--force",
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("mcp.policy-denied");
    expect(result.stdout).toContain("hosted MCP server has no post-approval rug-pull protection");
    expect(existsSync(join(workspace, "ai-coding", "skills"))).toBe(false);
    expect(existsSync(join(workspace, ".aih", "trust-lock.json"))).toBe(false);
  }, 30000);

  it("blocks a bundled-local incoming MCP server at enterprise posture", () => {
    const workspace = fresh("aih-cli-bundled-mcp-root-");
    const source = fresh("aih-cli-bundled-mcp-source-");
    write(source, "skills/clean/SKILL.md", "# Clean\n");
    write(
      source,
      ".mcp.json",
      JSON.stringify({ mcpServers: { bundled: { command: "node", args: ["./payload.js"] } } }),
    );

    const result = runAih([
      "workspace",
      "add",
      source,
      "--root",
      workspace,
      "--context-dir",
      "ai-coding",
      "--posture",
      "enterprise",
      "--apply",
      "--force",
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("mcp.policy-denied");
    expect(result.stdout).toContain("unpinned supply chain");
    expect(existsSync(join(workspace, "ai-coding", "skills"))).toBe(false);
    expect(existsSync(join(workspace, ".aih", "trust-lock.json"))).toBe(false);
  }, 30000);
});
