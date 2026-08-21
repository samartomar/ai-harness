#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pins = {
  serena: {
    package: "serena-agent==1.7.0",
    license: "MIT",
    source: "https://github.com/oraios/serena",
    securityOverrides: [
      "python-multipart==0.0.32",
      "starlette==1.3.1",
    ],
  },
  tokenOptimizer: {
    tag: "v5.11.68",
    commit: "ffe3b8007542260b17648a2d9228c3dedda380ad",
    tree: "d044ba6038ac705e8d0da6a4b545cbee00abe7d5",
    license: "PolyForm-Noncommercial-1.0.0",
    source: "https://github.com/alexgreensh/token-optimizer",
  },
  tokenSavior: {
    package: "token-savior-recall[mcp]==4.21.0",
    license: "MIT",
    source: "https://github.com/mibayy/token-savior",
  },
  codeReviewGraph: {
    package: "code-review-graph==2.3.7",
    license: "MIT",
    source: "https://github.com/DeusData/code-review-graph",
  },
  codebaseMemory: {
    package: "codebase-memory-mcp==0.10.5",
    license: "MIT",
    source: "https://github.com/DeusData/codebase-memory-mcp",
  },
};
const cacheGeneration = createHash("sha256")
  .update(JSON.stringify(pins))
  .digest("hex")
  .slice(0, 16);
const repoKey = createHash("sha256")
  .update(`${repoRoot}\0${cacheGeneration}`)
  .digest("hex")
  .slice(0, 16);
const cacheRoot =
  process.env.AIH_REPO_AI_TOOLS_HOME ||
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || homedir(), "aih-cache")
    : join(homedir(), ".cache"));
const installRoot = join(cacheRoot, "aih", "repo-ai-tools", repoKey);
const uvToolRoot = join(installRoot, "uv");
const binRoot = join(installRoot, "bin");
const tokenOptimizerRoot = join(installRoot, "token-optimizer", "v5.11.68");
const tokenOptimizerClaudeScope = join(installRoot, "token-optimizer", "claude-scope");
const serenaOverridesPath = join(installRoot, "serena-security-overrides.txt");
const serenaContextPath = join(installRoot, "serena-codex-context.yml");
const codeReviewGraphRoot = join(installRoot, "code-review-graph");
const codebaseMemoryRoot = join(installRoot, "codebase-memory");
const codebaseMemoryMarker = join(codebaseMemoryRoot, "indexed.json");
const codexConfigPath = join(repoRoot, ".codex", "config.toml");
const scriptPath = fileURLToPath(import.meta.url);

const serenaExcludedTools = [
  "create_text_file",
  "read_file",
  "execute_shell_command",
  "replace_content",
  "replace_in_files",
  "find_file",
  "list_dir",
];
const serenaEnabledTools = [
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
  "get_diagnostics_for_file",
  "search_for_pattern",
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
];
const tokenSaviorEnabledTools = [
  "get_entry_points",
  "search_codebase",
  "find_symbol",
  "get_call_chain",
  "get_function_source",
  "get_full_context",
];
const codeReviewGraphEnabledTools = [
  "get_impact_radius_tool",
  "get_affected_flows_tool",
  "get_review_context_tool",
  "detect_changes_tool",
  "build_or_update_graph_tool",
];
const codebaseMemoryEnabledTools = [
  "index_repository",
  "search_graph",
  "query_graph",
  "trace_path",
  "get_code_snippet",
  "get_graph_schema",
  "get_architecture",
  "search_code",
  "list_projects",
  "index_status",
  "detect_changes",
  "manage_adr",
  "check_index_coverage",
];

