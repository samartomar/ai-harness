import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readRegularFile } from "../internals/fsxn.js";
import { HOOK_INPUT_LIMITS, type HookClient } from "./hook-core.js";
import { renderSerenaConfig, SERENA_RUNTIME_PIN, SerenaMcpPolicyGuard } from "./mcp-profile.js";
import { SERENA_DEPENDENCY_LOCK_SHA256 } from "./native-registration.js";
import { executeNativeEccHook, prepareOwnedStateDirectory } from "./native-runtime.js";

const MAX_MCP_LINE_BYTES = 1024 * 1024;

export interface NativeRuntimeIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

function optionMap(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("ECC runtime arguments must be explicit option/value pairs");
    }
    if (values.has(key)) throw new Error(`duplicate ECC runtime option: ${key}`);
    values.set(key, value);
  }
  return values;
}

function exactOptions(values: Map<string, string>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  const unknown = [...values.keys()].filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !values.has(key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `invalid ECC runtime options (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

async function readBoundedJson(stream: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > HOOK_INPUT_LIMITS.maxBytes)
      throw new Error("native hook stdin exceeds its byte limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("native hook stdin is not valid JSON");
  }
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function canonicalProject(value: string): string {
  if (!isAbsolute(value)) throw new Error("Serena project must be absolute");
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Serena project must be a real directory");
  }
  return realpathSync(value);
}

function safeSerenaHome(env: NodeJS.ProcessEnv, project: string): string {
  const value = env.SERENA_HOME;
  if (typeof value !== "string" || value.length === 0 || !/^(?:[A-Za-z]:[\\/]|\/)/u.test(value)) {
    throw new Error("SERENA_HOME must be an absolute isolated state directory");
  }
  const destination = resolve(value);
  if (containsPath(project, destination) || containsPath(destination, project)) {
    throw new Error("SERENA_HOME must remain outside the Serena project");
  }
  const home = prepareOwnedStateDirectory(value, "SERENA_HOME");
  const stats = lstatSync(home);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("SERENA_HOME must be a real directory");
  if (containsPath(project, home) || containsPath(home, project)) {
    throw new Error("SERENA_HOME must remain outside the Serena project");
  }
  const configPath = join(home, "serena_config.yml");
  const expected = renderSerenaConfig();
  const existing = readRegularFile(configPath, { maxBytes: 128 * 1024 });
  if (existing === undefined)
    writeFileSync(configPath, expected, { encoding: "utf8", flag: "wx", mode: 0o600 });
  else if (existing.toString("utf8") !== expected)
    throw new Error("Serena config conflicts with the AIH-owned hardened profile");
  return home;
}

function isolatedSerenaEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
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
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "UV_CACHE_DIR",
    "SERENA_HOME",
  ]) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  if (next.PATH === undefined && next.Path !== undefined) next.PATH = next.Path;
  next.UV_OFFLINE = "1";
  next.UV_NO_ENV_FILE = "1";
  next.SERENA_USAGE_REPORTING = "false";
  return next;
}

function idKey(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? `${typeof value}:${value}`
    : undefined;
}

function transformLines(
  source: NodeJS.ReadableStream,
  onValue: (value: unknown, raw: string) => string | undefined,
  onError: (error: Error) => void,
): void {
  let buffer = "";
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_MCP_LINE_BYTES) {
      onError(new Error("Serena MCP frame exceeds its byte limit"));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (raw.length === 0) continue;
      try {
        const next = onValue(JSON.parse(raw), raw);
        if (next !== undefined) source.emit("aih-line", next);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  source.on("end", () => {
    if (buffer.trim().length > 0)
      onError(new Error("Serena MCP stream ended with a partial frame"));
  });
}

async function proxySerena(
  child: ChildProcessWithoutNullStreams,
  io: Required<Pick<NativeRuntimeIo, "stdin" | "stdout" | "stderr">>,
): Promise<number> {
  const guard = new SerenaMcpPolicyGuard();
  const toolsList = new Set<string>();
  let failed: Error | undefined;
  const fail = (error: Error) => {
    failed ??= error;
    child.kill();
  };
  transformLines(
    io.stdin,
    (value, raw) => {
      const record = value as { id?: unknown; method?: unknown };
      if (record.method === "tools/list") {
        const key = idKey(record.id);
        if (key !== undefined) toolsList.add(key);
      }
      const decision = guard.inspectClientRequest(value);
      if (!decision.forward) {
        io.stdout.write(`${JSON.stringify(decision.response)}\n`);
        return undefined;
      }
      return raw;
    },
    fail,
  );
  io.stdin.on("aih-line", (line: string) => child.stdin.write(`${line}\n`));
  io.stdin.on("end", () => child.stdin.end());
  transformLines(
    child.stdout,
    (value, raw) => {
      const record = value as { id?: unknown; result?: unknown };
      const key = idKey(record.id);
      if (key !== undefined && toolsList.delete(key) && record.result !== undefined) {
        return JSON.stringify({ ...record, result: guard.filterToolsList(record.result) });
      }
      return raw;
    },
    fail,
  );
  child.stdout.on("aih-line", (line: string) => io.stdout.write(`${line}\n`));
  child.stderr.on("data", (chunk) => io.stderr.write(chunk));
  const exit = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  if (failed) throw failed;
  return exit;
}

export async function runNativeEccRuntime(
  argv: readonly string[],
  io: NativeRuntimeIo = {},
): Promise<number> {
  const [mode, ...rest] = argv;
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  if (mode === "hook") {
    const options = optionMap(rest);
    exactOptions(options, ["--client", "--root", "--state-root"]);
    const client = options.get("--client");
    if (client !== "claude" && client !== "codex")
      throw new Error("--client must be claude or codex");
    const output = await executeNativeEccHook({
      client: client as HookClient,
      root: options.get("--root") ?? "",
      stateRoot: options.get("--state-root") ?? "",
      input: await readBoundedJson(stdin),
    });
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  if (mode !== "serena") throw new Error("ECC runtime mode must be hook or serena");
  const options = optionMap(rest);
  exactOptions(options, [
    "--package",
    "--dependency-lock-sha256",
    "--context",
    "--mode",
    "--project",
  ]);
  if (options.get("--package") !== SERENA_RUNTIME_PIN.package)
    throw new Error("Serena package pin is not accepted");
  if (options.get("--dependency-lock-sha256") !== SERENA_DEPENDENCY_LOCK_SHA256)
    throw new Error("Serena dependency lock is not accepted");
  const context = options.get("--context");
  if (context !== "claude-code" && context !== "codex")
    throw new Error("Serena context is not accepted");
  if (options.get("--mode") !== "no-memories") throw new Error("Serena mode is not accepted");
  const project = canonicalProject(options.get("--project") ?? "");
  safeSerenaHome(env, project);
  const child = (io.spawnProcess ?? spawn)(
    "uvx",
    [
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--from",
      SERENA_RUNTIME_PIN.package,
      "serena",
      "start-mcp-server",
      "--context",
      context,
      "--mode",
      "no-memories",
      "--project",
      project,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: isolatedSerenaEnvironment(env), windowsHide: true },
  ) as ChildProcessWithoutNullStreams;
  return proxySerena(child, { stdin, stdout, stderr });
}
