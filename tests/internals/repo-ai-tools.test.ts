import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hermeticGitEnv } from "../git-fixture-env.js";

const root = resolve(import.meta.dirname, "../..");
const TEST_PROCESS_TIMEOUT_MS = 10_000;

function toolingPlan(): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", "plan"], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;
}

function toolingCommand(...args: string[]): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;
}

function toolingPlanWithEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", "plan"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }),
  ) as Record<string, unknown>;
}

function toolingPlanFrom(script: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, [script, "plan"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    }),
  ) as Record<string, unknown>;
}

function managedCacheRootReader(config: string | undefined): () => string | undefined {
  const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
  const start = launcher.indexOf("function readManagedCacheRoot");
  if (start < 0) return () => undefined;
  const source = launcher.slice(start, launcher.indexOf("function hasErrorCode", start));
  return new Function(
    "deps",
    `
      const { codexBlockBegin, codexBlockEnd, codexConfigPath, isAbsolute,
        readOptionalUtf8, resolve } = deps;
      ${source}
      return readManagedCacheRoot;
    `,
  )({
    codexBlockBegin: "# BEGIN AIH REPO TOOLING (managed by npm run repo:init)",
    codexBlockEnd: "# END AIH REPO TOOLING",
    codexConfigPath: "/repo/.codex/config.toml",
    isAbsolute: (path: string) => path.startsWith("/") || /^[A-Z]:[\\/]/i.test(path),
    readOptionalUtf8: () => config,
    resolve: (path: string) => path,
  }) as () => string | undefined;
}

function projectionVerifier(entries: Record<string, unknown>): () => void {
  const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
  const verifierSource = launcher.slice(
    launcher.indexOf("function verifyCodexProjection"),
    launcher.indexOf("function verifyEcc"),
  );
  return new Function(
    "deps",
    `
      const { cacheRoot, codexConfigPath, existsSync, parseJson, projectMcpServers, readFileSync,
        renderCodexConfig, runCodex } = deps;
      ${verifierSource}
      return verifyCodexProjection;
    `,
  )({
    cacheRoot: "/managed/cache-base",
    codexConfigPath: "/work/.codex/config.toml",
    existsSync: () => true,
    parseJson: (value: string) => JSON.parse(value),
    projectMcpServers: [{ name: "serena", launcher: "serena-mcp", enabledTools: ["find_symbol"] }],
    readFileSync: () => "expected projection",
    renderCodexConfig: () => "expected projection",
    runCodex: (args: string[]) => JSON.stringify(entries[args[2] ?? ""]),
  }) as () => void;
}

/**
 * True when `git ls-files` reports the path as part of the tracked index.
 * `existsSync` cannot stand in for this: an operator's local, gitignored
 * AI-client projections (see ai-coding/rules/repo-ai-tools.md — "optional
 * local projections") legitimately exist on disk without being tracked, so a
 * filesystem-existence assertion fails on any workstation that carries them
 * even though the repository itself is clean. Probe tracking/ignore state
 * with real git, per ai-coding/rules/engine-invariants.md.
 */
function isTrackedByGit(relativePath: string): boolean {
  const out = execFileSync("git", ["ls-files", "--", relativePath], {
    cwd: root,
    encoding: "utf8",
    timeout: TEST_PROCESS_TIMEOUT_MS,
    env: hermeticGitEnv(),
  });
  return out.trim().length > 0;
}

/** `git check-ignore -q <path>` exits 0 iff the path IS ignored, 1 if it is NOT. */
function isIgnoredByGit(relativePath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relativePath], {
      cwd: root,
      timeout: TEST_PROCESS_TIMEOUT_MS,
      env: hermeticGitEnv(),
    });
    return true; // exit 0 -> ignored
  } catch {
    return false; // exit 1 -> not ignored
  }
}

/**
 * The repo-hygiene predicate: a path must never enter the Git index, and —
 * so it cannot be staged by accident either — must be ignore-covered
 * whenever it happens to exist on disk (an absent path trivially satisfies
 * the "can't be staged" intent).
 */
function expectUntrackedAndIgnored(relativePath: string): void {
  expect(isTrackedByGit(relativePath), relativePath).toBe(false);
  expect(
    isIgnoredByGit(relativePath) || !existsSync(resolve(root, relativePath)),
    relativePath,
  ).toBe(true);
}

type AtomicWriterFilesystem = {
  closeSync: (descriptor: string) => void;
  files: Map<string, string>;
  mkdirSync: () => void;
  openSync: (path: string, flags: string, mode: number) => string;
  readFileSync: (path: string, encoding: string) => string;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
  writeFileSync: (descriptor: string, contents: string, encoding: string) => void;
};

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function loadAtomicWriter(
  filesystem: AtomicWriterFilesystem,
  ids = ["first", "second"],
): (path: string, contents: string, expectedExisting?: string) => void {
  const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
  const atomicFunctions = launcher.slice(
    launcher.indexOf("function hasErrorCode"),
    launcher.indexOf("function assertCommand"),
  );
  const factory = new Function(
    "filesystem",
    "ids",
    `
      const {
        closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
      } = filesystem;
      const basename = (path) => path.slice(path.lastIndexOf("/") + 1);
      const dirname = (path) => path.slice(0, path.lastIndexOf("/")) || ".";
      const join = (...parts) => parts.join("/").replaceAll("//", "/");
      const process = { pid: 1 };
      const randomUUID = () => ids.shift();
      ${atomicFunctions}
      return writeFileAtomically;
    `,
  ) as (
    fs: AtomicWriterFilesystem,
    values: string[],
  ) => (path: string, contents: string, expectedExisting?: string) => void;
  return factory(filesystem, [...ids]);
}

