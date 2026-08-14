import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const validator = resolve(root, "tools/validate-snyk-agent-qualification.mjs");
const analyzer = "snyk-agent-scan@uv:0.5.17";
const completedPrefix =
  "Snyk Agent Scan completed with JSON output, --no-bootstrap, and no MCP auto-exec bypass. No findings != safe. Analyzers run: ";
const tempRoots: string[] = [];

function tempRoot(): string {
  const path = mkdtempSync(resolve(tmpdir(), "aih-snyk-validator-"));
  tempRoots.push(path);
  return path;
}

function githubEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "1",
    ...overrides,
  };
}

function report(check: Record<string, unknown>): Record<string, unknown> {
  return {
    capability: "trust scan",
    report: {
      ok: check.verdict !== "fail",
      checks: [check],
    },
    digests: [
      {
        describe: "trust runtime advisory",
        text: `No findings != safe. Static analyzers actually run: aih-native, ${analyzer}.`,
      },
    ],
  };
}

afterEach(() => {
  for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Snyk Agent Scan qualification validator", () => {
  it("emits only commit-bound sanitized evidence for one exact passing Snyk check", () => {
    const temp = tempRoot();
    const input = resolve(temp, "result.json");
    const output = resolve(temp, "summary.json");
    writeFileSync(
      input,
      JSON.stringify(
        report({
          name: "trust detector snyk-agent-scan",
          verdict: "pass",
          detail: `${completedPrefix}aih-native, ${analyzer}`,
        }),
      ),
    );

    execFileSync(process.execPath, [validator, input, output], {
      cwd: root,
      env: githubEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const summary = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
    expect(summary).toMatchObject({
      schemaVersion: 1,
      commit: "a".repeat(40),
      workflowRunId: "123456",
      workflowRunAttempt: "1",
      analyzer,
      target: "synthetic-skill-fixture",
      status: "qualified",
    });
    expect(summary.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(summary)).not.toContain(completedPrefix);
  });

  it("rejects an unavailable check even when its detail contains every magic string", () => {
    const temp = tempRoot();
    const input = resolve(temp, "result.json");
    const output = resolve(temp, "summary.json");
    writeFileSync(
      input,
      JSON.stringify(
        report({
          name: "trust detector snyk-agent-scan",
          verdict: "skip",
          code: "trust.detector-unavailable",
          detail: `scanner error quoted ${completedPrefix}aih-native, ${analyzer}`,
        }),
      ),
    );

    const result = spawnSync(process.execPath, [validator, input, output], {
      cwd: root,
      env: githubEnv(),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exactly one passing Snyk detector check");
    expect(existsSync(output)).toBe(false);
  });

  it("rejects missing GitHub run identities instead of writing unknown placeholders", () => {
    const temp = tempRoot();
    const input = resolve(temp, "result.json");
    const output = resolve(temp, "summary.json");
    writeFileSync(
      input,
      JSON.stringify(
        report({
          name: "trust detector snyk-agent-scan",
          verdict: "pass",
          detail: `${completedPrefix}aih-native, ${analyzer}`,
        }),
      ),
    );

    const result = spawnSync(process.execPath, [validator, input, output], {
      cwd: root,
      env: githubEnv({ GITHUB_RUN_ID: "", GITHUB_RUN_ATTEMPT: "" }),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GitHub run identity is invalid");
    expect(existsSync(output)).toBe(false);
  });
});
