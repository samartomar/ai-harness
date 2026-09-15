import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS,
  CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION,
  type CodebaseMemoryNativePayloadPin,
  type CodebaseMemoryNativePayloadTarget,
} from "./codebase-memory-native-pins.js";
import { codebaseMemoryNativeBinaryPath } from "./codebase-memory-runtime.js";

const HASH_BUFFER_BYTES = 1024 * 1024;

export interface AuthenticateCodebaseMemoryNativePayloadInput {
  readonly runtimeHome: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

export interface AuthenticatedCodebaseMemoryNativePayload {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly version: string;
}

interface SafeDirectory {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function fail(reason: string): never {
  throw new Error(`Codebase Memory native payload ${reason}`);
}

function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function targetFor(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): CodebaseMemoryNativePayloadPin {
  if (typeof platform !== "string" || typeof arch !== "string") {
    fail("platform and architecture must be strings");
  }
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS, target)) {
    fail("platform and architecture are not supported");
  }
  const typedTarget = target as CodebaseMemoryNativePayloadTarget;
  return CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS[typedTarget];
}

async function safeDirectory(path: string, root: string, label: string): Promise<SafeDirectory> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail(`${label} must be a real directory`);
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    fail(`${label} could not be canonicalized`);
  }
  if (!isContained(root, canonical)) fail(`${label} escapes the runtime home`);
  return { path, dev: stats.dev, ino: stats.ino };
}

async function canonicalRuntimeHome(value: string): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) {
    fail("runtime home must be an absolute path");
  }
  const requested = resolve(value);
  let stats: Stats;
  try {
    stats = await lstat(requested);
  } catch {
    fail("runtime home is unavailable");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail("runtime home must be a real directory");
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    fail("runtime home could not be canonicalized");
  }
  const canonicalStats = await safeDirectory(canonical, canonical, "runtime home");
  if (canonicalStats.dev !== stats.dev || canonicalStats.ino !== stats.ino) {
    fail("runtime home changed while canonicalizing");
  }
  return canonical;
}

async function captureSafeAncestry(
  root: string,
  target: string,
): Promise<readonly SafeDirectory[]> {
  const parent = dirname(target);
  if (!isContained(root, parent)) fail("expected path escapes the runtime home");
  const parts = relative(root, parent)
    .split(/[\\/]+/u)
    .filter(Boolean);
  const directories: SafeDirectory[] = [await safeDirectory(root, root, "runtime home")];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    directories.push(await safeDirectory(current, root, "payload directory"));
  }
  return directories;
}

async function assertSameSafeAncestry(
  root: string,
  directories: readonly SafeDirectory[],
): Promise<void> {
  for (const directory of directories) {
    const current = await safeDirectory(directory.path, root, "payload directory");
    if (current.dev !== directory.dev || current.ino !== directory.ino) {
      fail("directory ancestry changed while authenticating");
    }
  }
}

function assertExpectedFile(stats: Stats, pin: CodebaseMemoryNativePayloadPin): void {
  if (!stats.isFile() || stats.nlink !== 1) {
    fail("must be an unambiguous regular file");
  }
  if (stats.size !== pin.size) fail("has an unexpected size");
  if (process.platform !== "win32" && (stats.mode & 0o111) === 0) {
    fail("must be executable on Unix");
  }
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

async function streamSha256(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, expectedSize));
  let offset = 0;
  while (offset < expectedSize) {
    const length = Math.min(buffer.length, expectedSize - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) fail("was truncated while hashing");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * Authenticate an extracted, host-native Codebase Memory executable before a
 * launcher may execute it. Archive integrity alone is insufficient because the
 * extracted path remains mutable after installation.
 */
export async function authenticateCodebaseMemoryNativePayload(
  input: AuthenticateCodebaseMemoryNativePayloadInput,
): Promise<AuthenticatedCodebaseMemoryNativePayload> {
  if (input === null || typeof input !== "object") fail("input must be an object");
  const pin = targetFor(input.platform, input.arch);
  const runtimeHome = await canonicalRuntimeHome(input.runtimeHome);
  const expectedPath = codebaseMemoryNativeBinaryPath(input.platform, runtimeHome);
  const ancestry = await captureSafeAncestry(runtimeHome, expectedPath);

  let before: Stats;
  try {
    before = await lstat(expectedPath);
  } catch {
    fail("is unavailable");
  }
  if (before.isSymbolicLink()) fail("must not be a symbolic link");
  assertExpectedFile(before, pin);

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(expectedPath, flags);
  } catch {
    fail("could not be opened safely");
  }
  try {
    const opened = await handle.stat();
    let current: Stats;
    try {
      current = await lstat(expectedPath);
    } catch {
      fail("changed while opening");
    }
    if (
      current.isSymbolicLink() ||
      !sameFileSnapshot(before, current) ||
      !sameFileSnapshot(opened, current)
    ) {
      fail("changed while opening");
    }
    assertExpectedFile(opened, pin);
    const canonical = await realpath(expectedPath).catch(() => fail("could not be canonicalized"));
    if (!isContained(runtimeHome, canonical)) fail("escapes the runtime home");
    await assertSameSafeAncestry(runtimeHome, ancestry);

    const sha256 = await streamSha256(handle, pin.size);
    const after = await handle.stat();
    let currentAfter: Stats;
    try {
      currentAfter = await lstat(expectedPath);
    } catch {
      fail("changed while hashing");
    }
    if (
      currentAfter.isSymbolicLink() ||
      !sameFileSnapshot(opened, after) ||
      !sameFileSnapshot(after, currentAfter)
    ) {
      fail("changed while hashing");
    }
    assertExpectedFile(after, pin);
    await assertSameSafeAncestry(runtimeHome, ancestry);
    if (sha256 !== pin.sha256) fail("failed SHA-256 authentication");
    return {
      path: canonical,
      sha256,
      size: pin.size,
      version: CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION,
    };
  } finally {
    await handle.close();
  }
}