const plan = {
  pins,
  cache: {
    generation: cacheGeneration,
    keyInputs: ["repository-path", "tool-pins"],
  },
  runtime: {
    serena: {
      context: "repo-symbols",
      mode: "no-memories",
      singleProject: true,
      excludedTools: serenaExcludedTools,
      enabledTools: serenaEnabledTools,
    },
    tokenOptimizer: {
      actions: ["report", "coach"],
      clients: ["claude", "codex"],
      codexClaudeSessionFallback: false,
      profile: "quiet",
      event: "Stop",
    },
    tokenSavior: {
      profile: "optimized",
      memory: false,
      shellHooks: false,
      excludePatterns: [".token-savior-cache.json"],
      enabledTools: tokenSaviorEnabledTools,
    },
    codeReviewGraph: {
      role: "broad-impact-review",
      advisory: true,
      enabledTools: codeReviewGraphEnabledTools,
    },
    codebaseMemory: {
      role: "find-trace-recall",
      advisory: true,
      enabledTools: codebaseMemoryEnabledTools,
    },
  },
  bootstrap: {
    codex: {
      setupCommand: "setup-codex",
      doctorCommand: "doctor-codex",
      projection: ".codex/config.toml",
      ecc: {
        marketplace: "affaan-m/ECC",
        plugin: "ecc@ecc",
        lifecycle: "native-plugin",
      },
      tokenOptimizer: {
        integration: "on-demand",
        commands: ["token-optimizer-report", "token-optimizer-coach"],
      },
      mcpServers: {
        serena: { launcher: "serena-mcp", enabledTools: serenaEnabledTools },
        tokenSavior: {
          launcher: "token-savior-mcp",
          enabledTools: tokenSaviorEnabledTools,
        },
        codeReviewGraph: {
          launcher: "code-review-graph-mcp",
          enabledTools: codeReviewGraphEnabledTools,
        },
        codebaseMemory: {
          launcher: "codebase-memory-mcp",
          enabledTools: codebaseMemoryEnabledTools,
        },
      },
    },
  },
  installRoot: "project-and-toolset-keyed user cache",
};

function fail(message) {
  process.stderr.write(`[repo-ai-tools] ${message}\n`);
  process.exitCode = 1;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `: ${(result.stderr ?? "").trim()}` : "";
    throw new Error(`${command} exited ${result.status}${detail}`);
  }
  return options.capture ? (result.stdout ?? "").trim() : "";
}

function runProbe(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: options.env ?? process.env,
    timeout: options.timeout,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error,
  };
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function hasErrorCode(error, code) {
  return typeof error === "object" && error !== null && error.code === code;
}

function readOptionalUtf8(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function writeNewFileExclusively(path, contents) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function assertUnchangedDestination(path, expectedExisting) {
  if (readOptionalUtf8(path) !== expectedExisting) {
    throw new Error(`generated file changed during atomic update: ${path}`);
  }
}

function writeFileAtomically(path, contents, expectedExisting) {
  let temporaryPath;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      temporaryPath = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        writeNewFileExclusively(temporaryPath, contents);
        break;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        temporaryPath = undefined;
      }
    }
    if (temporaryPath === undefined) {
      throw new Error(`could not reserve temporary generated-file path: ${path}`);
    }
    assertUnchangedDestination(path, expectedExisting);
    renameSync(temporaryPath, path);
    temporaryPath = undefined;
  } finally {
    if (temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
    }
  }
}

function assertCommand(name) {
  const probe = runProbe(process.platform === "win32" ? "where.exe" : "which", [name]);
  if (!probe.ok) throw new Error(`missing required command: ${name}`);
}

function runCodex(args, options = {}) {
  if (process.platform === "win32") {
    return runChecked(
      process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "codex.cmd", ...args],
      options,
    );
  }
  return runChecked("codex", args, options);
}

function localToolEnv() {
  return {
    ...process.env,
    UV_TOOL_DIR: uvToolRoot,
    UV_TOOL_BIN_DIR: binRoot,
    UV_NO_PROGRESS: "1",
  };
}

function executable(name) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(binRoot, `${name}${suffix}`);
}

function toolPython(name) {
  return process.platform === "win32"
    ? join(uvToolRoot, name, "Scripts", "python.exe")
    : join(uvToolRoot, name, "bin", "python");
}

