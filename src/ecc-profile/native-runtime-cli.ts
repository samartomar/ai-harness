import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, parse, relative, resolve } from "node:path";
import { readRegularFile, readRegularFileWithStats } from "../internals/fsxn.js";
import { findOnPath } from "../live/runner.js";
import { runHeadroomMcpLauncher } from "../tools/headroom-launcher.js";
import {
  CODE_REVIEW_GRAPH_ALLOWED_TOOLS,
  CodeReviewGraphMcpPolicyGuard,
  isolatedCodeReviewGraphEnvironment,
} from "./code-review-graph-runtime.js";
import {
  assertCodebaseMemoryCoordinationRoot,
  prepareCodebaseMemoryCoordinationRoot,
} from "./codebase-memory-coordination.js";
import { authenticateCodebaseMemoryNativePayload } from "./codebase-memory-payload.js";
import { isolatedCodebaseMemoryEnvironment } from "./codebase-memory-runtime.js";
import { authenticateDefaultMcpRuntimeRoot } from "./default-mcp-runtime-auth.js";
import {
  CODE_REVIEW_GRAPH_RUNTIME_PIN,
  CODEBASE_MEMORY_RUNTIME_PIN,
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
} from "./default-mcp-runtime-lock.js";
import { HOOK_INPUT_LIMITS, type HookClient } from "./hook-core.js";
import { SERENA_ALLOWED_TOOLS, SERENA_RUNTIME_PIN, SerenaMcpPolicyGuard } from "./mcp-profile.js";
import {
  SERENA_DEPENDENCY_LOCK_SHA256,
  SERENA_RUNTIME_PYPROJECT_SHA256,
  SERENA_RUNTIME_UV_LOCK_SHA256,
} from "./native-registration.js";
import { executeNativeEccHook, prepareOwnedStateDirectory } from "./native-runtime.js";
import {
  assertHardenedSerenaRuntimeConfig,
  renderSerenaRuntimeConfig,
} from "./serena-runtime-config.js";

const MAX_MCP_LINE_BYTES = 1024 * 1024;
const SERENA_WINDOWS_PYTHON_ENTRYPOINT = "from serena.cli import top_level; top_level()";

/**
 * Windows console-script shims canonicalize MSIX-virtualized AppData paths and
 * can push pinned module filenames past the legacy import limit. Invoke the
 * exact pinned console function through the environment interpreter instead.
 */
export function serenaRuntimeEntrypoint(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? ["python", "-c", SERENA_WINDOWS_PYTHON_ENTRYPOINT] : ["serena"];
}

export interface NativeRuntimeIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  authenticateCodebaseMemoryPayload?: typeof authenticateCodebaseMemoryNativePayload;
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

