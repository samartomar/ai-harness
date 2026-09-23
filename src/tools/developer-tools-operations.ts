import { createHash } from "node:crypto";
import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { readAihConfig } from "../config/marker.js";
import { postureFromContext } from "../config/posture.js";
import { parseNativeStrictJsonObjectV1 } from "../contract/native-strict-json-object-v1.js";
import {
  CODE_REVIEW_GRAPH_ALLOWED_TOOLS,
  isolatedCodeReviewGraphEnvironment,
} from "../ecc-profile/code-review-graph-runtime.js";
import { acquireCodebaseMemoryNativePayload } from "../ecc-profile/codebase-memory-acquisition.js";
import { authenticateDefaultMcpRuntimeRoot } from "../ecc-profile/default-mcp-runtime-auth.js";
import { DEFAULT_MCP_DEPENDENCY_LOCK_SHA256 } from "../ecc-profile/default-mcp-runtime-lock.js";
import {
  CONTEXT7_SUBJECT_SHA256,
  SERENA_ALLOWED_TOOLS,
  SERENA_REQUIRED_TOOLS,
} from "../ecc-profile/mcp-profile.js";
import { SERENA_DEPENDENCY_LOCK_SHA256 } from "../ecc-profile/native-registration.js";
import { prepareOwnedStateDirectory } from "../ecc-profile/native-runtime.js";
import {
  authenticatedSerenaRuntimeRoot,
  isolatedSerenaEnvironment,
} from "../ecc-profile/native-runtime-cli.js";
import { assertHardenedSerenaRuntimeConfig } from "../ecc-profile/serena-runtime-config.js";
import { resolveClis } from "../internals/clis.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { RunInputDecision, RunInputStep, Runner, RunResult } from "../internals/proc.js";
import { findOnPath } from "../live/runner.js";
import {
  defaultNativeMcpServers,
  managedCodeReviewGraphCliInvocation,
} from "../mcp/default-native-runtime.js";
import { playwrightMcpServer } from "../mcp/servers.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import type { DeveloperToolId } from "./default-tool-selection.js";
import type {
  DeveloperToolRuntimeOperation,
  DeveloperToolRuntimeOperationResult,
} from "./developer-tools-runtime.js";
import { createMarkItDownOperation } from "./markitdown-runtime.js";
import {
  reconcileTokenOptimizer,
  TOKEN_OPTIMIZER_SOURCE_DIGEST,
  type TokenOptimizerReconcileDeps,
} from "./token-optimizer-runtime.js";

const CONTEXT7_ENDPOINT = "https://mcp.context7.com/mcp";
const LOCAL_TIMEOUT_MS = 5 * 60_000;
const MCP_OUTPUT_LIMIT = 8 * 1024 * 1024;
const CONTEXT7_RESPONSE_LIMIT = 4 * 1024 * 1024;
const PROCESS_DIAGNOSTIC_LIMIT = 800;
const PROCESS_DIAGNOSTIC_PREFIX = 240;
const PROCESS_DIAGNOSTIC_OMISSION = " … [truncated] … ";
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_MCP_EXCLUDE_NEWER = "2026-09-14T00:00:00Z";
const SERENA_EXCLUDE_NEWER = "2026-08-10T00:00:00Z";
const PLAYWRIGHT_SMOKE_MARKER = "AIH Playwright MCP verification";
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);
const SKIPPED_SOURCE_DIRECTORIES = new Set([
  ".aih",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

export interface DeveloperToolProductionDeps {
  readonly run?: Runner;
  readonly acquireMemory?: typeof acquireCodebaseMemoryNativePayload;
  readonly fetch?: typeof fetch;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly tokenOptimizer?: typeof reconcileTokenOptimizer;
  readonly tokenOptimizerDeps?: TokenOptimizerReconcileDeps;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function failed(result: RunResult): boolean {
  return result.spawnError === true || result.truncated === true || result.code !== 0;
}

function requireSuccess(label: string, result: RunResult): void {
  if (!failed(result)) return;
  const reason = result.truncated
    ? "output exceeded its limit"
    : result.spawnError
      ? "process could not start or timed out"
      : `process exited ${String(result.code)}`;
  const diagnostic = sanitizedProcessDiagnostic(result.stderr);
  throw new Error(
    `${label} failed: ${reason}${diagnostic === undefined ? "" : ` — ${diagnostic}`}`,
  );
}

function sanitizedProcessDiagnostic(raw: string): string | undefined {
  const printable = [...raw.replaceAll("\u001b", "")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && character !== "\n" && character !== "\r" && character !== "\t"
        ? " "
        : character;
    })
    .join("");
  const diagnostic = printable
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/\s+/gu, " ")
    .trim();
  if (diagnostic.length === 0) return undefined;
  if (diagnostic.length <= PROCESS_DIAGNOSTIC_LIMIT) return diagnostic;
  const tailLength =
    PROCESS_DIAGNOSTIC_LIMIT - PROCESS_DIAGNOSTIC_PREFIX - PROCESS_DIAGNOSTIC_OMISSION.length;
  return `${diagnostic.slice(0, PROCESS_DIAGNOSTIC_PREFIX).trimEnd()}${PROCESS_DIAGNOSTIC_OMISSION}${diagnostic.slice(-tailLength).trimStart()}`;
}

function externalExecutable(name: string, ctx: PlanContext): string {
  const executable = findOnPath(name, ctx.env, process.platform, {
    excludeRoot: ctx.root,
    windowsExeOnly: process.platform === "win32",
  });
  if (executable === undefined) {
    throw new Error(`${name} must resolve to an absolute executable outside the target project`);
  }
  return executable;
}

function semanticSourceFixture(project: string): string {
  const pending = [project];
  let inspected = 0;
  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > 4_096) {
        throw new Error("developer-tool semantic fixture scan exceeded its entry limit");
      }
      const path = join(directory, entry.name);
      let stats: Stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (!SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) pending.push(path);
        continue;
      }
      if (!stats.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      return relative(project, path).split("\\").join("/");
    }
  }
  throw new Error(
    "developer-tool runtime verification requires at least one supported source file in the project",
  );
}