function verifyTokenOptimizerCheckout() {
  const optimizerCommit = runChecked("git", ["-C", tokenOptimizerRoot, "rev-parse", "HEAD"], {
    capture: true,
  });
  if (optimizerCommit !== plan.pins.tokenOptimizer.commit) {
    throw new Error(
      `token-optimizer commit mismatch: expected ${plan.pins.tokenOptimizer.commit}, got ${optimizerCommit}`,
    );
  }
  const optimizerTree = runChecked(
    "git",
    ["-C", tokenOptimizerRoot, "rev-parse", "HEAD^{tree}"],
    { capture: true },
  );
  if (optimizerTree !== plan.pins.tokenOptimizer.tree) {
    throw new Error(
      `token-optimizer tree mismatch: expected ${plan.pins.tokenOptimizer.tree}, got ${optimizerTree}`,
    );
  }
}

function writeSerenaContext() {
  mkdirSync(dirname(serenaContextPath), { recursive: true });
  const exclusions = serenaExcludedTools.map((name) => `  - ${name}`).join("\n");
  writeFileSync(
    serenaContextPath,
    [
      "description: AIH single-project symbolic lane for Codex",
      "prompt: |",
      "  Use Serena only for exact symbol, reference, diagnostic, and semantic-edit work.",
      "  Use Codex file and shell tools for ordinary reads, writes, search, and commands.",
      "excluded_tools:",
      exclusions,
      "included_optional_tools: []",
      "tool_description_overrides: {}",
      "single_project: true",
      "structured_tool_output: null",
      "",
    ].join("\n"),
    "utf8",
  );
}

function uvToolList() {
  return runChecked("uv", ["tool", "list"], {
    capture: true,
    env: localToolEnv(),
  });
}

function installUvTool(packageSpec, listEntry, options = {}) {
  const installed = uvToolList();
  if (!options.force && installed.includes(listEntry)) return;
  const args = ["tool", "install"];
  if (options.force) args.push("--force");
  args.push("--python", "3.13", "--no-python-downloads");
  if (options.overrides) args.push("--overrides", options.overrides);
  args.push(packageSpec);
  runChecked("uv", args, { env: localToolEnv() });
}

function install() {
  mkdirSync(binRoot, { recursive: true });
  installUvTool(plan.pins.tokenSavior.package, "token-savior-recall v4.21.0");
  installUvTool(plan.pins.codeReviewGraph.package, "code-review-graph v2.3.7");
  installUvTool(plan.pins.codebaseMemory.package, "codebase-memory-mcp v0.10.5");
  writeFileSync(
    serenaOverridesPath,
    `${plan.pins.serena.securityOverrides.join("\n")}\n`,
    "utf8",
  );
  const serenaInstalled = uvToolList().includes("serena-agent v1.7.0");
  let serenaOverridesMatch = false;
  if (serenaInstalled && existsSync(toolPython("serena-agent"))) {
    const versions = runProbe(
      toolPython("serena-agent"),
      [
        "-c",
        "import importlib.metadata as m; print('|'.join(m.version(n) for n in ('python-multipart','starlette')))",
      ],
      { timeout: 10_000 },
    );
    serenaOverridesMatch = versions.ok && versions.stdout === "0.0.32|1.3.1";
  }
  if (!serenaInstalled || !serenaOverridesMatch) {
    installUvTool(plan.pins.serena.package, "serena-agent v1.7.0", {
      force: true,
      overrides: serenaOverridesPath,
    });
  }
  writeSerenaContext();

  let tokenOptimizerReady = false;
  if (existsSync(tokenOptimizerRoot)) {
    try {
      verifyTokenOptimizerCheckout();
      tokenOptimizerReady = true;
    } catch {
      const expectedParent = join(installRoot, "token-optimizer");
      if (dirname(tokenOptimizerRoot) !== expectedParent) {
        throw new Error("refusing to repair token-optimizer outside its generated cache");
      }
      process.stderr.write("[repo-ai-tools] repairing incomplete token-optimizer cache clone\n");
      rmSync(tokenOptimizerRoot, { recursive: true, force: true });
    }
  }
  if (!tokenOptimizerReady) {
    mkdirSync(dirname(tokenOptimizerRoot), { recursive: true });
    runChecked("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      plan.pins.tokenOptimizer.tag,
      plan.pins.tokenOptimizer.source,
      tokenOptimizerRoot,
    ]);
  }

  verifyTokenOptimizerCheckout();

  verify({ quiet: true });
}

