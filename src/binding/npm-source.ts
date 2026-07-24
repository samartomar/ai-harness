import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { hashComponentTree } from "../baseline-evidence/hash.js";
import type { Runner } from "../internals/proc.js";
import { BindingScanError, type ResolvedNpmSource } from "./scan-gate.js";
import { BindingNpmSourceSchema } from "./schema.js";

/**
 * EXACT npm tarball acquisition for the binding fast-scan gate ("scan what
 * you execute"). {@link acquireNpmTree} is the npm mirror of `resolveGitSource`:
 * given a {@link ResolvedNpmSource} identity ({package, exactVersion, integrity}),
 * it acquires the exact published tarball, SRI-verifies the bytes BEFORE anything
 * is unpacked, optionally asserts the registry `gitHead`, extracts the UNTRUSTED
 * tarball with validate-before-write containment (refusing absolute/drive/`..`
 * traversal and symlink/hardlink entries), strips the npm `package/` root prefix,
 * and digests the tree with the SAME `hashComponentTree` idiom git uses — so an
 * identical tree digests identically. The result feeds the gate unchanged via
 * `scannableFromNpm`.
 *
 * The extraction is a deliberate, dependency-free port of the USTAR reader the
 * trust pipeline already ships (see `src/trust/fetch.ts`), which lives inside a
 * quarantined subprocess script and so cannot be imported here.
 */

/**
 * Transport timeout for the npm CLI (pack/view) — a whole-package download sized
 * by the registry, not us; matches the git resolver's TRANSPORT_TIMEOUT_MS class.
 */
const TRANSPORT_TIMEOUT_MS = 120_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface AcquireNpmTreeOptions {
  runner: Runner;
  cacheHome: string;
  /**
   * When set, `npm view <pkg>@<version> gitHead` must equal this exact value or
   * acquisition fails closed — a source-provenance assertion beyond the SRI.
   */
  expectedGitHead?: string;
}

// -- Content-addressed tree cache metadata -----------------------------------

const NpmTreeMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    package: z.string().min(1),
    exactVersion: z.string().min(1),
    integrity: z.string().min(1),
    treeDigest: z.string().regex(SHA256_HEX),
    gitHead: z.string().min(1).optional(),
  })
  .strict();

type NpmTreeMeta = z.infer<typeof NpmTreeMetaSchema>;

// -- USTAR reader (validate-before-write; untrusted input) -------------------

function tarText(buffer: Buffer, start: number, len: number): string {
  return buffer
    .subarray(start, start + len)
    .toString("utf8")
    .replace(/\0.*$/, "");
}

function tarOctal(buffer: Buffer, start: number, len: number): number {
  const raw = buffer
    .subarray(start, start + len)
    .toString("utf8")
    .replace(/\0.*$/, "")
    .trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

/**
 * Reduce a tar entry name to a safe, root-stripped POSIX path, or `undefined` for
 * the root-prefix directory itself. Refuses (fail-closed) any name that is
 * absolute, drive-lettered (cross-platform, so a `C:` name is caught even off
 * Windows), backslash-bearing, or contains a `.`/`..`/empty segment — before any
 * byte is written. The leading segment (npm's `package/`) is stripped.
 */
function strippedRel(name: string): string | undefined {
  if (name.includes("\\") || /^[A-Za-z]:/.test(name) || isAbsolute(name)) {
    throw new BindingScanError(`refusing unsafe npm tar entry (absolute/drive path): ${name}`);
  }
  const normalized = name.replace(/\/+$/, "");
  if (normalized.length === 0) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "." || part === ".." || part === "")) {
    throw new BindingScanError(`refusing unsafe npm tar entry (path traversal): ${name}`);
  }
  if (parts.length === 1) return undefined; // the "package/" root prefix directory
  return parts.slice(1).join("/");
}

/** Prove a resolved target stays under the extraction root (defense in depth). */
function ensureContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new BindingScanError(`refusing npm tar path escape: ${target}`);
}

/**
 * Extract a (gunzipped) tar buffer into `outRoot`, materializing ONLY regular
 * files and directories under the stripped root. Symlink (type 2), hardlink (type
 * 1), and every other non-regular entry are refused; pax/global extended headers
 * (g/x) are skipped. Files are written exclusively (`wx`), so a duplicated entry
 * cannot overwrite an already-materialized path.
 */