interface LocalMcpRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function initializedMcpRequests(call: {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}): LocalMcpRequest[] {
  return initializedMcpRequestsForCalls([call]);
}

function initializedMcpRequestsForCalls(
  calls: readonly {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[],
): LocalMcpRequest[] {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "aih-developer-tools", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ...calls.map(
      (call, index): LocalMcpRequest => ({
        jsonrpc: "2.0",
        id: index + 3,
        method: "tools/call",
        params: { name: call.name, arguments: call.arguments },
      }),
    ),
  ];
}

function inspectMcpResponse(stdout: string, id: number): RunInputDecision {
  const lines = stdout.split(/\r?\n/u);
  let ready = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (index === lines.length - 1) return { state: "waiting" };
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { state: "failed", detail: `MCP response ${id} was malformed` };
      }
      const response = value as Record<string, unknown>;
      if (response.jsonrpc !== "2.0" || response.id !== id) continue;
      if (Object.hasOwn(response, "error")) {
        return { state: "failed", detail: `MCP response ${id} returned an error` };
      }
      if (!Object.hasOwn(response, "result")) {
        return { state: "failed", detail: `MCP response ${id} was malformed` };
      }
      if (
        response.result === null ||
        typeof response.result !== "object" ||
        Array.isArray(response.result)
      ) {
        return { state: "failed", detail: `MCP response ${id} was malformed` };
      }
      ready = true;
    } catch {
      return { state: "failed", detail: `MCP response ${id} was malformed` };
    }
  }
  return { state: ready ? "ready" : "waiting" };
}

function sequencedMcpInput(requests: readonly LocalMcpRequest[]): RunInputStep[] {
  const steps: RunInputStep[] = [];
  let pending = "";
  for (const request of requests) {
    pending += `${JSON.stringify(request)}\n`;
    if (request.id === undefined) continue;
    const id = request.id;
    steps.push({ input: pending, inspectStdout: (stdout) => inspectMcpResponse(stdout, id) });
    pending = "";
  }
  if (pending.length > 0) {
    throw new Error("MCP request sequence ended with a notification that cannot be acknowledged");
  }
  return steps;
}

async function runRootAwareMcpSession(
  ctx: PlanContext,
  run: Runner,
  id: "code-review-graph" | "codebase-memory-mcp" | "serena",
  requests: readonly LocalMcpRequest[],
  label: string,
): Promise<string> {
  const server = defaultNativeMcpServers(ctx)[id];
  if (server?.type !== "stdio") throw new Error(`${label} root-aware launcher is unavailable`);
  const result = await run([server.command, ...server.args], {
    cwd: ctx.root,
    env: ctx.env,
    inputSequence: sequencedMcpInput(requests),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxBufferBytes: MCP_OUTPUT_LIMIT,
  });
  requireSuccess(`${label} generated MCP launcher`, result);
  localMcpResponse(result.stdout, 1);
  return result.stdout;
}

function sameCanonicalProject(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) return false;
  try {
    const actual = realpathSync.native(candidate);
    const canonical = realpathSync.native(expected);
    return process.platform === "win32"
      ? actual.toLowerCase() === canonical.toLowerCase()
      : actual === canonical;
  } catch {
    return false;
  }
}