function verify({ quiet = false } = {}) {
  const installed = runChecked("uv", ["tool", "list"], {
    capture: true,
    env: localToolEnv(),
  });
  for (const expected of [
    "token-savior-recall v4.21.0",
    "serena-agent v1.7.0",
    "code-review-graph v2.3.7",
    "codebase-memory-mcp v0.10.5",
  ]) {
    if (!installed.includes(expected)) throw new Error(`missing repo-local tool: ${expected}`);
  }
  for (const name of ["token-savior", "serena", "code-review-graph", "codebase-memory-mcp"]) {
    if (!existsSync(executable(name))) throw new Error(`missing repo-local executable: ${name}`);
  }
  const serenaDependencyVersions = runChecked(
    toolPython("serena-agent"),
    [
      "-c",
      "import importlib.metadata as m; print('|'.join(m.version(n) for n in ('python-multipart','starlette')))",
    ],
    { capture: true },
  );
  if (serenaDependencyVersions !== "0.0.32|1.3.1") {
    throw new Error(`Serena security override mismatch: ${serenaDependencyVersions}`);
  }
  verifyTokenOptimizerCheckout();
  if (!existsSync(serenaContextPath)) throw new Error("missing generated Serena context");
  if (!quiet) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, installed: plan.pins, root: installRoot }, null, 2)}\n`,
    );
  }
}

function runMcp(name, args, env = process.env) {
  const command = executable(name);
  if (!existsSync(command)) {
    fail(`missing ${name}; run: node tools/repo-ai-tools.mjs install`);
    return;
  }
  const child = spawn(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  child.on("error", (error) => fail(`${name} failed to start: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

function tokenSaviorMcp() {
  const client = process.env.CLAUDECODE
    ? "claude-code"
    : process.env.CODEX_HOME || process.env.CODEX_SANDBOX
      ? "codex"
      : "aih";
  runMcp("token-savior", [], {
    ...process.env,
    TOKEN_SAVIOR_CLIENT: client,
    TOKEN_SAVIOR_PROFILE: "optimized",
    TOKEN_SAVIOR_EXCLUDE_PATTERNS: [
      process.env.TOKEN_SAVIOR_EXCLUDE_PATTERNS,
      plan.runtime.tokenSavior.excludePatterns.join(":"),
    ]
      .filter(Boolean)
      .join(":"),
    TS_CAPTURE_DISABLED: "1",
    TS_MEMORY_DISABLE: "1",
    TS_NO_HINTS: "1",
    WORKSPACE_ROOTS: repoRoot,
  });
}

function serenaMcp() {
  runMcp("serena", [
    "start-mcp-server",
    "--context",
    serenaContextPath,
    "--project",
    repoRoot,
    "--mode",
    "no-memories",
    "--enable-web-dashboard=false",
    "--open-web-dashboard=false",
    "--enable-gui-log-window=false",
    "--log-level=WARNING",
  ]);
}

function codeReviewGraphEnv() {
  return { ...process.env, CRG_DATA_DIR: codeReviewGraphRoot };
}

function codeReviewGraphMcp() {
  runMcp(
    "code-review-graph",
    [
      "serve",
      "--repo",
      repoRoot,
      "--tools",
      codeReviewGraphEnabledTools.join(","),
    ],
    codeReviewGraphEnv(),
  );
}

function codebaseMemoryEnv() {
  return {
    ...process.env,
    CBM_ALLOWED_ROOT: repoRoot,
    CBM_CACHE_DIR: codebaseMemoryRoot,
    CBM_LOG_LEVEL: "warn",
  };
}

function codebaseMemoryMcp() {
  runMcp("codebase-memory-mcp", [], codebaseMemoryEnv());
}

