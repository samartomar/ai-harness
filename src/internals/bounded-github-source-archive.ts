import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_PATH_BYTES = 4_096;
const MAX_PATH_SEGMENTS = 64;
const RESERVED_WINDOWS_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
type Material = Readonly<{ digest: string; bytes: number }>;
type ExtractedMaterial = Readonly<{
  files: ReadonlyMap<string, Material>;
  directories: ReadonlySet<string>;
  omittedLinks: ReadonlyMap<string, string>;
}>;
type AcquiredRoot = Readonly<{
  repository: string;
  commit: string;
  files: ReadonlyMap<string, Material>;
  directories: ReadonlySet<string>;
  omittedLinks: ReadonlyMap<string, string>;
}>;
const acquired = new Map<string, AcquiredRoot>();

function fail(message: string): never {
  throw new Error(`Bounded GitHub source archive: ${message}`);
}
function octal(bytes: Buffer, start: number, length: number): number {
  const text = bytes
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/u, "")
    .trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) fail("invalid tar numeric field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid tar numeric field");
  return value;
}
function field(bytes: Buffer, start: number, length: number): string {
  return bytes
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/u, "");
}
function validChecksum(header: Buffer): boolean {
  const declared = octal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < 512; index += 1)
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  return declared === actual;
}
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
}
function assertPathSegment(value: string, label: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("\\") ||
    value.includes(":") ||
    hasControlCharacter(value) ||
    /[. ]$/u.test(value) ||
    value.normalize("NFC") !== value ||
    /\p{C}/u.test(value) ||
    RESERVED_WINDOWS_SEGMENT.test(value)
  )
    fail(label);
}
function archivePath(name: string): Readonly<{ topLevel: string; path: string | undefined }> {
  if (!name || Buffer.byteLength(name, "utf8") > MAX_PATH_BYTES || isAbsolute(name))
    fail("unsafe tar path");
  const parts = name.replace(/\/+$/u, "").split("/");
  if (parts.length > MAX_PATH_SEGMENTS) fail("unsafe tar path");
  for (const part of parts) assertPathSegment(part, "unsafe tar path");
  const topLevel = parts[0];
  if (topLevel === undefined) fail("unsafe tar path");
  return { topLevel, path: parts.length === 1 ? undefined : parts.slice(1).join("/") };
}
function assertedRelativePath(path: string): string {
  if (!path || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES || isAbsolute(path))
    fail("unsafe acquired path");
  const parts = path.split("/");
  if (parts.length > MAX_PATH_SEGMENTS) fail("unsafe acquired path");
  for (const part of parts) assertPathSegment(part, "unsafe acquired path");
  return parts.join("/");
}
function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value.length > 0 &&
    !value.startsWith("..") &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/u).includes("..")
  );
}
function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function addParentDirectories(directories: Set<string>, path: string): void {
  const parts = path.split("/");
  for (let length = 1; length < parts.length; length += 1)
    directories.add(parts.slice(0, length).join("/"));
}
function assertManifestBound(
  files: ReadonlyMap<string, Material>,
  directories: ReadonlySet<string>,
  omittedLinks: ReadonlyMap<string, string> = new Map(),
): void {
  if (files.size + directories.size + omittedLinks.size > MAX_ENTRIES)
    fail("tar archive exceeds inode bound");
}
function parsePaxPath(bytes: Buffer): string {
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset) fail("invalid PAX path extension");
    const countText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(countText)) fail("invalid PAX path extension");
    const count = Number(countText);
    if (
      !Number.isSafeInteger(count) ||
      count > bytes.length - offset ||
      count <= space - offset + 1
    )
      fail("invalid PAX path extension");
    const recordEnd = offset + count;
    const record = bytes.subarray(space + 1, recordEnd);
    if (record.at(-1) !== 0x0a) fail("invalid PAX path extension");
    const equals = record.indexOf(0x3d);
    if (equals <= 0) fail("invalid PAX path extension");
    const key = record.subarray(0, equals).toString("ascii");
    if (key !== "path" || path !== undefined) fail("unsafe PAX path extension");
    path = record.subarray(equals + 1, -1).toString("utf8");
    offset = recordEnd;
  }
  if (path === undefined) fail("missing PAX path extension");
  archivePath(path);
  return path;
}
function assertGlobalPax(bytes: Buffer, name: string, commit: string): void {
  if (name !== "pax_global_header" || !bytes.equals(Buffer.from(`52 comment=${commit}\n`, "utf8")))
    fail("unsafe global PAX metadata");
}
function assertSafeParentChain(root: string): void {
  const temporary = resolve(tmpdir());
  const insideTemporary = root === temporary || contained(temporary, root);
  const canonicalTemporary = insideTemporary ? realpathSync(temporary) : undefined;
  for (let current = dirname(root); ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("destination parent is unsafe");
      if (insideTemporary) {
        const expected = resolve(canonicalTemporary!, relative(temporary, current));
        if (realpathSync(current) !== expected) fail("destination parent is unsafe");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Bounded GitHub source archive:"))
        throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("destination parent is unsafe");
    }
    if (insideTemporary && current === temporary) return;
    const parent = dirname(current);
    if (parent === current) return;
  }
}
function createOwnedDestination(destination: string): void {
  try {
    lstatSync(destination);
    fail("destination already exists");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Bounded GitHub source archive:"))
      throw error;
  }
  assertSafeParentChain(destination);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(destination, { mode: 0o700 });
  } catch {
    fail("destination already exists");
  }
  const stat = lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("destination is unsafe");
}
async function download(url: string): Promise<Buffer> {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "codeload.github.com" ||
    target.port ||
    target.username ||
    target.password
  )
    fail("unexpected archive endpoint");
  const response = await fetch(target.toString(), {
    // GitHub may take more than thirty seconds to generate a pinned archive.
    // Retain a finite deadline and the independent compressed/expanded byte caps.
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    fail("archive download failed");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > MAX_COMPRESSED_BYTES)
  ) {
    await response.body.cancel();
    fail("compressed archive exceeds byte limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_COMPRESSED_BYTES) fail("compressed archive exceeds byte limit");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  if (total === 0) fail("archive is empty");
  return Buffer.concat(chunks);
}
function extract(bytes: Buffer, destination: string, commit: string): ExtractedMaterial {
  let expanded: Buffer;
  try {
    expanded = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    fail("archive decompression failed or exceeded byte limit");
  }
  const root = resolve(destination);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("destination is unsafe");
  const seen = new Set<string>();
  const seenFolded = new Set<string>();
  const files = new Map<string, Material>();
  const directories = new Set<string>();
  const omittedLinks = new Map<string, string>();
  let archiveTopLevel: string | undefined;
  let pendingPath: string | undefined;
  let offset = 0;
  let entries = 0;
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (!validChecksum(header)) fail("invalid tar checksum");
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const rawName = prefix ? `${prefix}/${name}` : name;
    const type = field(header, 156, 1) || "0";
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / 512) * 512;
    offset += 512;
    entries += 1;
    if (
      entries > MAX_ENTRIES ||
      size > MAX_ENTRY_BYTES ||
      !Number.isSafeInteger(padded) ||
      offset + padded > expanded.length
    )
      fail("tar archive exceeds structural bound");
    const contents = expanded.subarray(offset, offset + size);
    if (type === "g") {
      assertGlobalPax(contents, rawName, commit);
      offset += padded;
      continue;
    }
    if (type === "x") {
      if (pendingPath !== undefined) fail("repeated PAX path extension");
      pendingPath = parsePaxPath(contents);
      offset += padded;
      continue;
    }
    const archiveEntry = archivePath(pendingPath ?? rawName);
    pendingPath = undefined;
    if (archiveTopLevel === undefined) archiveTopLevel = archiveEntry.topLevel;
    if (archiveEntry.topLevel !== archiveTopLevel) fail("multiple archive roots");
    const path = archiveEntry.path;
    if (path === undefined) {
      if (type !== "5") fail("unsafe tar root entry");
      offset += padded;
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "5" && type !== "2")
      fail("unsafe tar entry type");
    const folded = path.toLocaleLowerCase("en-US");
    if (seen.has(path) || seenFolded.has(folded)) fail("duplicate tar path");
    if (type === "2") {
      const linkTarget = field(header, 157, 100);
      if (!linkTarget || linkTarget.includes("\\") || isAbsolute(linkTarget))
        fail("unsafe tar link");

      if (
        [...files.keys(), ...directories].some((existing) => {
          const existingFolded = existing.toLocaleLowerCase("en-US");
          return existingFolded === folded || existingFolded.startsWith(`${folded}/`);
        }) ||
        [...files.keys()].some((existing) =>
          folded.startsWith(`${existing.toLocaleLowerCase("en-US")}/`),
        )
      )
        fail("link overlaps materialized path");
      seen.add(path);
      seenFolded.add(folded);
      omittedLinks.set(path, linkTarget);
      assertManifestBound(files, directories, omittedLinks);
      offset += padded;
      continue;
    }
    if (
      [...omittedLinks.keys()].some((link) => {
        const linkFolded = link.toLocaleLowerCase("en-US");
        return (
          folded === linkFolded ||
          folded.startsWith(`${linkFolded}/`) ||
          (type !== "5" && linkFolded.startsWith(`${folded}/`))
        );
      })
    )
      fail("materialized path overlaps omitted link");
    seen.add(path);
    seenFolded.add(folded);
    const target = resolve(root, ...path.split("/"));
    if (!contained(root, target)) fail("tar path escapes destination");
    if (type === "5") {
      directories.add(path);
      addParentDirectories(directories, path);
      assertManifestBound(files, directories, omittedLinks);
      mkdirSync(target, { recursive: true, mode: 0o700 });
    } else {
      files.set(
        path,
        Object.freeze({
          digest: createHash("sha256").update(contents).digest("hex"),
          bytes: contents.length,
        }),
      );
      addParentDirectories(directories, path);
      assertManifestBound(files, directories, omittedLinks);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, contents, { flag: "wx", mode: 0o600 });
    }
    offset += padded;
  }
  if (pendingPath !== undefined) fail("unconsumed PAX path extension");
  if (offset !== expanded.length && !expanded.subarray(offset).every((byte) => byte === 0))
    fail("trailing tar bytes");
  if (files.size === 0) fail("archive has no files");
  return Object.freeze({ files, directories, omittedLinks });
}
function requestedFileMatches(root: string, file: string, material: Material): boolean {
  if (!contained(root, file)) return false;
  for (let current = file; ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (current === file) {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== material.bytes) return false;
      } else if (!stat.isDirectory()) return false;
    } catch {
      return false;
    }
    if (current === root) return true;
    if (!contained(root, dirname(current)) && dirname(current) !== root) return false;
  }
}
/** Reads a regular acquired file through one stable descriptor, never after a separate path check. */
function readDescriptorBackedAcquiredFile(path: string, material: Material): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor);
    const named = lstatSync(path);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      opened.ino !== named.ino ||
      opened.dev !== named.dev ||
      opened.size !== named.size ||
      opened.size !== material.bytes
    )
      return undefined;
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    const bytes = buffer.subarray(0, length);
    if (
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== material.digest
    )
      return undefined;
    return Buffer.from(bytes);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function acquiredTreeMatches(root: string, proof: AcquiredRoot): boolean {
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const walk = (directory: string, relativeDirectory: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return false;
    }
    for (const name of entries) {
      try {
        assertPathSegment(name, "unsafe acquired path");
      } catch {
        return false;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const path = resolve(root, ...relativePath.split("/"));
      if (!contained(root, path)) return false;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) {
          if (!proof.directories.has(relativePath)) return false;
          seenDirectories.add(relativePath);
          if (seenFiles.size + seenDirectories.size > MAX_ENTRIES) return false;
          if (!walk(path, relativePath)) return false;
          continue;
        }
        const material = proof.files.get(relativePath);
        if (
          material === undefined ||
          readDescriptorBackedAcquiredFile(path, material) === undefined
        )
          return false;
        seenFiles.add(relativePath);
        if (seenFiles.size + seenDirectories.size > MAX_ENTRIES) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !walk(root, "")) return false;
  } catch {
    return false;
  }
  return (
    seenFiles.size === proof.files.size &&
    seenDirectories.size === proof.directories.size &&
    [...proof.files.keys()].every((path) => seenFiles.has(path)) &&
    [...proof.directories].every((path) => seenDirectories.has(path))
  );
}