function externalRuntimeFile(ctx: PlanContext, candidate: string, label: string): string {
  if (!isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  let canonical: string;
  let project: string;
  try {
    canonical = realpathSync.native(candidate);
    project = realpathSync.native(ctx.root);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  const relation = relative(project, canonical);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error(`${label} must remain outside the target project`);
  }
  const stats = lstatSync(canonical);
  if (!stats.isFile()) throw new Error(`${label} is not a regular file`);
  return canonical;
}

function playwrightMcpSourceDigest(): string {
  const server = playwrightMcpServer();
  return sha256(JSON.stringify({ command: server.command, args: server.args }));
}

function playwrightMcpArgv(ctx: PlanContext): {
  readonly argv: string[];
  readonly sourceDigest: string;
} {
  const server = playwrightMcpServer();
  const [yes, ...launchArgs] = server.args;
  if (server.command !== "npx" || yes !== "-y" || launchArgs.length === 0) {
    throw new Error("Playwright MCP canonical launch recipe is invalid");
  }
  const npmCliPath = ctx.host.npmCliPath();
  if (npmCliPath === undefined) {
    throw new Error("Playwright MCP requires npm alongside the current Node runtime");
  }
  const node = externalRuntimeFile(ctx, process.execPath, "Playwright Node runtime");
  const npmCli = externalRuntimeFile(ctx, npmCliPath, "Playwright npm CLI");
  return {
    argv: [node, npmCli, "exec", "--yes", "--", ...launchArgs],
    sourceDigest: playwrightMcpSourceDigest(),
  };
}

function memoryProjectName(result: Record<string, unknown>, expectedRoot: string): string {
  const text = verifyToolCall(result, "Codebase Memory list_projects");
  const inventory = parseNativeStrictJsonObjectV1(text, "Codebase Memory project inventory");
  if (
    inventory.total !== 1 ||
    !Array.isArray(inventory.projects) ||
    inventory.projects.length !== 1
  ) {
    throw new Error("Codebase Memory list_projects did not return one isolated project");
  }
  const project = inventory.projects[0];
  if (project === null || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("Codebase Memory list_projects returned a malformed project");
  }
  const entry = project as Record<string, unknown>;
  if (
    typeof entry.name !== "string" ||
    entry.name.length === 0 ||
    entry.name.length > 512 ||
    !sameCanonicalProject(entry.root_path, expectedRoot)
  ) {
    throw new Error("Codebase Memory list_projects returned a foreign or invalid project");
  }
  return entry.name;
}

function onlineEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.UV_OFFLINE;
  return next;
}

async function syncUvRuntime(
  run: Runner,
  uv: string,
  lockRoot: string,
  env: NodeJS.ProcessEnv,
  label: string,
  excludeNewer: string,
): Promise<void> {
  const result = await run(
    [uv, "--project", lockRoot, "sync", "--locked", "--no-python-downloads", "--no-config"],
    {
      cwd: lockRoot,
      env: { ...onlineEnvironment(env), UV_EXCLUDE_NEWER: excludeNewer },
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxBufferBytes: MCP_OUTPUT_LIMIT,
    },
  );
  requireSuccess(label, result);
}

function policyExclusion(
  ctx: PlanContext,
  id: Exclude<DeveloperToolId, "token-optimizer">,
): string | undefined {
  const policy = readOrgPolicy(ctx.root, ctx.env);
  if (policy?.mcp?.disabledServers?.includes(id)) return `${id} is disabled by org policy`;
  if (policy?.mcp?.allowManagedOnly === true && !(policy.mcp.allowedServers ?? []).includes(id)) {
    return `${id} is outside the org-managed MCP allowlist`;
  }
  if (id !== "context7" || postureFromContext(ctx) !== "enterprise") return undefined;
  const subject = `mcp-server-sha256:${CONTEXT7_SUBJECT_SHA256}`;
  const approved =
    (policy?.mcp?.allowedServers ?? []).includes("context7") &&
    (policy?.mcp?.approvals ?? []).some(
      (approval) =>
        approval.server === "context7" &&
        approval.acceptEgress === true &&
        approval.subject === subject,
    );
  return approved
    ? undefined
    : "Context7 third-party egress is not approved by the enterprise org policy";
}

function excludedResult(detail: string, sourceDigest: string): DeveloperToolRuntimeOperationResult {
  return {
    state: "policy-excluded",
    detail,
    sourceDigest,
    ownedPaths: [],
    changed: false,
  };
}