function tokenOptimizerRuntime() {
  if (
    process.env.CLAUDECODE ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CLAUDE_CODE_ENTRYPOINT
  ) {
    return "claude";
  }
  return "codex";
}

function tokenOptimizerPythonCandidates() {
  return process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];
}

function runTokenOptimizer(args, { quiet = false, timeout } = {}) {
  const measure = join(
    tokenOptimizerRoot,
    "skills",
    "token-optimizer",
    "scripts",
    "measure.py",
  );
  if (!existsSync(measure)) {
    if (!quiet) fail("token-optimizer is missing; run: node tools/repo-ai-tools.mjs install");
    return;
  }

  const runtime = tokenOptimizerRuntime();
  const env = { ...process.env, TOKEN_OPTIMIZER_RUNTIME: runtime };
  if (runtime === "codex") {
    mkdirSync(tokenOptimizerClaudeScope, { recursive: true });
    env.CLAUDE_CONFIG_DIR = tokenOptimizerClaudeScope;
  }

  for (const [python, prefix] of tokenOptimizerPythonCandidates()) {
    const result = spawnSync(python, [...prefix, measure, ...args], {
      cwd: repoRoot,
      env,
      stdio: quiet ? "ignore" : "inherit",
      timeout,
    });
    if (result.error?.code === "ENOENT") continue;
    if (!quiet && result.status !== 0) process.exitCode = result.status ?? 1;
    return;
  }
  if (!quiet) fail("Python 3 is required to run token-optimizer");
}

function tokenOptimizerStop() {
  runTokenOptimizer(
    ["session-end-flush", "--trigger", "stop", "--quiet", "--defer"],
    { quiet: true, timeout: 7_000 },
  );
}

const projectMcpServers = [
  {
    name: "serena",
    launcher: "serena-mcp",
    enabledTools: serenaEnabledTools,
    startupTimeout: 60,
    toolTimeout: 180,
  },
  {
    name: "token-savior",
    launcher: "token-savior-mcp",
    enabledTools: tokenSaviorEnabledTools,
    startupTimeout: 45,
    toolTimeout: 120,
  },
  {
    name: "code-review-graph",
    launcher: "code-review-graph-mcp",
    enabledTools: codeReviewGraphEnabledTools,
    startupTimeout: 60,
    toolTimeout: 180,
  },
  {
    name: "codebase-memory-mcp",
    launcher: "codebase-memory-mcp",
    enabledTools: codebaseMemoryEnabledTools,
    startupTimeout: 90,
    toolTimeout: 300,
  },
];
const codexBlockBegin = "# BEGIN AIH REPO TOOLING (managed by npm run repo:init)";
const codexBlockEnd = "# END AIH REPO TOOLING";

function tomlString(value) {
  return JSON.stringify(value);
}

function renderCodexConfig() {
  const lines = [
    codexBlockBegin,
    "# Generated by: npm run repo:init",
    "# Machine-local projection; ai-coding remains the committed authority.",
    "",
  ];
  for (const server of projectMcpServers) {
    lines.push(
      `[mcp_servers.${tomlString(server.name)}]`,
      `command = ${tomlString("node")}`,
      `args = ${tomlString([scriptPath, server.launcher])}`,
      `cwd = ${tomlString(repoRoot)}`,
      `enabled_tools = ${tomlString(server.enabledTools)}`,
      `startup_timeout_sec = ${server.startupTimeout}`,
      `tool_timeout_sec = ${server.toolTimeout}`,
      "",
    );
  }
  lines.push(codexBlockEnd);
  return `${lines.join("\n")}\n`;
}