/** Acquires one exact GitHub archive with no Git process and records private root custody. */
export async function acquireBoundedGithubSourceArchiveV1(
  input: Readonly<{ repository: string; commit: string; destination: string }>,
): Promise<string> {
  const repositoryParts = input.repository.split("/");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) ||
    repositoryParts.some((part) => part === "." || part === "..") ||
    !/^[a-f0-9]{40}$/u.test(input.commit)
  )
    fail("invalid repository identity");
  const destination = resolve(input.destination);
  if (acquired.has(destination)) fail("destination already acquired");
  createOwnedDestination(destination);
  try {
    const material = extract(
      await download(`https://codeload.github.com/${input.repository}/tar.gz/${input.commit}`),
      destination,
      input.commit,
    );
    const proof = Object.freeze({
      repository: input.repository,
      commit: input.commit,
      files: material.files,
      directories: material.directories,
      omittedLinks: material.omittedLinks,
    });
    acquired.set(destination, proof);
    if (!acquiredTreeMatches(destination, proof)) fail("extracted archive custody mismatch");
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

export type AcquiredGithubSourceTreeEntryV1 = Readonly<
  | { type: "directory"; path: string }
  | { type: "file"; path: string; bytes: number; sha256: string }
  | { type: "symlink"; path: string; target: string }
>;
/**
 * Supplies the exact literal source-tree identity for a private acquired root.
 * It never materializes or follows omitted symlinks; a known mutated root fails.
 */
export function acquiredGithubSourceTreeEntriesV1(
  rootInput: string,
): readonly AcquiredGithubSourceTreeEntryV1[] | undefined {
  const root = resolve(rootInput);
  const proof = acquired.get(root);
  if (proof === undefined) return undefined;
  if (!acquiredTreeMatches(root, proof)) fail("acquired root changed after extraction");
  return [
    ...[...proof.directories].map((path) => ({ type: "directory" as const, path })),
    ...[...proof.files].map(([path, material]) => ({
      type: "file" as const,
      path,
      bytes: material.bytes,
      sha256: material.digest,
    })),
    ...[...proof.omittedLinks].map(([path, target]) => ({
      type: "symlink" as const,
      path,
      target,
    })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
/** Tests only the private same-process identity map; it does not validate on-disk bytes. */
export function isKnownAcquiredGithubSourceRootV1(
  rootInput: string,
  repository: string,
  commit: string,
): boolean {
  const proof = acquired.get(resolve(rootInput));
  return proof?.repository === repository && proof.commit === commit;
} /**
 * Rejects a component declaration that intersects a private archive link which
 * was deliberately retained only as virtual source identity metadata.
 * Unknown roots are ordinary filesystem roots and need no special handling.
 */
export function assertAcquiredGithubSourceComponentPathsV1(
  rootInput: string,
  paths: readonly string[],
): void {
  const proof = acquired.get(resolve(rootInput));
  if (proof === undefined) return;
  for (const rawPath of paths) {
    const path = assertedRelativePath(rawPath);
    if ([...proof.omittedLinks.keys()].some((link) => pathsOverlap(link, path)))
      fail("declared component material overlaps omitted link");
  }
}
/** Private-custody check for an acquired root; callers cannot register arbitrary roots. */
export function assertAcquiredGithubSourceRootV1(
  rootInput: string,
  repository: string,
  commit: string,
): boolean {
  const root = resolve(rootInput);
  const proof = acquired.get(root);
  return (
    proof?.repository === repository && proof.commit === commit && acquiredTreeMatches(root, proof)
  );
}
/**
 * Confirms every declared source path remains within the private acquired root
 * and does not equal, contain, or descend through an omitted archive symlink.
 */
export function assertAcquiredGithubSourceMaterialPathsV1(
  rootInput: string,
  repository: string,
  commit: string,
  paths: readonly string[],
): boolean {
  const root = resolve(rootInput);
  const proof = acquired.get(root);
  if (
    proof === undefined ||
    proof.repository !== repository ||
    proof.commit !== commit ||
    !acquiredTreeMatches(root, proof) ||
    paths.length > MAX_ENTRIES
  )
    return false;
  try {
    const unique = new Set(paths.map(assertedRelativePath));
    return (
      unique.size === paths.length &&
      [...unique].every((path) =>
        [...proof.omittedLinks.keys()].every((link) => !pathsOverlap(link, path)),
      )
    );
  } catch {
    return false;
  }
} /** Returns one acquired file after its private manifest entry and ancestor chain still match. */
export function readAcquiredGithubSourceFileV1(
  rootInput: string,
  repository: string,
  commit: string,
  pathInput: string,
): Buffer | undefined {
  const root = resolve(rootInput);
  const proof = acquired.get(root);
  if (proof === undefined || proof.repository !== repository || proof.commit !== commit)
    return undefined;
  const path = assertedRelativePath(pathInput);
  const material = proof.files.get(path);
  if (material === undefined) return undefined;
  const file = resolve(root, ...path.split("/"));
  if (!requestedFileMatches(root, file, material)) return undefined;
  return readDescriptorBackedAcquiredFile(file, material);
}
export function forgetAcquiredGithubSourceArchiveV1(rootInput: string): void {
  acquired.delete(resolve(rootInput));
}
export const BOUNDED_GITHUB_SOURCE_ARCHIVE_LIMITS_V1 = Object.freeze({
  compressedBytes: MAX_COMPRESSED_BYTES,
  expandedBytes: MAX_EXPANDED_BYTES,
  entryBytes: MAX_ENTRY_BYTES,
  entries: MAX_ENTRIES,
});
