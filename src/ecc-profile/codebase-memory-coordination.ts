import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

function paths(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function effectiveUid(): number | undefined {
  return process.geteuid?.() ?? process.getuid?.();
}

function overlaps(first: string, second: string, platform: NodeJS.Platform): boolean {
  const path = paths(platform);
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  return within(first, second) || within(second, first);
}

function socketBudget(root: string, platform: NodeJS.Platform): void {
  if (platform === "win32") return;
  // Pinned 0.11.0 src/daemon/ipc.c appends this directory and a 16-hex instance key.
  // Use the native effective uid; reserve uint32 width for cross-platform previews.
  const address = `${root}/cbm-daemon-${effectiveUid() ?? "4294967295"}/cbm-${"0".repeat(16)}.sock`;
  if (Buffer.byteLength(address, "utf8") >= (platform === "darwin" ? 104 : 108)) {
    throw new Error(
      "Memory coordination root exceeds the native socket path limit; set XDG_RUNTIME_DIR to a shorter private user runtime directory",
    );
  }
}

function layout(env: NodeJS.ProcessEnv, project: string, platform: NodeJS.Platform) {
  const path = paths(platform);
  if (!path.isAbsolute(project)) throw new Error("Memory project root must be absolute");
  let base: string;
  let managed: string;
  let privateBase = false;
  const key = createHash("sha256").update(project).digest("hex").slice(0, 20);
  if (platform === "win32") {
    base = env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? homedir(), "AppData", "Local");
    managed = path.join("aih", "developer-tools", "coordination", key);
  } else if (platform === "linux" || (platform === "darwin" && env.XDG_RUNTIME_DIR !== undefined)) {
    if (env.XDG_RUNTIME_DIR === undefined && effectiveUid() === undefined) {
      throw new Error("Memory requires an explicit private XDG_RUNTIME_DIR on this host");
    }
    base = env.XDG_RUNTIME_DIR ?? `/run/user/${effectiveUid()}`;
    managed = `aih-m-${key}`;
    privateBase = true;
  } else if (platform === "darwin") {
    base = env.HOME ?? homedir();
    managed = path.join(".aih", "run", `aih-m-${key}`);
  } else {
    throw new Error("Memory coordination is unsupported on this platform");
  }
  if (path.isAbsolute(base)) base = path.resolve(base);
  const root = path.join(base, managed);
  return { base, root, privateBase };
}

/** Pure derivation. Defer Memory-only usability failures until its own setup/launch. */
export function codebaseMemoryCoordinationRoot(
  env: NodeJS.ProcessEnv,
  canonicalProject: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return layout(env, canonicalProject, platform).root;
}

/** Pure launch preflight, so invalid root geometry never creates partial state. */
export function assertCodebaseMemoryCoordinationRoot(
  expectedRoot: string,
  env: NodeJS.ProcessEnv,
  canonicalProject: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = paths(platform);
  const { base, root } = layout(env, canonicalProject, platform);
  if (!path.isAbsolute(base)) throw new Error("Memory runtime directory must be absolute");
  if (overlaps(canonicalProject, root, platform))
    throw new Error("Memory coordination must remain outside the project root");
  socketBudget(root, platform);
  if (!path.isAbsolute(expectedRoot) || path.resolve(expectedRoot) !== root) {
    throw new Error("Memory coordination root must match the derived project root");
  }
  return root;
}

/** Check every lexical ancestor before creating only the derived managed directories. */
export function prepareCodebaseMemoryCoordinationRoot(
  expectedRoot: string,
  env: NodeJS.ProcessEnv,
  canonicalProject: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== process.platform)
    throw new Error("Memory directory preparation requires the current platform");
  const path = paths(platform);
  const root = assertCodebaseMemoryCoordinationRoot(expectedRoot, env, canonicalProject, platform);
  const { base, privateBase } = layout(env, canonicalProject, platform);
  const uid = effectiveUid();
  function inspect(candidate: string, requirePrivate: boolean, requireOwner: boolean) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Memory runtime has a linked or non-directory path segment");
    }
    if (platform !== "win32") {
      if (
        uid === undefined ||
        (stat.uid !== uid && (requireOwner || stat.uid !== 0)) ||
        (stat.mode & 0o022) !== 0
      ) {
        throw new Error(
          "Memory runtime ancestry must be owned by the user or system and not writable by other users",
        );
      }
      if (requirePrivate && (stat.mode & 0o077) !== 0) {
        throw new Error("Memory runtime directory must already be private (mode 0700)");
      }
    }
  }
  // Reject any existing redirection before the first write. The user runtime base
  // must already exist; in particular, never invent /run/user/<uid> or use /tmp.
  const filesystemRoot = path.parse(root).root;
  const segments = path.relative(filesystemRoot, root).split(path.sep).filter(Boolean);
  let cursor = filesystemRoot;
  inspect(cursor, false, false);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const underBase = cursor === base || !path.relative(base, cursor).startsWith("..");
    try {
      inspect(
        cursor,
        (cursor === base && privateBase) || (underBase && cursor !== base),
        underBase,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!underBase || cursor === base)
        throw new Error(
          "Memory requires an existing private user runtime directory; configure XDG_RUNTIME_DIR or restore the local application-data directory",
        );
    }
  }
  const canonicalBase = realpathSync(base);
  const canonicalRoot = path.join(canonicalBase, path.relative(base, root));
  if (overlaps(canonicalProject, canonicalRoot, platform))
    throw new Error("Memory coordination must remain outside the project root");
  socketBudget(canonicalRoot, platform);
  cursor = base;
  for (const segment of path.relative(base, root).split(path.sep)) {
    inspect(cursor, cursor !== base || privateBase, true);
    cursor = path.join(cursor, segment);
    try {
      mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    inspect(cursor, true, true);
  }
  return realpathSync(root);
}