function writeCodexProjection() {
  mkdirSync(dirname(codexConfigPath), { recursive: true });
  const expected = renderCodexConfig();
  const existing = readOptionalUtf8(codexConfigPath);
  if (existing === undefined) {
    writeFileAtomically(codexConfigPath, expected, existing);
    return;
  }
  if (existing.includes(expected)) return;
  const begin = existing.indexOf(codexBlockBegin);
  const end = existing.indexOf(codexBlockEnd);
  if (begin >= 0 || end >= 0) {
    if (begin < 0 || end < begin) throw new Error("malformed managed Codex config block");
    const after = end + codexBlockEnd.length;
    const updated = `${existing.slice(0, begin)}${expected.trimEnd()}${existing.slice(after)}`;
    writeFileAtomically(
      codexConfigPath,
      updated.endsWith("\n") ? updated : `${updated}\n`,
      existing,
    );
    return;
  }
  if (existing.startsWith("# Generated by: npm run repo:init")) {
    writeFileAtomically(codexConfigPath, expected, existing);
    return;
  }
  for (const server of projectMcpServers) {
    const plainHeader = `[mcp_servers.${server.name}]`;
    const quotedHeader = `[mcp_servers.${tomlString(server.name)}]`;
    if (existing.includes(plainHeader) || existing.includes(quotedHeader)) {
      throw new Error(`existing Codex config already owns managed server: ${server.name}`);
    }
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileAtomically(codexConfigPath, `${existing}${separator}${expected}`, existing);
}

function configureEcc({ refresh = false } = {}) {
  const marketplaceInventory = parseJson(
    runCodex(["plugin", "marketplace", "list", "--json"], { capture: true }),
    "Codex marketplace inventory",
  );
  const marketplaces = Array.isArray(marketplaceInventory.marketplaces)
    ? marketplaceInventory.marketplaces
    : [];
  const eccMarketplace = marketplaces.find(
    (item) => typeof item?.name === "string" && item.name.toLowerCase() === "ecc",
  );
  if (!eccMarketplace) {
    runCodex([
      "plugin",
      "marketplace",
      "add",
      plan.bootstrap.codex.ecc.marketplace,
      "--json",
    ]);
  } else if (refresh) {
    runCodex([
      "plugin",
      "marketplace",
      "upgrade",
      eccMarketplace.name,
      "--json",
    ]);
  }

  const plugins = parseJson(
    runCodex(["plugin", "list", "--json"], { capture: true }),
    "Codex plugin inventory",
  );
  const installed = Array.isArray(plugins.installed) ? plugins.installed : [];
  if (!installed.some((item) => item?.pluginId === plan.bootstrap.codex.ecc.plugin)) {
    runCodex(["plugin", "add", plan.bootstrap.codex.ecc.plugin, "--json"]);
  }
}

function graphStatus() {
  const result = runProbe(
    executable("code-review-graph"),
    ["status", "--repo", repoRoot, "--data-dir", codeReviewGraphRoot, "--json"],
    { env: codeReviewGraphEnv(), timeout: 30_000 },
  );
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function hasPositiveGraphMetric(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "number" &&
      entry > 0 &&
      /(^|_)(files?|nodes?)(_|$)|(?:file|node).*count/i.test(key)
    ) {
      return true;
    }
    if (hasPositiveGraphMetric(entry)) return true;
  }
  return false;
}

function initializeCodeReviewGraph() {
  mkdirSync(codeReviewGraphRoot, { recursive: true });
  const status = graphStatus();
  if (status && hasPositiveGraphMetric(status)) return;
  runChecked(
    executable("code-review-graph"),
    ["build", "--repo", repoRoot, "--data-dir", codeReviewGraphRoot, "--quiet"],
    { env: codeReviewGraphEnv(), timeout: 900_000 },
  );
}

function initializeCodebaseMemory() {
  mkdirSync(codebaseMemoryRoot, { recursive: true });
  const markerText = readOptionalUtf8(codebaseMemoryMarker);
  if (markerText !== undefined) {
    const marker = parseJson(markerText, "codebase-memory marker");
    if (marker.repository === repoRoot && marker.generation === cacheGeneration) return;
  }
  runChecked(
    executable("codebase-memory-mcp"),
    ["cli", "index_repository", "--repo-path", repoRoot, "--mode", "moderate"],
    { env: codebaseMemoryEnv(), timeout: 1_800_000 },
  );
  writeFileAtomically(
    codebaseMemoryMarker,
    `${JSON.stringify({ repository: repoRoot, generation: cacheGeneration }, null, 2)}\n`,
    markerText,
  );
}

