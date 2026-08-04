import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import {
  assertPortableSourcePath,
  checkedPath,
  checkedRoot,
  type EccProfile,
  type ResolvedEccProfile,
} from "./index.js";

const SHA256 = /^[0-9a-f]{64}$/;

export const PROJECTED_SOURCE_LIMITS = {
  maxReceiptBytes: 128 * 1024,
  maxFileBytes: 128 * 1024,
  maxAggregateBytes: 4 * 1024 * 1024,
  maxFiles: 512,
  maxDiagnosticPathChars: 240,
} as const;

export interface ProjectionSourceTrust {
  id: string;
  evidencePath: string;
  evidenceSha256: string;
  sourceCommit: string;
  fileCount: number;
  totalBytes: number;
  aggregateSha256: string;
}

export const TRUSTED_PROJECTED_SOURCE: ProjectionSourceTrust = {
  id: "ecc-projected-source-closure-v1",
  evidencePath: "evidence/ecc/projected-source-closure-v1.json",
  evidenceSha256: "f610d0999ba4300be2ac3c08428da1249cdd53d7bf8d74722433fef0b013448e",
  sourceCommit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
  fileCount: 379,
  totalBytes: 2_672_419,
  aggregateSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
};

const closureEntrySchema = z
  .object({
    path: z.string().min(1),
    rawSha256: z.string().regex(SHA256),
    bytes: z.number().int().nonnegative(),
    fileType: z.literal("regular"),
    mode: z.enum(["100644", "100755"]),
  })
  .strict();

const sourceClosureReceiptSchema = z
  .object({
    receiptVersion: z.literal(1),
    id: z.string().min(1),
    repository: z.literal("affaan-m/ECC"),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    fileCount: z.number().int().positive(),
    totalBytes: z.number().int().nonnegative(),
    aggregateSha256: z.string().regex(SHA256),
    entries: z.array(closureEntrySchema),
  })
  .strict();

export type ProjectedSourceEntry = z.infer<typeof closureEntrySchema>;

export interface VerifiedProjectedSource extends ProjectedSourceEntry {
  contents: Buffer;
}

export interface VerifiedProjectionSourceClosure {
  id: string;
  aggregateSha256: string;
  fileCount: number;
  totalBytes: number;
  files: ReadonlyMap<string, VerifiedProjectedSource>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function diagnosticPath(sourcePath: string): string {
  if (sourcePath.length <= PROJECTED_SOURCE_LIMITS.maxDiagnosticPathChars) return sourcePath;
  return `${sourcePath.slice(0, PROJECTED_SOURCE_LIMITS.maxDiagnosticPathChars - 3)}...`;
}

function closureAggregate(entries: readonly ProjectedSourceEntry[]): string {
  return sha256(
    entries
      .map((entry) =>
        [entry.path, entry.rawSha256, entry.bytes, entry.fileType, entry.mode].join("\0"),
      )
      .join("\n"),
  );
}

function parseReceipt(bytes: Buffer, sourcePath: string) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`projected source closure receipt is not UTF-8: ${diagnosticPath(sourcePath)}`);
  }
  try {
    return sourceClosureReceiptSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(
      `projected source closure receipt is malformed: ${diagnosticPath(sourcePath)} (${(error as Error).message})`,
    );
  }
}

function assertTrust(profile: EccProfile, trust: ProjectionSourceTrust): void {
  assertPortableSourcePath(trust.evidencePath);
  if (!SHA256.test(trust.evidenceSha256) || !SHA256.test(trust.aggregateSha256))
    throw new Error("trusted projected source closure uses a malformed digest");
  if (trust.sourceCommit !== profile.source.commit)
    throw new Error("trusted projected source closure contradicts the profile source pin");
  if (trust.fileCount > PROJECTED_SOURCE_LIMITS.maxFiles)
    throw new Error("trusted projected source closure exceeds the file-count limit");
  if (trust.totalBytes > PROJECTED_SOURCE_LIMITS.maxAggregateBytes)
    throw new Error("trusted projected source closure exceeds the aggregate byte limit");
}

