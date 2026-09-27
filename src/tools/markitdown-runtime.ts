import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { prepareOwnedStateDirectory } from "../ecc-profile/native-runtime.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Runner, RunResult } from "../internals/proc.js";
import { findOnPath } from "../live/runner.js";
import {
  type DefaultNativeRuntimeLayout,
  defaultNativeRuntimeLayout,
} from "../mcp/default-native-runtime.js";
import type { DeveloperToolRuntimeOperation } from "./developer-tools-runtime.js";

const ACQUISITION_TIMEOUT_MS = 5 * 60_000;
const CONVERSION_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const SMOKE_HTML =
  "<!doctype html><html><body><h1>AIH MarkItDown smoke</h1><p>Bounded conversion.</p></body></html>";
const SMOKE_MARKDOWN = "# AIH MarkItDown smoke\n\nBounded conversion.";

const LOCAL_CHILD_ENV_KEYS = [
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
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const ACQUISITION_TRUST_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CARGO_HTTP_CAINFO",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
  "PIP_CERT",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "UV_NATIVE_TLS",
] as const;

/** Immutable identity for the published Microsoft MarkItDown CLI release. */
export const MARKITDOWN_RUNTIME_PIN = {
  version: "0.1.8",
  package: "markitdown[docx,outlook,pdf,pptx,xls,xlsx]==0.1.8",
  sourceTag: "v0.1.8",
  sourceCommit: "b8f79c57ebc0044be41323d89b2a45d3fda8460e",
  wheelSha256: "de7375a50578a39bcbbf13b48c67d99033d988e0ae8ad25af46ed432dbe4cbab",
  license: "MIT",
} as const;

export const MARKITDOWN_RUNTIME_PYPROJECT_SHA256 =
  "4285e6190bc803e8da1169cd18c6fa7d50e90c862959cb18c7442013ec7c8d35";
export const MARKITDOWN_RUNTIME_UV_LOCK_SHA256 =
  "7d42167515feaf7a8da2c46c2b124b92c2dd542f5c64108c0c3fab31b9faaf34";
export const MARKITDOWN_DEPENDENCY_LOCK_SHA256 =
  "27827be1e2d9c058d54e6f16572a17e6dbdad0da0474a8fb9ac5a4fc36e49c0f";

// A 128-bit digest prefix keeps the external Python path safely short on Windows.
const MARKITDOWN_RUNTIME_DIRECTORY = `md-${MARKITDOWN_DEPENDENCY_LOCK_SHA256.slice(0, 32)}`;

export interface ManagedMarkItDownCliInvocation {
  /** Official console script installed in the digest-keyed external runtime. */
  readonly executable: string;
  /** Direct official console-script invocation for one selected local file. */
  readonly argv: readonly string[];
  /** Equivalent official Python module entrypoint for the same selected local file. */
  readonly pythonModuleArgv: readonly string[];
  /** External packaged runtime directory, never the target project. */
  readonly cwd: string;
  /** Scrubbed environment with offline uv defaults and no inherited credentials. */
  readonly env: NodeJS.ProcessEnv;
  /** The shell in which the two display commands can be pasted verbatim. */
  readonly displayShell: "PowerShell" | "POSIX shell";
  /** Runnable direct CLI command for {@link displayShell}. */
  readonly displayCommand: string;
  /** Runnable `python -m markitdown` alternative for {@link displayShell}. */
  readonly pythonModuleDisplayCommand: string;
}

interface PreparedMarkItDownRuntime {
  readonly lockRoot: string;
  readonly cacheRoot: string;
  readonly runtimeRoot: string;
  readonly executable: string;
  readonly python: string;
  readonly env: NodeJS.ProcessEnv;
}

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(value);
}

/** Authenticate the shipped lock before any package acquisition or CLI launch. */
export function authenticateMarkItDownRuntimeRoot(
  value: string,
  project: string,
  stateRoots: readonly string[] = [],
): string {
  const canonicalProject = canonicalDirectory(project, "MarkItDown project");
  if (!isAbsolute(value)) throw new Error("MarkItDown runtime lock root must be absolute");
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("MarkItDown runtime lock root must be a real directory");
  }
  const root = realpathSync(value);
  if (
    contains(canonicalProject, root) ||
    contains(root, canonicalProject) ||
    stateRoots.some((state) => contains(resolve(state), root) || contains(root, resolve(state)))
  ) {
    throw new Error("MarkItDown runtime lock root must be disjoint from project and state roots");
  }
  const identities = [
    ["pyproject.toml", MARKITDOWN_RUNTIME_PYPROJECT_SHA256],
    ["uv.lock", MARKITDOWN_RUNTIME_UV_LOCK_SHA256],
  ] as const;
  const verified: string[] = [];
  for (const [name, expected] of identities) {
    const opened = readRegularFileWithStats(join(root, name), { maxBytes: 8 * 1024 * 1024 });
    if (!opened || opened.stats.nlink > 1) {
      throw new Error(`MarkItDown runtime ${name} must be an unambiguous regular file`);
    }
    const actual = sha256(opened.contents);
    if (actual !== expected) throw new Error(`MarkItDown runtime ${name} failed authentication`);
    verified.push(actual);
  }
  const aggregate = sha256(verified.join("\0"));
  if (aggregate !== MARKITDOWN_DEPENDENCY_LOCK_SHA256) {
    throw new Error("MarkItDown runtime dependency closure failed authentication");
  }
  return root;
}