function createAtomicWriterFilesystem(
  options: {
    collisionCount?: number;
    failClose?: boolean;
    failRename?: boolean;
    failWrite?: boolean;
    files?: Record<string, string>;
  } = {},
): AtomicWriterFilesystem & { openPaths: string[]; removedPaths: string[] } {
  const files = new Map(Object.entries(options.files ?? {}));
  let collisionsRemaining = options.collisionCount ?? 0;
  const openPaths: string[] = [];
  const removedPaths: string[] = [];
  return {
    files,
    openPaths,
    removedPaths,
    mkdirSync() {},
    openSync(path, flags, mode) {
      expect(flags).toBe("wx");
      expect(mode).toBe(0o600);
      openPaths.push(path);
      if (collisionsRemaining > 0) {
        collisionsRemaining -= 1;
        throw errno("EEXIST");
      }
      if (files.has(path)) throw errno("EEXIST");
      files.set(path, "");
      return path;
    },
    writeFileSync(descriptor, contents, encoding) {
      expect(encoding).toBe("utf8");
      if (options.failWrite) throw new Error("write failed");
      files.set(descriptor, contents);
    },
    closeSync() {
      if (options.failClose) throw new Error("close failed");
    },
    readFileSync(path, encoding) {
      expect(encoding).toBe("utf8");
      const value = files.get(path);
      if (value === undefined) throw errno("ENOENT");
      return value;
    },
    renameSync(from, to) {
      if (options.failRename) throw new Error("rename failed");
      const value = files.get(from);
      if (value === undefined) throw errno("ENOENT");
      files.set(to, value);
      files.delete(from);
    },
    unlinkSync(path) {
      removedPaths.push(path);
      if (!files.delete(path)) throw errno("ENOENT");
    },
  };
}

type CodebaseMemoryHarness = {
  codebaseMemoryCompletion: () => { nodes: number; edges: number };
  codebaseMemoryProject: (inventory: unknown) => unknown;
  codebaseMemoryStatus: () => { nodes: number; edges: number };
  codebaseMemoryEnv: () => Record<string, string>;
  initializeCodebaseMemory: () => void;
  preflightCodebaseMemory: () => void;
};

function loadCodebaseMemoryHarness(deps: Record<string, unknown>): CodebaseMemoryHarness {
  const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
  const prepareIndex = launcher.indexOf("function prepareCodebaseMemoryRuntime");
  const envFunctions = launcher.slice(
    prepareIndex >= 0 ? prepareIndex : launcher.indexOf("function codebaseMemoryEnv"),
    launcher.indexOf("function codebaseMemoryMcp"),
  );
  const memoryFunctions = launcher.slice(
    launcher.indexOf("function initializeCodebaseMemory"),
    launcher.indexOf("const mcpProbeScript"),
  );
  return new Function(
    "deps",
    `
      const {
        codebaseMemoryCacheDir, codebaseMemoryGeneration,
        codebaseMemoryMarker, codebaseMemoryRoot, codebaseMemoryRuntimeDir,
        executable, isAbsolute, mkdirSync, parseJson, process, readOptionalUtf8, repoRoot, resolve, runChecked,
        writeFileAtomically,
      } = deps;
      ${envFunctions}
      ${memoryFunctions}
      return { codebaseMemoryEnv, codebaseMemoryProject, codebaseMemoryStatus,
        codebaseMemoryCompletion, initializeCodebaseMemory, preflightCodebaseMemory };
    `,
  )(deps) as CodebaseMemoryHarness;
}

function loadSetupCodex(deps: Record<string, unknown>): () => void {
  const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
  const setupStage = launcher.slice(
    launcher.indexOf("function setupStage"),
    launcher.indexOf("const mcpProbeScript"),
  );
  const setupCodex = launcher.slice(
    launcher.indexOf("function setupCodex"),
    launcher.indexOf("const command = process.argv[2]"),
  );
  return new Function(
    "deps",
    `
      const {
        assertCommand, configureEcc, doctorCodex, initializeCodeReviewGraph,
        initializeCodebaseMemory, install, preflightCodebaseMemory, runChecked,
        writeCodexProjection,
      } = deps;
      ${setupStage}
      ${setupCodex}
      return setupCodex;
    `,
  )(deps) as () => void;
}

function loadCodexRenderer(deps: Record<string, unknown>): () => string {
  const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
  const source = launcher.slice(
    launcher.indexOf("function tomlString"),
    launcher.indexOf("function writeCodexProjection"),
  );
  return new Function(
    "deps",
    `
      const { cacheRoot, codexBlockBegin, codexBlockEnd, projectMcpServers, repoRoot, scriptPath } = deps;
      ${source}
      return renderCodexConfig;
    `,
  )(deps) as () => string;
}