function codebaseMemoryStatus() {
  const inventory = parseJson(
    runChecked(executable("codebase-memory-mcp"), ["cli", "list_projects"], {
      capture: true,
      env: codebaseMemoryEnv(),
      timeout: 120_000,
    }),
    "codebase-memory project inventory",
  );
  const projects = Array.isArray(inventory.projects) ? inventory.projects : [];
  const project = projects.find(
    (item) =>
      typeof item?.root_path === "string" &&
      resolve(item.root_path).toLowerCase() === repoRoot.toLowerCase(),
  );
  if (!project || project.nodes <= 0 || project.edges <= 0) {
    throw new Error("codebase-memory-mcp has no populated index for this repository");
  }
  return { nodes: project.nodes, edges: project.edges };
}

const mcpProbeScript = String.raw`
import asyncio
import json
import os
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    params = StdioServerParameters(
        command=os.environ["AIH_MCP_COMMAND"],
        args=json.loads(os.environ["AIH_MCP_ARGS"]),
    )
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            result = await session.list_tools()
            print(json.dumps(sorted(tool.name for tool in result.tools)))

asyncio.run(main())
`;

function probeMcpServer(server) {
  const output = runChecked(toolPython("serena-agent"), ["-c", mcpProbeScript], {
    capture: true,
    timeout: Math.max(server.startupTimeout * 1_000, 120_000),
    env: {
      ...process.env,
      AIH_MCP_COMMAND: "node",
      AIH_MCP_ARGS: JSON.stringify([scriptPath, server.launcher]),
    },
  });
  const exposed = parseJson(output, `${server.name} MCP tool inventory`);
  if (!Array.isArray(exposed)) throw new Error(`${server.name} MCP returned a malformed tool list`);
  const missing = server.enabledTools.filter((tool) => !exposed.includes(tool));
  if (missing.length > 0) {
    throw new Error(`${server.name} MCP is missing expected tools: ${missing.join(", ")}`);
  }
  return exposed.length;
}

function verifyCodexProjection() {
  if (!existsSync(codexConfigPath)) throw new Error("missing project-local Codex projection");
  const expectedText = renderCodexConfig();
  if (!readFileSync(codexConfigPath, "utf8").includes(expectedText)) {
    throw new Error("project-local Codex projection differs from the pinned plan");
  }
  for (const server of projectMcpServers) {
    const entry = parseJson(
      runCodex(["mcp", "get", server.name, "--json"], { capture: true }),
      `Codex MCP entry ${server.name}`,
    );
    const transport = entry.transport ?? entry;
    if (transport.command !== "node") throw new Error(`${server.name} Codex command drifted`);
    if (!Array.isArray(transport.args) || !transport.args.includes(server.launcher)) {
      throw new Error(`${server.name} Codex launcher drifted`);
    }
    if (
      !Array.isArray(entry.enabled_tools) ||
      entry.enabled_tools.some((tool) => typeof tool !== "string")
    ) {
      throw new Error(`${server.name} Codex enabled_tools managed list is malformed`);
    }
    const enabledTools = entry.enabled_tools;
    const missing = server.enabledTools.filter((tool) => !enabledTools.includes(tool));
    if (missing.length > 0) {
      throw new Error(`${server.name} Codex tool allowlist drifted: ${missing.join(", ")}`);
    }
  }
}

function verifyEcc() {
  const plugins = parseJson(
    runCodex(["plugin", "list", "--json"], { capture: true }),
    "Codex plugin inventory",
  );
  const installed = Array.isArray(plugins.installed) ? plugins.installed : [];
  const ecc = installed.find((item) => item?.pluginId === plan.bootstrap.codex.ecc.plugin);
  if (!ecc?.installed || !ecc?.enabled) throw new Error("ECC is not installed and enabled in Codex");
  const cachedInstallPath = join(
    homedir(),
    ".codex",
    "plugins",
    "cache",
    ecc.marketplaceName,
    ecc.name,
    ecc.version,
  );
  const installedPath = existsSync(cachedInstallPath) ? cachedInstallPath : ecc.source?.path;
  if (typeof installedPath !== "string" || !existsSync(installedPath)) {
    throw new Error("ECC installed path is missing");
  }
  return { pluginId: ecc.pluginId, version: ecc.version, installedPath };
}