/**
 * Keep only ordinary process prerequisites. Cloud credentials, third-party plugin
 * settings, and project-specific environment files never cross this boundary.
 */
export function isolatedMarkItDownEnvironment(
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  cacheRoot: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_CHILD_ENV_KEYS) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  if (next.PATH === undefined && next.Path !== undefined) next.PATH = next.Path;
  next.UV_CACHE_DIR = cacheRoot;
  next.UV_PROJECT_ENVIRONMENT = runtimeRoot;
  next.UV_OFFLINE = "1";
  next.UV_NO_ENV_FILE = "1";
  next.PYTHONNOUSERSITE = "1";
  next.PYTHONDONTWRITEBYTECODE = "1";
  return next;
}

/**
 * Package acquisition is the only networked step. It retains a managed
 * workstation's proxy and TLS trust configuration, while local conversion
 * remains credential-free and offline.
 */
function acquisitionEnvironment(
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  cacheRoot: string,
): NodeJS.ProcessEnv {
  const next = isolatedMarkItDownEnvironment(env, runtimeRoot, cacheRoot);
  delete next.UV_OFFLINE;
  for (const key of ACQUISITION_TRUST_ENV_KEYS) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  return next;
}

function sharedRuntimeRoot(layout: DefaultNativeRuntimeLayout): string {
  const project = canonicalDirectory(layout.project, "MarkItDown project");
  if (!isAbsolute(layout.uvCache)) throw new Error("MarkItDown shared uv cache must be absolute");
  const cacheDestination = resolve(layout.uvCache);
  if (contains(project, cacheDestination) || contains(cacheDestination, project)) {
    throw new Error("MarkItDown shared uv cache must remain outside and disjoint from the project");
  }
  const cacheRoot = prepareOwnedStateDirectory(cacheDestination, "MarkItDown shared uv cache");
  if (contains(project, cacheRoot) || contains(cacheRoot, project)) {
    throw new Error("MarkItDown shared uv cache must remain outside and disjoint from the project");
  }
  return prepareOwnedStateDirectory(
    join(cacheRoot, MARKITDOWN_RUNTIME_DIRECTORY),
    "MarkItDown shared runtime root",
  );
}

function runtimePaths(
  runtimeRoot: string,
  platform: PlanContext["host"]["platform"],
): {
  executable: string;
  python: string;
} {
  const bin = platform === "windows" ? join(runtimeRoot, "Scripts") : join(runtimeRoot, "bin");
  return {
    executable: join(bin, platform === "windows" ? "markitdown.exe" : "markitdown"),
    python: join(bin, platform === "windows" ? "python.exe" : "python"),
  };
}

function prepareRuntime(
  ctx: PlanContext,
  layout: DefaultNativeRuntimeLayout,
): PreparedMarkItDownRuntime {
  const project = canonicalDirectory(layout.project, "MarkItDown project");
  const lockRoot = authenticateMarkItDownRuntimeRoot(layout.markitdownLockRoot, project, [
    layout.uvCache,
  ]);
  const runtimeRoot = sharedRuntimeRoot({ ...layout, project });
  const cacheRoot = canonicalDirectory(layout.uvCache, "MarkItDown shared uv cache");
  authenticateMarkItDownRuntimeRoot(lockRoot, project, [cacheRoot, runtimeRoot]);
  const paths = runtimePaths(runtimeRoot, ctx.host.platform);
  return {
    lockRoot,
    cacheRoot,
    runtimeRoot,
    ...paths,
    env: isolatedMarkItDownEnvironment(ctx.env, runtimeRoot, cacheRoot),
  };
}

function trustedUvExecutable(ctx: PlanContext, project: string): string {
  const uv = findOnPath("uv", ctx.env, process.platform, {
    excludeRoot: project,
    windowsExeOnly: process.platform === "win32",
  });
  if (uv === undefined) {
    throw new Error("MarkItDown uv executable is unavailable on external absolute PATH");
  }
  return uv;
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
  throw new Error(`${label} failed: ${reason}`);
}

function assertOfficialCli(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("MarkItDown dependency sync did not install the official CLI entrypoint");
  }
}

