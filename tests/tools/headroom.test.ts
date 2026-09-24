import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { defaultNativeRuntimeLayout } from "../../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  authenticateHeadroomRuntimeRoot,
  HEADROOM_DEPENDENCY_LOCK_SHA256,
  HEADROOM_EXCLUDE_NEWER,
  HEADROOM_MCP_TOOL_NAMES,
  HEADROOM_RUNTIME_PIN,
  HEADROOM_RUNTIME_PYPROJECT_SHA256,
  HEADROOM_RUNTIME_SWITCHES,
  HEADROOM_RUNTIME_UV_LOCK_SHA256,
  HEADROOM_TOKENIZER_VOCABULARIES,
  headroomLauncherDigest,
  headroomLayout,
  headroomMcpServer,
  headroomPlatform,
  headroomRuntimeLockRoot,
  isolatedHeadroomEnvironment,
} from "../../src/tools/headroom.js";

const repository = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function context(platform: "linux" | "windows" = "linux"): PlanContext {
  const root = temporary("aih-headroom-project-");
  const state = temporary("aih-headroom-state-");
  const run = fakeRunner(() => undefined);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: state,
    USERPROFILE: state,
    LOCALAPPDATA: state,
    XDG_STATE_HOME: state,
    OPENAI_API_KEY: "must-not-reach-headroom",
    ANTHROPIC_API_KEY: "must-not-reach-headroom",
    HEADROOM_PROXY_URL: "https://proxy.example.invalid",
    HEADROOM_BEACON: "on",
    HTTPS_PROXY: "http://proxy.example:8443",
    SSL_CERT_FILE: "C:\\corp\\ca.pem",
  };
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({ platform, run, env }),
    options: {},
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lockedPackage(lock: string, name: string): string {
  const block = lock
    .split(/\n\[\[package\]\]\n/u)
    .find((candidate) => candidate.startsWith(`name = "${name}"\n`));
  if (block === undefined) throw new Error(`locked package ${name} is missing`);
  return block;
}

