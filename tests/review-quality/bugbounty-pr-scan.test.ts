import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticGitEnv } from "../git-fixture-env.js";

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
// A correct run finishes in well under a second, so this budget exists to stop a
// hang, not to police latency. It was 15s, and the FIRST python spawn on a
// windows-latest runner exceeded it once (2026-08-06, PR #620) while the other
// six spawns in this file — same interpreter, same script — passed: interpreter
// cold start, not a slow scan. Raising it costs nothing on a healthy run and
// removes a failure mode that says nothing about the code under test.
const TEST_PROCESS_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTIC_BYTES = 2_000;

function bounded(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "<empty>";
  return value.length > MAX_DIAGNOSTIC_BYTES
    ? `${value.slice(0, MAX_DIAGNOSTIC_BYTES)}… <truncated ${value.length - MAX_DIAGNOSTIC_BYTES} bytes>`
    : value;
}

/**
 * Describes why a spawn did not cleanly succeed, or `undefined` when it did.
 *
 * Callers must consult this BEFORE parsing stdout. `spawnSync` reports a timeout
 * as an `ETIMEDOUT` error with a null status, so `status` alone cannot tell
 * "timed out" apart from "never started" — and a caller that goes straight to
 * `JSON.parse` reports either one as a JSON syntax error, discarding the child's
 * stderr along with the actual cause.
 *
 * `requireCleanExit` is false for the scanner itself, which exits 1 BY DESIGN
 * when it reports findings; there, a non-zero status is the result, not a
 * failure. It stays true for the git fixture commands, where it is a failure.
 */
function spawnFailure(
  label: string,
  result: SpawnSyncReturns<string>,
  options: { readonly requireCleanExit?: boolean } = {},
): string | undefined {
  const detail = `stdout: ${bounded(result.stdout)}\nstderr: ${bounded(result.stderr)}`;
  if (result.error !== undefined) {
    const signal = result.signal === null ? "" : ` (signal ${result.signal})`;
    return `${label} did not complete: ${result.error.message}${signal}\n${detail}`;
  }
  if (result.status === null) {
    return `${label} produced no exit status (signal ${result.signal})\n${detail}`;
  }
  if (options.requireCleanExit !== false && result.status !== 0) {
    return `${label} exited with status ${result.status}\n${detail}`;
  }
  return undefined;
}

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
    env: hermeticGitEnv(),
  });
  const failure = spawnFailure(`${command} ${args.join(" ")}`, result);
  if (failure !== undefined) throw new Error(failure);
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
    env: hermeticGitEnv(),
  });
  const label = `${python} ${script}`;
  const failure = spawnFailure(label, result, { requireCleanExit: false });
  if (failure !== undefined) throw new Error(failure);
  if (result.stdout.trim().length === 0) {
    throw new Error(`${label} exited 0 without emitting a scan payload\n${bounded(result.stderr)}`);
  }
  let output: ScanOutput;
  try {
    output = JSON.parse(result.stdout) as ScanOutput;
  } catch (error) {
    // Reaching here now means the payload genuinely is malformed, so show it.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} emitted a payload that is not JSON: ${reason}
stdout: ${bounded(result.stdout)}`);
  }
  return { status: result.status, stdout: result.stdout, output };
}

function codes(output: ScanOutput): string[] {
  return output.findings.map((finding) => finding.code);
}

function syntheticResult(
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

describe("spawn diagnostics", () => {
  // A timed-out scan used to surface as "SyntaxError: Unexpected end of JSON
  // input" from JSON.parse, which names neither the timeout nor the child's
  // stderr and sends the reader hunting for a malformed payload.
  it("names a timeout rather than the empty stdout it leaves behind", () => {
    const failure = spawnFailure(
      "python scan_ecc_pr.py",
      syntheticResult({
        status: null,
        signal: "SIGTERM",
        error: new Error("spawnSync python ETIMEDOUT"),
      }),
    );

    expect(failure).toContain("did not complete");
    expect(failure).toContain("ETIMEDOUT");
    expect(failure).toContain("SIGTERM");
  });

  it("names a non-zero exit and carries the child's stderr", () => {
    const failure = spawnFailure(
      "python scan_ecc_pr.py",
      syntheticResult({ status: 2, stderr: "Traceback: boom\n" }),
    );

    expect(failure).toContain("status 2");
    expect(failure).toContain("Traceback: boom");
  });

  it("bounds a runaway stderr so a failure cannot flood the report", () => {
    const failure = spawnFailure(
      "python scan_ecc_pr.py",
      syntheticResult({ status: 1, stderr: "x".repeat(MAX_DIAGNOSTIC_BYTES * 3) }),
    );

    expect(failure).toContain("truncated");
    expect(failure?.length).toBeLessThan(MAX_DIAGNOSTIC_BYTES * 3);
  });

  it("stays silent on a clean run so callers only throw on real failures", () => {
    expect(
      spawnFailure("python scan_ecc_pr.py", syntheticResult({ stdout: "{}" })),
    ).toBeUndefined();
  });

  // The scanner exits 1 when it reports findings, which is the outcome most of
  // this file asserts on. Treating that as a spawn failure would fail every
  // finding case, so the scanner opts out of the clean-exit requirement.
  it("accepts the scanner's by-design non-zero exit when it carries a payload", () => {
    const failure = spawnFailure(
      "python scan_ecc_pr.py",
      syntheticResult({ status: 1, stdout: '{"findings":[]}' }),
      { requireCleanExit: false },
    );

    expect(failure).toBeUndefined();
  });

  it("still rejects a signal kill even when a non-zero exit is allowed", () => {
    const failure = spawnFailure(
      "python scan_ecc_pr.py",
      syntheticResult({ status: null, signal: "SIGKILL" }),
      { requireCleanExit: false },
    );

    expect(failure).toContain("no exit status");
    expect(failure).toContain("SIGKILL");
  });
});

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