function canonicalLocalRegularFile(value: string): string {
  if (!isAbsolute(value)) throw new Error("MarkItDown input must be an absolute local file path");
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("MarkItDown input must be an unlinked regular local file");
  }
  return realpathSync(value);
}

function shellQuote(value: string, platform: PlanContext["host"]["platform"]): string {
  if (platform === "windows") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function displayCommand(
  argv: readonly string[],
  platform: PlanContext["host"]["platform"],
): string {
  const command = argv.map((value) => shellQuote(value, platform)).join(" ");
  return platform === "windows" ? `& ${command}` : command;
}

function invocationFor(
  ctx: PlanContext,
  layout: DefaultNativeRuntimeLayout,
  source: string,
): ManagedMarkItDownCliInvocation {
  const prepared = prepareRuntime(ctx, layout);
  const input = canonicalLocalRegularFile(source);
  const argv = [prepared.executable, input];
  const pythonModuleArgv = [prepared.python, "-m", "markitdown", input];
  return {
    executable: prepared.executable,
    argv,
    pythonModuleArgv,
    cwd: prepared.lockRoot,
    env: prepared.env,
    displayShell: ctx.host.platform === "windows" ? "PowerShell" : "POSIX shell",
    displayCommand: displayCommand(argv, ctx.host.platform),
    pythonModuleDisplayCommand: displayCommand(pythonModuleArgv, ctx.host.platform),
  };
}

/**
 * Return the direct official CLI command for one caller-selected local regular
 * file. It never modifies PATH and keeps the process outside the target project.
 */
export function managedMarkItDownCliInvocation(
  ctx: PlanContext,
  source: string,
): ManagedMarkItDownCliInvocation {
  return invocationFor(ctx, defaultNativeRuntimeLayout(ctx), source);
}

function smokeFixture(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "aih-markitdown-smoke-"));
  const source = join(root, "markitdown-smoke.html");
  writeFileSync(source, SMOKE_HTML, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { root, source };
}

function verifiedMarkdown(stdout: string): void {
  const actual = stdout.replace(/\r\n?/gu, "\n").trim();
  if (actual !== SMOKE_MARKDOWN) {
    throw new Error(
      "MarkItDown CLI did not produce the expected Markdown for the local HTML fixture",
    );
  }
}

/** Provision the shared pinned CLI, then prove its two official local entrypoints. */
export function createMarkItDownOperation(
  ctx: PlanContext,
  run: Runner,
): DeveloperToolRuntimeOperation {
  return async ({ layout }) => {
    const prepared = prepareRuntime(ctx, layout);
    const wasInstalled = existsSync(prepared.executable);
    const uv = trustedUvExecutable(ctx, layout.project);
    const sync = await run(
      [
        uv,
        "--project",
        prepared.lockRoot,
        "sync",
        "--locked",
        "--no-python-downloads",
        "--no-config",
      ],
      {
        cwd: prepared.lockRoot,
        env: acquisitionEnvironment(ctx.env, prepared.runtimeRoot, prepared.cacheRoot),
        timeoutMs: ACQUISITION_TIMEOUT_MS,
        maxBufferBytes: OUTPUT_LIMIT,
      },
    );
    requireSuccess("MarkItDown dependency sync", sync);
    assertOfficialCli(prepared.executable);

    const fixture = smokeFixture();
    try {
      const invocation = invocationFor(ctx, layout, fixture.source);
      for (const argv of [invocation.argv, invocation.pythonModuleArgv]) {
        const conversion = await run([...argv], {
          cwd: invocation.cwd,
          env: invocation.env,
          timeoutMs: CONVERSION_TIMEOUT_MS,
          maxBufferBytes: OUTPUT_LIMIT,
        });
        requireSuccess("MarkItDown local HTML conversion", conversion);
        verifiedMarkdown(conversion.stdout);
      }
      const displayShell = ctx.host.platform === "windows" ? "PowerShell" : "POSIX shell";
      const directCommand = displayCommand(
        [prepared.executable, "<input-file>"],
        ctx.host.platform,
      );
      const moduleCommand = displayCommand(
        [prepared.python, "-m", "markitdown", "<input-file>"],
        ctx.host.platform,
      );
      return {
        state: "verified",
        detail:
          `MarkItDown CLI ${MARKITDOWN_RUNTIME_PIN.version} was provisioned in the shared pinned runtime at ${prepared.executable}; ` +
          `the official CLI and ${prepared.python} -m markitdown converted a bounded local HTML fixture twice offline without plugins or cloud flags. ` +
          `${displayShell} command: ${directCommand}. Equivalent module command: ${moduleCommand}.`,
        sourceDigest: MARKITDOWN_DEPENDENCY_LOCK_SHA256,
        ownedPaths: [],
        changed: !wasInstalled,
      };
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
    }
  };
}