function canonicalProject(value: string, label = "Serena"): string {
  if (!isAbsolute(value)) throw new Error(`${label} project must be absolute`);
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} project must be a real directory`);
  }
  return realpathSync(value);
}

function trustedUvExecutable(env: NodeJS.ProcessEnv, project: string): string {
  const executable = findOnPath("uv", env, process.platform, {
    excludeRoot: project,
    windowsExeOnly: true,
  });
  if (executable === undefined) {
    throw new Error("uv must resolve to an absolute executable outside the target project");
  }
  return executable;
}

function assertOwnedStateDestination(value: string, project: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute state directory`);
  const destination = resolve(value);
  if (containsPath(project, destination) || containsPath(destination, project)) {
    throw new Error(`${label} must remain outside and disjoint from the project`);
  }
  const rootPath = parse(destination).root;
  const segments = relative(rootPath, destination)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let cursor = rootPath;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (stats === undefined) break;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} has a non-directory or linked path segment`);
    }
  }
  return destination;
}

function safeOwnedStateRoot(value: string, project: string, label: string): string {
  const destination = assertOwnedStateDestination(value, project, label);
  const root = prepareOwnedStateDirectory(destination, label);
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return root;
}

function assertDisjointMemoryRoots(roots: readonly string[]): void {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left];
      const b = roots[right];
      if (a && b && (containsPath(a, b) || containsPath(b, a))) {
        throw new Error(
          "Codebase Memory state, coordination, payload, and uv cache roots must be disjoint",
        );
      }
    }
  }
}

export function authenticatedSerenaRuntimeRoot(
  value: string,
  project: string,
  home: string,
): string {
  if (!isAbsolute(value)) throw new Error("Serena runtime lock root must be absolute");
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Serena runtime lock root must be a real directory");
  }
  const root = realpathSync(value);
  if (
    containsPath(project, root) ||
    containsPath(root, project) ||
    containsPath(home, root) ||
    containsPath(root, home)
  ) {
    throw new Error("Serena runtime lock root must be disjoint from project and state roots");
  }
  const identities = [
    ["pyproject.toml", SERENA_RUNTIME_PYPROJECT_SHA256],
    ["uv.lock", SERENA_RUNTIME_UV_LOCK_SHA256],
  ] as const;
  const verified: string[] = [];
  for (const [name, expected] of identities) {
    const opened = readRegularFileWithStats(join(root, name), { maxBytes: 4 * 1024 * 1024 });
    if (!opened || opened.stats.nlink > 1) {
      throw new Error(`Serena runtime ${name} must be an unambiguous regular file`);
    }
    const actual = createHash("sha256").update(opened.contents).digest("hex");
    if (actual !== expected) throw new Error(`Serena runtime ${name} failed authentication`);
    verified.push(actual);
  }
  const aggregate = createHash("sha256").update(verified.join("\0")).digest("hex");
  if (aggregate !== SERENA_DEPENDENCY_LOCK_SHA256) {
    throw new Error("Serena runtime dependency closure failed authentication");
  }
  return root;
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
  prepareOwnedStateDirectory(
    join(home, "projects", basename(project), ".serena"),
    "Serena project metadata root",
  );
  const configPath = join(home, "serena_config.yml");
  const scope = { project, home, allowedTools: SERENA_ALLOWED_TOOLS };
  const expected = renderSerenaRuntimeConfig(scope);
  const existing = readRegularFile(configPath, { maxBytes: 128 * 1024 });
  if (existing === undefined)
    writeFileSync(configPath, expected, { encoding: "utf8", flag: "wx", mode: 0o600 });
  else assertHardenedSerenaRuntimeConfig(existing.toString("utf8"), scope);
  return home;
}

export function isolatedSerenaEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
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
  next.UV_PROJECT_ENVIRONMENT = join(home, "runtime-env");
  next.SERENA_HOME = home;
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
      onError(new Error("MCP frame exceeds its byte limit"));
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
    if (buffer.trim().length > 0) onError(new Error("MCP stream ended with a partial frame"));
  });
}

interface McpProtocolGuard {
  inspectClientRequest(value: unknown): { forward: boolean; response?: unknown };
  filterToolsList(value: unknown): unknown;
}

async function proxyGuardedMcp(
  child: ChildProcessWithoutNullStreams,
  io: Required<Pick<NativeRuntimeIo, "stdin" | "stdout" | "stderr">>,
  guard: McpProtocolGuard,
): Promise<number> {
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

async function proxyTransparentMcp(
  child: ChildProcessWithoutNullStreams,
  io: Required<Pick<NativeRuntimeIo, "stdin" | "stdout" | "stderr">>,
): Promise<number> {
  io.stdin.pipe(child.stdin);
  child.stdout.on("data", (chunk) => io.stdout.write(chunk));
  child.stderr.on("data", (chunk) => io.stderr.write(chunk));
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
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
  if (mode === "code-review-graph") {
    const options = optionMap(rest);
    exactOptions(options, [
      "--package",
      "--dependency-lock-sha256",
      "--lock-root",
      "--project",
      "--state-root",
      "--uv-cache",
    ]);
    if (options.get("--package") !== CODE_REVIEW_GRAPH_RUNTIME_PIN.package) {
      throw new Error("Code Review Graph package pin is not accepted");
    }
    if (options.get("--dependency-lock-sha256") !== DEFAULT_MCP_DEPENDENCY_LOCK_SHA256) {
      throw new Error("default MCP dependency lock is not accepted");
    }
    const project = canonicalProject(options.get("--project") ?? "", "Code Review Graph");
    const stateRoot = safeOwnedStateRoot(
      options.get("--state-root") ?? "",
      project,
      "CRG_DATA_DIR",
    );
    const uvCache = safeOwnedStateRoot(
      options.get("--uv-cache") ?? "",
      project,
      "Code Review Graph uv cache",
    );
    if (containsPath(stateRoot, uvCache) || containsPath(uvCache, stateRoot)) {
      throw new Error("Code Review Graph state and uv cache roots must be disjoint");
    }
    const lockRoot = authenticateDefaultMcpRuntimeRoot(options.get("--lock-root") ?? "", project, [
      stateRoot,
      uvCache,
    ]);
    const uvExecutable = trustedUvExecutable(env, project);
    const child = (io.spawnProcess ?? spawn)(
      uvExecutable,
      [
        "--project",
        lockRoot,
        "run",
        "--offline",
        "--no-python-downloads",
        "--no-env-file",
        "--frozen",
        "code-review-graph",
        "serve",
        "--repo",
        project,
        "--tools",
        CODE_REVIEW_GRAPH_ALLOWED_TOOLS.join(","),
      ],
      {
        cwd: project,
        stdio: ["pipe", "pipe", "pipe"],
        env: isolatedCodeReviewGraphEnvironment(env, stateRoot, uvCache),
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams;
    return proxyGuardedMcp(
      child,
      { stdin, stdout, stderr },
      new CodeReviewGraphMcpPolicyGuard(project),
    );
  }
  if (mode === "codebase-memory-mcp") {
    const options = optionMap(rest);
    exactOptions(options, [
      "--package",
      "--dependency-lock-sha256",
      "--lock-root",
      "--project",
      "--state-root",
      "--coordination-root",
      "--runtime-home",
      "--uv-cache",
    ]);
    if (options.get("--package") !== CODEBASE_MEMORY_RUNTIME_PIN.package) {
      throw new Error("Codebase Memory package pin is not accepted");
    }
    if (options.get("--dependency-lock-sha256") !== DEFAULT_MCP_DEPENDENCY_LOCK_SHA256) {
      throw new Error("default MCP dependency lock is not accepted");
    }
    const project = canonicalProject(options.get("--project") ?? "", "Codebase Memory");
    const stateDestination = assertOwnedStateDestination(
      options.get("--state-root") ?? "",
      project,
      "Codebase Memory state root",
    );
    const runtimeHomeDestination = assertOwnedStateDestination(
      options.get("--runtime-home") ?? "",
      project,
      "Codebase Memory payload root",
    );
    const uvCacheDestination = assertOwnedStateDestination(
      options.get("--uv-cache") ?? "",
      project,
      "Codebase Memory uv cache",
    );
    const coordinationDestination = assertCodebaseMemoryCoordinationRoot(
      options.get("--coordination-root") ?? "",
      env,
      project,
      process.platform,
    );
    const destinations = [
      stateDestination,
      coordinationDestination,
      runtimeHomeDestination,
      uvCacheDestination,
    ];
    assertDisjointMemoryRoots(destinations);
    const lockRoot = authenticateDefaultMcpRuntimeRoot(
      options.get("--lock-root") ?? "",
      project,
      destinations,
    );
    const coordinationRoot = prepareCodebaseMemoryCoordinationRoot(
      coordinationDestination,
      env,
      project,
      process.platform,
    );
    const stateRoot = safeOwnedStateRoot(stateDestination, project, "Codebase Memory state root");
    const runtimeHome = safeOwnedStateRoot(
      runtimeHomeDestination,
      project,
      "Codebase Memory payload root",
    );
    const uvCache = safeOwnedStateRoot(uvCacheDestination, project, "Codebase Memory uv cache");
    const stateRoots = [stateRoot, coordinationRoot, runtimeHome, uvCache];
    assertDisjointMemoryRoots(stateRoots);
    authenticateDefaultMcpRuntimeRoot(lockRoot, project, stateRoots);
    prepareOwnedStateDirectory(join(stateRoot, "index"), "CBM_CACHE_DIR");
    const payload = await (
      io.authenticateCodebaseMemoryPayload ?? authenticateCodebaseMemoryNativePayload
    )({
      runtimeHome,
      platform: process.platform,
      arch: process.arch,
    });
    const child = (io.spawnProcess ?? spawn)(payload.path, [], {
      cwd: project,
      stdio: ["pipe", "pipe", "pipe"],
      env: isolatedCodebaseMemoryEnvironment(
        env,
        project,
        stateRoot,
        coordinationRoot,
        runtimeHome,
        uvCache,
        true,
      ),
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    return proxyTransparentMcp(child, { stdin, stdout, stderr });
  }
  if (mode === "headroom") {
    return runHeadroomMcpLauncher(rest, {
      stdin,
      stdout,
      stderr,
      env,
      ...(io.spawnProcess === undefined ? {} : { spawnProcess: io.spawnProcess }),
    });
  }
  if (mode !== "serena") {
    throw new Error(
      "ECC runtime mode must be hook, code-review-graph, codebase-memory-mcp, headroom, or serena",
    );
  }
  const options = optionMap(rest);
  const serenaOptions = [
    "--package",
    "--dependency-lock-sha256",
    "--lock-root",
    "--context",
    "--mode",
    "--project",
  ];
  exactOptions(
    options,
    options.has("--state-root") ? [...serenaOptions, "--state-root"] : serenaOptions,
  );
  if (options.get("--package") !== SERENA_RUNTIME_PIN.package)
    throw new Error("Serena package pin is not accepted");
  if (options.get("--dependency-lock-sha256") !== SERENA_DEPENDENCY_LOCK_SHA256)
    throw new Error("Serena dependency lock is not accepted");
  const context = options.get("--context");
  if (context !== "claude-code" && context !== "codex" && context !== "ide-assistant")
    throw new Error("Serena context is not accepted");
  if (options.get("--mode") !== "no-memories") throw new Error("Serena mode is not accepted");
  const project = canonicalProject(options.get("--project") ?? "");
  const stateRoot = options.get("--state-root");
  const home = safeSerenaHome(
    stateRoot === undefined ? env : { ...env, SERENA_HOME: stateRoot },
    project,
  );
  const lockRoot = authenticatedSerenaRuntimeRoot(options.get("--lock-root") ?? "", project, home);
  const uvExecutable = trustedUvExecutable(env, project);
  const child = (io.spawnProcess ?? spawn)(
    uvExecutable,
    [
      "--project",
      lockRoot,
      "run",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--frozen",
      ...serenaRuntimeEntrypoint(process.platform),
      "start-mcp-server",
      "--context",
      context,
      "--mode",
      "no-memories",
      "--project",
      project,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: isolatedSerenaEnvironment(env, home),
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  return proxyGuardedMcp(child, { stdin, stdout, stderr }, new SerenaMcpPolicyGuard());
}
