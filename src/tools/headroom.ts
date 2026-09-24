import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { defaultNativeRuntimeLayout } from "../mcp/default-native-runtime.js";
import type { StdioServer } from "../mcp/servers.js";

/**
 * Exact published Headroom release consumed through its MCP extra only. The
 * proxy, `wrap`, `deploy` and `learn --apply` modes route provider traffic,
 * install other tools or edit user-scope configuration, so they are not used.
 */
export const HEADROOM_RUNTIME_PIN = {
  version: "0.38.0",
  package: "headroom-ai[mcp]==0.38.0",
  sourceRepository: "headroomlabs-ai/headroom",
  sourceTag: "v0.38.0",
  sourceCommit: "94206e265203acfd72a3b939e9a964e29175ad50",
  license: "Apache-2.0",
  /** Only platforms whose whole locked closure has prebuilt, hash-pinned wheels. */
  wheels: {
    "win32-x64": {
      name: "headroom_ai-0.38.0-cp310-abi3-win_amd64.whl",
      sha256: "acff25742f03e5a9f0249b49ffb09cd937c40ce72591a88c375aebddea4f591b",
    },
    "linux-x64": {
      name: "headroom_ai-0.38.0-cp310-abi3-manylinux_2_28_x86_64.whl",
      sha256: "941d1f0c0aa0754bd4959bba0b212d1554a56c179c0643dd7852a4b9d95c7db7",
    },
    "linux-arm64": {
      name: "headroom_ai-0.38.0-cp310-abi3-manylinux_2_28_aarch64.whl",
      sha256: "80603045483022cc4c65c78121eb1e66aedf02e876c2d378ddbbef6b99fe5a3f",
    },
    "darwin-arm64": {
      name: "headroom_ai-0.38.0-cp310-abi3-macosx_11_0_arm64.whl",
      sha256: "456ba6bddba827267291fca4843728c8aad5fb66eb961ff6804ab26b84398b03",
    },
  },
} as const;

export type HeadroomPlatform = keyof typeof HEADROOM_RUNTIME_PIN.wheels;

export const HEADROOM_RUNTIME_PYPROJECT_SHA256 =
  "78aef32f022cddb8d682a18c9ef9c9da80416deae539388ea474344eaefdb932";
export const HEADROOM_RUNTIME_UV_LOCK_SHA256 =
  "4e53a95f73204f34f6fa1a6d9f0a67de263706ea9a74bed96365ba62581d2a65";
export const HEADROOM_DEPENDENCY_LOCK_SHA256 =
  "c0b19e47129efd3b776afd7e40a94ccdd607b90dc2a853bfd409d6a3bc81e7be";
/** The committed lock's resolution cutoff; `--no-config` sync must restate it. */
export const HEADROOM_EXCLUDE_NEWER = "2026-09-23T00:00:00Z";

export const HEADROOM_MCP_TOOL_NAMES = [
  "headroom_compress",
  "headroom_retrieve",
  "headroom_stats",
] as const;

/**
 * Tokenizer vocabularies Headroom loads through tiktoken. Activation fetches
 * them once (tiktoken verifies these hashes) so the MCP launch needs no network.
 */
export const HEADROOM_TOKENIZER_VOCABULARIES = [
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
] as const;

/**
 * Upstream switches applied to every Headroom launch: the anonymous beacon, the
 * PyPI update check, the offline master switch (beacon, update check, license
 * reporter and model downloads), Hugging Face offline mode, LiteLLM's bundled
 * model-cost map instead of its import-time GitHub fetch, and LiteLLM's
 * production mode so it never loads a `.env` file found above its install.
 */
export const HEADROOM_RUNTIME_SWITCHES = {
  HEADROOM_BEACON: "off",
  DO_NOT_TRACK: "1",
  HEADROOM_UPDATE_CHECK: "off",
  HEADROOM_OFFLINE: "1",
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  LITELLM_LOCAL_MODEL_COST_MAP: "True",
  LITELLM_MODE: "PRODUCTION",
} as const;

const LOCAL_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
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

/** Only package and vocabulary acquisition may use a managed workstation's proxy and trust. */
const ACQUISITION_TRUST_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "PIP_CERT",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "UV_NATIVE_TLS",
] as const;

export interface HeadroomLayout {
  readonly project: string;
  readonly lockRoot: string;
  /** The single AIH-owned Headroom root; deactivation removes it entirely. */
  readonly stateRoot: string;
  readonly receiptPath: string;
  readonly environment: string;
  readonly uvCache: string;
  readonly workspace: string;
  readonly tiktokenCache: string;
  readonly huggingFaceHome: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function headroomPlatform(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture | string,
): HeadroomPlatform | undefined {
  const key = `${platform}-${arch}`;
  return Object.hasOwn(HEADROOM_RUNTIME_PIN.wheels, key) ? (key as HeadroomPlatform) : undefined;
}

/** The packaged lock directory, from source (`src/tools`) or the bundled `dist`. */
export function headroomRuntimeLockRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const found = [
    resolve(moduleDirectory, "headroom-runtime"),
    resolve(moduleDirectory, "../src/tools/headroom-runtime"),
  ].find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error("packaged Headroom dependency lock is missing");
  return realpathSync(found);
}

