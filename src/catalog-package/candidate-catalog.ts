import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import {
  CATALOG_PACKAGE_NAME,
  type CatalogPackageAccessV1,
  substituteCatalogPackageAccessV1,
} from "./load-catalog-package.js";

/**
 * Internal preparation tools only (owner decision D7, 2026-09-24). At pins the installed
 * Catalog does not carry yet, preparation may read an explicitly named candidate Catalog
 * whose sha256 the operator states up front:
 *
 * - an `npm pack` tarball (`.tgz`): the sha256 of the tarball bytes (`sha256sum -t <file>`);
 * - an extracted package directory: the sha256 of its canonical listing, one line
 *   `<sha256>  <path>\n` per regular file, in byte order of the package-relative path
 *   (`find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum -t | sha256sum`).
 *
 * The candidate is verified in memory and never executed. Activating it switches this
 * process's Catalog loads to the candidate for good: the installed Catalog becomes
 * unreachable and the candidate's named digest stands in for Core's accepted Catalog
 * digests. Core anchors the shipped Catalog's digests later (runbook step 11); runtime
 * never activates a candidate.
 */

export interface CandidateCatalogV1 {
  readonly sha256: string;
  readonly digestOf: "tarball" | "directory-listing";
  readonly version: string;
}

/** What a preparation read from the active candidate: its identity and every file's digest. */
export interface CandidateCatalogUseV1 extends CandidateCatalogV1 {
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

const LIMITS = { tarballBytes: 64 * 1024 * 1024, expandedBytes: 512 * 1024 * 1024, files: 20_000 };
const VIRTUAL_ROOT = "aih-candidate-catalog:/";

interface OpenedCandidateV1 {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly consumed: Map<string, string>;
}

const opened = new WeakMap<CandidateCatalogV1, OpenedCandidateV1>();
let active: CandidateCatalogV1 | undefined;

function fail(message: string): never {
  throw new TypeError(`Candidate Catalog: ${message}`);
}

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const byteOrder = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Printable ASCII, no backslash, no empty or dot segment: byte order equals code-unit order. */
function assertSafePath(path: string): void {
  if (
    !/^[\x20-\x5b\x5d-\x7e]+$/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    fail(`unsafe path ${JSON.stringify(path)}`);
}

function add(files: Map<string, Buffer>, path: string, bytes: Buffer): void {
  assertSafePath(path);
  if (files.has(path)) fail(`repeats ${path}`);
  if (files.size >= LIMITS.files) fail(`holds more than ${LIMITS.files} files`);
  files.set(path, bytes);
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number {
  const text = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(text)) fail("tarball has a malformed header");
  return Number.parseInt(text, 8);
}

interface PaxV1 {
  path?: string;
  size?: number;
}

/**
 * The pax keys `npm pack` writes (node-tar, portable mode) and this reader implements:
 * `path` names the next entry, `size` must equal its header size, and `mtime` is checked
 * for form and otherwise ignored because no recorded time is read. Every other key could
 * change what a pax-aware extractor installs, so it is refused rather than ignored.
 */
const PAX_KEYS = new Set(["path", "size", "mtime"]);

/** Strict `<length> <key>=<value>\n` records filling the whole extended header body. */
function paxRecords(bytes: Buffer): PaxV1 {
  if (bytes.length === 0) fail("tarball has an empty pax header");
  const malformed = () => fail("tarball has a malformed pax record");
  const pax: PaxV1 = {};
  const seen = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const lengthText = space === -1 ? "" : bytes.subarray(offset, space).toString("latin1");
    if (!/^[1-9][0-9]{0,8}$/.test(lengthText)) malformed();
    const end = offset + Number(lengthText);
    if (end > bytes.length || end - 1 <= space || bytes[end - 1] !== 0x0a) malformed();
    let record: string;
    try {
      record = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(space + 1, end - 1));
    } catch {
      return malformed();
    }
    const equals = record.indexOf("=");
    if (equals <= 0) malformed();
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (!PAX_KEYS.has(key)) fail(`tarball has unsupported pax key ${JSON.stringify(key)}`);
    if (seen.has(key)) fail(`tarball pax header repeats ${key}`);
    seen.add(key);
    if (key === "path") {
      if (value === "") malformed();
      pax.path = value;
    } else if (key === "size") {
      if (!/^(?:0|[1-9][0-9]{0,14})$/.test(value)) malformed();
      pax.size = Number(value);
    } else if (!/^-?(?:0|[1-9][0-9]{0,18})(?:\.[0-9]{1,9})?$/.test(value)) malformed();
    offset = end;
  }
  return pax;
}

