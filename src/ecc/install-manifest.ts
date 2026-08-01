import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists, retryTransient } from "../internals/fsxn.js";

/**
 * ECC install manifest — the ownership record that lets a rerun tell an AIH-written
 * file from a user-edited one from a file AIH never touched (issue #555).
 *
 * The proof is an install manifest carrying a per-file content hash plus the ECC
 * source identity the install came from. Ownership is a three-state test, and the
 * third state is the point:
 *
 *   in manifest + hash matches  -> AIH wrote it, untouched      -> safe to replace
 *   in manifest + hash differs  -> AIH wrote it, user edited it -> report, never replace
 *   not in manifest             -> user-owned                   -> never touch
 *
 * Alternatives were rejected because each collapses a state that matters: an in-file
 * marker cannot be written into JSON/binary destinations and cannot separate an
 * untouched AIH file from an edited one; recomputed content identity keeps no record,
 * so files AIH no longer writes can never be identified as stale; and a paths-only
 * manifest cannot detect local modification, so an upgrade would silently clobber
 * user customization.
 *
 * A missing or unreadable manifest FAILS CLOSED to "not proven ours — do not touch",
 * never to "safe to overwrite": every path under the managed root then reports as
 * unknown provenance. That is also the honest answer for installs predating this
 * manifest — inferring ownership from a content match against the current source
 * would resurrect the rejected option, since it cannot tell an AIH-written file from
 * a user-authored identical one.
 *
 * Scope: DETECTION. Nothing here replaces, prunes, or reconciles content — making a
 * stale install visible and actionable is the whole job. The manifest lives in
 * repo-local `.aih/` state rather than inside the target directory, so it survives
 * target-directory cleanup (the case where ownership evidence matters most) and never
 * pollutes the tool's own surface. Writer/reader mirror `binding/lock.ts`.
 */

export const ECC_INSTALL_MANIFEST_SCHEMA_VERSION = "aih.ecc.install-manifest.v1";

/** Corrupt or schema-invalid ownership evidence — fail closed, never guess. */
export class EccInstallManifestError extends AihError {
  constructor(message: string) {
    super(message, "AIH_ECC_INSTALL_MANIFEST");
  }
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters");

/**
 * A destination path recorded relative to the install's managed `root`. Absolute
 * paths and any `..` segment are rejected: a manifest entry must never be able to
 * name a file outside the root it claims to own.
 */
const ManagedRelativePath = z
  .string()
  .min(1)
  .refine(
    (value) => !/^([a-zA-Z]:)?[\\/]/.test(value),
    "recorded path must be relative to the managed root",
  )
  .refine(
    (value) => !value.split(/[\\/]/).includes(".."),
    "recorded path must not escape the managed root",
  );

const EccManifestFileSchema = z.object({ path: ManagedRelativePath, sha256: Sha256 }).strict();

/**
 * The ECC source identity an install came from. `git-checkout` installs are
 * identified by commit, `npm` installs by package + version. A null identifying
 * field means "not resolvable on that run" and is never treated as a match.
 */
const EccManifestSourceSchema = z
  .object({
    kind: z.enum(["git-checkout", "npm"]),
    ref: z.string().nullable(),
    commit: z.string().nullable(),
    package: z.string().nullable(),
    version: z.string().nullable(),
  })
  .strict();

/** The mechanisms that actually write files. `consult` targets install nothing. */
export const ECC_INSTALL_MECHANISMS = ["npm", "checkout-merge", "native-script"] as const;
export type EccInstallMechanism = (typeof ECC_INSTALL_MECHANISMS)[number];

const EccManifestInstallSchema = z
  .object({
    target: z.string().min(1),
    mechanism: z.enum(ECC_INSTALL_MECHANISMS),
    root: z.string().min(1),
    installedAt: z.string().min(1),
    source: EccManifestSourceSchema,
    files: z.array(EccManifestFileSchema),
  })
  .strict();

const EccInstallManifestSchema = z
  .object({
    schemaVersion: z.literal(ECC_INSTALL_MANIFEST_SCHEMA_VERSION),
    installs: z.array(EccManifestInstallSchema),
  })
  .strict();

export type EccManifestFile = z.infer<typeof EccManifestFileSchema>;
export type EccManifestSource = z.infer<typeof EccManifestSourceSchema>;
export type EccManifestInstall = z.infer<typeof EccManifestInstallSchema>;
export type EccInstallManifest = z.infer<typeof EccInstallManifestSchema>;

export type EccInstallManifestRead =
  | { present: true; manifest: EccInstallManifest }
  | { present: false };

/** `<root>/.aih/ecc` — repo-local, gitignored derived state (never inside the target dir). */
export function eccInstallManifestDir(root: string): string {
  return join(root, ".aih", "ecc");
}

export function eccInstallManifestPath(root: string): string {
  return join(eccInstallManifestDir(root), "install-manifest.json");
}

function parseManifest(value: unknown, where: string): EccInstallManifest {
  const result = EccInstallManifestSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at =
      issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
    throw new EccInstallManifestError(`invalid ECC install manifest ${where}${at}`);
  }
  return result.data;
}

