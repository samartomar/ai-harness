import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

const hardRule = "Never run AIH against this checkout.";
const githubExpression = (body: string): string => `\${{ ${body} }}`;

function managedBody(text: string): string {
  const match = text.match(
    /<!-- BEGIN ai-canonical:shared[^\n]*-->\n\n([\s\S]*?)\n\n<!-- END ai-canonical:shared -->/,
  );
  if (!match?.[1]) throw new Error("missing ai-canonical:shared block");
  return match[1].trim();
}

describe("ai-harness self-hosting boundary", () => {
  it("states the hard rule on every always-loaded canon surface", () => {
    for (const path of [
      "AGENTS.md",
      "CLAUDE.md",
      "ai-coding/RULE_ROUTER.md",
      "ai-coding/adapters/_shared-canonical-block.md",
      "ai-coding/rules/agent-behavior-core.md",
      "ai-coding/rules/project-canon-extension.md",
      "ai-coding/SELF-HOSTING.md",
    ]) {
      expect(read(path), path).toContain(hardRule);
    }
  });

  it("keeps bootloader blocks byte-aligned with the manual shared source", () => {
    const shared = read("ai-coding/adapters/_shared-canonical-block.md").trim();
    for (const path of ["AGENTS.md", "CLAUDE.md"]) {
      const bootloader = read(path);
      expect(managedBody(bootloader), path).toBe(shared);
      expect(bootloader, path).toContain("manual self-hosting mirror");
      expect(bootloader, path).not.toContain("regenerate with `aih bootstrap-ai`");
    }
  });

  it("does not expose a repository script or CI gate that self-applies AIH", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const projectScopedCli =
      /src\/cli\.ts\s+(?:bootstrap-ai|contract|adopt|doctor|truth|init|secrets|guardrails|docs-lint)\b/;

    expect(pkg.scripts["check:canon-drift"]).toBeUndefined();
    expect(pkg.scripts["check:self-hosting-canon"]).toContain(
      "tests/self-hosting/self-hosting.test.ts",
    );
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, name).not.toMatch(projectScopedCli);
    }

    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("npm run check:self-hosting-canon");
    expect(ci).not.toContain("npm run check:canon-drift");

    for (const path of ["CHANGELOG.md", "docs/CANON_GOVERNANCE.md"]) {
      const publicSurface = read(path);
      expect(publicSurface, path).toContain("check:self-hosting-canon");
      expect(publicSurface, path).not.toContain("check:canon-drift");
    }
  });

  it("runs the complete fallback suite behind fail-closed protected contexts", () => {
    const ci = read(".github/workflows/ci.yml");
    const workflow = parseYaml(ci) as {
      jobs: {
        full_verify: {
          if: string;
          env?: Record<string, string>;
          strategy: { matrix: { os: string[] } };
          steps: Array<{ if?: string; run?: string }>;
        };
        windows_full_tests: {
          if: string;
          name: string;
          strategy: { matrix: { shard: number[] } };
          "runs-on": string;
          steps: Array<{ if?: string; run?: string }>;
        };
        required_verify: {
          name: string;
          if: string;
          needs: string[];
          strategy: { matrix: { os: string[] } };
          steps: Array<{ env?: Record<string, string>; run?: string }>;
        };
      };
    };
    const full = workflow.jobs.full_verify;
    const windows = workflow.jobs.windows_full_tests;
    const aggregate = workflow.jobs.required_verify;

    expect(full.if).toContain("needs.classify.outputs.full_suite == 'true'");
    expect(full.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(full.env?.NODE_OPTIONS).toBeUndefined();
    expect(full.steps.map((step) => step.run)).toEqual(
      expect.arrayContaining([
        "npx vitest run --coverage --maxWorkers=2 --testTimeout=15000",
        "npx vitest run --shard=1/4",
        "npx vitest run --shard=2/4",
        "npx vitest run --shard=3/4",
        "npx vitest run --shard=4/4",
      ]),
    );
    expect(windows.name).toBe(`windows test (${githubExpression("matrix.shard")}/2)`);
    expect(windows.if).toContain("needs.classify.outputs.full_suite == 'true'");
    expect(windows.strategy.matrix.shard).toEqual([1, 2]);
    expect(windows["runs-on"]).toBe("windows-latest");
    expect(windows.steps.map((step) => step.run)).toContain(
      `npx vitest run --testTimeout=15000 --shard=${githubExpression("matrix.shard")}/2`,
    );
    expect(aggregate.name).toBe(`verify (${githubExpression("matrix.os")})`);
    expect(aggregate.if).toBe(githubExpression("always()"));
    expect(aggregate.strategy.matrix.os).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
    ]);
    expect(aggregate.needs).toContain("windows_full_tests");
    const gate = aggregate.steps.find((step) => step.run?.includes("require-ci-lane.mjs"));
    expect(gate?.env?.WINDOWS_RESULT).toBe(githubExpression("needs.windows_full_tests.result"));
    expect(gate?.run).toBe("node .github/scripts/require-ci-lane.mjs");
    for (const [name, job] of Object.entries({
      full_verify: full,
      windows_full_tests: windows,
      required_verify: aggregate,
    })) {
      expect(JSON.stringify(job), name).not.toContain("continue-on-error");
    }
  });

  it("keeps the manual contract mirror aligned with live repository facts", () => {
    const contract = JSON.parse(read("ai-coding/project.json")) as {
      description: string;
      targets: string[];
      languages: string[];
      entrypoints: string[];
      mcpServers: string[];
      knownGaps: string[];
      scale: { trackedFiles: number; class: string; isMonorepo: boolean };
      workspaces?: Record<string, { languages: string[]; packageManager?: string }>;
    };
    const markdown = read("ai-coding/project.md");
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean).length;
    const trackedSnapshot = contract.scale.trackedFiles;
    if (trackedSnapshot === undefined) throw new Error("tracked-file snapshot is required");
    const allowedSnapshotDrift = Math.max(1, Math.ceil(trackedSnapshot * 0.05));

    expect(contract.targets).toEqual(["claude", "codex"]);
    expect(contract.languages).toEqual(["TypeScript/Node.js"]);
    expect(contract.scale.class).toBe("medium");
    expect(contract.scale.isMonorepo).toBe(false);
    expect(Math.abs(trackedSnapshot - tracked)).toBeLessThanOrEqual(allowedSnapshotDrift);
    expect(contract.mcpServers).toEqual([]);
    expect(contract.knownGaps).toEqual([]);
    expect(contract.workspaces).toBeUndefined();
    expect(existsSync(resolve(root, ".mcp.json"))).toBe(false);

    expect(markdown.replace(/\s+/g, " ")).toContain(contract.description);
    expect(markdown).toContain(
      `- ${trackedSnapshot} tracked files (bounded snapshot) · ${contract.scale.class} · single-package repository`,
    );
    expect(read("ai-coding/SELF-HOSTING.md")).toContain(
      "The tracked-file count is a bounded informational snapshot",
    );
    expect(markdown).toContain("Auxiliary Python assets are not repository workspaces");
    for (const entrypoint of contract.entrypoints)
      expect(markdown).toContain(`- \`${entrypoint}\``);
    expect(markdown).toContain("_No root `.mcp.json` servers detected._");
    expect(markdown).toContain("_None — the contract is clean._");
  });

  it("keeps setup and adapters free of self-targeting AIH instructions", () => {
    for (const path of [
      "ai-coding/setup.md",
      "ai-coding/project.md",
      "ai-coding/adapters/claude.md",
      "ai-coding/adapters/codex.md",
    ]) {
      const text = read(path);
      expect(text, path).not.toMatch(
        /`aih\s+(?:init|bootstrap-ai|contract|adopt|doctor|truth|secrets|guardrails)\b/,
      );
      expect(text, path).not.toMatch(/`(?:npx\s+)?aih\b/);
    }
  });
});
