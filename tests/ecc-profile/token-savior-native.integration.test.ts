import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NormalizedHookEvent,
  normalizeClaudeHookInput,
  normalizeCodexHookInput,
} from "../../src/ecc-profile/hook-core.js";
import {
  createFileTokenSaviorRetentionStore,
  createTokenSaviorCompactionAdapter,
  type TokenSaviorCompactResult,
} from "../../src/ecc-profile/token-savior.js";

const codexEntrypoint = process.env.AIH_CODEX_NATIVE_ENTRYPOINT;
const claudeExecutable = process.env.AIH_CLAUDE_NATIVE_EXECUTABLE;
const nativeEnabled = Boolean(codexEntrypoint && claudeExecutable);
const roots: string[] = [];
const originalText = "NATIVE_ORIGINAL_OUTPUT_MUST_NOT_REACH_THE_NEXT_MODEL_REQUEST";
const compactedText = "native compacted output";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function nativeEnvironment(
  inherited: NodeJS.ProcessEnv,
  home: string,
  additions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...additions,
  };
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]) {
    if (inherited[key] !== undefined) environment[key] = inherited[key];
  }
  if (environment.PATH === undefined && environment.Path !== undefined) {
    environment.PATH = environment.Path;
  }
  return environment;
}

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function boundedOutput(result: ChildResult): string {
  return `${result.stdout}\n${result.stderr}`.slice(0, 8_192);
}

function runChild(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(-64 * 1024);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.on("error", (error) => {
      stderr = append(stderr, Buffer.from(error.message, "utf8"));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin.end();
  });
}

function compactResult(): TokenSaviorCompactResult {
  return {
    text: compactedText,
    originalText,
    originalBytes: Buffer.byteLength(originalText),
    compactBytes: Buffer.byteLength(compactedText),
    savingsPercent: 100 * (1 - Buffer.byteLength(compactedText) / Buffer.byteLength(originalText)),
  };
}

function nativeEvent(client: "claude" | "codex", project: string): NormalizedHookEvent {
  const common = {
    session_id: "native-session",
    transcript_path: null,
    cwd: project,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: client === "codex" ? "shell_command" : "Bash",
    tool_use_id: "native-tool-use",
    tool_input: { command: "cat native-source.txt" },
  };
  return client === "claude"
    ? normalizeClaudeHookInput({
        ...common,
        prompt_id: "native-prompt",
        tool_response: {
          stdout: originalText,
          stderr: "",
          interrupted: false,
          isImage: false,
        },
      })
    : normalizeCodexHookInput({
        ...common,
        model: "native-test-model",
        turn_id: "native-turn",
        tool_response: originalText,
      });
}

async function nativeHookOutput(client: "claude" | "codex", project: string, state: string) {
  const result = await createTokenSaviorCompactionAdapter({
    canonicalWorktree: project,
    repositoryId: "native-probe/project",
    store: createFileTokenSaviorRetentionStore({
      stateRoot: state,
      canonicalWorktree: project,
      repositoryId: "native-probe/project",
    }),
    compact: async () => compactResult(),
    timeoutMs: 1_000,
  }).run(nativeEvent(client, project));
  expect(result.status).toBe("compacted");
  expect(result.originalRetained).toBe(true);
  expect(result.nativeOutput).toBeDefined();
  return result.nativeOutput;
}