describe("ai-harness repo AI tooling", () => {
  it.each([
    [
      "absent",
      {
        transport: {
          command: "node",
          args: ["serena-mcp"],
          env: { AIH_REPO_AI_TOOLS_HOME: "/managed/cache-base" },
        },
      },
    ],
    [
      "non-array",
      {
        transport: {
          command: "node",
          args: ["serena-mcp"],
          env: { AIH_REPO_AI_TOOLS_HOME: "/managed/cache-base" },
        },
        enabled_tools: {},
      },
    ],
    [
      "non-string member",
      {
        transport: {
          command: "node",
          args: ["serena-mcp"],
          env: { AIH_REPO_AI_TOOLS_HOME: "/managed/cache-base" },
        },
        enabled_tools: ["find_symbol", 7],
      },
    ],
  ])("reports a malformed Codex managed enabled_tools list when it is %s", (_label, entry) => {
    expect(() => projectionVerifier({ serena: entry })()).toThrow(
      "serena Codex enabled_tools managed list is malformed",
    );
  });

  it("keeps a valid but incomplete Codex enabled_tools list as ordinary drift", () => {
    expect(() =>
      projectionVerifier({
        serena: {
          transport: {
            command: "node",
            args: ["serena-mcp"],
            env: { AIH_REPO_AI_TOOLS_HOME: "/managed/cache-base" },
          },
          enabled_tools: [],
        },
      })(),
    ).toThrow("serena Codex tool allowlist drifted: find_symbol");
  });

  it("rejects a projected MCP child that drifted to an ambient cache base", () => {
    expect(() =>
      projectionVerifier({
        serena: {
          transport: {
            command: "node",
            args: ["serena-mcp"],
            env: { AIH_REPO_AI_TOOLS_HOME: "/ambient/cache-base" },
          },
          enabled_tools: ["find_symbol"],
        },
      })(),
    ).toThrow("serena Codex managed cache binding drifted");
  });

  it("pins the complete repo toolchain and keeps each runtime scope narrow", () => {
    expect(toolingPlan()).toMatchObject({
      pins: {
        serena: {
          package: "serena-agent==1.7.0",
          license: "MIT",
          securityOverrides: ["python-multipart==0.0.32", "starlette==1.3.1"],
        },
        tokenOptimizer: {
          tag: "v5.11.68",
          commit: "ffe3b8007542260b17648a2d9228c3dedda380ad",
          tree: "d044ba6038ac705e8d0da6a4b545cbee00abe7d5",
          license: "PolyForm-Noncommercial-1.0.0",
        },
        tokenSavior: { package: "token-savior-recall[mcp]==4.21.0", license: "MIT" },
        codeReviewGraph: {
          package: "code-review-graph==2.3.7",
          license: "MIT",
          source: "https://github.com/tirth8205/code-review-graph",
        },
        codebaseMemory: { package: "codebase-memory-mcp==0.10.5", license: "MIT" },
      },
      runtime: {
        serena: {
          context: "repo-symbols",
          mode: "no-memories",
          singleProject: true,
          excludedTools: expect.arrayContaining([
            "execute_shell_command",
            "replace_content",
            "replace_in_files",
          ]),
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
          enabledTools: [
            "get_entry_points",
            "search_codebase",
            "find_symbol",
            "get_call_chain",
            "get_function_source",
            "get_full_context",
          ],
        },
        codeReviewGraph: { role: "broad-impact-review", advisory: true },
        codebaseMemory: { role: "find-trace-recall", advisory: true },
      },
    });
  });

  it("defines one idempotent Codex bootstrap and one proof-oriented doctor", () => {
    expect(toolingPlan()).toMatchObject({
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
            serena: { launcher: "serena-mcp" },
            tokenSavior: { launcher: "token-savior-mcp" },
            codeReviewGraph: { launcher: "code-review-graph-mcp" },
            codebaseMemory: { launcher: "codebase-memory-mcp" },
          },
        },
      },
    });

    expect(toolingCommand("setup-codex", "--dry-run")).toMatchObject({
      command: "setup-codex",
      dryRun: true,
      mutations: expect.arrayContaining([
        "install pinned repo AI tools",
        "write ignored Codex project projection",
        "install or refresh ECC through the native Codex plugin lifecycle",
      ]),
    });

    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["repo:init"]).toBe("node tools/repo-ai-tools.mjs setup-codex");
    expect(pkg.scripts["repo:doctor"]).toBe("node tools/repo-ai-tools.mjs doctor-codex");
  });

  it("versions the project cache by tool pins so live MCP environments are never replaced", () => {
    expect(toolingPlan()).toMatchObject({
      cache: {
        generation: expect.stringMatching(/^[0-9a-f]{16}$/),
        keyInputs: ["repository-path", "tool-pins"],
      },
      installRoot: "project-and-toolset-keyed user cache",
    });
  });

  it("keys managed memory state only by canonical root, memory pin, platform, and architecture", () => {
    const plan = toolingPlan() as {
      pins: { codebaseMemory: { package: string } };
      runtime: { codebaseMemory: { cacheDir: string; generation: string; runtimeDir: string } };
    };
    const expectedGeneration = createHash("sha256")
      .update(
        JSON.stringify({
          package: plan.pins.codebaseMemory.package,
          platform: process.platform,
          arch: process.arch,
        }),
      )
      .digest("hex")
      .slice(0, 16);
    expect(plan.runtime.codebaseMemory.generation).toBe(expectedGeneration);
    expect(plan.runtime.codebaseMemory.cacheDir).not.toBe(plan.runtime.codebaseMemory.runtimeDir);
  });

  it("keeps memory state across unrelated pin changes and separates memory pins and roots", () => {
    const fixture = mkdtempSync(join(tmpdir(), "aih-memory-generation-"));
    try {
      const cacheHome = join(fixture, "cache-home");
      const repoA = join(fixture, "repo-a");
      const repoB = join(fixture, "repo-b");
      const aliasA = join(fixture, "repo-a-alias");
      const scriptA = join(repoA, "tools", "repo-ai-tools.mjs");
      const scriptB = join(repoB, "tools", "repo-ai-tools.mjs");
      const source = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
      mkdirSync(join(repoA, "tools"), { recursive: true });
      mkdirSync(join(repoB, "tools"), { recursive: true });
      writeFileSync(scriptA, source);
      writeFileSync(scriptB, source);
      symlinkSync(repoA, aliasA, process.platform === "win32" ? "junction" : "dir");

      const memoryRuntime = (script: string) =>
        (
          toolingPlanFrom(script, { AIH_REPO_AI_TOOLS_HOME: cacheHome }) as {
            runtime: { codebaseMemory: { cacheDir: string; runtimeDir: string } };
          }
        ).runtime.codebaseMemory;
      const baseline = memoryRuntime(scriptA);

      writeFileSync(scriptA, source.replace("serena-agent==1.7.0", "serena-agent==1.7.1"));
      expect(memoryRuntime(scriptA)).toEqual(baseline);

      writeFileSync(scriptA, source);
      expect(memoryRuntime(join(aliasA, "tools", "repo-ai-tools.mjs"))).toEqual(baseline);

      writeFileSync(
        scriptA,
        source.replace("codebase-memory-mcp==0.10.5", "codebase-memory-mcp==0.10.6"),
      );
      expect(memoryRuntime(scriptA)).not.toEqual(baseline);
      expect(memoryRuntime(scriptB)).not.toEqual(baseline);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps a not-yet-created cache path stable across creation beneath a filesystem alias", () => {
    const fixture = mkdtempSync(join(tmpdir(), "aih-cache-alias-"));
    try {
      const target = join(fixture, "target");
      const alias = join(fixture, "alias");
      const selected = join(alias, "new", "cache");
      mkdirSync(join(target, "new"), { recursive: true });
      symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

      const before = toolingPlanWithEnv({ AIH_REPO_AI_TOOLS_HOME: selected }) as {
        runtime: { codebaseMemory: { cacheDir: string; runtimeDir: string } };
      };
      mkdirSync(join(target, "new", "cache"));
      const after = toolingPlanWithEnv({ AIH_REPO_AI_TOOLS_HOME: selected }) as {
        runtime: { codebaseMemory: { cacheDir: string; runtimeDir: string } };
      };

      expect(before.runtime.codebaseMemory).toEqual(after.runtime.codebaseMemory);
      expect(before.runtime.codebaseMemory.cacheDir).toContain(realpathSync.native(target));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("recovers one consistent absolute managed cache base for a fresh shell", () => {
    const header = "# BEGIN AIH REPO TOOLING (managed by npm run repo:init)";
    const footer = "# END AIH REPO TOOLING";
    const line = 'env = { AIH_REPO_AI_TOOLS_HOME = "/persistent/cache" }';
    const managed = `${header}\n${line}\n${line}\n${line}\n${line}\n${footer}\n`;

    expect(managedCacheRootReader(managed)()).toBe("/persistent/cache");
    expect(() =>
      managedCacheRootReader(
        `${header}\n${line}\nenv = { AIH_REPO_AI_TOOLS_HOME = "/other/cache" }\n${footer}\n`,
      )(),
    ).toThrow(/managed cache/i);
    expect(() =>
      managedCacheRootReader(
        `${header}\nenv = { AIH_REPO_AI_TOOLS_HOME = "relative/cache" }\n${footer}\n`,
      )(),
    ).toThrow(/absolute|managed cache/i);
    expect(
      managedCacheRootReader("# user config without an AIH managed block\n")(),
    ).toBeUndefined();
  });

  it("passes the persisted cache base through the Python MCP stdio child", () => {
    const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
    const probe = launcher.slice(
      launcher.indexOf("const mcpProbeScript"),
      launcher.indexOf("function verifyCodexProjection"),
    );

    expect(probe).toContain('env={"AIH_REPO_AI_TOOLS_HOME": os.environ["AIH_REPO_AI_TOOLS_HOME"]}');
    expect(probe).toContain("AIH_REPO_AI_TOOLS_HOME: cacheRoot");
  });

  it("always binds managed memory children to their owned cache, runtime, and canonical root", () => {
    const directories: string[] = [];
    const childEnvironments: Array<Record<string, string>> = [];
    const childArguments: string[][] = [];
    const harness = loadCodebaseMemoryHarness({
      codebaseMemoryCacheDir: "/managed/cache",
      codebaseMemoryGeneration: "memory-pin-generation",
      codebaseMemoryMarker: "/managed/indexed.json",
      codebaseMemoryRoot: "/managed",
      codebaseMemoryRuntimeDir: "/managed/runtime",
      executable: () => "codebase-memory-mcp",
      isAbsolute: (path: string) => path.startsWith("/"),
      mkdirSync: (path: string) => directories.push(path),
      parseJson: JSON.parse,
      process: {
        env: {
          AIH_REPO_AI_TOOLS_HOME: "/persistent/base",
          CBM_ALLOWED_ROOT: "/ambient/root",
          CBM_CACHE_DIR: "/ambient/cache",
          CBM_RUNTIME_DIR: "/ambient/runtime",
          KEEP: "yes",
        },
        platform: "linux",
      },
      readOptionalUtf8: () => undefined,
      repoRoot: "/canonical/consumer",
      resolve: (path: string) => path,
      runChecked: (_command: string, args: string[], options: { env: Record<string, string> }) => {
        childArguments.push(args);
        childEnvironments.push(options.env);
        return JSON.stringify({ projects: [] });
      },
      writeFileAtomically: () => {},
    });

    expect(harness.codebaseMemoryEnv()).toMatchObject({
      AIH_REPO_AI_TOOLS_HOME: "/persistent/base",
      CBM_ALLOWED_ROOT: "/canonical/consumer",
      CBM_CACHE_DIR: "/managed/cache",
      CBM_RUNTIME_DIR: "/managed/runtime",
      CBM_LOG_LEVEL: "warn",
      KEEP: "yes",
    });
    expect(directories).toEqual(
      expect.arrayContaining(["/managed", "/managed/cache", "/managed/runtime"]),
    );
    harness.preflightCodebaseMemory();
    expect(childArguments).toEqual([
      ["config", "set", "auto_watch", "false"],
      ["config", "set", "auto_index", "false"],
      ["cli", "list_projects"],
    ]);
    expect(childEnvironments).toHaveLength(childArguments.length);
    for (const environment of childEnvironments) {
      expect(environment).toMatchObject({
        CBM_ALLOWED_ROOT: "/canonical/consumer",
        CBM_CACHE_DIR: "/managed/cache",
        CBM_RUNTIME_DIR: "/managed/runtime",
      });
    }
  });

  it("persists the managed cache base into every projected MCP child", () => {
    const servers = ["serena", "token-savior", "code-review-graph", "codebase-memory-mcp"].map(
      (name) => ({ name, launcher: name, enabledTools: [], startupTimeout: 1, toolTimeout: 2 }),
    );
    const rendered = loadCodexRenderer({
      cacheRoot: "/persistent/tool-cache",
      codexBlockBegin: "# BEGIN",
      codexBlockEnd: "# END",
      projectMcpServers: servers,
      repoRoot: "/canonical/repo",
      scriptPath: "/canonical/repo/tools/repo-ai-tools.mjs",
    })();

    expect(rendered.match(/AIH_REPO_AI_TOOLS_HOME/g)).toHaveLength(servers.length);
    expect(rendered.match(/\/persistent\/tool-cache/g)).toHaveLength(servers.length);
  });

  it("reindexes a matching managed marker only when its inventory is not populated", () => {
    const rootA = "/consumer/a";
    const rootB = "/consumer/b";
    const generation = "pins";
    const projects = [
      { root_path: rootA, nodes: 4, edges: 3 },
      { root_path: rootB, nodes: 0, edges: 0 },
    ];
    const indexed: string[] = [];
    const markers = new Map([
      [`${rootA}/indexed.json`, JSON.stringify({ repository: rootA, generation })],
      [`${rootB}/indexed.json`, JSON.stringify({ repository: rootB, generation })],
    ]);

    const harnessFor = (repoRoot: string) =>
      loadCodebaseMemoryHarness({
        codebaseMemoryGeneration: generation,
        codebaseMemoryEnv: () => ({ CBM_ALLOWED_ROOT: repoRoot }),
        codebaseMemoryMarker: `${repoRoot}/indexed.json`,
        codebaseMemoryRoot: `${repoRoot}/memory-marker`,
        executable: () => "codebase-memory-mcp",
        isAbsolute: (path: string) => path.startsWith("/"),
        mkdirSync: () => {},
        parseJson: JSON.parse,
        process: { platform: "linux" },
        readOptionalUtf8: (path: string) => markers.get(path),
        repoRoot,
        resolve: (path: string) => path,
        runChecked: (_command: string, args: string[]) => {
          if (args[1] === "list_projects") return JSON.stringify({ projects });
          if (args[1] === "index_repository") {
            const indexedRoot = args[3];
            if (typeof indexedRoot !== "string") {
              throw new Error("index_repository requires a repository path");
            }
            indexed.push(indexedRoot);
            const project = projects.find((entry) => entry.root_path === indexedRoot);
            if (project) {
              project.nodes = 5;
              project.edges = 4;
            } else {
              projects.push({ root_path: indexedRoot, nodes: 5, edges: 4 });
            }
            return "";
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        writeFileAtomically: (path: string, contents: string) => markers.set(path, contents),
      });

    const first = harnessFor(rootA);
    first.initializeCodebaseMemory();
    expect(indexed).toEqual([]);

    const second = harnessFor(rootB);
    second.initializeCodebaseMemory();
    const markerAfterFirstInit = markers.get(`${rootB}/indexed.json`);
    second.initializeCodebaseMemory();
    expect(indexed).toEqual([rootB]);
    expect(first.codebaseMemoryStatus()).toEqual({ nodes: 4, edges: 3 });
    expect(markers.get(`${rootA}/indexed.json`)).toContain(rootA);
    expect(markers.get(`${rootB}/indexed.json`)).toBe(markerAfterFirstInit);
  });

  it("requires a root-and-memory-generation marker plus populated inventory for completion", () => {
    const marker = { repository: "/consumer/a", generation: "memory-generation" };
    const inventory = JSON.stringify({
      projects: [{ root_path: "/consumer/a", nodes: 4, edges: 3 }],
    });
    const createHarness = (storedMarker: unknown) =>
      loadCodebaseMemoryHarness({
        codebaseMemoryCacheDir: "/managed/cache",
        codebaseMemoryGeneration: "memory-generation",
        codebaseMemoryMarker: "/managed/indexed.json",
        codebaseMemoryRoot: "/managed",
        codebaseMemoryRuntimeDir: "/managed/runtime",
        executable: () => "codebase-memory-mcp",
        isAbsolute: (path: string) => path.startsWith("/"),
        mkdirSync: () => {},
        parseJson: JSON.parse,
        process: { env: {}, platform: "linux" },
        readOptionalUtf8: () =>
          storedMarker === undefined ? undefined : JSON.stringify(storedMarker),
        repoRoot: "/consumer/a",
        resolve: (path: string) => path,
        runChecked: () => inventory,
        writeFileAtomically: () => {},
      });

    expect(() => createHarness(undefined).codebaseMemoryCompletion()).toThrow(
      "no completed repo index marker",
    );
    expect(() =>
      createHarness({ ...marker, repository: "/consumer/b" }).codebaseMemoryCompletion(),
    ).toThrow("marker differs from this root or memory pin");
    expect(() =>
      createHarness({ ...marker, generation: "old-generation" }).codebaseMemoryCompletion(),
    ).toThrow("marker differs from this root or memory pin");
    expect(createHarness(marker).codebaseMemoryCompletion()).toEqual({ nodes: 4, edges: 3 });
  });

  it("does not write a completion marker when managed-runtime indexing fails", () => {
    const writes: string[] = [];
    const harness = loadCodebaseMemoryHarness({
      codebaseMemoryGeneration: "pins",
      codebaseMemoryEnv: () => ({}),
      codebaseMemoryMarker: "/consumer/b/indexed.json",
      codebaseMemoryRoot: "/consumer/b/memory-marker",
      executable: () => "codebase-memory-mcp",
      isAbsolute: (path: string) => path.startsWith("/"),
      mkdirSync: () => {},
      parseJson: JSON.parse,
      process: { platform: "linux" },
      readOptionalUtf8: () => undefined,
      repoRoot: "/consumer/b",
      resolve: (path: string) => path,
      runChecked: (_command: string, args: string[]) => {
        if (args[1] === "index_repository") throw new Error("managed cache admission failed");
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      writeFileAtomically: (path: string) => writes.push(path),
    });

    expect(() => harness.initializeCodebaseMemory()).toThrow("managed cache admission failed");
    expect(writes).toEqual([]);
  });

  it("rejects malformed managed inventory and nonnumeric index metrics", () => {
    const malformed = loadCodebaseMemoryHarness({
      codebaseMemoryGeneration: "pins",
      codebaseMemoryEnv: () => ({}),
      codebaseMemoryMarker: "/consumer/a/indexed.json",
      codebaseMemoryRoot: "/consumer/a/memory-marker",
      executable: () => "codebase-memory-mcp",
      isAbsolute: (path: string) => path.startsWith("/"),
      mkdirSync: () => {},
      parseJson: JSON.parse,
      process: { platform: "linux" },
      readOptionalUtf8: () => undefined,
      repoRoot: "/consumer/a",
      resolve: (path: string) => path,
      runChecked: () => JSON.stringify({}),
      writeFileAtomically: () => {},
    });
    const nonnumeric = loadCodebaseMemoryHarness({
      codebaseMemoryGeneration: "pins",
      codebaseMemoryEnv: () => ({}),
      codebaseMemoryMarker: "/consumer/a/indexed.json",
      codebaseMemoryRoot: "/consumer/a/memory-marker",
      executable: () => "codebase-memory-mcp",
      isAbsolute: (path: string) => path.startsWith("/"),
      mkdirSync: () => {},
      parseJson: JSON.parse,
      process: { platform: "linux" },
      readOptionalUtf8: () => undefined,
      repoRoot: "/consumer/a",
      resolve: (path: string) => path,
      runChecked: () =>
        JSON.stringify({ projects: [{ root_path: "/consumer/a", nodes: "4", edges: 3 }] }),
      writeFileAtomically: () => {},
    });

    expect(() => malformed.preflightCodebaseMemory()).toThrow("malformed project inventory");
    expect(() => nonnumeric.codebaseMemoryStatus()).toThrow("no populated index");
  });

  it("keeps case-distinct POSIX worktrees separate", () => {
    const harness = loadCodebaseMemoryHarness({
      codebaseMemoryGeneration: "pins",
      codebaseMemoryEnv: () => ({}),
      codebaseMemoryMarker: "/consumer/A/indexed.json",
      codebaseMemoryRoot: "/consumer/A/memory-marker",
      executable: () => "codebase-memory-mcp",
      isAbsolute: (path: string) => path.startsWith("/"),
      mkdirSync: () => {},
      parseJson: JSON.parse,
      process: { platform: "linux" },
      readOptionalUtf8: () => undefined,
      repoRoot: "/consumer/A",
      resolve: (path: string) => path,
      runChecked: () => "",
      writeFileAtomically: () => {},
    });

    expect(
      harness.codebaseMemoryProject({
        projects: [{ root_path: "/consumer/a", nodes: 2, edges: 2 }],
      }),
    ).toBeUndefined();
  });

  it("rejects relative daemon project roots", () => {
    const harness = loadCodebaseMemoryHarness({
      codebaseMemoryGeneration: "pins",
      codebaseMemoryEnv: () => ({}),
      codebaseMemoryMarker: "/consumer/a/indexed.json",
      codebaseMemoryRoot: "/consumer/a/memory-marker",
      executable: () => "codebase-memory-mcp",
      isAbsolute: (path: string) => path.startsWith("/"),
      mkdirSync: () => {},
      parseJson: JSON.parse,
      process: { platform: "linux" },
      readOptionalUtf8: () => undefined,
      repoRoot: "/consumer/a",
      resolve: () => "/consumer/a",
      runChecked: () => "",
      writeFileAtomically: () => {},
    });

    expect(
      harness.codebaseMemoryProject({ projects: [{ root_path: "../a", nodes: 2, edges: 2 }] }),
    ).toBeUndefined();
  });

  it("contains a preflight failure before client, hook, and index mutations", () => {
    const calls: string[] = [];
    const setupCodex = loadSetupCodex({
      assertCommand: () => {},
      configureEcc: () => calls.push("ecc"),
      doctorCodex: () => calls.push("doctor"),
      initializeCodeReviewGraph: () => calls.push("graph"),
      initializeCodebaseMemory: () => calls.push("index"),
      install: () => calls.push("install"),
      preflightCodebaseMemory: () => {
        throw new Error("shared cache unavailable");
      },
      runChecked: () => calls.push("hooks"),
      writeCodexProjection: () => calls.push("projection"),
    });

    expect(() => setupCodex()).toThrow("setup-codex codebase-memory preflight failed");
    expect(calls).toEqual(["install"]);
  });

  it("contains an indexing failure before client, hook, and graph mutations", () => {
    const calls: string[] = [];
    const setupCodex = loadSetupCodex({
      assertCommand: () => {},
      configureEcc: () => calls.push("ecc"),
      doctorCodex: () => calls.push("doctor"),
      initializeCodeReviewGraph: () => calls.push("graph"),
      initializeCodebaseMemory: () => {
        calls.push("index");
        throw new Error("native worker rejected root");
      },
      install: () => calls.push("install"),
      preflightCodebaseMemory: () => calls.push("preflight"),
      runChecked: () => calls.push("hooks"),
      writeCodexProjection: () => calls.push("projection"),
    });

    expect(() => setupCodex()).toThrow("setup-codex codebase-memory indexing failed");
    expect(calls).toEqual(["install", "preflight", "index"]);
  });

  it("keeps client-specific MCP and hook launchers out of the repository", () => {
    for (const file of [
      ".mcp.json",
      ".codex/config.toml",
      ".codex/hooks.json",
      ".claude/settings.json",
    ]) {
      expectUntrackedAndIgnored(file);
    }
  });

  it("portable ignore rules protect every generated project-local projection", () => {
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");

    for (const entry of [
      "/.codex/config.toml",
      "/.codex/hooks.json",
      "/.serena/",
      "/.code-review-graph/",
      "/.codebase-memory/",
    ]) {
      expect(gitignore, entry).toContain(entry);
    }
  });

  it("keeps the repository hook path limited to the non-AI pre-commit guardrail", () => {
    const hook = readFileSync(resolve(root, ".githooks/pre-commit"), "utf8");
    const routing = readFileSync(resolve(root, "ai-coding/rules/repo-ai-tools.md"), "utf8");

    expect(hook.startsWith("#!/bin/sh")).toBe(true);
    expect(hook).toContain("pre-commit: staged policy + lint + focused tests");
    expect(hook).toContain("npm run --silent check:staged");
    expect(existsSync(resolve(root, ".githooks/post-merge"))).toBe(false);
    expect(routing).not.toContain(".githooks/post-merge");
  });

  it("does not expose the removed automatic graph-refresh path", () => {
    const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");

    expect(launcher).not.toContain('command === "graph-refresh"');
    expect(launcher).not.toContain("graphRefreshLauncher");
  });

  it("routes overlapping tools in the repo-owned canon", () => {
    const extension = readFileSync(
      resolve(root, "ai-coding/rules/project-canon-extension.md"),
      "utf8",
    );
    const routing = readFileSync(resolve(root, "ai-coding/rules/repo-ai-tools.md"), "utf8");

    expect(extension).toContain("rules/repo-ai-tools.md");
    expect(extension).toContain("Never run AIH against this checkout.");
    expect(routing).toContain("blast-area and reviewer-context aid");
    expect(routing).toContain("Serena");
    expect(routing).toContain("Token Savior");
    expect(routing).toContain("Token Optimizer");
    expect(routing).toContain("Claude and Codex");
    expect(routing).toContain("must not block product work");
    expect(routing).toContain("## Default decision path");
    expect(routing).toContain("`get_entry_points`");
    expect(routing).toContain("`get_symbols_overview`");
    expect(routing).toContain("Do not use `replace_symbol_source`");
    expect(routing).toContain("Do not run the report or coach on every task");
    expect(routing).toContain("codebase-memory-mcp");
    expect(routing).toContain("broad impact");
    expect(routing).toContain("find, trace, and recall");
  });

  it("documents the complete Codex bootstrap and local projection boundary", () => {
    const setup = readFileSync(resolve(root, "ai-coding/setup.md"), "utf8");
    const adapter = readFileSync(resolve(root, "ai-coding/adapters/codex.md"), "utf8");

    expect(setup).toContain("npm run repo:init");
    expect(setup).toContain("npm run repo:doctor");
    expect(setup).toContain("Start a new Codex task");
    expect(adapter).toContain("native Codex plugin lifecycle");
    expect(adapter).toContain("ignored project-local `.codex/config.toml`");
  });

  it("makes graph use advisory and consistent in every session bootloader", () => {
    const canonFiles = [
      "AGENTS.md",
      "CLAUDE.md",
      "ai-coding/RULE_ROUTER.md",
      "ai-coding/rules/agent-behavior-core.md",
      "ai-coding/adapters/_shared-canonical-block.md",
    ];

    for (const file of canonFiles) {
      const content = readFileSync(resolve(root, file), "utf8");
      expect(content, file).not.toContain("code-review-graph is a hard prerequisite");
      expect(content, file).not.toContain("work must stop until");
    }

    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const content = readFileSync(resolve(root, file), "utf8");
      expect(content, file).toContain("ai-coding/rules/repo-ai-tools.md");
      expect(content, file).toContain("Never run AIH against this checkout.");
      expect(content, file).toContain("warn once and continue");
    }

    const shared = readFileSync(
      resolve(root, "ai-coding/adapters/_shared-canonical-block.md"),
      "utf8",
    );
    expect(shared).toContain("warn once and continue");
  });

  it("keeps Serena configuration and runtime artifacts out of the product diff", () => {
    for (const file of [".serena/project.yml", ".serena/.gitignore"]) {
      expectUntrackedAndIgnored(file);
    }
    expect(toolingPlan()).toMatchObject({
      installRoot: "project-and-toolset-keyed user cache",
    });
  });

  it("keeps Token Savior from indexing or dirtying the worktree with its own cache", () => {
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
    const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");

    expect(gitignore).toContain(".token-savior-cache.json");
    expect(launcher).toContain("TOKEN_SAVIOR_EXCLUDE_PATTERNS:");
    expect(launcher).toContain('plan.runtime.tokenSavior.excludePatterns.join(":")');
  });

  it("keeps this repo's manual canon authoritative without generator self-use", () => {
    const selfHosting = readFileSync(resolve(root, "ai-coding/SELF-HOSTING.md"), "utf8");
    const shared = readFileSync(
      resolve(root, "ai-coding/adapters/_shared-canonical-block.md"),
      "utf8",
    );
    const core = readFileSync(resolve(root, "ai-coding/rules/agent-behavior-core.md"), "utf8");
    const router = readFileSync(resolve(root, "ai-coding/RULE_ROUTER.md"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(selfHosting).toContain("AIH_SELF_HOSTING_BOUNDARY_v1");
    for (const content of [shared, core, router]) {
      expect(content).toContain("Never run AIH against this checkout.");
    }
    expect(router).toContain("npm run check:self-hosting-canon");
    expect(pkg.scripts["check:self-hosting-canon"]).toContain(
      "tests/self-hosting/self-hosting.test.ts",
    );
    expect(pkg.scripts["check:canon-drift"]).toBeUndefined();
  });

  it("retries an exclusive temporary-file collision before publishing the projection", () => {
    const filesystem = createAtomicWriterFilesystem({ collisionCount: 1 });
    const writeAtomically = loadAtomicWriter(filesystem);

    writeAtomically("/work/.codex/config.toml", "expected", undefined);

    expect(filesystem.openPaths).toHaveLength(2);
    expect(filesystem.files.get("/work/.codex/config.toml")).toBe("expected");
  });

  it.each([
    ["write", { failWrite: true }],
    ["close", { failClose: true }],
    ["rename", { failRename: true }],
  ])("removes an unpublished temporary file when %s fails", (_operation, options) => {
    const filesystem = createAtomicWriterFilesystem(options);
    const writeAtomically = loadAtomicWriter(filesystem);

    expect(() => writeAtomically("/work/.codex/config.toml", "expected", undefined)).toThrow();
    expect(filesystem.files.has("/work/.codex/config.toml")).toBe(false);
    expect(filesystem.removedPaths).toHaveLength(1);
  });

  it("preserves a concurrent destination instead of replacing a stale projection", () => {
    const filesystem = createAtomicWriterFilesystem({
      files: { "/work/.codex/config.toml": "concurrent edit" },
    });
    const writeAtomically = loadAtomicWriter(filesystem);

    expect(() =>
      writeAtomically("/work/.codex/config.toml", "managed projection", "previous projection"),
    ).toThrow("changed during atomic update");
    expect(filesystem.files.get("/work/.codex/config.toml")).toBe("concurrent edit");
    expect(filesystem.removedPaths).toHaveLength(1);
  });
});