function tarballFiles(bytes: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: LIMITS.expandedBytes });
  } catch {
    return fail("the file is not a gzip'd tarball within its size limit");
  }
  const files = new Map<string, Buffer>();
  let pax: PaxV1 | undefined;
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let index = 0; index < 512; index += 1)
      sum += index >= 148 && index < 156 ? 0x20 : (block[index] as number);
    if (sum !== octal(block, 148, 8)) fail("tarball has a header checksum mismatch");
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] as number);
    const content = tar.subarray(offset + 512, offset + 512 + size);
    if (content.length !== size) fail("tarball is truncated");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") fail("tarball has a global pax header");
    if (type === "x") {
      if (pax !== undefined) fail("tarball has a pax header that follows a pax header");
      pax = paxRecords(content);
      continue;
    }
    const prefix = field(block, 257, 6) === "ustar" ? field(block, 345, 155) : "";
    const name = pax?.path ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    if (pax?.size !== undefined && pax.size !== size)
      fail(`tarball pax size ${pax.size} disagrees with the header size ${size} of ${name}`);
    pax = undefined;
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") fail(`unsupported tar entry type ${type} for ${name}`);
    if (!name.startsWith("package/")) fail(`tarball entry ${name} is outside package/`);
    add(files, name.slice("package/".length), Buffer.from(content));
  }
  if (!ended) fail("tarball has no end-of-archive marker");
  if (pax !== undefined) fail("tarball pax header describes no entry");
  // The marker is two zero blocks; only zero blocks (record padding) may follow it.
  const rest = tar.subarray(offset);
  if (rest.length % 512 !== 0 || !rest.every((byte) => byte === 0))
    fail("tarball has data after its end-of-archive marker");
  if (rest.length < 1024) fail("tarball has an incomplete end-of-archive marker");
  return files;
}

function directoryFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort(byteOrder)) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) fail(`holds symbolic link ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > LIMITS.expandedBytes) fail("directory exceeds its size limit");
        add(files, path, readFileSync(join(root, path)));
      } else fail(`holds ${path}, which is not a regular file`);
    }
  };
  walk("");
  return files;
}

/** Verify the named candidate against its operator-stated sha256; nothing is activated. */
export function openCandidateCatalogV1(path: string, sha256: string): CandidateCatalogV1 {
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("the sha256 must be 64 lowercase hex characters");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return fail(`${path} does not exist`);
  }
  let files: Map<string, Buffer>;
  let identity: Omit<CandidateCatalogV1, "version">;
  if (stat.isFile() && path.endsWith(".tgz")) {
    if (stat.size > LIMITS.tarballBytes) fail("tarball exceeds its size limit");
    const bytes = readFileSync(path);
    const observed = digest(bytes);
    if (observed !== sha256) fail(`tarball sha256 ${observed} does not match ${sha256}`);
    files = tarballFiles(bytes);
    identity = { sha256, digestOf: "tarball" };
  } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
    files = directoryFiles(path);
    const listing = [...files.keys()]
      .sort(byteOrder)
      .map((file) => `${digest(files.get(file) as Buffer)}  ${file}\n`)
      .join("");
    const observed = digest(listing);
    if (observed !== sha256) fail(`directory listing sha256 ${observed} does not match ${sha256}`);
    identity = { sha256, digestOf: "directory-listing" };
  } else {
    return fail(`${path} must be a .tgz tarball or a package directory`);
  }
  const manifestBytes = files.get("package.json");
  if (manifestBytes === undefined) fail("the package has no package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return fail("package.json is not JSON");
  }
  const { name, version, exports } = (manifest ?? {}) as Record<string, unknown>;
  if (name !== CATALOG_PACKAGE_NAME || typeof version !== "string")
    fail(`not an ${CATALOG_PACKAGE_NAME} package`);
  if (exports === null || typeof exports !== "object" || Array.isArray(exports))
    fail("package.json has no exports map");
  const candidate = Object.freeze({ ...identity, version });
  // The manifest interpreted here decides every export, even when its exports map sends the
  // `./package.json` subpath to another file, so it is always on the use record.
  opened.set(candidate, {
    files,
    exports: exports as Record<string, unknown>,
    consumed: new Map([["package.json", digest(manifestBytes)]]),
  });
  return candidate;
}

function accessFor(candidate: OpenedCandidateV1): CatalogPackageAccessV1 {
  const prefix = `${CATALOG_PACKAGE_NAME}/`;
  return {
    importPackage: () =>
      Promise.reject(
        new TypeError(
          "a candidate Catalog is data only; preparation never runs its code (ERR_CANDIDATE_CATALOG_DATA_ONLY)",
        ),
      ),
    resolve: (specifier) => {
      const subpath = specifier.startsWith(prefix) ? `./${specifier.slice(prefix.length)}` : "";
      const target = candidate.exports[subpath];
      const path = typeof target === "string" && target.startsWith("./") ? target.slice(2) : "";
      if (!path || !candidate.files.has(path))
        throw Object.assign(new Error(`candidate Catalog does not export ${subpath}`), {
          code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
        });
      return `${VIRTUAL_ROOT}${path}`;
    },
    readFile: (virtual) => {
      const path = virtual.startsWith(VIRTUAL_ROOT) ? virtual.slice(VIRTUAL_ROOT.length) : "";
      const bytes = candidate.files.get(path);
      if (bytes === undefined) throw new Error(`candidate Catalog does not hold ${virtual}`);
      candidate.consumed.set(path, digest(bytes));
      return Uint8Array.from(bytes);
    },
  };
}

/** From now on every Catalog load in this process reads the verified candidate. One-way. */
export function activateCandidateCatalogV1(candidate: CandidateCatalogV1): void {
  const verified = opened.get(candidate);
  if (verified === undefined) fail("was not opened and verified by openCandidateCatalogV1");
  substituteCatalogPackageAccessV1(accessFor(verified));
  active = candidate;
}

/** The active candidate and the digest of every file preparation read from it. */
export function activeCandidateCatalogUseV1(): CandidateCatalogUseV1 | undefined {
  if (active === undefined) return undefined;
  const consumed = opened.get(active)?.consumed ?? new Map<string, string>();
  return {
    ...active,
    files: [...consumed.keys()]
      .sort(byteOrder)
      .map((path) => ({ path, sha256: consumed.get(path) as string })),
  };
}

/** Where a preparation output's candidate Catalog use record lives. */
export function candidateCatalogUsePathV1(output: string): string {
  return `${output}.candidate-catalog.json`;
}

/**
 * Names the active candidate beside a written preparation output, so the final Core anchors
 * (runbook step 11) can prove the shipped Catalog carries the bytes this output was made
 * from. The output's own format is unchanged. Returns the record's path.
 */
export function writeCandidateCatalogUseV1(tool: string, output: string): string {
  const candidateCatalog = activeCandidateCatalogUseV1();
  if (candidateCatalog === undefined) fail("no candidate is active");
  const path = candidateCatalogUsePathV1(output);
  const record = {
    format: "aih-candidate-catalog-use",
    version: 1,
    tool,
    output: { file: basename(output), sha256: digest(readFileSync(output)) },
    candidateCatalog,
  };
  writeFileSync(path, canonicalStrictJsonBytesV1(record), { flag: "wx", mode: 0o600 });
  return path;
}