function sse(events: readonly unknown[]): string {
  return events
    .map((event) => {
      const type = (event as { type: string }).type;
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

async function scriptedProvider(client: "claude" | "codex") {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) request.destroy(new Error("native request exceeded limit"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      requests.push(body);
      const index = requests.length;
      if (client === "codex") {
        const events =
          index === 1
            ? [
                { type: "response.created", response: { id: "resp-1" } },
                {
                  type: "response.output_item.done",
                  item: {
                    type: "function_call",
                    call_id: "native-call",
                    name: "shell_command",
                    arguments: JSON.stringify({ command: "cat native-source.txt" }),
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "resp-1",
                    usage: {
                      input_tokens: 0,
                      input_tokens_details: null,
                      output_tokens: 0,
                      output_tokens_details: null,
                      total_tokens: 0,
                    },
                  },
                },
              ]
            : [
                { type: "response.created", response: { id: "resp-2" } },
                {
                  type: "response.output_item.done",
                  item: {
                    type: "message",
                    role: "assistant",
                    id: "message-1",
                    content: [{ type: "output_text", text: "native probe complete" }],
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "resp-2",
                    usage: {
                      input_tokens: 0,
                      input_tokens_details: null,
                      output_tokens: 0,
                      output_tokens_details: null,
                      total_tokens: 0,
                    },
                  },
                },
              ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse(events));
        return;
      }
      const id = index === 1 ? "msg-1" : "msg-2";
      const events = [
        {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        index === 1
          ? {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "native-call",
                name: "Bash",
                input: {},
              },
            }
          : {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
        index === 1
          ? {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ command: "cat native-source.txt" }),
              },
            }
          : {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "native probe complete" },
            },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: {
            stop_reason: index === 1 ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse(events));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("native server failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const nativeHookFixture = fileURLToPath(
  new URL("./fixtures/token-savior-native-hook.cjs", import.meta.url),
);

describe.skipIf(!nativeEnabled)("installed native Token Savior transport qualification", () => {
  it.each(["claude", "codex"] as const)(
    "proves %s sends compacted feedback, not original tool bytes, to the next model request",
    async (client) => {
      const root = mkdtempSync(join(tmpdir(), `aih-token-savior-${client}-native-`));
      roots.push(root);
      const project = join(root, "project");
      const home = join(root, "home");
      const state = join(root, "state");
      mkdirSync(project);
      mkdirSync(home);
      mkdirSync(state);
      writeFileSync(join(project, "native-source.txt"), originalText, "utf8");
      const hookOutput = await nativeHookOutput(client, project, state);
      const hook = nativeHookFixture;
      const hookMarker = join(root, "hook-executed.txt");
      const hookEnvironment = {
        AIH_NATIVE_HOOK_MARKER: hookMarker,
        AIH_NATIVE_HOOK_OUTPUT_BASE64: Buffer.from(JSON.stringify(hookOutput), "utf8").toString(
          "base64",
        ),
      };
      const provider = await scriptedProvider(client);
      try {
        let result: ChildResult;
        if (client === "codex") {
          const codexHome = join(home, ".codex");
          mkdirSync(codexHome, { recursive: true });
          writeFileSync(
            join(codexHome, "config.toml"),
            [
              'model = "native-test-model"',
              'model_provider = "aih-native"',
              "[features]",
              "hooks = true",
              "[model_providers.aih-native]",
              'name = "AIH native fixture"',
              `base_url = "${provider.url}/v1"`,
              'env_key = "AIH_NATIVE_LOCAL_TOKEN"',
              'wire_api = "responses"',
              "",
            ].join("\n"),
            "utf8",
          );
          writeFileSync(
            join(codexHome, "hooks.json"),
            `${JSON.stringify({
              hooks: {
                PostToolUse: [
                  {
                    matcher: "^Bash$",
                    hooks: [
                      {
                        type: "command",
                        command: `node ${hook}`,
                      },
                    ],
                  },
                ],
              },
            })}\n`,
            "utf8",
          );
          result = await runChild(
            process.execPath,
            [
              codexEntrypoint ?? "",
              "--dangerously-bypass-hook-trust",
              "--strict-config",
              "--ask-for-approval",
              "never",
              "exec",
              "--skip-git-repo-check",
              "--sandbox",
              "read-only",
              "Use the shell exactly once to read native-source.txt, then finish.",
            ],
            {
              cwd: project,
              env: nativeEnvironment(process.env, home, {
                AIH_NATIVE_LOCAL_TOKEN: "local-fixture-only",
                ...hookEnvironment,
              }),
              timeoutMs: 60_000,
            },
          );
        } else {
          const settings = join(root, "claude-settings.json");
          const emptyMcp = join(root, "empty-mcp.json");
          writeFileSync(
            settings,
            `${JSON.stringify({
              hooks: {
                PostToolUse: [
                  {
                    matcher: "Bash",
                    hooks: [
                      {
                        type: "command",
                        command: `"${process.execPath}" "${hook}"`,
                      },
                    ],
                  },
                ],
              },
            })}\n`,
            "utf8",
          );
          writeFileSync(emptyMcp, '{"mcpServers":{}}\n', "utf8");
          result = await runChild(
            claudeExecutable ?? "",
            [
              "-p",
              "Use Bash exactly once to read native-source.txt, then finish.",
              "--output-format",
              "json",
              "--model",
              "sonnet",
              "--tools",
              "Bash",
              "--allowedTools",
              "Bash",
              "--dangerously-skip-permissions",
              "--settings",
              settings,
              "--setting-sources",
              "user",
              "--strict-mcp-config",
              "--mcp-config",
              emptyMcp,
            ],
            {
              cwd: project,
              env: nativeEnvironment(process.env, home, {
                ANTHROPIC_BASE_URL: provider.url,
                ANTHROPIC_AUTH_TOKEN: "local-fixture-only",
                ...hookEnvironment,
              }),
              timeoutMs: 60_000,
            },
          );
        }
        expect(result.status, boundedOutput(result)).toBe(0);
        expect(existsSync(hookMarker), boundedOutput(result)).toBe(true);
        expect(provider.requests).toHaveLength(2);
        const nextRequest = JSON.stringify(provider.requests[1]);
        expect(nextRequest).toContain(compactedText);
        expect(nextRequest).not.toContain(originalText);
      } finally {
        await provider.close();
      }
    },
    90_000,
  );
});

describe("native Token Savior probe environment", () => {
  it("does not inherit provider credentials or unrelated caller variables", () => {
    const environment = nativeEnvironment(
      {
        PATH: "fixture-path",
        SystemRoot: "fixture-system-root",
        OPENAI_API_KEY: "must-not-cross-boundary",
        ANTHROPIC_API_KEY: "must-not-cross-boundary",
        AWS_SECRET_ACCESS_KEY: "must-not-cross-boundary",
      },
      "fixture-home",
      {},
    );
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