function graphStatus(raw: string): { nodes: number; files: number } {
  const value = parseNativeStrictJsonObjectV1(raw, "Code Review Graph status");
  const nodes = value.nodes;
  const files = value.files;
  if (
    typeof nodes !== "number" ||
    !Number.isSafeInteger(nodes) ||
    nodes < 0 ||
    typeof files !== "number" ||
    !Number.isSafeInteger(files) ||
    files < 0
  ) {
    throw new Error("Code Review Graph status did not contain valid node and file counts");
  }
  return { nodes, files };
}

function graphOperation(ctx: PlanContext, run: Runner): DeveloperToolRuntimeOperation {
  return async ({ layout }) => {
    const exclusion = policyExclusion(ctx, "code-review-graph");
    if (exclusion !== undefined)
      return excludedResult(exclusion, DEFAULT_MCP_DEPENDENCY_LOCK_SHA256);

    const runtimeExisted = existsSync(join(layout.graphStateRoot, "runtime-env"));
    const graphStateRoot = prepareOwnedStateDirectory(
      layout.graphStateRoot,
      "Code Review Graph state root",
    );
    const uvCache = prepareOwnedStateDirectory(layout.uvCache, "developer-tool uv cache");
    const lockRoot = authenticateDefaultMcpRuntimeRoot(layout.defaultMcpLockRoot, layout.project, [
      graphStateRoot,
      uvCache,
    ]);
    const uv = externalExecutable("uv", ctx);
    const environment = isolatedCodeReviewGraphEnvironment(ctx.env, graphStateRoot, uvCache);
    await syncUvRuntime(
      run,
      uv,
      lockRoot,
      environment,
      "Code Review Graph dependency sync",
      DEFAULT_MCP_EXCLUDE_NEWER,
    );

    const invoke = async (operation: "status" | "build") => {
      const invocation = managedCodeReviewGraphCliInvocation(ctx, operation);
      return run(invocation.argv, {
        cwd: invocation.cwd,
        env: invocation.env,
        timeoutMs: operation === "build" ? LOCAL_TIMEOUT_MS : 120_000,
        maxBufferBytes: MCP_OUTPUT_LIMIT,
      });
    };
    let built = false;
    const buildAndReadStatus = async () => {
      const build = await invoke("build");
      requireSuccess("Code Review Graph build", build);
      built = true;
      const after = await invoke("status");
      requireSuccess("Code Review Graph post-build status", after);
      return graphStatus(after.stdout);
    };
    const graphDatabase = lstatSync(join(graphStateRoot, "graph.db"), {
      throwIfNoEntry: false,
    });
    let status: { nodes: number; files: number };
    if (graphDatabase === undefined) {
      status = await buildAndReadStatus();
    } else {
      const beforeResult = await invoke("status");
      requireSuccess("Code Review Graph status", beforeResult);
      status = graphStatus(beforeResult.stdout);
    }
    if (!built && (status.nodes === 0 || status.files === 0)) {
      status = await buildAndReadStatus();
    }
    if (status.nodes === 0 || status.files === 0) {
      throw new Error("Code Review Graph remained empty after its supported build operation");
    }
    const sourceFixture = semanticSourceFixture(layout.project);
    const mcpOutput = await runRootAwareMcpSession(
      ctx,
      run,
      "code-review-graph",
      initializedMcpRequests({
        name: "detect_changes_tool",
        arguments: {
          changed_files: [sourceFixture],
          include_source: false,
          max_depth: 1,
          detail_level: "minimal",
          max_results: 5,
          max_flows: 5,
        },
      }),
      "Code Review Graph",
    );
    verifyToolsList(localMcpResponse(mcpOutput, 2), CODE_REVIEW_GRAPH_ALLOWED_TOOLS, true);
    verifyToolCall(localMcpResponse(mcpOutput, 3), "Code Review Graph detect_changes_tool");
    return {
      state: "verified",
      detail: `authenticated generated Code Review Graph exposed exactly ${CODE_REVIEW_GRAPH_ALLOWED_TOOLS.length} guarded operations, indexed ${status.files} files / ${status.nodes} nodes, and completed detect_changes_tool for ${sourceFixture}`,
      sourceDigest: DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
      ownedPaths: [],
      changed: !runtimeExisted || built,
    };
  };
}

interface McpResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function localMcpResponse(stdout: string, id: number): Record<string, unknown> {
  const responses = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseNativeStrictJsonObjectV1(line, "MCP response"));
  const response = responses.find((candidate) => candidate.id === id) as McpResponse | undefined;
  if (response === undefined) throw new Error(`MCP runtime omitted response ${id}`);
  if (response.error !== undefined)
    throw new Error(`MCP runtime returned an error for response ${id}`);
  if (
    response.result === null ||
    typeof response.result !== "object" ||
    Array.isArray(response.result)
  ) {
    throw new Error(`MCP runtime returned a malformed result for response ${id}`);
  }
  return response.result as Record<string, unknown>;
}

