import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { removeManagedBlock, upsertTextBlock } from "../internals/envfile.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { type Action, type Plan, plan, remove, type WriteAction } from "../internals/plan.js";
import { beginMarker, endMarker } from "../internals/render.js";
import { assertPortableSourcePath } from "./index.js";
import {
  type EccProjection,
  projectionFilesDigest,
  type RenderedProjectionFile,
} from "./render.js";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MANAGED_SCOPE = "ecc-profile";
const MAX_PROJECTED_FILES = 2_000;
const MAX_PROJECTED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTED_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
const DESTINATION_PREFIXES = [".agents/", ".claude/", ".codex/"] as const;

export const ECC_PROFILE_OWNERSHIP_PATH = ".aih/ecc-profile/ownership-v1.json";

const hashSchema = z.string().regex(SHA256);
const sourceSchema = z
  .object({
    repository: z.literal("affaan-m/ECC"),
    commit: z.string().regex(COMMIT),
    sourceClosureId: z.string().min(1).max(256),
    sourceClosureSha256: hashSchema,
    projectionSha256: hashSchema,
  })
  .strict();
const ownershipFileSchema = z
  .object({
    destination: z.string().min(1).max(1_024),
    sourcePin: z.string().regex(COMMIT),
    sourcePaths: z.array(z.string().min(1).max(1_024)).min(1),
    normalizedHash: hashSchema,
    installedHash: hashSchema,
    managedBlockHash: hashSchema.nullable(),
    previousHash: hashSchema.nullable(),
    owner: z.literal("aih"),
    capabilityOwner: z.enum(["upstream", "aih-adaptation"]),
    mergeStrategy: z.enum(["replace", "toml-merge"]),
    mode: z.enum(["100644", "100755"]),
  })
  .strict();
const rollbackFileSchema = ownershipFileSchema
  .extend({ content: z.string().max(MAX_PROJECTED_FILE_BYTES) })
  .strict();
const rollbackSchema = z
  .object({ source: sourceSchema, files: z.array(rollbackFileSchema).max(MAX_PROJECTED_FILES) })
  .strict();
const ownershipSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.literal("active"),
    canonicalRoot: z.string().min(1).max(4_096),
    source: sourceSchema,
    files: z.array(ownershipFileSchema).max(MAX_PROJECTED_FILES),
    rollback: rollbackSchema.optional(),
  })
  .strict();

export type EccProfileOwnership = z.infer<typeof ownershipSchema>;
type OwnershipFile = EccProfileOwnership["files"][number];
type RollbackFile = NonNullable<EccProfileOwnership["rollback"]>["files"][number];
export type EccProfileLifecycleOperation =
  | "install"
  | "update"
  | "repair"
  | "uninstall"
  | "rollback";

interface CurrentFile {
  contents: string;
  sha256: string;
  mode: "100644" | "100755";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left: { destination: string }, right: { destination: string }): number {
  return left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0;
}

function sourcePaths(file: RenderedProjectionFile): string[] {
  return (
    file.provenance.kind === "pinned-file"
      ? [file.provenance.path]
      : file.provenance.inputs.map((input) => input.path)
  ).sort();
}

function sourceIdentity(projection: EccProjection): EccProfileOwnership["source"] {
  return {
    repository: projection.source.repository,
    commit: projection.source.commit,
    sourceClosureId: projection.sourceClosure.id,
    sourceClosureSha256: projection.sourceClosure.aggregateSha256,
    projectionSha256: projectionFilesDigest(projection.files),
  };
}

function assertDestination(root: string, destination: string, allowReceipt = false): void {
  assertPortableSourcePath(destination);
  if (
    !DESTINATION_PREFIXES.some((prefix) => destination.startsWith(prefix)) &&
    !(allowReceipt && destination === ECC_PROFILE_OWNERSHIP_PATH)
  ) {
    throw new Error(
      `ECC profile destination is outside the managed client namespaces: ${destination}`,
    );
  }
  const rootReal = realpathSync(root);
  let current = rootReal;
  const segments = destination.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new Error(`invalid ECC profile destination: ${destination}`);
    current = resolve(current, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`ECC profile destination parent is inaccessible: ${destination}`);
    }
    if (stats.isSymbolicLink())
      throw new Error(`ECC profile destination uses a symlinked parent: ${destination}`);
    if (!stats.isDirectory())
      throw new Error(`ECC profile destination parent is not a directory: ${destination}`);
    const canonical = realpathSync(current);
    const rel = relative(rootReal, canonical);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel))
      throw new Error(`ECC profile destination escapes its root: ${destination}`);
    current = canonical;
  }
}

