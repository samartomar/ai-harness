import { EventEmitter } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SERENA_DEPENDENCY_LOCK_SHA256 } from "../../src/ecc-profile/native-registration.js";
import { executeNativeEccHook } from "../../src/ecc-profile/native-runtime.js";
import { runNativeEccRuntime } from "../../src/ecc-profile/native-runtime-cli.js";
import { buildProgram } from "../../src/program.js";

const roots: string[] = [];
const serenaRuntimeRoot = fileURLToPath(
  new URL("../../src/ecc-profile/serena-runtime", import.meta.url),
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  // macOS exposes /var as a system alias; production registration stores canonical paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-ecc-native-runtime-project-")));
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "aih-ecc-native-runtime-state-")));
  roots.push(root, stateRoot);
  mkdirSync(join(stateRoot, "continuity"));
  return { root, stateRoot };
}

describe("native ECC hook runtime", () => {
  it("returns a client-native deny for repository-protection decisions", async () => {
    const scope = fixture();
    const output = await executeNativeEccHook({
      client: "claude",
      root: scope.root,
      stateRoot: scope.stateRoot,
      input: {
        session_id: "session-1",
        transcript_path: join(scope.stateRoot, "transcript.jsonl"),
        cwd: scope.root,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "git commit --no-verify" },
      },
    });

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "repository protection blocks Git verification bypass and hooksPath overrides",
      },
    });
  });

  it("emits bounded native additional context without exposing internal receipts", async () => {
    const scope = fixture();
    const probed: string[] = [];
    const output = await executeNativeEccHook({
      client: "codex",
      root: scope.root,
      stateRoot: scope.stateRoot,
      mcpHealthProbe: async (id) => {
        probed.push(id);
        return { ok: id !== "serena" };
      },
      input: {
        session_id: "session-2",
        transcript_path: join(scope.stateRoot, "transcript.jsonl"),
        cwd: scope.root,
        permission_mode: "default",
        hook_event_name: "SessionStart",
        source: "startup",
      },
    });
    expect(probed).toEqual(["code-review-graph", "codebase-memory-mcp", "context7", "serena"]);
    expect(JSON.stringify(output)).toContain("MCP serena unavailable");
    expect(JSON.stringify(output)).not.toContain("receipts");
    expect(
      Object.keys(output).every((key) =>
        ["hookSpecificOutput", "continue", "stopReason"].includes(key),
      ),
    ).toBe(true);
  });

  it("keeps hookSpecificOutput off Claude events that reject it", async () => {
    const scope = fixture();
    const output = await executeNativeEccHook({
      client: "claude",
      root: scope.root,
      stateRoot: scope.stateRoot,
      input: {
        session_id: "session-precompact",
        transcript_path: join(scope.stateRoot, "transcript.jsonl"),
        cwd: scope.root,
        permission_mode: "default",
        hook_event_name: "PreCompact",
        trigger: "manual",
        custom_instructions: "",
      },
    });

    // Claude validates hookSpecificOutput against a per-event allowlist and
    // discards the whole payload when an event is not on it. PreCompact is not,
    // so the continuity summary has to travel as a root-level systemMessage.
    expect(output.hookSpecificOutput).toBeUndefined();
    expect(output.systemMessage).toContain("Before compaction, preserve decisions");
  });

  it("denies a Claude PermissionRequest through the root-level decision", async () => {
    const scope = fixture();
    const output = await executeNativeEccHook({
      client: "claude",
      root: scope.root,
      stateRoot: scope.stateRoot,
      input: {
        session_id: "session-permission",
        transcript_path: join(scope.stateRoot, "transcript.jsonl"),
        cwd: scope.root,
        permission_mode: "default",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "git commit --no-verify" },
      },
    });

    expect(output.hookSpecificOutput).toBeUndefined();
    expect(output.permissionDecision).toBe("deny");
    expect(output.reason).toBe(
      "repository protection blocks Git verification bypass and hooksPath overrides",
    );
  });

  it("rejects a foreign project root and an in-project state directory", async () => {
    const scope = fixture();
    const foreign = mkdtempSync(join(tmpdir(), "aih-ecc-native-runtime-foreign-"));
    roots.push(foreign);
    const input = {
      session_id: "session-3",
      transcript_path: join(scope.stateRoot, "transcript.jsonl"),
      cwd: foreign,
      permission_mode: "default",
      hook_event_name: "SessionStart",
      source: "startup",
    };
    await expect(
      executeNativeEccHook({
        client: "claude",
        root: scope.root,
        stateRoot: scope.stateRoot,
        input,
      }),
    ).rejects.toThrow(/foreign|root|cwd/i);
    await expect(
      executeNativeEccHook({
        client: "claude",
        root: scope.root,
        stateRoot: join(scope.root, ".aih"),
        input: { ...input, cwd: scope.root },
      }),
    ).rejects.toThrow(/state.*outside/i);
  });

  it("keeps the runtime outside the public command contract while dispatching bounded hook stdin", async () => {
    expect(buildProgram().helpInformation()).not.toContain("ecc-runtime");
    expect(buildProgram().commands.map((command) => command.name())).not.toContain("ecc-runtime");
    const scope = fixture();
    const stdout = new PassThrough();
    let rendered = "";
    stdout.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const exit = await runNativeEccRuntime(
      ["hook", "--client", "codex", "--root", scope.root, "--state-root", scope.stateRoot],
      {
        stdin: Readable.from([
          JSON.stringify({
            session_id: "session-cli",
            transcript_path: join(scope.stateRoot, "transcript.jsonl"),
            cwd: scope.root,
            permission_mode: "default",
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_use_id: "tool-cli",
            tool_input: { command: "git -c core.hooksPath=NUL commit" },
            turn_id: "turn-cli",
          }),
        ]),
        stdout,
      },
    );
    expect(exit).toBe(0);
    expect(JSON.parse(rendered).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("rejects malformed internal runtime modes, options, clients, and hook input", async () => {
    const scope = fixture();
    await expect(runNativeEccRuntime(["unknown"], { stdin: Readable.from([]) })).rejects.toThrow(
      /mode must be hook or serena/i,
    );
    await expect(
      runNativeEccRuntime(["hook", "--client", "codex", "--client", "claude"], {
        stdin: Readable.from([]),
      }),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      runNativeEccRuntime(["hook", "client-without-option-prefix"], {
        stdin: Readable.from([]),
      }),
    ).rejects.toThrow(/explicit option\/value pairs/i);
    await expect(
      runNativeEccRuntime(
        [
          "hook",
          "--client",
          "codex",
          "--root",
          scope.root,
          "--state-root",
          scope.stateRoot,
          "--extra",
          "value",
        ],
        { stdin: Readable.from([]) },
      ),
    ).rejects.toThrow(/invalid ECC runtime options/i);
    await expect(
      runNativeEccRuntime(
        ["hook", "--client", "unsupported", "--root", scope.root, "--state-root", scope.stateRoot],
        { stdin: Readable.from([]) },
      ),
    ).rejects.toThrow(/client must be claude or codex/i);
    await expect(
      runNativeEccRuntime(
        ["hook", "--client", "codex", "--root", scope.root, "--state-root", scope.stateRoot],
        { stdin: Readable.from([Buffer.alloc(1024 * 1024 + 1, "x")]) },
      ),
    ).rejects.toThrow(/stdin exceeds its byte limit/i);
    await expect(
      runNativeEccRuntime(
        ["hook", "--client", "codex", "--root", scope.root, "--state-root", scope.stateRoot],
        { stdin: Readable.from(["not-json"]) },
      ),
    ).rejects.toThrow(/stdin is not valid JSON/i);

    const serenaArgs = [
      "serena",
      "--package",
      "wrong-package",
      "--dependency-lock-sha256",
      SERENA_DEPENDENCY_LOCK_SHA256,
      "--lock-root",
      serenaRuntimeRoot,
      "--context",
      "codex",
      "--mode",
      "no-memories",
      "--project",
      scope.root,
    ];
    await expect(
      runNativeEccRuntime(serenaArgs, {
        stdin: Readable.from([]),
        env: { SERENA_HOME: scope.stateRoot },
      }),
    ).rejects.toThrow(/package pin is not accepted/i);
    await expect(
      runNativeEccRuntime(
        serenaArgs.map((value) => (value === "wrong-package" ? "serena-agent==1.7.0" : value)),
        { stdin: Readable.from([]), env: {} },
      ),
    ).rejects.toThrow(/SERENA_HOME.*absolute/i);
    await expect(
      runNativeEccRuntime(
        serenaArgs
          .map((value) => (value === "wrong-package" ? "serena-agent==1.7.0" : value))
          .map((value) => (value === SERENA_DEPENDENCY_LOCK_SHA256 ? "0".repeat(64) : value)),
        { stdin: Readable.from([]), env: { SERENA_HOME: scope.stateRoot } },
      ),
    ).rejects.toThrow(/dependency lock is not accepted/i);
    await expect(
      runNativeEccRuntime(
        serenaArgs.map((value) =>
          value === "wrong-package"
            ? "serena-agent==1.7.0"
            : value === "codex"
              ? "unsupported-context"
              : value,
        ),
        { stdin: Readable.from([]), env: { SERENA_HOME: scope.stateRoot } },
      ),
    ).rejects.toThrow(/context is not accepted/i);
    await expect(
      runNativeEccRuntime(
        serenaArgs
          .map((value) => (value === "wrong-package" ? "serena-agent==1.7.0" : value))
          .map((value) => (value === "no-memories" ? "memory-enabled" : value)),
        { stdin: Readable.from([]), env: { SERENA_HOME: join(scope.stateRoot, "serena") } },
      ),
    ).rejects.toThrow(/mode is not accepted/i);

    const projectFile = join(scope.stateRoot, "not-a-project");
    writeFileSync(projectFile, "fixture\n");
    await expect(
      runNativeEccRuntime(
        serenaArgs
          .map((value) => (value === "wrong-package" ? "serena-agent==1.7.0" : value))
          .map((value) => (value === scope.root ? projectFile : value)),
        { stdin: Readable.from([]), env: { SERENA_HOME: join(scope.stateRoot, "serena") } },
      ),
    ).rejects.toThrow(/project must be a real directory/i);

    const serenaHome = join(scope.stateRoot, "conflicting-serena");
    mkdirSync(serenaHome);
    writeFileSync(join(serenaHome, "serena_config.yml"), "operator-owned: true\n");
    await expect(
      runNativeEccRuntime(
        serenaArgs.map((value) => (value === "wrong-package" ? "serena-agent==1.7.0" : value)),
        { stdin: Readable.from([]), env: { SERENA_HOME: serenaHome } },
      ),
    ).rejects.toThrow(/config conflicts/i);
  });

  it("fails closed on inaccessible event roots and reports indeterminate MCP health honestly", async () => {
    const scope = fixture();
    const missing = join(scope.root, "missing-event-root");
    await expect(
      executeNativeEccHook({
        client: "codex",
        root: scope.root,
        stateRoot: scope.stateRoot,
        input: {
          session_id: "session-missing-root",
          transcript_path: join(scope.stateRoot, "transcript.jsonl"),
          cwd: missing,
          permission_mode: "default",
          hook_event_name: "SessionStart",
          source: "startup",
        },
      }),
    ).rejects.toThrow(/event cwd is not an accessible project root/i);

    const output = await executeNativeEccHook({
      client: "codex",
      root: scope.root,
      stateRoot: scope.stateRoot,
      input: {
        session_id: "session-default-health",
        transcript_path: join(scope.stateRoot, "transcript.jsonl"),
        cwd: scope.root,
        permission_mode: "default",
        hook_event_name: "SessionStart",
        source: "startup",
      },
    });
    expect(JSON.stringify(output)).toContain("MCP serena unavailable");
  });

  it("runs the exact offline Serena pin behind the protocol guard with provider credentials scrubbed", async () => {
    const scope = fixture();
    const serenaHome = join(scope.stateRoot, "serena");
    const clientInput = [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: {} } },
    ];
    const stdin = Readable.from(clientInput.map((value) => `${JSON.stringify(value)}\n`));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let rendered = "";
    stdout.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    let spawnArgs: readonly string[] = [];
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    const spawnProcess = ((
      _command: string,
      args: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      spawnArgs = args;
      spawnEnv = options.env;
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      child.stdin.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString()) as { id: number; method: string };
        if (request.method === "tools/list") {
          child.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                tools: [
                  "get_symbols_overview",
                  "find_symbol",
                  "find_referencing_symbols",
                  "find_implementations",
                  "read_file",
                ].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
              },
            })}\n`,
          );
        }
      });
      child.stdin.on("finish", () => {
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("exit", 0, null));
      });
      return child;
    }) as never;

    const exit = await runNativeEccRuntime(
      [
        "serena",
        "--package",
        "serena-agent==1.7.0",
        "--dependency-lock-sha256",
        SERENA_DEPENDENCY_LOCK_SHA256,
        "--lock-root",
        serenaRuntimeRoot,
        "--context",
        "codex",
        "--mode",
        "no-memories",
        "--project",
        scope.root,
      ],
      {
        stdin,
        stdout,
        stderr,
        env: {
          SERENA_HOME: serenaHome,
          OPENAI_API_KEY: "must-not-pass",
          NPM_TOKEN: "must-not-pass",
          DATABASE_URL: "must-not-pass",
          SSH_AUTH_SOCK: "must-not-pass",
          PATH: "fixture-path",
        },
        spawnProcess,
      },
    );
    expect(exit).toBe(0);
    expect(spawnArgs.slice(0, 5)).toEqual([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--frozen",
      "--project",
    ]);
    expect(spawnArgs[5]).toBe(realpathSync(serenaRuntimeRoot));
    expect(spawnArgs).toContain("serena");
    expect(spawnEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(spawnEnv?.NPM_TOKEN).toBeUndefined();
    expect(spawnEnv?.DATABASE_URL).toBeUndefined();
    expect(spawnEnv?.SSH_AUTH_SOCK).toBeUndefined();
    expect(spawnEnv?.PATH).toBe("fixture-path");
    expect(spawnEnv?.SERENA_USAGE_REPORTING).toBe("false");
    const messages = rendered
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages
        .find((message) => message.id === 1)
        ?.result.tools.map((tool: { name: string }) => tool.name),
    ).not.toContain("read_file");
    expect(messages.find((message) => message.id === 2)?.error.code).toBe(-32601);
  });

  it("rejects modified packaged Serena lock bytes before spawning the runtime", async () => {
    const scope = fixture();
    const lockRoot = join(scope.stateRoot, "tampered-lock");
    mkdirSync(lockRoot);
    copyFileSync(join(serenaRuntimeRoot, "pyproject.toml"), join(lockRoot, "pyproject.toml"));
    copyFileSync(join(serenaRuntimeRoot, "uv.lock"), join(lockRoot, "uv.lock"));
    writeFileSync(join(lockRoot, "uv.lock"), "forged dependency closure\n");
    let spawned = false;

    await expect(
      runNativeEccRuntime(
        [
          "serena",
          "--package",
          "serena-agent==1.7.0",
          "--dependency-lock-sha256",
          SERENA_DEPENDENCY_LOCK_SHA256,
          "--lock-root",
          lockRoot,
          "--context",
          "codex",
          "--mode",
          "no-memories",
          "--project",
          scope.root,
        ],
        {
          stdin: Readable.from([]),
          env: { SERENA_HOME: join(scope.stateRoot, "serena") },
          spawnProcess: (() => {
            spawned = true;
            throw new Error("must not spawn");
          }) as never,
        },
      ),
    ).rejects.toThrow(/uv\.lock failed authentication/i);
    expect(spawned).toBe(false);
  });

  it("rejects Serena roots that are relative, linked, or overlap project state", async () => {
    const scope = fixture();
    const args = [
      "serena",
      "--package",
      "serena-agent==1.7.0",
      "--dependency-lock-sha256",
      SERENA_DEPENDENCY_LOCK_SHA256,
      "--lock-root",
      serenaRuntimeRoot,
      "--context",
      "codex",
      "--mode",
      "no-memories",
      "--project",
      "relative-project",
    ];
    await expect(
      runNativeEccRuntime(args, {
        stdin: Readable.from([]),
        env: { SERENA_HOME: join(scope.stateRoot, "serena") },
      }),
    ).rejects.toThrow(/project.*absolute/i);

    await expect(
      runNativeEccRuntime([...args.slice(0, -1), scope.root], {
        stdin: Readable.from([]),
        env: { SERENA_HOME: join(scope.root, ".serena") },
      }),
    ).rejects.toThrow(/SERENA_HOME.*outside/i);
  });
});