function verifyToolsList(
  result: Record<string, unknown>,
  required: readonly string[],
  exact = false,
): void {
  if (!Array.isArray(result.tools)) throw new Error("MCP tools/list result is malformed");
  const names = new Set(
    result.tools.flatMap((tool) => {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return [];
      const name = (tool as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    }),
  );
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0)
    throw new Error(`MCP tools/list omitted required tools: ${missing.join(", ")}`);
  if (exact && names.size !== required.length) {
    throw new Error("MCP tools/list exposed operations outside the reviewed allowlist");
  }
}

function verifyToolCall(result: Record<string, unknown>, label: string): string {
  const text = (Array.isArray(result.content) ? result.content : [])
    .flatMap((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n")
    .trim();
  if (result.isError === true) {
    const diagnostic = sanitizedProcessDiagnostic(text);
    throw new Error(
      `${label} returned an MCP tool error${diagnostic === undefined ? "" : ` — ${diagnostic}`}`,
    );
  }
  if (!Array.isArray(result.content) || result.content.length === 0) {
    throw new Error(`${label} returned no content`);
  }
  if (text.length === 0) throw new Error(`${label} returned no textual result`);
  if (/"(?:status|state)"\s*:\s*"error"/iu.test(text)) {
    throw new Error(`${label} reported an operation error`);
  }
  return text;
}

function verifyPlaywrightEvaluationResult(text: string): void {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const resultSections = lines.flatMap((line, index) => (line === "### Result" ? [index] : []));
  if (resultSections.length !== 1) {
    throw new Error("Playwright browser_evaluate returned a malformed result section");
  }
  const start = (resultSections[0] as number) + 1;
  const nextSection = lines.findIndex((line, index) => index >= start && /^###\s/u.test(line));
  const serialized = lines
    .slice(start, nextSection === -1 ? undefined : nextSection)
    .join("\n")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Playwright browser_evaluate returned a malformed JSON result");
  }
  if (value !== PLAYWRIGHT_SMOKE_MARKER) {
    throw new Error("Playwright browser_evaluate did not return the isolated fixture marker");
  }
}

function structuredToolResult(
  result: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const value = result.structuredContent;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned no structured result`);
  }
  return value as Record<string, unknown>;
}

function playwrightOperation(ctx: PlanContext, run: Runner): DeveloperToolRuntimeOperation {
  return async () => {
    const exclusion = policyExclusion(ctx, "playwright");
    if (exclusion !== undefined) {
      return excludedResult(exclusion, playwrightMcpSourceDigest());
    }
    const { argv, sourceDigest } = playwrightMcpArgv(ctx);
    const result = await run(argv, {
      cwd: ctx.root,
      env: ctx.env,
      inputSequence: sequencedMcpInput(
        initializedMcpRequestsForCalls([
          { name: "browser_navigate", arguments: { url: "about:blank" } },
          {
            name: "browser_evaluate",
            arguments: {
              function:
                '() => { const main = document.createElement("main"); main.id = "aih-playwright-smoke"; main.textContent = "AIH Playwright MCP verification"; document.body.replaceChildren(main); return main.textContent; }',
            },
          },
        ]),
      ),
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxBufferBytes: MCP_OUTPUT_LIMIT,
    });
    requireSuccess("Playwright MCP", result);
    localMcpResponse(result.stdout, 1);
    verifyToolsList(localMcpResponse(result.stdout, 2), ["browser_navigate", "browser_evaluate"]);
    verifyToolCall(localMcpResponse(result.stdout, 3), "Playwright browser_navigate");
    const evaluated = verifyToolCall(
      localMcpResponse(result.stdout, 4),
      "Playwright browser_evaluate",
    );
    verifyPlaywrightEvaluationResult(evaluated);
    return {
      state: "verified",
      detail:
        "pinned Playwright MCP completed browser_navigate and browser_evaluate against an isolated headless about:blank fixture",
      sourceDigest,
      ownedPaths: [],
      changed: false,
    };
  };
}

function serenaOperation(ctx: PlanContext, run: Runner): DeveloperToolRuntimeOperation {
  return async ({ layout, previous }) => {
    const exclusion = policyExclusion(ctx, "serena");
    if (exclusion !== undefined) return excludedResult(exclusion, SERENA_DEPENDENCY_LOCK_SHA256);

    const runtimeExisted = existsSync(join(layout.serenaStateRoot, "runtime-env"));
    const stateRoot = prepareOwnedStateDirectory(layout.serenaStateRoot, "Serena state root");
    const uvCache = prepareOwnedStateDirectory(layout.uvCache, "developer-tool uv cache");
    const lockRoot = authenticatedSerenaRuntimeRoot(
      layout.serenaLockRoot,
      layout.project,
      stateRoot,
    );
    const uv = externalExecutable("uv", ctx);
    const environment = isolatedSerenaEnvironment({ ...ctx.env, UV_CACHE_DIR: uvCache }, stateRoot);
    await syncUvRuntime(
      run,
      uv,
      lockRoot,
      environment,
      "Serena dependency sync",
      SERENA_EXCLUDE_NEWER,
    );

    const configPath = join(stateRoot, "serena_config.yml");
    const beforeConfig = readRegularFileWithStats(configPath, { maxBytes: 128 * 1024 });
    if (beforeConfig !== undefined) {
      assertHardenedSerenaRuntimeConfig(beforeConfig.contents.toString("utf8"), {
        project: layout.project,
        home: stateRoot,
        allowedTools: SERENA_ALLOWED_TOOLS,
      });
    }
    const sourceFixture = semanticSourceFixture(layout.project);
    const mcpOutput = await runRootAwareMcpSession(
      ctx,
      run,
      "serena",
      initializedMcpRequests({
        name: "get_symbols_overview",
        arguments: { relative_path: sourceFixture, depth: 1 },
      }),
      "Serena",
    );
    verifyToolsList(localMcpResponse(mcpOutput, 2), SERENA_REQUIRED_TOOLS);
    verifyToolCall(localMcpResponse(mcpOutput, 3), "Serena get_symbols_overview");

    const config = readRegularFileWithStats(configPath, { maxBytes: 128 * 1024 });
    if (config === undefined || config.stats.nlink !== 1) {
      throw new Error("Serena did not retain the authenticated hardened configuration");
    }
    assertHardenedSerenaRuntimeConfig(config.contents.toString("utf8"), {
      project: layout.project,
      home: stateRoot,
      allowedTools: SERENA_ALLOWED_TOOLS,
    });
    const configDigest = sha256(config.contents);
    const previouslyOwned = previous?.ownedPaths.some(
      (owned) => owned.path === configPath && owned.sha256 === configDigest,
    );
    const ownedPaths =
      beforeConfig === undefined || previouslyOwned
        ? [{ path: configPath, sha256: configDigest, ownership: "file" as const }]
        : [];
    return {
      state: "verified",
      detail: `authenticated generated Serena exposed its guarded semantic surface (${SERENA_ALLOWED_TOOLS.length} allowed tools) and completed get_symbols_overview for ${sourceFixture}`,
      sourceDigest: SERENA_DEPENDENCY_LOCK_SHA256,
      ownedPaths,
      changed: !runtimeExisted || beforeConfig === undefined,
    };
  };
}

function memoryOperation(
  ctx: PlanContext,
  run: Runner,
  deps: DeveloperToolProductionDeps,
): DeveloperToolRuntimeOperation {
  return async ({ layout }) => {
    const exclusion = policyExclusion(ctx, "codebase-memory-mcp");
    if (exclusion !== undefined) return excludedResult(exclusion, sha256("codebase-memory-policy"));
    const acquire = deps.acquireMemory ?? acquireCodebaseMemoryNativePayload;
    const payload = await acquire({
      runtimeHome: layout.memoryPayloadRoot,
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
      run,
      env: ctx.env,
    });
    if (!SHA256.test(payload.sha256)) {
      throw new Error("Codebase Memory acquisition returned an invalid native payload identity");
    }
    const stateRoot = prepareOwnedStateDirectory(
      layout.memoryStateRoot,
      "Codebase Memory state root",
    );
    prepareOwnedStateDirectory(layout.uvCache, "developer-tool uv cache");
    prepareOwnedStateDirectory(layout.memoryPayloadRoot, "Codebase Memory payload root");
    prepareOwnedStateDirectory(join(stateRoot, "index"), "Codebase Memory index root");
    const sourceFixture = semanticSourceFixture(layout.project);
    const indexedOutput = await runRootAwareMcpSession(
      ctx,
      run,
      "codebase-memory-mcp",
      initializedMcpRequests({
        name: "index_repository",
        arguments: { repo_path: layout.project, mode: "fast" },
      }),
      "Codebase Memory",
    );
    verifyToolsList(localMcpResponse(indexedOutput, 2), ["index_repository", "search_graph"]);
    const indexedCall = localMcpResponse(indexedOutput, 3);
    verifyToolCall(indexedCall, "Codebase Memory index_repository");
    const indexed = structuredToolResult(indexedCall, "Codebase Memory index_repository");
    if (
      indexed.status !== "indexed" ||
      typeof indexed.nodes !== "number" ||
      !Number.isSafeInteger(indexed.nodes) ||
      indexed.nodes <= 0 ||
      typeof indexed.edges !== "number" ||
      !Number.isSafeInteger(indexed.edges) ||
      indexed.edges < 0
    ) {
      throw new Error("Codebase Memory index_repository did not produce a populated healthy index");
    }

    const inventoryOutput = await runRootAwareMcpSession(
      ctx,
      run,
      "codebase-memory-mcp",
      initializedMcpRequests({ name: "list_projects", arguments: {} }),
      "Codebase Memory",
    );
    verifyToolsList(localMcpResponse(inventoryOutput, 2), ["list_projects"]);
    const projectName = memoryProjectName(localMcpResponse(inventoryOutput, 3), layout.project);

    const queriedOutput = await runRootAwareMcpSession(
      ctx,
      run,
      "codebase-memory-mcp",
      initializedMcpRequests({
        name: "search_graph",
        arguments: {
          project: projectName,
          label: "File",
          file_pattern: sourceFixture,
          limit: 5,
          format: "json",
        },
      }),
      "Codebase Memory",
    );
    verifyToolsList(localMcpResponse(queriedOutput, 2), ["index_repository", "search_graph"]);
    const queriedCall = localMcpResponse(queriedOutput, 3);
    verifyToolCall(queriedCall, "Codebase Memory search_graph");
    const queried = structuredToolResult(queriedCall, "Codebase Memory search_graph");
    if (
      typeof queried.count !== "number" ||
      !Number.isSafeInteger(queried.count) ||
      queried.count <= 0 ||
      !JSON.stringify(queried).includes(basename(sourceFixture))
    ) {
      throw new Error("Codebase Memory search_graph did not retrieve the indexed source fixture");
    }
    return {
      state: "verified",
      detail: `authenticated generated native Codebase Memory indexed the canonical project (${indexed.nodes} nodes / ${indexed.edges} edges) and retrieved ${sourceFixture} through search_graph with isolated project state`,
      sourceDigest: payload.sha256,
      ownedPaths: [],
      changed: payload.changed,
    };
  };
}

function safeSession(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!/^[A-Za-z0-9._~+/=-]{1,512}$/u.test(value)) {
    throw new Error("Context7 returned an invalid MCP session identifier");
  }
  return value;
}

async function boundedResponseText(response: Response): Promise<string> {
  const announced = response.headers.get("content-length");
  if (announced !== null) {
    const length = Number(announced);
    if (!Number.isSafeInteger(length) || length < 0 || length > CONTEXT7_RESPONSE_LIMIT) {
      throw new Error("Context7 response exceeds its byte limit");
    }
  }
  if (response.body === null) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > CONTEXT7_RESPONSE_LIMIT)
      throw new Error("Context7 response exceeds its byte limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function remoteMcpResponse(raw: string, contentType: string, id: number): Record<string, unknown> {
  const candidates = contentType.toLowerCase().includes("text/event-stream")
    ? raw
        .replace(/\r\n/g, "\n")
        .split("\n\n")
        .flatMap((event) => {
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          return data.length === 0 ? [] : [data];
        })
    : [raw];
  for (const candidate of candidates) {
    const response = parseNativeStrictJsonObjectV1(candidate, "Context7 MCP response");
    if (response.id !== id) continue;
    if (response.error !== undefined)
      throw new Error(`Context7 returned an error for response ${id}`);
    if (
      response.result === null ||
      typeof response.result !== "object" ||
      Array.isArray(response.result)
    ) {
      throw new Error(`Context7 returned a malformed result for response ${id}`);
    }
    return response.result as Record<string, unknown>;
  }
  throw new Error(`Context7 omitted MCP response ${id}`);
}

export async function verifyContext7DocumentationOperation(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let session: string | undefined;
  let protocolVersion = "2024-11-05";
  const post = async (body: Record<string, unknown>, expectedId?: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetchImpl(CONTEXT7_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": protocolVersion,
          ...(session === undefined ? {} : { "Mcp-Session-Id": session }),
        },
        body: JSON.stringify(body),
      });
      if (response.status !== 200 && response.status !== 202) {
        throw new Error(`Context7 returned HTTP ${response.status}`);
      }
      session = safeSession(response.headers.get("mcp-session-id")) ?? session;
      const raw = await boundedResponseText(response);
      if (expectedId === undefined) return undefined;
      if (response.status !== 200 || raw.trim().length === 0) {
        throw new Error(`Context7 omitted MCP response ${expectedId}`);
      }
      return remoteMcpResponse(raw, response.headers.get("content-type") ?? "", expectedId);
    } finally {
      clearTimeout(timeout);
    }
  };

  const initialized = await post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "aih-developer-tools", version: "1" },
      },
    },
    1,
  );
  const negotiated = initialized?.protocolVersion;
  if (typeof negotiated !== "string" || negotiated.length === 0 || negotiated.length > 64) {
    throw new Error("Context7 returned an invalid MCP protocol version");
  }
  protocolVersion = negotiated;
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, 2);
  if (tools === undefined) throw new Error("Context7 omitted tools/list");
  verifyToolsList(tools, ["query-docs"]);
  const docs = await post(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "query-docs",
        arguments: {
          libraryId: "/facebook/react",
          query: "Explain effect cleanup behavior with a short API example.",
        },
      },
    },
    3,
  );
  if (docs === undefined) throw new Error("Context7 omitted query-docs");
  verifyToolCall(docs, "Context7 query-docs");
  return "Context7 query-docs returned documentation through the reviewed HTTPS MCP endpoint";
}

function context7Operation(
  ctx: PlanContext,
  fetchImpl: typeof fetch,
): DeveloperToolRuntimeOperation {
  return async () => {
    const exclusion = policyExclusion(ctx, "context7");
    if (exclusion !== undefined) return excludedResult(exclusion, CONTEXT7_SUBJECT_SHA256);
    const detail = await verifyContext7DocumentationOperation(fetchImpl);
    return {
      state: "verified",
      detail,
      sourceDigest: CONTEXT7_SUBJECT_SHA256,
      ownedPaths: [],
      changed: false,
    };
  };
}

function tokenOptimizerTargets(ctx: PlanContext): readonly string[] {
  if (ctx.targets !== undefined) return ctx.targets;
  if (
    ctx.options.allTools === true ||
    (typeof ctx.options.cli === "string" && ctx.options.cli.trim().length > 0)
  ) {
    return resolveClis(ctx.options, { strict: true });
  }
  const persisted = readAihConfig(ctx.root)?.targets;
  return persisted !== undefined && persisted.length > 0
    ? persisted
    : resolveClis(ctx.options, { strict: true });
}

function tokenOptimizerOperation(
  ctx: PlanContext,
  deps: DeveloperToolProductionDeps,
): DeveloperToolRuntimeOperation {
  return async ({ layout, selected, acceptTokenOptimizerLicense, tokenOptimizerProfile }) => {
    if (selected && !tokenOptimizerTargets(ctx).includes("codex")) {
      return {
        state: "blocked",
        detail:
          "Token Optimizer project hook setup currently supports Codex only; target codex to configure it. Selection remains active.",
        sourceDigest: sha256(TOKEN_OPTIMIZER_SOURCE_DIGEST),
        ownedPaths: [],
        changed: false,
      };
    }
    const reconcile = deps.tokenOptimizer ?? reconcileTokenOptimizer;
    const result = await reconcile(
      {
        project: {
          canonicalRoot: layout.project,
          stateRoot: layout.projectStateRoot,
        },
        installRoot: layout.tokenOptimizerRoot,
        selected,
        acceptLicense: acceptTokenOptimizerLicense,
        profile: tokenOptimizerProfile,
      },
      deps.tokenOptimizerDeps,
    );
    if (result.state === "selected-pending") {
      throw new Error("Token Optimizer reconciliation returned a non-final lifecycle state");
    }
    return {
      state: result.state,
      detail: result.detail,
      sourceDigest: sha256(TOKEN_OPTIMIZER_SOURCE_DIGEST),
      ownedPaths: [],
      changed: result.changed,
    };
  };
}

/** Concrete production operations used whenever callers do not inject a focused seam. */
export function createDefaultDeveloperToolRuntimeOperations(
  ctx: PlanContext,
  deps: DeveloperToolProductionDeps = {},
): Record<Exclude<DeveloperToolId, "headroom">, DeveloperToolRuntimeOperation> {
  const run = deps.run ?? ctx.run;
  return {
    "code-review-graph": graphOperation(ctx, run),
    "codebase-memory-mcp": memoryOperation(ctx, run, deps),
    serena: serenaOperation(ctx, run),
    "token-optimizer": tokenOptimizerOperation(ctx, deps),
    context7: context7Operation(ctx, deps.fetch ?? fetch),
    markitdown: createMarkItDownOperation(ctx, run),
    playwright: playwrightOperation(ctx, run),
  };
}
