import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterNote } from "../../src/bootstrap-ai/canon.js";
import { command } from "../../src/bootstrap-ai/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function context(root: string, cli: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: root },
    options: { cli, canon: "compact" },
  };
}

function generatedBytes(root: string, cli: string): Map<string, string> {
  const paths = [
    "ai-coding/RULE_ROUTER.md",
    "ai-coding/adapters/_shared-canonical-block.md",
    "ai-coding/rules/agent-behavior-core.md",
    `ai-coding/adapters/${cli}.md`,
  ];
  return new Map(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

describe("bootstrap-ai fleet regeneration (#507)", () => {
  it.each([
    ["TypeScript repo", "claude", "package.json", JSON.stringify({ scripts: { test: "vitest" } })],
    ["Python repo", "codex", "pyproject.toml", '[project]\nname = "service"\n'],
  ])(
    "converges %s idempotently, preserves bootloader hand edits, and sweeps orphan adapters",
    async (_label, cli, manifest, manifestContents) => {
      const root = mkdtempSync(join(tmpdir(), "aih-bootstrap-fleet-"));
      roots.push(root);
      put(root, manifest, manifestContents);
      put(root, "ai-coding/adapters/gemini.md", adapterNote("gemini", "ai-coding", "compact"));
      const bootloader = cli === "claude" ? "CLAUDE.md" : "AGENTS.md";
      put(root, bootloader, "# Operator header\n\nKeep this note.\n");
      const ctx = context(root, cli);

      const first = await executePlan(await command.plan(ctx), ctx);
      const firstBytes = generatedBytes(root, cli);
      expect(first.removed.map((entry) => entry.path)).toContain("ai-coding/adapters/gemini.md");
      expect(existsSync(join(root, "ai-coding", "adapters", "gemini.md"))).toBe(false);
      expect(readFileSync(join(root, bootloader), "utf8")).toContain("Keep this note.");

      const second = await executePlan(await command.plan(ctx), ctx);
      expect(generatedBytes(root, cli)).toEqual(firstBytes);
      expect(second.removed.map((entry) => entry.path)).not.toContain(
        "ai-coding/adapters/gemini.md",
      );
      expect(readFileSync(join(root, bootloader), "utf8")).toContain("Keep this note.");
    },
  );
});