function expectedEntryPaths(
  resolved: ResolvedEccProfile,
  entries: readonly ProjectedSourceEntry[],
): Set<string> {
  const exactFiles = new Set(
    [...resolved.roles, ...resolved.workflows].map((entry) => entry.sourcePath),
  );
  const skillPrefixes = resolved.skills.map((skill) => `${skill.sourcePath}/`);
  const paths = new Set<string>();
  const folded = new Set<string>();
  for (const entry of entries) {
    const path = assertPortableSourcePath(entry.path);
    if (!exactFiles.has(path) && !skillPrefixes.some((prefix) => path.startsWith(prefix)))
      throw new Error(`closure receipt contains an unselected path: ${diagnosticPath(path)}`);
    if (paths.has(path) || folded.has(path.toLowerCase()))
      throw new Error(`closure receipt contains an ambiguous path: ${diagnosticPath(path)}`);
    paths.add(path);
    folded.add(path.toLowerCase());
  }
  for (const sourcePath of exactFiles) {
    if (!paths.has(sourcePath))
      throw new Error(`closure receipt omits a projected source: ${diagnosticPath(sourcePath)}`);
  }
  for (const skill of resolved.skills) {
    const primary = `${skill.sourcePath}/SKILL.md`;
    if (!paths.has(primary))
      throw new Error(
        `closure receipt omits selected skill entry point: ${diagnosticPath(primary)}`,
      );
  }
  return paths;
}

function enumerateSkillFiles(sourceRoot: string, resolved: ResolvedEccProfile): string[] {
  const files: string[] = [];
  const visit = (sourceDirectory: string): void => {
    const absolute = checkedPath(
      sourceRoot,
      sourceDirectory,
      "directory",
      "projected source closure",
    );
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const sourcePath = assertPortableSourcePath(posix.join(sourceDirectory, entry.name));
      if (entry.isSymbolicLink())
        throw new Error(
          `projected source closure uses a linked path: ${diagnosticPath(sourcePath)}`,
        );
      if (entry.isDirectory()) visit(sourcePath);
      else if (entry.isFile()) files.push(sourcePath);
      else
        throw new Error(
          `projected source closure contains a non-regular entry: ${diagnosticPath(sourcePath)}`,
        );
      if (files.length > PROJECTED_SOURCE_LIMITS.maxFiles)
        throw new Error("projected source closure exceeds the file-count limit");
    }
  };
  for (const skill of resolved.skills) visit(skill.sourcePath);
  return files;
}

function assertActualInventory(
  resolved: ResolvedEccProfile,
  receiptPaths: Set<string>,
  sourceRoot: string,
): void {
  const actual = new Set([
    ...enumerateSkillFiles(sourceRoot, resolved),
    ...resolved.roles.map((entry) => entry.sourcePath),
    ...resolved.workflows.map((entry) => entry.sourcePath),
  ]);
  const missing = [...receiptPaths].find((path) => !actual.has(path));
  if (missing) throw new Error(`projected source inventory is missing: ${diagnosticPath(missing)}`);
  const extra = [...actual].find((path) => !receiptPaths.has(path));
  if (extra)
    throw new Error(`projected source inventory has an extra path: ${diagnosticPath(extra)}`);
}

function actualMode(entry: ProjectedSourceEntry, mode: number): "100644" | "100755" {
  if (process.platform === "win32") return entry.mode;
  return (mode & 0o111) === 0 ? "100644" : "100755";
}

