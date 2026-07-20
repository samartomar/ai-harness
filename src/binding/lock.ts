import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists, retryTransient } from "../internals/fsxn.js";
import { BindingDeclarationSchema } from "./schema.js";

/**
 * Binding lock — the machine-scoped applied-state record (D7 derived state, D18
 * ownership). It lives at repo-local, gitignored `.aih/binding/lock.json`: it is
 * REBUILDABLE from the committed declaration + the world, and pre-existing values
 * of local files it captures must never be committed. It records the exact
 * declaration identity it was applied for, every write performed, the D7
 * scanned/loaded digest pair with their match verdict (a binding fails closed
 * when they differ), and the D18 field-level ownership entries removal will later
 * reconcile against.
 *
 * W2 defines the schema + atomic read/write + the fail-closed missing-lock rule
 * as a typed result. The actual removal reconciliation is W3.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Owned-write mechanisms: a whole file, a JSON pointer, or an MCP server id (D18). */
const OWNERSHIP_KINDS = ["json-pointer", "mcp-server", "file"] as const;
const WRITE_MECHANISMS = ["file", "json-pointer", "mcp-server"] as const;

function isSafeRelPath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.endsWith("/") || value.includes("//")) return false;
  if (value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    return false;
  }
  for (const char of value) {
    if (char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127) return false;
  }
  return true;
}

const SafeRelPathSchema = z.string().min(1).refine(isSafeRelPath, {
  message:
    "path must be a safe repo-relative POSIX path (no .., absolute, drive, or control chars)",
});

export const BindingWriteSchema = z
  .object({
    path: SafeRelPathSchema,
    mechanism: z.enum(WRITE_MECHANISMS),
    contentDigest: z.string().regex(SHA256_HEX),
  })
  .strict();

/** D18: the pre-existing value AIH observed, or an explicit record of its absence. */
const PreExistingSchema = z.union([
  z.object({ absent: z.literal(true) }).strict(),
  z.object({ value: z.unknown() }).strict(),
]);

export const BindingOwnershipEntrySchema = z
  .object({
    kind: z.enum(OWNERSHIP_KINDS),
    /** JSON pointer, MCP server identifier, or repo-relative file path. */
    target: z.string().min(1),
    preExisting: PreExistingSchema,
    /** The AIH-applied value (a JSON value for pointers/servers; a digest for files). */
    applied: z.unknown(),
    postApplyDigest: z.string().regex(SHA256_HEX),
  })
  .strict();

export const BindingLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    declaration: BindingDeclarationSchema,
    writes: z.array(BindingWriteSchema),
    scannedDigest: z.string().regex(SHA256_HEX),
    loadedDigest: z.string().regex(SHA256_HEX),
    match: z.boolean(),
    ownership: z.array(BindingOwnershipEntrySchema),
  })
  .strict()
  .superRefine((lock, ctx) => {
    if (lock.match !== (lock.scannedDigest === lock.loadedDigest)) {
      ctx.addIssue({
        code: "custom",
        path: ["match"],
        message:
          "match must equal (scannedDigest === loadedDigest); a binding fails closed when scanned and loaded digests differ",
      });
    }
  });

export type BindingWrite = z.infer<typeof BindingWriteSchema>;
export type BindingOwnershipEntry = z.infer<typeof BindingOwnershipEntrySchema>;
export type BindingLock = z.infer<typeof BindingLockSchema>;

export type BindingLockRead = { present: true; lock: BindingLock } | { present: false };

export type BindingRemovalPlan =
  | { mode: "apply"; lock: BindingLock }
  | { mode: "drift-report-only"; reason: string };

/** Corrupt or schema-invalid machine-state lock — fail closed, never guess. */
export class BindingLockError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_LOCK");
  }
}

export function parseBindingLock(value: unknown): BindingLock {
  return BindingLockSchema.parse(value);
}

export function bindingDir(root: string): string {
  return join(root, ".aih", "binding");
}

export function bindingLockPath(root: string): string {
  return join(bindingDir(root), "lock.json");
}

function assertNotSymlink(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    throw new BindingLockError(`refusing symlinked binding lock path: ${path}`);
  }
}

/**
 * Read the applied-state lock. Absent => `{ present: false }`. A present file
 * that is unparseable or schema-invalid FAILS CLOSED with {@link BindingLockError}
 * — a damaged machine-state record is never silently treated as empty.
 */
export function readBindingLock(root: string): BindingLockRead {
  const path = bindingLockPath(root);
  assertNotSymlink(path);
  const raw = readIfExists(path);
  if (raw === undefined) return { present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BindingLockError(`binding lock is not valid JSON: ${path}`);
  }
  const result = BindingLockSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
    throw new BindingLockError(`invalid binding lock ${path}${where}`);
  }
  return { present: true, lock: result.data };
}

function prepareBindingDir(root: string): string {
  let current = root;
  for (const segment of [".aih", "binding"]) {
    current = join(current, segment);
    assertNotSymlink(current);
    if (!existsSync(current)) mkdirSync(current, { recursive: false, mode: 0o700 });
  }
  return current;
}

/**
 * Atomically write the lock (validate -> temp file with owner-only mode -> rename),
 * mirroring the ECC ledger writer. The rename is retried through the transient
 * Windows lock window.
 */
export function writeBindingLockAtomic(root: string, lock: BindingLock): void {
  const contents = `${JSON.stringify(parseBindingLock(lock), null, 2)}\n`;
  const directory = prepareBindingDir(root);
  const path = bindingLockPath(root);
  assertNotSymlink(path);
  const temporary = join(directory, `.lock.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    retryTransient(() => renameSync(temporary, path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Decide how removal must proceed (W3 executes it). A MISSING lock degrades to
 * drift-report-only — conservative removal never guess-deletes state it has no
 * applied-value record for (ruling 3). A corrupt lock propagates the fail-closed
 * {@link BindingLockError} from {@link readBindingLock} for the same reason.
 */
export function planBindingRemoval(root: string): BindingRemovalPlan {
  const read = readBindingLock(root);
  if (!read.present) {
    return {
      mode: "drift-report-only",
      reason:
        "no binding lock found; removal degrades to drift-report-only and will not delete un-recorded state",
    };
  }
  return { mode: "apply", lock: read.lock };
}