function readCurrent(
  root: string,
  destination: string,
  maxBytes = MAX_PROJECTED_FILE_BYTES,
  allowReceipt = false,
): CurrentFile | undefined {
  assertDestination(root, destination, allowReceipt);
  const inspected = inspectContainedRelativePath(root, destination);
  if (inspected.state === "absent") return undefined;
  if (inspected.state === "unsafe" || inspected.kind !== "file")
    throw new Error(`ECC profile destination is unsafe: ${destination}`);
  const opened = readRegularFileWithStats(inspected.realPath, { maxBytes });
  if (!opened || opened.stats.nlink > 1)
    throw new Error(
      `ECC profile destination is not a bounded unambiguous regular file: ${destination}`,
    );
  const contents = opened.contents.toString("utf8");
  return {
    contents,
    sha256: sha256(opened.contents),
    mode: (opened.stats.mode & 0o111) === 0 ? "100644" : "100755",
  };
}

function managedBlock(contents: string): string | undefined {
  const begin = beginMarker(MANAGED_SCOPE);
  const end = endMarker(MANAGED_SCOPE);
  const start = contents.indexOf(begin);
  if (start < 0) return undefined;
  if (contents.indexOf(begin, start + begin.length) >= 0)
    throw new Error("ECC profile TOML contains duplicate managed blocks");
  const finish = contents.indexOf(end, start + begin.length);
  if (finish < 0 || contents.indexOf(end, finish + end.length) >= 0)
    throw new Error("ECC profile TOML contains a malformed managed block");
  return contents.slice(start, finish + end.length);
}

function managedBody(contents: string): string | undefined {
  const block = managedBlock(contents);
  if (block === undefined) return undefined;
  const begin = beginMarker(MANAGED_SCOPE);
  const end = endMarker(MANAGED_SCOPE);
  return block
    .slice(begin.length, block.length - end.length)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "")
    .replace(/\r\n/g, "\n");
}

function validateProjection(root: string, projection: EccProjection): RenderedProjectionFile[] {
  if (projection.version !== 1 || projection.source.repository !== "affaan-m/ECC")
    throw new Error("invalid ECC profile projection identity");
  if (!COMMIT.test(projection.source.commit)) throw new Error("invalid ECC profile source commit");
  if (
    projection.sourceClosure.id.length === 0 ||
    projection.sourceClosure.id.length > 256 ||
    !SHA256.test(projection.sourceClosure.aggregateSha256) ||
    !Number.isSafeInteger(projection.sourceClosure.fileCount) ||
    projection.sourceClosure.fileCount < 1 ||
    !Number.isSafeInteger(projection.sourceClosure.totalBytes) ||
    projection.sourceClosure.totalBytes < 1
  ) {
    throw new Error("invalid ECC profile source closure identity");
  }
  if (
    projection.source.reviewReceipt.sourceCommit !== projection.source.commit ||
    !SHA256.test(projection.source.reviewReceipt.evidenceSha256)
  ) {
    throw new Error("invalid ECC profile review receipt identity");
  }
  assertPortableSourcePath(projection.source.reviewReceipt.evidencePath);
  if (projection.files.length === 0 || projection.files.length > MAX_PROJECTED_FILES)
    throw new Error("ECC profile projection file count exceeds the lifecycle boundary");
  let total = 0;
  const destinations = new Set<string>();
  const files = [...projection.files].sort(comparePaths);
  for (const file of files) {
    assertDestination(root, file.destination);
    const identity = file.destination.toLowerCase();
    if (destinations.has(identity))
      throw new Error(`ambiguous ECC profile destination: ${file.destination}`);
    destinations.add(identity);
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (bytes > MAX_PROJECTED_FILE_BYTES || total > MAX_PROJECTED_BYTES)
      throw new Error("ECC profile projected bytes exceed the lifecycle boundary");
    if (file.owner !== "aih")
      throw new Error(`ECC profile file has ambiguous owner: ${file.destination}`);
    if (file.provenance.sourcePin !== projection.source.commit)
      throw new Error(`ECC profile source pin contradicts projection: ${file.destination}`);
    if (file.normalizedSha256 !== sha256(file.content))
      throw new Error(`ECC profile normalized hash contradicts content: ${file.destination}`);
    for (const path of sourcePaths(file)) assertPortableSourcePath(path);
  }
  return files;
}

