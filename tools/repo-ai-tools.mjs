#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
const cacheRoot =
  process.env.AIH_REPO_AI_TOOLS_HOME ||
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || homedir(), "aih-cache")
    : join(homedir(), ".cache"));
const installRoot = join(cacheRoot, "aih", "repo-ai-tools", repoKey);
const uvToolRoot = join(installRoot, "uv");
const binRoot = join(installRoot, "bin");
const tokenOptimizerRoot = join(installRoot, "token-optimizer", "v5.11.44");
const tokenOptimizerClaudeScope = join(installRoot, "token-optimizer", "claude-scope");
const serenaOverridesPath = join(installRoot, "serena-security-overrides.txt");

const plan = {
  pins: {
    serena: {
      package: "serena-agent==1.5.3",
      license: "MIT",
      source: "https://github.com/oraios/serena",
      securityOverrides: [
        "cryptography==49.0.0",
        "python-multipart==0.0.32",
        "starlette==1.3.1",
      ],
    },
    tokenOptimizer: {
      tag: "v5.11.44",
      commit: "bbe6c9a4bc2694be5c718b4ef77a729f3a8646dc",
      license: "PolyForm-Noncommercial-1.0.0",
      source: "https://github.com/alexgreensh/token-optimizer",
    },
    tokenSavior: {
      package: "token-savior-recall[mcp]==4.4.1",
      license: "MIT",
      source: "https://github.com/mibayy/token-savior",
    },
  },
  runtime: {
    serena: { context: "ide", mode: "no-memories" },
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
    },
  },
  installRoot: "project-keyed user cache",
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
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `: ${(result.stderr ?? "").trim()}` : "";
    throw new Error(`${command} exited ${result.status}${detail}`);
  }
  return options.capture ? (result.stdout ?? "").trim() : "";
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

function install() {
  mkdirSync(binRoot, { recursive: true });
  const env = localToolEnv();
  runChecked(
    "uv",
    ["tool", "install", "--python", "3.13", "--no-python-downloads", plan.pins.tokenSavior.package],
    { env },
  );
  writeFileSync(
    serenaOverridesPath,
    `${plan.pins.serena.securityOverrides.join("\n")}\n`,
    "utf8",
  );
  runChecked(
    "uv",
    [
      "tool",
      "install",
      "--force",
      "--python",
      "3.13",
      "--no-python-downloads",
      "--overrides",
      serenaOverridesPath,
      plan.pins.serena.package,
    ],
    { env },
  );

  if (!existsSync(tokenOptimizerRoot)) {
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

  const optimizerCommit = runChecked("git", ["-C", tokenOptimizerRoot, "rev-parse", "HEAD"], {
    capture: true,
  });
  if (optimizerCommit !== plan.pins.tokenOptimizer.commit) {
    throw new Error(
      `token-optimizer pin mismatch: expected ${plan.pins.tokenOptimizer.commit}, got ${optimizerCommit}`,
    );
  }

  verify();
}

function verify() {
  const installed = runChecked("uv", ["tool", "list"], {
    capture: true,
    env: localToolEnv(),
  });
  for (const expected of ["token-savior-recall v4.4.1", "serena-agent v1.5.3"]) {
    if (!installed.includes(expected)) throw new Error(`missing repo-local tool: ${expected}`);
  }
  for (const name of ["token-savior", "serena"]) {
    if (!existsSync(executable(name))) throw new Error(`missing repo-local executable: ${name}`);
  }
  const serenaDependencyVersions = runChecked(
    toolPython("serena-agent"),
    [
      "-c",
      "import importlib.metadata as m; print('|'.join(m.version(n) for n in ('cryptography','python-multipart','starlette')))",
    ],
    { capture: true },
  );
  if (serenaDependencyVersions !== "49.0.0|0.0.32|1.3.1") {
    throw new Error(`Serena security override mismatch: ${serenaDependencyVersions}`);
  }
  const optimizerCommit = runChecked("git", ["-C", tokenOptimizerRoot, "rev-parse", "HEAD"], {
    capture: true,
  });
  if (optimizerCommit !== plan.pins.tokenOptimizer.commit) {
    throw new Error("token-optimizer checkout does not match the approved commit");
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, installed: plan.pins, root: installRoot }, null, 2)}\n`,
  );
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
    "--context=ide",
    "--project",
    repoRoot,
    "--mode",
    "no-memories",
  ]);
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

const command = process.argv[2];
try {
  if (command === "plan") process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else if (command === "install") install();
  else if (command === "verify") verify();
  else if (command === "token-savior-mcp") tokenSaviorMcp();
  else if (command === "serena-mcp") serenaMcp();
  else if (command === "token-optimizer-stop") tokenOptimizerStop();
  else if (command === "token-optimizer-report") runTokenOptimizer(["report"]);
  else if (command === "token-optimizer-coach") runTokenOptimizer(["coach"]);
  else {
    fail(
      "usage: repo-ai-tools.mjs <plan|install|verify|token-savior-mcp|serena-mcp|token-optimizer-stop|token-optimizer-report|token-optimizer-coach>",
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