function assertNotSymlink(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    throw new EccInstallManifestError(`refusing symlinked ECC install manifest path: ${path}`);
  }
}

/**
 * Read the ownership record. Absent => `{ present: false }` — a repo never installed
 * by a manifest-aware aih. A PRESENT file that is unparseable or schema-invalid throws:
 * damaged ownership evidence must never degrade to "empty", because empty would read
 * as "nothing is ours" in one direction and "nothing is user-owned" in the other.
 */
export function readEccInstallManifest(root: string): EccInstallManifestRead {
  const path = eccInstallManifestPath(root);
  assertNotSymlink(path);
  const raw = readIfExists(path);
  if (raw === undefined) return { present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EccInstallManifestError(`ECC install manifest is not valid JSON: ${path}`);
  }
  return { present: true, manifest: parseManifest(parsed, path) };
}

function prepareManifestDir(root: string): string {
  let current = root;
  for (const segment of [".aih", "ecc"]) {
    current = join(current, segment);
    assertNotSymlink(current);
    if (!existsSync(current)) mkdirSync(current, { recursive: false, mode: 0o700 });
  }
  return current;
}

/**
 * Atomically write the manifest (validate -> temp file with owner-only mode -> rename),
 * mirroring the binding lock writer. Validation runs BEFORE anything touches disk, so a
 * manifest naming a path outside its managed root is rejected rather than stored.
 */