function ownershipEntry(
  file: RenderedProjectionFile,
  installed: string,
  previousHash: string | null,
): OwnershipFile {
  const block = file.mergeStrategy === "toml-merge" ? managedBlock(installed) : undefined;
  if (file.mergeStrategy === "toml-merge" && block === undefined)
    throw new Error(`ECC profile TOML merge produced no managed block: ${file.destination}`);
  return {
    destination: file.destination,
    sourcePin: file.provenance.sourcePin,
    sourcePaths: sourcePaths(file),
    normalizedHash: file.normalizedSha256,
    installedHash: sha256(installed),
    managedBlockHash: block === undefined ? null : sha256(block),
    previousHash,
    owner: "aih",
    capabilityOwner: file.capabilityOwner,
    mergeStrategy: file.mergeStrategy,
    mode: file.mode,
  };
}

function pinnedWrite(
  destination: string,
  contents: string,
  mode: "100644" | "100755",
  current: CurrentFile | undefined,
  describe: string,
): WriteAction {
  return {
    kind: "write",
    path: destination,
    describe,
    contents,
    mode: mode === "100755" ? 0o755 : 0o644,
    expect: current === undefined ? { absent: true } : { sha256: current.sha256 },
  };
}

function receiptWrite(
  receipt: EccProfileOwnership,
  currentReceipt: CurrentFile | undefined,
): WriteAction {
  return pinnedWrite(
    ECC_PROFILE_OWNERSHIP_PATH,
    `${JSON.stringify(receipt, null, 2)}\n`,
    "100644",
    currentReceipt,
    "record AIH-owned ECC profile lifecycle ownership",
  );
}

function assertOwnedCurrent(root: string, entry: OwnershipFile): CurrentFile | undefined {
  const current = readCurrent(root, entry.destination);
  if (current === undefined) return undefined;
  if (entry.mergeStrategy === "replace") {
    if (current.sha256 !== entry.installedHash)
      throw new Error(`modified owned ECC profile destination: ${entry.destination}`);
    return current;
  }
  const block = managedBlock(current.contents);
  if (block === undefined || sha256(block) !== entry.managedBlockHash)
    throw new Error(`modified owned ECC profile managed block: ${entry.destination}`);
  return current;
}

function canonicalRoot(root: string): string {
  const canonical = realpathSync(root);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function parseReceipt(contents: string, root: string): EccProfileOwnership {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("invalid ECC profile ownership receipt JSON");
  }
  const receipt = ownershipSchema.parse(parsed);
  if (receipt.canonicalRoot !== canonicalRoot(root))
    throw new Error("invalid ECC profile ownership receipt: foreign worktree root");
  validateReceiptFiles(receipt.files, receipt.source.commit, "active");
  if (receipt.rollback !== undefined)
    validateReceiptFiles(receipt.rollback.files, receipt.rollback.source.commit, "rollback");
  return receipt;
}

function validateReceiptFiles(
  files: ReadonlyArray<OwnershipFile | RollbackFile>,
  sourceCommit: string,
  label: string,
): void {
  const destinations = files.map((file) => file.destination.toLowerCase());
  if (new Set(destinations).size !== destinations.length)
    throw new Error(`invalid ECC profile ownership receipt: ambiguous ${label} destinations`);
  for (const file of files) {
    assertPortableSourcePath(file.destination);
    if (!DESTINATION_PREFIXES.some((prefix) => file.destination.startsWith(prefix)))
      throw new Error(`invalid ECC profile ownership receipt: unmanaged ${label} destination`);
    const paths = file.sourcePaths.map((path) => {
      assertPortableSourcePath(path);
      return path.toLowerCase();
    });
    if (new Set(paths).size !== paths.length)
      throw new Error(`invalid ECC profile ownership receipt: ambiguous ${label} source paths`);
    if (file.sourcePin !== sourceCommit)
      throw new Error("invalid ECC profile ownership receipt: contradictory source pin");
    if (
      (file.mergeStrategy === "replace" && file.managedBlockHash !== null) ||
      (file.mergeStrategy === "toml-merge" && file.managedBlockHash === null)
    )
      throw new Error("invalid ECC profile ownership receipt: contradictory merge metadata");
  }
}