function verifyCanonRouting() {
  const required = [
    [join(repoRoot, "ai-coding", "RULE_ROUTER.md"), "rules/repo-ai-tools.md"],
    [join(repoRoot, "ai-coding", "setup.md"), "npm run repo:init"],
    [join(repoRoot, "ai-coding", "rules", "repo-ai-tools.md"), "find, trace, and recall"],
  ];
  for (const [path, text] of required) {
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(text)) {
      throw new Error(`repo AI routing is incomplete: ${path}`);
    }
  }
}

function doctorCodex() {
  for (const name of ["node", "git", "uv", "codex", "rg", "fd", "tree"]) {
    assertCommand(name);
  }
  verify({ quiet: true });
  verifyCanonRouting();
  verifyCodexProjection();
  const ecc = verifyEcc();
  const status = graphStatus();
  if (!status || !hasPositiveGraphMetric(status)) {
    throw new Error("code-review-graph has no populated repo-scoped graph");
  }
  if (!existsSync(codebaseMemoryMarker)) {
    throw new Error("codebase-memory-mcp has no completed repo index marker");
  }
  const memory = codebaseMemoryStatus();
  const mcp = Object.fromEntries(
    projectMcpServers.map((server) => [server.name, { exposedTools: probeMcpServer(server) }]),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        repository: repoRoot,
        cacheGeneration,
        projection: codexConfigPath,
        ecc,
        indexes: {
          codeReviewGraph: "populated",
          codebaseMemory: memory,
        },
        mcp,
        tokenOptimizer: {
          integration: "on-demand",
          commands: plan.bootstrap.codex.tokenOptimizer.commands,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function setupCodex({ dryRun = false, refreshEcc = false } = {}) {
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          command: "setup-codex",
          dryRun: true,
          mutations: [
            "install pinned repo AI tools",
            "write ignored Codex project projection",
            "install or refresh ECC through the native Codex plugin lifecycle",
            "initialize project-scoped graph and memory indexes",
            "enable the repository pre-commit hook path",
          ],
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  for (const name of ["node", "git", "uv", "codex", "rg", "fd", "tree"]) {
    assertCommand(name);
  }
  const hooksPath = runChecked("git", ["config", "--get", "core.hooksPath"], {
    capture: true,
  });
  if (hooksPath !== ".githooks") {
    runChecked("git", ["config", "core.hooksPath", ".githooks"]);
  }
  install();
  writeCodexProjection();
  configureEcc({ refresh: refreshEcc });
  initializeCodeReviewGraph();
  initializeCodebaseMemory();
  doctorCodex();
}

const command = process.argv[2];
try {
  if (command === "plan") process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else if (command === "install") install();
  else if (command === "verify") verify();
  else if (command === "token-savior-mcp") tokenSaviorMcp();
  else if (command === "serena-mcp") serenaMcp();
  else if (command === "code-review-graph-mcp") codeReviewGraphMcp();
  else if (command === "codebase-memory-mcp") codebaseMemoryMcp();
  else if (command === "setup-codex") {
    setupCodex({
      dryRun: process.argv.includes("--dry-run"),
      refreshEcc: process.argv.includes("--refresh-ecc"),
    });
  }
  else if (command === "doctor-codex") doctorCodex();
  else if (command === "token-optimizer-stop") tokenOptimizerStop();
  else if (command === "token-optimizer-report") runTokenOptimizer(["report"]);
  else if (command === "token-optimizer-coach") runTokenOptimizer(["coach"]);
  else {
    fail(
      "usage: repo-ai-tools.mjs <plan|install|verify|setup-codex|doctor-codex|token-savior-mcp|serena-mcp|code-review-graph-mcp|codebase-memory-mcp|token-optimizer-stop|token-optimizer-report|token-optimizer-coach>",
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
