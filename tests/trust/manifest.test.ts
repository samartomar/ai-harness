import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTrustManifests } from "../../src/trust/manifest.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-trust-manifest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function codes(): string[] {
  return scanTrustManifests(dir).map((check) => check.code ?? "");
}

describe("scanTrustManifests", () => {
  it.each([
    ["array Bash(*)", "skills/bash-array/SKILL.md", "---\nallowed-tools:\n  - Bash(*)\n---\n# X\n"],
    ["flow Bash(*)", "agents/bash-flow.md", "---\nallowed-tools: [Read, Bash(*)]\n---\n# Agent\n"],
    [
      "quoted Bash(*)",
      "commands/bash-quoted.md",
      "---\nallowed-tools: ['Bash(*)']\n---\n# Command\n",
    ],
    [
      "permissionMode bypass",
      "skills/bypass/SKILL.md",
      "---\npermissionMode: bypassPermissions\n---\n# X\n",
    ],
    [
      "dangerously skip permissions",
      "skills/danger/SKILL.md",
      "---\ndangerously-skip-permissions: true\n---\n# X\n",
    ],
    ["bang auto-run", "skills/bang/SKILL.md", "# Bang\n\n  !npm install\n"],
    ["malformed frontmatter", "skills/bad-yaml/SKILL.md", "---\nallowed-tools: [\n---\n# X\n"],
  ])("flags skill frontmatter/body auto-exec tell: %s", (_name, rel, content) => {
    write(rel, content);

    const [check] = scanTrustManifests(dir);

    expect(check).toMatchObject({
      verdict: "fail",
      code: "trust.auto-exec-hook",
      location: expect.objectContaining({ uri: rel }),
    });
    expect(check?.fingerprint).toMatch(/^trust-auto-exec-hook:/);
  });

  it.each([
    ["postinstall", { scripts: { postinstall: "node setup.js" } }],
    ["preinstall", { scripts: { preinstall: "node setup.js" } }],
    ["install", { scripts: { install: "node setup.js" } }],
    ["prepare", { scripts: { prepare: "node setup.js" } }],
    ["prepublish", { scripts: { prepublish: "node setup.js" } }],
    ["prepublishOnly", { scripts: { prepublishOnly: "node setup.js" } }],
  ])("flags package lifecycle script %s", (_script, pkg) => {
    write("package.json", JSON.stringify(pkg));

    expect(codes()).toContain("trust.auto-exec-hook");
  });

  it("fails closed on unparseable package.json", () => {
    write("package.json", "{");

    expect(codes()).toContain("trust.auto-exec-hook");
  });

  it("flags npmrc ignore-scripts=false", () => {
    write(".npmrc", "ignore-scripts = false\n");

    expect(codes()).toContain("trust.auto-exec-hook");
  });

  it("flags Claude hooks directory", () => {
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });

    expect(codes()).toContain("trust.auto-exec-hook");
  });

  it.each(["settings.json", ".claude/settings.json"])("flags hooks key in %s", (rel) => {
    write(rel, JSON.stringify({ hooks: { Stop: [] } }));

    expect(codes()).toContain("trust.auto-exec-hook");
  });

  it("passes a clean tree", () => {
    write("skills/clean/SKILL.md", "---\nallowed-tools:\n  - Read\n---\n# Clean\n");
    write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(".npmrc", "ignore-scripts=true\n");

    expect(scanTrustManifests(dir)).toEqual([]);
  });
});