export function writeEccInstallManifestAtomic(root: string, manifest: EccInstallManifest): void {
  const contents = `${JSON.stringify(parseManifest(manifest, "(in memory)"), null, 2)}\n`;
  const directory = prepareManifestDir(root);
  const path = eccInstallManifestPath(root);
  assertNotSymlink(path);
  const temporary = join(directory, `.install-manifest.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    retryTransient(() => renameSync(temporary, path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sameInstall(entry: EccManifestInstall, target: string, root: string): boolean {
  return entry.target === target && resolve(entry.root) === resolve(root);
}

/** Replace the record for one (target, root), leaving every other target's record intact. */
export function upsertEccInstall(
  manifest: EccInstallManifest,
  install: EccManifestInstall,
): EccInstallManifest {
  const installs = manifest.installs.filter(
    (entry) => !sameInstall(entry, install.target, install.root),
  );
  installs.push(install);
  installs.sort((left, right) =>
    `${left.target}\0${left.root}`.localeCompare(`${right.target}\0${right.root}`),
  );
  return { schemaVersion: ECC_INSTALL_MANIFEST_SCHEMA_VERSION, installs };
}

/**
 * Every regular file under `root`, as root-relative POSIX paths. Symlinks are SKIPPED
 * rather than followed: a link is not content aih wrote, and following one would let a
 * link inside the target dir pull an arbitrary file into the ownership record.
 * A missing root yields `[]` — nothing installed there yet.
 */
export function walkManagedRoot(root: string, limit = 20_000): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (found.length >= limit) return;
      const rel = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) walk(join(dir, child.name), rel);
      else if (child.isFile()) found.push(rel);
    }
  };
  walk(root, "");
  return found;
}

/** sha256 of one root-relative file, or `undefined` when it is absent or not a regular file. */
export function hashManagedFile(root: string, relativePath: string): string | undefined {
  const full = join(root, relativePath);
  try {
    if (lstatSync(full).isSymbolicLink()) return undefined;
    return createHash("sha256").update(readFileSync(full)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Evaluate one target root straight off disk — the rerun path. */
export function eccInstallDriftForRoot(
  repoRoot: string,
  target: string,
  managedRoot: string,
  currentSource: EccManifestSource | undefined,
): EccInstallDrift {
  let manifest: EccInstallManifest | undefined;
  try {
    const read = readEccInstallManifest(repoRoot);
    manifest = read.present ? read.manifest : undefined;
  } catch {
    // Unreadable ownership evidence fails CLOSED to "not proven ours": every path
    // reports unknown provenance, so nothing is ever claimed on damaged state.
    manifest = undefined;
  }
  return evaluateEccInstallDrift({
    manifest,
    target,
    root: managedRoot,
    presentPaths: walkManagedRoot(managedRoot),
    hashAt: (path) => hashManagedFile(managedRoot, path),
    currentSource,
  });
}

export const ECC_OWNERSHIP_STATES = [
  "aih-owned",
  "stale",
  "user-modified",
  "removed",
  "unknown-provenance",
] as const;

export type EccOwnershipState = (typeof ECC_OWNERSHIP_STATES)[number];

export interface EccInstallDriftSample {
  state: EccOwnershipState;
  path: string;
}

export interface EccInstallDrift {
  target: string;
  root: string;
  /** False when nothing proves ownership of this root — no manifest, or no entry for it. */
  provenanceKnown: boolean;
  /** At least one AIH-owned, untouched file is behind the source now on disk. */
  stale: boolean;
  counts: Record<EccOwnershipState, number>;
  /** Bounded, deterministic examples so a finding names real paths without dumping the tree. */
  samples: EccInstallDriftSample[];
  recordedSource?: EccManifestSource;
  currentSource?: EccManifestSource;
}

export interface EccInstallDriftInput {
  /** `undefined` when the manifest is absent or unreadable — fails closed to unknown. */
  manifest: EccInstallManifest | undefined;
  target: string;
  root: string;
  /** Every file currently under `root`, relative to it. */
  presentPaths: readonly string[];
  /** Hash of the file at a root-relative path; `undefined` when it is gone. */
  hashAt: (path: string) => string | undefined;
  /** ECC source identity on disk now; `undefined` when it could not be resolved. */
  currentSource: EccManifestSource | undefined;
}

const SAMPLES_PER_STATE = 3;

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Has the ECC source moved on since this install? Compares only the field that
 * identifies the mechanism's source (commit for a checkout, package@version for npm).
 * A null on either side means the identity was not resolvable, so the answer is NO —
 * staleness is a positive claim and is never made from missing evidence.
 */
function sourceMoved(recorded: EccManifestSource, current: EccManifestSource | undefined): boolean {
  if (current === undefined || current.kind !== recorded.kind) return false;
  if (recorded.kind === "git-checkout") {
    return (
      recorded.commit !== null && current.commit !== null && recorded.commit !== current.commit
    );
  }
  return (
    recorded.package !== null &&
    current.package !== null &&
    recorded.version !== null &&
    current.version !== null &&
    (recorded.package !== current.package || recorded.version !== current.version)
  );
}

/**
 * Evaluate the three-state ownership test for one target root and return an actionable
 * finding: which recorded files are stale (AIH-owned, source moved on), which are
 * user-modified (never touch), which vanished, and how much of the tree has no
 * ownership evidence at all.
 */
export function evaluateEccInstallDrift(input: EccInstallDriftInput): EccInstallDrift {
  const entry = input.manifest?.installs.find((candidate) =>
    sameInstall(candidate, input.target, input.root),
  );
  const counts: Record<EccOwnershipState, number> = {
    "aih-owned": 0,
    stale: 0,
    "user-modified": 0,
    removed: 0,
    "unknown-provenance": 0,
  };
  const byState = new Map<EccOwnershipState, string[]>(
    ECC_OWNERSHIP_STATES.map((state) => [state, []]),
  );
  const record = (state: EccOwnershipState, path: string): void => {
    counts[state] += 1;
    byState.get(state)?.push(path);
  };

  const recorded = new Map(entry?.files.map((file) => [normalize(file.path), file.sha256]) ?? []);
  const moved = entry === undefined ? false : sourceMoved(entry.source, input.currentSource);

  for (const [path, expected] of [...recorded].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const live = input.hashAt(path);
    if (live === undefined) record("removed", path);
    else if (live !== expected) record("user-modified", path);
    else record(moved ? "stale" : "aih-owned", path);
  }

  for (const present of [...input.presentPaths].map(normalize).sort()) {
    if (!recorded.has(present)) record("unknown-provenance", present);
  }

  const samples: EccInstallDriftSample[] = [];
  for (const state of ECC_OWNERSHIP_STATES) {
    for (const path of (byState.get(state) ?? []).slice(0, SAMPLES_PER_STATE)) {
      samples.push({ state, path });
    }
  }

  return {
    target: input.target,
    root: resolve(input.root),
    provenanceKnown: entry !== undefined,
    stale: counts.stale > 0,
    counts,
    samples,
    ...(entry === undefined ? {} : { recordedSource: entry.source }),
    ...(input.currentSource === undefined ? {} : { currentSource: input.currentSource }),
  };
}
