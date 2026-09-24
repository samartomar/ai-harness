import { join } from "node:path";
import { CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION } from "./codebase-memory-native-pins.js";

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
] as const;

/**
 * Root-scoped native Memory environment. `runtimeHome` contains the immutable
 * launcher payload while `stateRoot` and `coordinationRoot` are unique to one
 * canonical worktree. The coordination root is kept short for Unix sockets.
 */
export function isolatedCodebaseMemoryEnvironment(
  env: NodeJS.ProcessEnv,
  project: string,
  stateRoot: string,
  coordinationRoot: string,
  runtimeHome: string,
  uvCache: string,
  offline: boolean,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_CHILD_ENV_KEYS) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  if (next.PATH === undefined && next.Path !== undefined) next.PATH = next.Path;
  next.HOME = runtimeHome;
  next.USERPROFILE = runtimeHome;
  next.LOCALAPPDATA = runtimeHome;
  next.XDG_CACHE_HOME = runtimeHome;
  next.CBM_ALLOWED_ROOT = project;
  next.CBM_CACHE_DIR = join(stateRoot, "index");
  next.CBM_RUNTIME_DIR = coordinationRoot;
  next.CBM_LOG_LEVEL = "none";
  next.UV_CACHE_DIR = uvCache;
  next.UV_NO_ENV_FILE = "1";
  if (offline) next.UV_OFFLINE = "1";
  return next;
}

export function codebaseMemoryNativeBinaryPath(
  platform: NodeJS.Platform,
  runtimeHome: string,
): string {
  const base =
    platform === "darwin"
      ? join(runtimeHome, "Library", "Caches")
      : platform === "win32"
        ? runtimeHome
        : runtimeHome;
  return join(
    base,
    "codebase-memory-mcp",
    CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION,
    platform === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp",
  );
}