function assertReceiptMatchesProjection(
  receipt: EccProfileOwnership,
  files: ReadonlyArray<RenderedProjectionFile>,
): void {
  if (receipt.files.length !== files.length)
    throw new Error("ECC profile ownership receipt does not close over the pinned projection");
  const projected = new Map(files.map((file) => [file.destination, file]));
  for (const entry of receipt.files) {
    const file = projected.get(entry.destination);
    if (
      file === undefined ||
      entry.sourcePin !== file.provenance.sourcePin ||
      entry.normalizedHash !== file.normalizedSha256 ||
      entry.capabilityOwner !== file.capabilityOwner ||
      entry.mergeStrategy !== file.mergeStrategy ||
      entry.mode !== file.mode ||
      JSON.stringify(entry.sourcePaths) !== JSON.stringify(sourcePaths(file))
    )
      throw new Error(`ECC profile ownership receipt contradicts ${entry.destination}`);
  }
}

function readReceiptFile(
  root: string,
): { receipt: EccProfileOwnership; current: CurrentFile } | undefined {
  const current = readCurrent(root, ECC_PROFILE_OWNERSHIP_PATH, MAX_RECEIPT_BYTES, true);
  if (current === undefined) return undefined;
  if (Buffer.byteLength(current.contents, "utf8") > MAX_RECEIPT_BYTES)
    throw new Error("invalid ECC profile ownership receipt: oversized");
  return { receipt: parseReceipt(current.contents, root), current };
}

export function readEccProfileOwnership(root: string): EccProfileOwnership | undefined {
  return readReceiptFile(root)?.receipt;
}

function sameSource(
  left: EccProfileOwnership["source"],
  right: EccProfileOwnership["source"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function activeReceipt(
  root: string,
  projection: EccProjection,
  files: OwnershipFile[],
  rollback?: EccProfileOwnership["rollback"],
): EccProfileOwnership {
  return {
    schemaVersion: 1,
    state: "active",
    canonicalRoot: canonicalRoot(root),
    source: sourceIdentity(projection),
    files: [...files].sort(comparePaths),
    ...(rollback === undefined ? {} : { rollback }),
  };
}

function installPlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
): Plan {
  const receiptFile = readReceiptFile(root);
  const source = sourceIdentity(projection);
  if (receiptFile !== undefined) {
    if (!sameSource(receiptFile.receipt.source, source))
      throw new Error("ECC profile is already owned at a different pin; use update");
    assertReceiptMatchesProjection(receiptFile.receipt, files);
    for (const entry of receiptFile.receipt.files) assertOwnedCurrent(root, entry);
    return plan("ecc-profile: install");
  }
  const actions: Action[] = [];
  const entries: OwnershipFile[] = [];
  for (const file of files) {
    const current = readCurrent(root, file.destination);
    if (file.mergeStrategy === "replace") {
      if (current !== undefined)
        throw new Error(
          `refusing to claim existing unowned ECC profile destination: ${file.destination}`,
        );
      actions.push(
        pinnedWrite(
          file.destination,
          file.content,
          file.mode,
          undefined,
          `install ECC profile ${file.destination}`,
        ),
      );
      entries.push(ownershipEntry(file, file.content, null));
      continue;
    }
    if (current !== undefined && managedBlock(current.contents) !== undefined)
      throw new Error(`refusing ambiguous existing ECC profile managed block: ${file.destination}`);
    const merged = upsertTextBlock(current?.contents ?? "", MANAGED_SCOPE, file.content);
    actions.push(
      pinnedWrite(
        file.destination,
        merged,
        file.mode,
        current,
        `merge ECC profile ${file.destination}`,
      ),
    );
    entries.push(ownershipEntry(file, merged, current?.sha256 ?? null));
  }
  actions.push(receiptWrite(activeReceipt(root, projection, entries), undefined));
  return plan("ecc-profile: install", ...actions);
}

function rollbackSnapshot(root: string, receipt: EccProfileOwnership): RollbackFile[] {
  return receipt.files.map((entry) => {
    const current = assertOwnedCurrent(root, entry);
    if (current === undefined)
      throw new Error(
        `owned ECC profile destination is missing; repair before update: ${entry.destination}`,
      );
    const content =
      entry.mergeStrategy === "replace" ? current.contents : managedBody(current.contents);
    if (content === undefined)
      throw new Error(`owned ECC profile managed block is missing: ${entry.destination}`);
    return { ...entry, content };
  });
}

function updatePlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined)
    throw new Error("ECC profile update requires an ownership receipt");
  const { receipt, current: currentReceipt } = receiptFile;
  if (receipt.source.commit === projection.source.commit)
    throw new Error("ECC profile update requires an exact new source pin");
  const snapshot = rollbackSnapshot(root, receipt);
  const prior = new Map(receipt.files.map((entry) => [entry.destination, entry]));
  const priorFolded = new Map(
    receipt.files.map((entry) => [entry.destination.toLowerCase(), entry]),
  );
  const nextDestinations = new Set(files.map((file) => file.destination));
  const actions: Action[] = [];
  const entries: OwnershipFile[] = [];

  for (const file of files) {
    const foldedPrevious = priorFolded.get(file.destination.toLowerCase());
    if (foldedPrevious !== undefined && foldedPrevious.destination !== file.destination)
      throw new Error(`ambiguous case-only ECC profile destination update: ${file.destination}`);
    const previous = prior.get(file.destination);
    const current = previous
      ? assertOwnedCurrent(root, previous)
      : readCurrent(root, file.destination);
    if (previous === undefined && file.mergeStrategy === "replace" && current !== undefined)
      throw new Error(
        `refusing to claim existing unowned ECC profile destination: ${file.destination}`,
      );
    if (
      previous === undefined &&
      file.mergeStrategy === "toml-merge" &&
      managedBlock(current?.contents ?? "")
    )
      throw new Error(`refusing ambiguous existing ECC profile managed block: ${file.destination}`);
    const installed =
      file.mergeStrategy === "replace"
        ? file.content
        : upsertTextBlock(current?.contents ?? "", MANAGED_SCOPE, file.content);
    if (current?.contents !== installed) {
      actions.push(
        pinnedWrite(
          file.destination,
          installed,
          file.mode,
          current,
          `update ECC profile ${file.destination}`,
        ),
      );
    }
    entries.push(ownershipEntry(file, installed, current?.sha256 ?? null));
  }

  for (const entry of receipt.files) {
    if (nextDestinations.has(entry.destination)) continue;
    const current = assertOwnedCurrent(root, entry);
    if (current === undefined) continue;
    if (entry.mergeStrategy === "replace") {
      actions.push(
        remove(entry.destination, `remove superseded ECC profile ${entry.destination}`, {
          expect: { sha256: entry.installedHash },
        }),
      );
    } else {
      actions.push(...planManagedBlockRemoval(entry, current, "remove superseded"));
    }
  }

  actions.push(
    receiptWrite(
      activeReceipt(root, projection, entries, { source: receipt.source, files: snapshot }),
      currentReceipt,
    ),
  );
  return plan("ecc-profile: update", ...actions);
}

function repairPlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined)
    throw new Error("ECC profile repair requires an ownership receipt");
  const expectedSource = sourceIdentity(projection);
  if (!sameSource(receiptFile.receipt.source, expectedSource))
    throw new Error("ECC profile repair projection contradicts the ownership receipt");
  assertReceiptMatchesProjection(receiptFile.receipt, files);
  const owned = new Map(receiptFile.receipt.files.map((entry) => [entry.destination, entry]));
  const actions: Action[] = [];
  for (const file of files) {
    const entry = owned.get(file.destination);
    if (!entry) throw new Error(`ECC profile ownership receipt omits ${file.destination}`);
    const current = readCurrent(root, file.destination);
    if (current === undefined) {
      const repaired =
        file.mergeStrategy === "replace"
          ? file.content
          : upsertTextBlock("", MANAGED_SCOPE, file.content);
      actions.push(
        pinnedWrite(
          file.destination,
          repaired,
          file.mode,
          undefined,
          `repair ECC profile ${file.destination}`,
        ),
      );
      continue;
    }
    assertOwnedCurrent(root, entry);
    if (current.mode !== file.mode && file.mergeStrategy === "replace") {
      actions.push(
        pinnedWrite(
          file.destination,
          current.contents,
          file.mode,
          current,
          `repair ECC profile mode ${file.destination}`,
        ),
      );
    }
  }
  return plan("ecc-profile: repair", ...actions);
}

function uninstallPlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined) return plan("ecc-profile: uninstall");
  if (!sameSource(receiptFile.receipt.source, sourceIdentity(projection)))
    throw new Error("ECC profile uninstall projection contradicts the ownership receipt");
  assertReceiptMatchesProjection(receiptFile.receipt, files);
  const actions: Action[] = [];
  for (const entry of receiptFile.receipt.files) {
    const current = assertOwnedCurrent(root, entry);
    if (current === undefined) continue;
    if (entry.mergeStrategy === "replace") {
      actions.push(
        remove(entry.destination, `uninstall ECC profile ${entry.destination}`, {
          expect: { sha256: entry.installedHash },
        }),
      );
      continue;
    }
    actions.push(...planManagedBlockRemoval(entry, current, "uninstall"));
  }
  actions.push(
    remove(ECC_PROFILE_OWNERSHIP_PATH, "remove ECC profile ownership receipt", {
      expect: { sha256: receiptFile.current.sha256 },
    }),
  );
  return plan("ecc-profile: uninstall", ...actions);
}