describe("Headroom locked runtime", () => {
  it("pins the published Apache-2.0 MCP extra to an exact release and source commit", () => {
    expect(HEADROOM_RUNTIME_PIN).toMatchObject({
      version: "0.38.0",
      package: "headroom-ai[mcp]==0.38.0",
      sourceRepository: "headroomlabs-ai/headroom",
      sourceTag: "v0.38.0",
      sourceCommit: "94206e265203acfd72a3b939e9a964e29175ad50",
      license: "Apache-2.0",
    });
    expect(Object.keys(HEADROOM_RUNTIME_PIN.wheels).sort()).toEqual([
      "darwin-arm64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    expect(HEADROOM_MCP_TOOL_NAMES).toEqual([
      "headroom_compress",
      "headroom_retrieve",
      "headroom_stats",
    ]);
  });

  it("binds every supported platform wheel to the committed hash-pinned uv lock", () => {
    const lockRoot = headroomRuntimeLockRoot();
    const pyproject = readFileSync(join(lockRoot, "pyproject.toml"));
    const lock = readFileSync(join(lockRoot, "uv.lock"));
    expect(sha256(pyproject)).toBe(HEADROOM_RUNTIME_PYPROJECT_SHA256);
    expect(sha256(lock)).toBe(HEADROOM_RUNTIME_UV_LOCK_SHA256);
    expect(sha256([sha256(pyproject), sha256(lock)].join("\0"))).toBe(
      HEADROOM_DEPENDENCY_LOCK_SHA256,
    );
    const text = lock.toString("utf8");
    expect(text).toContain(`[options]\nexclude-newer = "${HEADROOM_EXCLUDE_NEWER}"\n`);
    expect(pyproject.toString("utf8")).toContain('"headroom-ai[mcp]==0.38.0"');
    const headroom = lockedPackage(text, "headroom-ai");
    expect(headroom).toContain('version = "0.38.0"');
    for (const wheel of Object.values(HEADROOM_RUNTIME_PIN.wheels)) {
      expect(headroom).toContain(`/${wheel.name}", hash = "sha256:${wheel.sha256}"`);
    }
    // No Windows arm64 or Intel macOS wheel exists for the pinned closure.
    expect(headroom).not.toContain("win_arm64");
    expect(lockedPackage(text, "cryptography")).not.toMatch(
      /macosx_[0-9_]+_(?:x86_64|universal2)/u,
    );
  });

  it("names only platforms with a complete prebuilt wheel closure", () => {
    expect(headroomPlatform("win32", "x64")).toBe("win32-x64");
    expect(headroomPlatform("linux", "x64")).toBe("linux-x64");
    expect(headroomPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(headroomPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(headroomPlatform("darwin", "x64")).toBeUndefined();
    expect(headroomPlatform("win32", "arm64")).toBeUndefined();
    expect(headroomPlatform("freebsd", "x64")).toBeUndefined();
  });

  it("authenticates the packaged lock and refuses a modified copy or overlapping state", () => {
    const project = temporary("aih-headroom-auth-project-");
    const lockRoot = headroomRuntimeLockRoot();
    expect(authenticateHeadroomRuntimeRoot(lockRoot, project)).toBe(realpathSync(lockRoot));

    const copy = temporary("aih-headroom-lock-copy-");
    cpSync(lockRoot, copy, { recursive: true });
    expect(authenticateHeadroomRuntimeRoot(copy, project)).toBe(copy);
    writeFileSync(join(copy, "uv.lock"), `${readFileSync(join(copy, "uv.lock"), "utf8")}\n`);
    expect(() => authenticateHeadroomRuntimeRoot(copy, project)).toThrow(
      /uv\.lock failed authentication/u,
    );
    expect(() => authenticateHeadroomRuntimeRoot(lockRoot, project, [lockRoot])).toThrow(
      /disjoint/u,
    );
    expect(() => authenticateHeadroomRuntimeRoot("relative/lock", project)).toThrow(/absolute/u);
  });

  it("keeps all Headroom state in one AIH-owned root outside the project", () => {
    const ctx = context();
    const layout = headroomLayout(ctx);
    const projectStateRoot = defaultNativeRuntimeLayout(ctx).projectStateRoot;
    expect(layout.project).toBe(realpathSync(ctx.root));
    expect(layout.stateRoot).toBe(join(projectStateRoot, "headroom"));
    expect(layout.receiptPath).toBe(join(layout.stateRoot, "activation.json"));
    expect(layout.environment).toBe(join(layout.stateRoot, "e"));
    expect(layout.uvCache).toBe(join(layout.stateRoot, "u"));
    expect(layout.workspace).toBe(join(layout.stateRoot, "w"));
    expect(layout.tiktokenCache).toBe(join(layout.stateRoot, "t"));
    expect(layout.huggingFaceHome).toBe(join(layout.stateRoot, "f"));
    expect(layout.lockRoot).toBe(headroomRuntimeLockRoot());
    expect(headroomLayout(context("windows")).stateRoot).toMatch(/[\\/]h$/u);
  });

  it("launches with the upstream network switches off and no inherited credentials", () => {
    const ctx = context();
    const layout = headroomLayout(ctx);
    const runtime = isolatedHeadroomEnvironment(ctx.env, layout, "runtime");
    expect(runtime).toMatchObject({
      ...HEADROOM_RUNTIME_SWITCHES,
      UV_CACHE_DIR: layout.uvCache,
      UV_PROJECT_ENVIRONMENT: layout.environment,
      UV_OFFLINE: "1",
      UV_NO_ENV_FILE: "1",
      UV_EXCLUDE_NEWER: HEADROOM_EXCLUDE_NEWER,
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      HEADROOM_WORKSPACE_DIR: layout.workspace,
      TIKTOKEN_CACHE_DIR: layout.tiktokenCache,
      HF_HOME: layout.huggingFaceHome,
    });
    expect(HEADROOM_RUNTIME_SWITCHES).toMatchObject({
      HEADROOM_BEACON: "off",
      DO_NOT_TRACK: "1",
      HEADROOM_UPDATE_CHECK: "off",
    });
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "HEADROOM_PROXY_URL",
      "HTTPS_PROXY",
      "SSL_CERT_FILE",
    ])
      expect(runtime[key]).toBeUndefined();

    const acquisition = isolatedHeadroomEnvironment(ctx.env, layout, "acquisition");
    expect(acquisition.UV_OFFLINE).toBeUndefined();
    expect(acquisition.HTTPS_PROXY).toBe("http://proxy.example:8443");
    expect(acquisition.SSL_CERT_FILE).toBe("C:\\corp\\ca.pem");
    expect(acquisition.OPENAI_API_KEY).toBeUndefined();
    expect(acquisition.HEADROOM_BEACON).toBe("off");
  });

  it("pre-provisions only hash-pinned tokenizer vocabularies", () => {
    expect(HEADROOM_TOKENIZER_VOCABULARIES).toEqual([
      {
        encoding: "o200k_base",
        url: "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken",
        sha256: "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d",
      },
      {
        encoding: "cl100k_base",
        url: "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken",
        sha256: "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
      },
    ]);
  });

  it("generates one local pinned stdio launcher bound to this worktree", () => {
    const ctx = context();
    const layout = headroomLayout(ctx);
    const server = headroomMcpServer(ctx);
    expect(server).toMatchObject({
      type: "stdio",
      command: process.execPath,
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
    });
    expect(server).not.toHaveProperty("env");
    expect(server.args.slice(1)).toEqual([
      "headroom",
      "--package",
      "headroom-ai[mcp]==0.38.0",
      "--dependency-lock-sha256",
      HEADROOM_DEPENDENCY_LOCK_SHA256,
      "--lock-root",
      layout.lockRoot,
      "--project",
      layout.project,
      "--state-root",
      layout.stateRoot,
    ]);
    expect(server.args[0]).toBe(defaultNativeRuntimeLayout(ctx).runtimeScript);
    expect(headroomLauncherDigest(server)).toMatch(/^[a-f0-9]{64}$/u);
    expect(headroomLauncherDigest(server)).toBe(headroomLauncherDigest({ ...server }));
    expect(
      headroomLauncherDigest({ ...server, args: [...server.args.slice(0, -1), "other"] }),
    ).not.toBe(headroomLauncherDigest(server));
  });

  it("ships the Headroom lock project in the published package", () => {
    const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(manifest.files).toContain("src/tools/headroom-runtime");
  });
});
