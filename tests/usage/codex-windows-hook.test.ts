import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { usageRecorderScript } from "../../src/usage/capture.js";
import { usageHookActions } from "../../src/usage/hooks.js";

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
  ]) {
    delete env[name];
  }
  return env;
}

function context(root: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "windows", run, env: {} }),
    env: {},
    options: {},
  };
}

function generatedWindowsCommand(root: string): string {
  const action = usageHookActions(context(root), ["codex"]).find(
    (candidate): candidate is WriteAction =>
      candidate.kind === "write" && candidate.path === ".codex/hooks.json",
  );
  if (action?.json === undefined) throw new Error("Codex usage hook was not generated");
  const payload = action.json as {
    hooks: { PostToolUse: Array<{ hooks: Array<{ commandWindows: string }> }> };
  };
  const command = payload.hooks.PostToolUse[0]?.hooks[0]?.commandWindows;
  if (typeof command !== "string") throw new Error("Codex Windows usage hook was not generated");
  return command;
}

function runPowerShell(command: string, cwd: string, input: string) {
  return spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    cwd,
    env: gitEnvironment(),
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
}

function runCmd(command: string, cwd: string, input: string) {
  const script = join(cwd, "codex-usage-hook.cmd");
  writeFileSync(script, `@${command}\r\n`);
  return spawnSync("cmd.exe", ["/d", "/c", script], {
    cwd,
    env: gitEnvironment(),
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
}

windowsDescribe("Codex Windows usage hook", () => {
  it("runs through PowerShell from a nested path with spaces and records stdin at the Git root", () => {
    const root = mkdtempSync(join(tmpdir(), "aih codex hook "));
    roots.push(root);
    execFileSync("git", ["init", "-q", root], { env: gitEnvironment(), windowsHide: true });
    mkdirSync(join(root, ".aih"));
    writeFileSync(join(root, ".aih", "usage-record.mjs"), usageRecorderScript());
    const nested = join(root, "nested folder", "child");
    mkdirSync(nested, { recursive: true });

    const result = runPowerShell(
      generatedWindowsCommand(root),
      nested,
      JSON.stringify({ tool_name: "shell_command", tool_input: { command: "git status" } }),
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const rows = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "codex", kind: "tool", name: "shell_command" });
    expect(existsSync(join(nested, ".aih", "usage.jsonl"))).toBe(false);
  });

  it("fails closed outside Git without executing a cwd-relative recorder", () => {
    const root = mkdtempSync(join(tmpdir(), "aih codex hook outside "));
    roots.push(root);
    mkdirSync(join(root, ".aih"));
    const sentinel = join(root, "escaped.txt");
    writeFileSync(
      join(root, ".aih", "usage-record.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "escaped");\n`,
    );

    const result = runPowerShell(generatedWindowsCommand(root), root, "{}\n");

    expect(result.status).not.toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(root, ".aih", "usage.jsonl"))).toBe(false);
  });

  it("also runs the same Windows launcher through cmd.exe", () => {
    const root = mkdtempSync(join(tmpdir(), "aih codex cmd hook "));
    roots.push(root);
    execFileSync("git", ["init", "-q", root], { env: gitEnvironment(), windowsHide: true });
    mkdirSync(join(root, ".aih"));
    writeFileSync(join(root, ".aih", "usage-record.mjs"), usageRecorderScript());

    const result = runCmd(
      generatedWindowsCommand(root),
      root,
      JSON.stringify({ tool_name: "read_file", tool_input: { path: "README.md" } }),
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".aih", "usage.jsonl"), "utf8"))).toMatchObject({
      tool: "codex",
      kind: "tool",
      name: "read_file",
    });
  });
});