function extractNpmTar(buffer: Buffer, outRoot: string): void {
  mkdirSync(outRoot, { recursive: true });
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const linkName = tarText(header, 157, 100);
    const size = tarOctal(header, 124, 12);
    const type = tarText(header, 156, 1) || "0";
    offset += 512;
    const rel = strippedRel(fullName);
    if (rel === undefined) {
      // Root-prefix directory or a metadata-only header: skip its payload; refuse
      // anything else that reduced to no usable path.
      if (type !== "5" && type !== "g" && type !== "x") {
        throw new BindingScanError(`refusing unsafe npm tar entry: ${fullName}`);
      }
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === "g" || type === "x") {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const target = resolvePath(outRoot, rel);
    ensureContained(outRoot, target);
    if (type === "5") {
      mkdirSync(target, { recursive: true });
    } else if (type === "0" || type === "\0") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer.subarray(offset, offset + size), { flag: "wx" });
    } else if (type === "2") {
      throw new BindingScanError(`refusing npm tar symlink entry: ${fullName} -> ${linkName}`);
    } else {
      throw new BindingScanError(`refusing non-regular npm tar entry: ${fullName} (type ${type})`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

// -- Tree digest ------------------------------------------------------------

/** Top-level entries (except `.git`), sorted — the digest's declared roots. */
function topLevelPaths(treeDir: string): string[] {
  const entries = readdirSync(treeDir).filter((name) => name !== ".git");
  if (entries.length === 0) {
    throw new BindingScanError("npm tarball produced no scannable content");
  }
  return entries.sort((left, right) => left.localeCompare(right));
}

function enrich(
  identity: { package: string; exactVersion: string; integrity: string },
  treeDir: string,
  treeDigest: string,
  files: readonly string[],
  gitHead: string | undefined,
): ResolvedNpmSource {
  return {
    kind: "npm",
    package: identity.package,
    exactVersion: identity.exactVersion,
    integrity: identity.integrity,
    treeDigest,
    treePath: treeDir,
    files,
    gitHead,
  };
}

/**
 * Serve a cached tree ONLY after re-verifying it — a corrupt or partial cache
 * (interrupted prior run, tampered content) must re-acquire, never be trusted.
 * Mirrors the git resolver's `cachedCheckoutIsAtCommit` guard: identity match,
 * then a fresh digest recomputation that must equal the recorded one.
 */
function servedFromCache(
  treeDir: string,
  metaPath: string,
  identity: { package: string; exactVersion: string; integrity: string },
  expectedGitHead: string | undefined,
): ResolvedNpmSource | undefined {
  if (!existsSync(metaPath) || !existsSync(treeDir)) return undefined;
  let meta: NpmTreeMeta;
  try {
    const parsed = NpmTreeMetaSchema.safeParse(JSON.parse(readFileSync(metaPath, "utf8")));
    if (!parsed.success) return undefined;
    meta = parsed.data;
  } catch {
    return undefined;
  }
  if (
    meta.integrity !== identity.integrity ||
    meta.package !== identity.package ||
    meta.exactVersion !== identity.exactVersion
  ) {
    return undefined;
  }
  if (expectedGitHead !== undefined && meta.gitHead !== expectedGitHead) return undefined;
  let hashed: ReturnType<typeof hashComponentTree>;
  try {
    hashed = hashComponentTree(treeDir, topLevelPaths(treeDir));
  } catch {
    return undefined;
  }
  if (hashed.treeSha256 !== meta.treeDigest) return undefined;
  return enrich(
    identity,
    treeDir,
    meta.treeDigest,
    hashed.files.map((file) => file.path),
    meta.gitHead,
  );
}

// -- npm CLI seams ----------------------------------------------------------

/** `npm pack <pkg>@<version> --ignore-scripts` into `destDir`; returns the tgz path. */
async function packTarball(runner: Runner, spec: string, destDir: string): Promise<string> {
  const result = await runner(
    ["npm", "pack", spec, "--ignore-scripts", "--pack-destination", destDir, "--silent"],
    { timeoutMs: TRANSPORT_TIMEOUT_MS },
  );
  if (result.spawnError) {
    throw new BindingScanError(
      `npm pack could not run for ${spec} (${(result.stderr || "").trim().slice(0, 200)})`,
    );
  }
  if (result.code !== 0) {
    throw new BindingScanError(
      `npm pack failed for ${spec} (exit ${result.code}: ${(result.stderr || "").trim().slice(0, 200)})`,
    );
  }
  const named = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  const fromStdout = named !== undefined && existsSync(join(destDir, named)) ? named : undefined;
  const tgz = fromStdout ?? readdirSync(destDir).find((name) => name.endsWith(".tgz"));
  if (tgz === undefined) {
    throw new BindingScanError(`npm pack wrote no tarball for ${spec}`);
  }
  return join(destDir, tgz);
}

/** Assert `npm view <spec> gitHead` equals the expected head; fail closed. */
async function verifyGitHead(runner: Runner, spec: string, expected: string): Promise<string> {
  const result = await runner(["npm", "view", spec, "gitHead"], {
    timeoutMs: TRANSPORT_TIMEOUT_MS,
  });
  if (result.spawnError || result.code !== 0) {
    throw new BindingScanError(
      `npm view gitHead failed for ${spec} (${(result.stderr || "").trim().slice(0, 200)})`,
    );
  }
  const got = result.stdout.trim().replace(/^"|"$/g, "");
  if (got !== expected) {
    throw new BindingScanError(
      `npm gitHead mismatch for ${spec}: expected ${expected}, registry reports ${got || "(none)"}`,
    );
  }
  return got;
}

// -- The acquisition entry point --------------------------------------------

/**
 * Acquire, verify, unpack, and digest the EXACT npm tarball for a resolved npm
 * identity, returning it enriched with the materialized tree (treeDigest /
 * treePath / files, and gitHead when asserted). Idempotent: a second call for the
 * same (package, version, integrity) serves the content-addressed cache only after
 * re-verifying the cached tree's digest. Fail-closed at every step (bad identity,
 * SRI mismatch, gitHead mismatch, malicious tar entry) — nothing is published to
 * the cache and staging is always cleaned.
 */
export async function acquireNpmTree(
  resolved: ResolvedNpmSource,
  opts: AcquireNpmTreeOptions,
): Promise<ResolvedNpmSource> {
  // 1. Re-validate identity against the shared schema guard — exact version + SRI
  //    only. A range/dist-tag version or non-SRI integrity fails closed here,
  //    before any CLI runs (reusing the schema; never duplicating the rule).
  const parsed = BindingNpmSourceSchema.safeParse({
    kind: "npm",
    package: resolved.package,
    exactVersion: resolved.exactVersion,
    integrity: resolved.integrity,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BindingScanError(
      `npm source is not exact, verifiable identity${issue ? `: ${issue.message}` : ""}`,
    );
  }
  const identity = {
    package: parsed.data.package,
    exactVersion: parsed.data.exactVersion,
    integrity: parsed.data.integrity,
  };
  const { runner, cacheHome, expectedGitHead } = opts;
  const spec = `${identity.package}@${identity.exactVersion}`;

  // Content-addressed by the integrity (the exact-content identity), so the dir
  // name is filesystem-safe and unique per published tarball.
  const token = createHash("sha256").update(identity.integrity).digest("hex");
  const entryDir = join(cacheHome, "npm", token);
  const treeDir = join(entryDir, "tree");
  const metaPath = join(entryDir, "meta.json");

  // 2. Cache hit — only after re-verifying the cached tree.
  const cached = servedFromCache(treeDir, metaPath, identity, expectedGitHead);
  if (cached !== undefined) return cached;

  // 3. Acquire → verify → unpack in staging, then atomically publish.
  mkdirSync(cacheHome, { recursive: true });
  const stagingDir = mkdtempSync(join(cacheHome, "npm-staging-"));
  try {
    const tgzBytes = readFileSync(await packTarball(runner, spec, stagingDir));

    // VERIFY BEFORE UNPACK — recompute the sha512 SRI over the exact bytes.
    const actual = `sha512-${createHash("sha512").update(tgzBytes).digest("base64")}`;
    if (actual !== identity.integrity) {
      throw new BindingScanError(
        `npm tarball integrity mismatch for ${spec}: expected ${identity.integrity}, got ${actual}`,
      );
    }

    // Provenance: the asserted gitHead must match the registry's.
    const gitHead =
      expectedGitHead === undefined
        ? undefined
        : await verifyGitHead(runner, spec, expectedGitHead);

    // Untrusted extraction into staging (validate-before-write), then digest with
    // the git-comparable tree hash.
    const stagingTree = join(stagingDir, "tree");
    extractNpmTar(gunzipSync(tgzBytes), stagingTree);
    const hashed = hashComponentTree(stagingTree, topLevelPaths(stagingTree));

    // Publish: replace any prior (corrupt) entry, then move the verified tree in.
    rmSync(entryDir, { recursive: true, force: true });
    mkdirSync(entryDir, { recursive: true });
    renameSync(stagingTree, treeDir);
    const meta: NpmTreeMeta = {
      schemaVersion: 1,
      package: identity.package,
      exactVersion: identity.exactVersion,
      integrity: identity.integrity,
      treeDigest: hashed.treeSha256,
      ...(gitHead !== undefined ? { gitHead } : {}),
    };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    return enrich(
      identity,
      treeDir,
      hashed.treeSha256,
      hashed.files.map((file) => file.path),
      gitHead,
    );
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
