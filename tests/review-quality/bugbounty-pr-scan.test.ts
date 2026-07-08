import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface ScanFinding {
  severity: string;
  code: string;
  path: string;
  evidence: string;
}

interface ScanOutput {
  changedFiles: string[];
  findings: ScanFinding[];
}

const script = join(
  process.cwd(),
  "packs",
  "review-quality",
  "bugbounty-pr-scan",
  "scripts",
  "scan_ecc_pr.py",
);
const python = process.env.PYTHON ?? "python";
const TEST_PROCESS_TIMEOUT_MS = 15_000;

let repo: string | undefined;

afterEach(() => {
  if (repo !== undefined) {
    rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: TEST_PROCESS_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function currentRepo(): string {
  if (repo === undefined) {
    throw new Error("test repository was not initialized");
  }
  return repo;
}

function write(rel: string, body: string): void {
  const target = join(currentRepo(), rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

function initRepo(): void {
  repo = mkdtempSync(join(tmpdir(), "aih-bugbounty-pr-scan-"));
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "aih@example.invalid"], repo);
  run("git", ["config", "user.name", "AIH Test"], repo);
  run("git", ["commit", "--allow-empty", "-m", "base"], repo);
}

function commitHead(): void {
  const root = currentRepo();
  run("git", ["add", "."], root);
  run("git", ["commit", "-m", "head"], root);
}

function scan(): { status: number | null; stdout: string; output: ScanOutput } {
  const root = currentRepo();
  const result = spawnSync(python, [script, "--repo", root, "--base", "HEAD~1", "--head", "HEAD"], {
    encoding: "utf8",
    timeout: TEST_PROCESS_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    output: JSON.parse(result.stdout) as ScanOutput,
  };
}

function codes(output: ScanOutput): string[] {
  return output.findings.map((finding) => finding.code);
}

describe("bugbounty-pr-scan", () => {
  it("skips sensitive changed paths without reading their contents", () => {
    initRepo();
    write(".env", "SECRET_SENTINEL=do-not-read\n");
    write("secrets/token.md", "another-secret-sentinel\n");
    commitHead();

    const result = scan();

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("SECRET_SENTINEL");
    expect(result.stdout).not.toContain("another-secret-sentinel");
    expect(result.output.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "sensitive.skipped", path: ".env" }),
        expect.objectContaining({ code: "sensitive.skipped", path: "secrets/token.md" }),
      ]),
    );
  }, 20_000);

  it("flags unapproved and unpinned servers in generated .mcp.json", () => {
    initRepo();
    write(
      ".mcp.json",
      `${JSON.stringify({ mcpServers: { rogue: { command: "npx", args: ["-y", "mcp-rogue"] } } }, null, 2)}\n`,
    );
    commitHead();

    const result = scan();

    expect(result.status).toBe(1);
    expect(codes(result.output)).toEqual(
      expect.arrayContaining(["mcp.added-server", "mcp.unpinned-package"]),
    );
  }, 20_000);

  it("flags write-enabled reviewer agent configs without justification", () => {
    initRepo();
    write(".codex/agents/reviewer.toml", 'sandbox_mode = "workspace-write"\n');
    commitHead();

    const result = scan();

    expect(result.status).toBe(1);
    expect(result.output.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "agent.write-sandbox",
          path: ".codex/agents/reviewer.toml",
        }),
      ]),
    );
  }, 20_000);

  it("flags Codex-facing skill files outside the canonical skills subdirectory", () => {
    initRepo();
    write(".codex/review/SKILL.md", "# Review\n\nGenerated review workflow.\n");
    commitHead();

    const result = scan();

    expect(result.status).toBe(1);
    expect(result.output.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "skill.frontmatter-missing",
          path: ".codex/review/SKILL.md",
        }),
      ]),
    );
  }, 20_000);

  it("does not treat source-link test references as over-narrow workflow guidance", () => {
    initRepo();
    write("tests/workspace/manifest.test.ts", "test\n");
    write("tests/report/workspace-report.test.ts", "test\n");
    write("tests/secrets/secrets.test.ts", "test\n");
    run("git", ["add", "."], currentRepo());
    run("git", ["commit", "-m", "base tests"], currentRepo());
    write(
      "docs/workspace.md",
      [
        "## Source links",
        "",
        "- [`tests/workspace/manifest.test.ts`](../tests/workspace/manifest.test.ts)",
        "- [`tests/report/workspace-report.test.ts`](../tests/report/workspace-report.test.ts)",
      ].join("\n"),
    );
    commitHead();

    const result = scan();

    expect(result.status).toBe(0);
    expect(codes(result.output)).not.toContain("claim.over-narrow-tests");
  }, 20_000);

  it("flags generated workflow guidance that claims only two test areas are needed", () => {
    initRepo();
    write("tests/workspace/manifest.test.ts", "test\n");
    write("tests/report/workspace-report.test.ts", "test\n");
    write("tests/secrets/secrets.test.ts", "test\n");
    run("git", ["add", "."], currentRepo());
    run("git", ["commit", "-m", "base tests"], currentRepo());
    write(
      "docs/generated-workflow.md",
      "The generated workflow should only run tests/workspace and tests/report for this repo.\n",
    );
    commitHead();

    const result = scan();

    expect(codes(result.output)).toContain("claim.over-narrow-tests");
  }, 20_000);

  it("flags release gate guidance that omits npm run verify", () => {
    initRepo();
    write("docs/release.md", "Release gate: run npm test before publishing.\n");
    commitHead();

    const result = scan();

    expect(codes(result.output)).toContain("claim.verify-gate-missing");
  }, 20_000);
});