function planManagedBlockRemoval(
  entry: OwnershipFile,
  current: CurrentFile,
  verb: string,
): Action[] {
  const stripped = removeManagedBlock(current.contents, MANAGED_SCOPE);
  return entry.previousHash === null && stripped.trim().length === 0
    ? [
        remove(entry.destination, `${verb} ECC profile ${entry.destination}`, {
          expect: { sha256: current.sha256 },
        }),
      ]
    : [
        pinnedWrite(
          entry.destination,
          stripped,
          entry.mode,
          current,
          `${verb} ECC profile block ${entry.destination}`,
        ),
      ];
}

function rollbackPlan(root: string, projection: EccProjection): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined)
    throw new Error("ECC profile rollback requires an ownership receipt");
  const { receipt, current: currentReceipt } = receiptFile;
  if (!sameSource(receipt.source, sourceIdentity(projection)))
    throw new Error("ECC profile rollback projection contradicts the ownership receipt");
  if (!receipt.rollback) throw new Error("ECC profile ownership receipt has no rollback snapshot");
  const currentEntries = new Map(receipt.files.map((entry) => [entry.destination, entry]));
  const previousEntries = new Map(
    receipt.rollback.files.map((entry) => [entry.destination, entry]),
  );
  const actions: Action[] = [];
  const restored: OwnershipFile[] = [];

  for (const entry of receipt.files) {
    if (previousEntries.has(entry.destination)) continue;
    const current = assertOwnedCurrent(root, entry);
    if (current === undefined) continue;
    if (entry.mergeStrategy === "replace") {
      actions.push(
        remove(entry.destination, `roll back new ECC profile ${entry.destination}`, {
          expect: { sha256: entry.installedHash },
        }),
      );
    } else {
      actions.push(...planManagedBlockRemoval(entry, current, "roll back"));
    }
  }

  for (const previous of receipt.rollback.files) {
    const currentEntry = currentEntries.get(previous.destination);
    const current = currentEntry
      ? assertOwnedCurrent(root, currentEntry)
      : readCurrent(root, previous.destination);
    if (currentEntry === undefined && previous.mergeStrategy === "replace" && current !== undefined)
      throw new Error(
        `refusing to restore over unowned ECC profile destination: ${previous.destination}`,
      );
    const installed =
      previous.mergeStrategy === "replace"
        ? previous.content
        : upsertTextBlock(current?.contents ?? "", MANAGED_SCOPE, previous.content);
    if (current?.contents !== installed) {
      actions.push(
        pinnedWrite(
          previous.destination,
          installed,
          previous.mode,
          current,
          `roll back ECC profile ${previous.destination}`,
        ),
      );
    }
    const { content: _content, ...entry } = previous;
    restored.push({
      ...entry,
      installedHash: sha256(installed),
      managedBlockHash:
        previous.mergeStrategy === "toml-merge" ? sha256(managedBlock(installed) ?? "") : null,
    });
  }

  const restoredReceipt: EccProfileOwnership = {
    schemaVersion: 1,
    state: "active",
    canonicalRoot: receipt.canonicalRoot,
    source: receipt.rollback.source,
    files: restored.sort(comparePaths),
  };
  actions.push(receiptWrite(restoredReceipt, currentReceipt));
  return plan("ecc-profile: rollback", ...actions);
}

export function planEccProfileLifecycle(
  root: string,
  projection: EccProjection,
  operation: EccProfileLifecycleOperation,
): Plan {
  if (!isAbsolute(root)) throw new Error("ECC profile lifecycle root must be absolute");
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    throw new Error("ECC profile lifecycle root must be a real directory");
  const files = validateProjection(root, projection);
  switch (operation) {
    case "install":
      return installPlan(root, projection, files);
    case "update":
      return updatePlan(root, projection, files);
    case "repair":
      return repairPlan(root, projection, files);
    case "uninstall":
      return uninstallPlan(root, projection, files);
    case "rollback":
      return rollbackPlan(root, projection);
  }
}