export function acquireProjectionSourceClosure(
  profile: EccProfile,
  resolved: ResolvedEccProfile,
  options: { sourceRoot: string; evidenceRoot: string },
  trust: ProjectionSourceTrust,
): VerifiedProjectionSourceClosure {
  assertTrust(profile, trust);
  const evidenceRoot = checkedRoot(options.evidenceRoot, "ECC projection evidence root");
  const receiptPath = checkedPath(
    evidenceRoot,
    trust.evidencePath,
    "file",
    "projected source closure receipt",
  );
  const openedReceipt = readRegularFileWithStats(receiptPath, {
    maxBytes: PROJECTED_SOURCE_LIMITS.maxReceiptBytes,
  });
  if (!openedReceipt || openedReceipt.stats.nlink > 1)
    throw new Error("projected source closure receipt must be a bounded non-linked regular file");
  if (sha256(openedReceipt.contents) !== trust.evidenceSha256)
    throw new Error("projected source closure receipt does not match its trusted digest");
  const receipt = parseReceipt(openedReceipt.contents, trust.evidencePath);
  if (
    receipt.id !== trust.id ||
    receipt.sourceCommit !== trust.sourceCommit ||
    receipt.sourceCommit !== profile.source.commit ||
    receipt.fileCount !== trust.fileCount ||
    receipt.totalBytes !== trust.totalBytes ||
    receipt.aggregateSha256 !== trust.aggregateSha256
  )
    throw new Error("projected source closure receipt contradicts its trusted profile pin");
  if (receipt.entries.length !== receipt.fileCount)
    throw new Error("projected source closure receipt has a contradictory file count");
  if (receipt.fileCount > PROJECTED_SOURCE_LIMITS.maxFiles)
    throw new Error("projected source closure exceeds the file-count limit");
  if (receipt.totalBytes > PROJECTED_SOURCE_LIMITS.maxAggregateBytes)
    throw new Error("projected source closure exceeds the aggregate byte limit");
  if (closureAggregate(receipt.entries) !== receipt.aggregateSha256)
    throw new Error("projected source closure aggregate digest is invalid");

  const receiptPaths = expectedEntryPaths(resolved, receipt.entries);
  const sourceRoot = checkedRoot(options.sourceRoot, "ECC projection source root");
  assertActualInventory(resolved, receiptPaths, sourceRoot);

  const verified = new Map<string, VerifiedProjectedSource>();
  const actualEntries: ProjectedSourceEntry[] = [];
  let totalBytes = 0;
  for (const entry of receipt.entries) {
    if (entry.bytes > PROJECTED_SOURCE_LIMITS.maxFileBytes)
      throw new Error(
        `projected source exceeds the file byte limit: ${diagnosticPath(entry.path)}`,
      );
    const absolute = checkedPath(sourceRoot, entry.path, "file", "projected source closure");
    const opened = readRegularFileWithStats(absolute, {
      maxBytes: PROJECTED_SOURCE_LIMITS.maxFileBytes,
    });
    if (!opened || opened.stats.nlink > 1)
      throw new Error(
        `projected source is not a bounded non-linked regular file: ${diagnosticPath(entry.path)}`,
      );
    const source: VerifiedProjectedSource = {
      ...entry,
      bytes: opened.contents.length,
      rawSha256: sha256(opened.contents),
      mode: actualMode(entry, opened.stats.mode),
      contents: opened.contents,
    };
    if (source.bytes !== entry.bytes || source.rawSha256 !== entry.rawSha256)
      throw new Error(
        `projected source content does not match closure: ${diagnosticPath(entry.path)}`,
      );
    if (source.mode !== entry.mode)
      throw new Error(
        `projected source mode does not match closure: ${diagnosticPath(entry.path)}`,
      );
    totalBytes += source.bytes;
    if (totalBytes > PROJECTED_SOURCE_LIMITS.maxAggregateBytes)
      throw new Error("projected source closure exceeds the aggregate byte limit");
    actualEntries.push(source);
    verified.set(entry.path, source);
  }
  if (
    totalBytes !== receipt.totalBytes ||
    closureAggregate(actualEntries) !== receipt.aggregateSha256
  )
    throw new Error("projected source closure does not reproduce its authenticated aggregate");

  return {
    id: receipt.id,
    aggregateSha256: receipt.aggregateSha256,
    fileCount: receipt.fileCount,
    totalBytes: receipt.totalBytes,
    files: verified,
  };
}