/** Authenticate the shipped lock before any acquisition or launch uses it. */
export function authenticateHeadroomRuntimeRoot(
  value: string,
  project: string,
  stateRoots: readonly string[] = [],
): string {
  if (!isAbsolute(value)) throw new Error("Headroom runtime lock root must be absolute");
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Headroom runtime lock root must be a real directory");
  }
  const root = realpathSync(value);
  if (
    contains(project, root) ||
    contains(root, project) ||
    stateRoots.some((state) => contains(resolve(state), root) || contains(root, resolve(state)))
  ) {
    throw new Error("Headroom runtime lock root must be disjoint from project and state roots");
  }
  const verified: string[] = [];
  for (const [name, expected] of [
    ["pyproject.toml", HEADROOM_RUNTIME_PYPROJECT_SHA256],
    ["uv.lock", HEADROOM_RUNTIME_UV_LOCK_SHA256],
  ] as const) {
    const opened = readRegularFileWithStats(join(root, name), { maxBytes: 8 * 1024 * 1024 });
    if (!opened || opened.stats.nlink > 1) {
      throw new Error(`Headroom runtime ${name} must be an unambiguous regular file`);
    }
    const actual = sha256(opened.contents);
    if (actual !== expected) throw new Error(`Headroom runtime ${name} failed authentication`);
    verified.push(actual);
  }
  if (sha256(verified.join("\0")) !== HEADROOM_DEPENDENCY_LOCK_SHA256) {
    throw new Error("Headroom runtime dependency closure failed authentication");
  }
  return root;
}

/** Fixed state layout below one AIH-owned root, shared by setup and the launcher. */
export function headroomLayoutFor(
  project: string,
  lockRoot: string,
  stateRoot: string,
): HeadroomLayout {
  return {
    project,
    lockRoot,
    stateRoot,
    receiptPath: join(stateRoot, "activation.json"),
    environment: join(stateRoot, "e"),
    uvCache: join(stateRoot, "u"),
    workspace: join(stateRoot, "w"),
    tiktokenCache: join(stateRoot, "t"),
    huggingFaceHome: join(stateRoot, "f"),
  };
}

export function headroomLayout(ctx: PlanContext): HeadroomLayout {
  const native = defaultNativeRuntimeLayout(ctx);
  return headroomLayoutFor(
    native.project,
    headroomRuntimeLockRoot(),
    join(native.projectStateRoot, ctx.host.platform === "windows" ? "h" : "headroom"),
  );
}

/**
 * Credential-free child environment. `runtime` is offline; `acquisition` also
 * keeps the workstation's proxy and TLS trust for the explicit activation step.
 */
export function isolatedHeadroomEnvironment(
  env: NodeJS.ProcessEnv,
  layout: HeadroomLayout,
  mode: "runtime" | "acquisition",
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_CHILD_ENV_KEYS) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  if (next.PATH === undefined && next.Path !== undefined) next.PATH = next.Path;
  if (mode === "acquisition") {
    for (const key of ACQUISITION_TRUST_ENV_KEYS) {
      if (env[key] !== undefined) next[key] = env[key];
    }
  } else {
    next.UV_OFFLINE = "1";
  }
  next.UV_CACHE_DIR = layout.uvCache;
  next.UV_PROJECT_ENVIRONMENT = layout.environment;
  next.UV_NO_ENV_FILE = "1";
  next.UV_EXCLUDE_NEWER = HEADROOM_EXCLUDE_NEWER;
  next.PYTHONNOUSERSITE = "1";
  next.PYTHONDONTWRITEBYTECODE = "1";
  next.HEADROOM_WORKSPACE_DIR = layout.workspace;
  next.TIKTOKEN_CACHE_DIR = layout.tiktokenCache;
  next.HF_HOME = layout.huggingFaceHome;
  return { ...next, ...HEADROOM_RUNTIME_SWITCHES };
}

/** The exact generated MCP definition; host entries are projected from it. */
export function headroomMcpServer(ctx: PlanContext): StdioServer {
  const native = defaultNativeRuntimeLayout(ctx);
  const layout = headroomLayout(ctx);
  return {
    type: "stdio",
    command: process.execPath,
    args: [
      native.runtimeScript,
      "headroom",
      "--package",
      HEADROOM_RUNTIME_PIN.package,
      "--dependency-lock-sha256",
      HEADROOM_DEPENDENCY_LOCK_SHA256,
      "--lock-root",
      layout.lockRoot,
      "--project",
      layout.project,
      "--state-root",
      layout.stateRoot,
    ],
    description:
      "AIH-owned Headroom 0.38.0 MCP launcher (headroom mcp serve over stdio) for this canonical worktree, present only after explicit activation. It runs with the upstream beacon, update check and model downloads switched off, a pre-provisioned tokenizer cache and AIH-owned state. Compression and retrieval run locally; this is an environment boundary, not an operating-system network sandbox.",
    classification: "local",
    egress: "local-only",
    credentials: "none",
    supplyChain: "pinned",
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Content identity of a generated launcher definition, independent of key order. */
export function headroomLauncherDigest(server: StdioServer): string {
  return sha256(stable(server));
}
