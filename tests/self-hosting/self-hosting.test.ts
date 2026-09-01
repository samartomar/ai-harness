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

  it("shards the complete Windows suite behind the fail-closed required context", () => {
    const ci = read(".github/workflows/ci.yml");
    const workflow = parseYaml(ci) as {
      jobs: {
        verify: {
          env: Record<string, string>;
          strategy: { matrix: { os: string[] } };
        };
        windows_tests: {
          name: string;
          strategy: { matrix: { shard: number[] } };
          "runs-on": string;
          steps: Array<{ if?: string; run?: string }>;
        };
        windows_verify: {
          name: string;
          if: string;
          needs: string;
          steps: Array<{ env?: Record<string, string>; run?: string }>;
        };
      };
    };
    const windows = workflow.jobs.windows_tests;
    const aggregate = workflow.jobs.windows_verify;

    expect(workflow.jobs.verify.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(workflow.jobs.verify.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(windows.name).toBe(`windows test (${githubExpression("matrix.shard")}/2)`);
    expect(windows.strategy.matrix.shard).toEqual([1, 2]);
    expect(windows["runs-on"]).toBe("windows-latest");
    expect(windows.steps.map((step) => step.run)).toContain(
      `npx vitest run --testTimeout=15000 --shard=${githubExpression("matrix.shard")}/2`,
    );
    expect(windows.steps.filter((step) => step.if === "matrix.shard == 1")).toHaveLength(5);

    expect(aggregate.name).toBe("verify (windows-latest)");
    expect(aggregate.if).toBe(githubExpression("always()"));
    expect(aggregate.needs).toBe("windows_tests");
    expect(aggregate.steps[0]?.env?.WINDOWS_SHARDS_RESULT).toBe(
      githubExpression("needs.windows_tests.result"),
    );
    expect(aggregate.steps[0]?.run).toContain('if [ "$WINDOWS_SHARDS_RESULT" != "success" ]; then');
    expect(ci).not.toContain("continue-on-error:");
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

    expect(contract.targets).toEqual(["claude", "codex"]);
    expect(contract.languages).toEqual(["TypeScript/Node.js"]);
    expect(contract.scale).toEqual({ trackedFiles: tracked, class: "medium", isMonorepo: false });
    expect(contract.mcpServers).toEqual([]);
    expect(contract.knownGaps).toEqual([]);
    expect(contract.workspaces).toBeUndefined();
    expect(existsSync(resolve(root, ".mcp.json"))).toBe(false);

    expect(markdown.replace(/\s+/g, " ")).toContain(contract.description);
    expect(markdown).toContain(
      `- ${tracked} tracked files · ${contract.scale.class} · single-package repository`,
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
