import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  SyntheticMethodologyProjectionManifestSchema,
  SyntheticMethodologyProjectionPlanSchema,
} from "./projection-planner.js";

const OUTPUT_ROOT = "methodology/v1";
const CONTAINER = ".aih";
const OWNER_FILE = ".aih-methodology-transaction-owner.json";
const LOCK_FILE = ".aih-methodology-transaction.lock";
const RECEIPT_FILE = ".aih-methodology-transaction.json";
const STAGE_PREFIX = ".methodology-stage-";
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 512 * 1024;

const OWNER = "aih-methodology-transaction-fixture";
const OwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.literal(OWNER),
    token: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.literal("aih-methodology-v1"),
    manifest: SyntheticMethodologyProjectionManifestSchema,
  })
  .strict();

export const SyntheticMethodologyTransactionInputSchema = z
  .object({
    plan: SyntheticMethodologyProjectionPlanSchema,
    contents: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            bytes: z.instanceof(Uint8Array),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.plan.state !== "planned" || input.plan.manifest === null) {
      ctx.addIssue({
        code: "custom",
        path: ["plan"],
        message: "transactions require a planned synthetic projection manifest",
      });
      return;
    }

    const planned = new Map(input.plan.manifest.entries.map((entry) => [entry.id, entry]));
    const supplied = new Set<string>();
    let totalBytes = 0;
    for (const [index, content] of input.contents.entries()) {
      if (supplied.has(content.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["contents", index, "id"],
          message: "transaction contents must have unique component ids",
        });
      }
      supplied.add(content.id);
      totalBytes += content.bytes.byteLength;
      if (content.bytes.byteLength > MAX_CONTENT_BYTES) {
        ctx.addIssue({
          code: "custom",
          path: ["contents", index, "bytes"],
          message: "transaction content exceeds the bounded entry size",
        });
      }
      const entry = planned.get(content.id);
      if (entry === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["contents", index, "id"],
          message: "transaction content is not present in the planned manifest",
        });
      } else if (digest(content.bytes) !== entry.source.contentDigest) {
        ctx.addIssue({
          code: "custom",
          path: ["contents", index, "bytes"],
          message: "transaction content digest does not bind the planned artifact",
        });
      }
    }
    if (totalBytes > MAX_TOTAL_CONTENT_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["contents"],
        message: "transaction content exceeds the bounded total size",
      });
    }
    for (const id of planned.keys()) {
      if (!supplied.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["contents"],
          message: "transaction contents must exactly cover the planned manifest",
        });
      }
    }
  });

type TransactionInput = z.infer<typeof SyntheticMethodologyTransactionInputSchema>;
type Manifest = z.infer<typeof SyntheticMethodologyProjectionManifestSchema>;

interface FileIdentity {
  dev: number;
  ino: number;
}

interface FixtureState {
  root: string;
  rootIdentity: FileIdentity;
  token: string;
  containerIdentity?: FileIdentity;
  stage?: { path: string; identity: FileIdentity };
}

export interface SyntheticMethodologyTransactionFixtureRoot {
  readonly __syntheticMethodologyTransactionFixtureRoot: unique symbol;
}

const fixtureRoots = new WeakMap<object, FixtureState>();

export type SyntheticMethodologyTransactionTestBoundary =
  | "after-container"
  | "after-lock"
  | "after-stage"
  | "after-entry"
  | "after-receipt"
  | "before-commit"
  | "before-entry-write"
  | "before-rename"
  | "after-rename"
  | "after-commit";

export interface SyntheticMethodologyTransactionTestOptions {
  /** Test-only failure injection. No command or production caller supplies this. */
  faultAt?: SyntheticMethodologyTransactionTestBoundary;
  /** Test-only containment-race seam; the next operation revalidates all owned paths. */
  onBoundary?: (boundary: SyntheticMethodologyTransactionTestBoundary) => void;
}

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function transactionError(message: string): Error {
  return new Error(`synthetic methodology transaction refused: ${message}`);
}

function trustedFixtureParent(): string {
  if (process.platform === "win32") {
    throw transactionError(
      "Windows fixture roots are unavailable without enforceable DACL confinement",
    );
  }
  const candidate = "/tmp";
  if (!isAbsolute(candidate)) throw transactionError("trusted fixture parent is unavailable");
  const parent = realpathSync(candidate);
  const parentInfo = lstatSync(parent);
  const parentIsPrivateToCurrentUser =
    typeof process.getuid === "function" &&
    parentInfo.uid === process.getuid() &&
    (parentInfo.mode & 0o077) === 0;
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (!parentIsPrivateToCurrentUser && (parentInfo.mode & 0o1000) === 0)
  ) {
    throw transactionError("trusted fixture parent is not an isolated temporary directory");
  }
  const cwd = realpathSync(process.cwd());
  const checkoutWithinParent = relative(parent, cwd);
  if (
    checkoutWithinParent === "" ||
    (!checkoutWithinParent.startsWith("..") && !isAbsolute(checkoutWithinParent))
  ) {
    throw transactionError("trusted fixture parent overlaps the checkout");
  }
  return parent;
}

function identity(path: string, label: string): FileIdentity {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw transactionError(`${label} is linked, non-directory, or a reparse point`);
  }
  return { dev: info.dev, ino: info.ino };
}

function privateFixtureRootIdentity(path: string, label: string): FileIdentity {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    typeof process.getuid !== "function" ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  ) {
    throw transactionError(`${label} is not private to the current POSIX user`);
  }
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertIdentity(path: string, expected: FileIdentity, label: string): void {
  const actual = identity(path, label);
  if (!sameIdentity(actual, expected)) {
    throw transactionError(`${label} containment identity changed`);
  }
}

function assertPrivateFixtureRoot(path: string, expected: FileIdentity): void {
  const actual = privateFixtureRootIdentity(path, "fixture root");
  if (!sameIdentity(actual, expected)) {
    throw transactionError("fixture root containment identity changed");
  }
}

function assertRegularFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw transactionError(`${label} is linked, non-regular, or hard-linked`);
  }
}

function stateFor(root: unknown): FixtureState {
  if (typeof root !== "object" || root === null) {
    throw transactionError("fixture root capability is unknown");
  }
  const state = fixtureRoots.get(root);
  if (state === undefined) throw transactionError("fixture root capability is unknown");
  assertPrivateFixtureRoot(state.root, state.rootIdentity);
  return state;
}

function containerPath(state: FixtureState): string {
  return join(state.root, CONTAINER);
}

function ownerPath(state: FixtureState): string {
  return join(containerPath(state), OWNER_FILE);
}

function lockPath(state: FixtureState): string {
  return join(containerPath(state), LOCK_FILE);
}

function outputPath(state: FixtureState): string {
  return join(containerPath(state), OUTPUT_ROOT);
}

function assertOwner(state: FixtureState): void {
  if (state.containerIdentity === undefined) throw transactionError("output parent is unowned");
  assertIdentity(containerPath(state), state.containerIdentity, "output parent");
  assertRegularFile(ownerPath(state), "output owner marker");
  const owner = OwnerSchema.parse(JSON.parse(readFileSync(ownerPath(state), "utf8")));
  if (owner.token !== state.token) throw transactionError("output parent is unowned");
}

function initializeOwner(state: FixtureState): void {
  const path = containerPath(state);
  if (existsSync(path)) throw transactionError("output parent is unowned");
  mkdirSync(path, { mode: 0o700 });
  state.containerIdentity = identity(path, "output parent");
  writeFileSync(
    ownerPath(state),
    `${JSON.stringify({ schemaVersion: 1, owner: OWNER, token: state.token })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  assertOwner(state);
}

function assertLock(state: FixtureState): void {
  assertOwner(state);
  assertRegularFile(lockPath(state), "transaction lock");
  if (readFileSync(lockPath(state), "utf8") !== `${state.token}\n`) {
    throw transactionError("transaction lock is unowned");
  }
}

function acquireLock(state: FixtureState): void {
  assertOwner(state);
  try {
    const descriptor = openSync(lockPath(state), "wx", 0o600);
    try {
      writeFileSync(descriptor, `${state.token}\n`, "utf8");
    } finally {
      // writeFileSync does not close a numeric descriptor.
      closeSync(descriptor);
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw transactionError("transaction lock already exists");
    }
    throw error;
  }
  assertLock(state);
}

function removeLock(state: FixtureState): void {
  if (!existsSync(lockPath(state))) return;
  assertLock(state);
  unlinkSync(lockPath(state));
}

function outputRelative(target: string): string {
  if (!target.startsWith(`${OUTPUT_ROOT}/`)) {
    throw transactionError("manifest target escapes the owned output root");
  }
  return target.slice(OUTPUT_ROOT.length + 1);
}

function safeJoin(base: string, child: string): string {
  const destination = resolve(base, child);
  if (relative(base, destination).startsWith("..") || relative(base, destination) === "") {
    throw transactionError("manifest target escapes transaction containment");
  }
  return destination;
}

function ensureDirectory(base: string, relativePath: string): void {
  if (relativePath === ".") {
    identity(base, "transaction staging directory");
    return;
  }
  let current = base;
  for (const segment of relativePath.split("/")) {
    current = safeJoin(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    identity(current, "transaction staging directory");
  }
}

function checkpoint(
  state: FixtureState,
  options: SyntheticMethodologyTransactionTestOptions | undefined,
  boundary: SyntheticMethodologyTransactionTestBoundary,
): void {
  options?.onBoundary?.(boundary);
  assertPrivateFixtureRoot(state.root, state.rootIdentity);
  if (state.containerIdentity !== undefined) assertOwner(state);
  if (state.stage !== undefined)
    assertIdentity(state.stage.path, state.stage.identity, "transaction stage");
  if (options?.faultAt === boundary) throw new Error(`injected transaction failure at ${boundary}`);
}

function createStage(state: FixtureState): void {
  assertOwner(state);
  const path = join(containerPath(state), `${STAGE_PREFIX}${state.token}`);
  mkdirSync(path, { mode: 0o700 });
  state.stage = { path, identity: identity(path, "transaction stage") };
}

function assertStage(state: FixtureState): string {
  if (state.stage === undefined) throw transactionError("transaction stage is missing");
  assertOwner(state);
  assertIdentity(state.stage.path, state.stage.identity, "transaction stage");
  return state.stage.path;
}

function expectedFiles(manifest: Manifest): Map<string, string> {
  return new Map(
    manifest.entries.map((entry) => [outputRelative(entry.target), entry.source.contentDigest]),
  );
}

function receiptText(manifest: Manifest): string {
  return `${JSON.stringify({ schemaVersion: 1, owner: "aih-methodology-v1", manifest })}\n`;
}

function readReceipt(base: string): z.infer<typeof ReceiptSchema> {
  identity(base, "projection root");
  const path = join(base, RECEIPT_FILE);
  assertRegularFile(path, "projection receipt");
  return ReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function assertExactChildren(path: string, expected: readonly string[], label: string): void {
  identity(path, label);
  const actual = readdirSync(path).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((name, index) => name !== canonicalExpected[index])
  ) {
    throw transactionError(`${label} contains an unknown or missing entry`);
  }
}

function verifyTree(
  base: string,
  manifest: Manifest,
  requireComplete: boolean,
): { files: string[]; directories: string[] } {
  const files = expectedFiles(manifest);
  files.set(RECEIPT_FILE, "receipt");
  const directories = new Set<string>([""]);
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }

  const actualFiles: string[] = [];
  const actualDirectories: string[] = [];
  function visit(relativePath: string): void {
    const directory = relativePath === "" ? base : safeJoin(base, relativePath);
    identity(directory, "projection directory");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      const full = safeJoin(base, child);
      if (entry.isDirectory()) {
        if (!directories.has(child))
          throw transactionError("projection contains an unknown directory");
        actualDirectories.push(child);
        visit(child);
      } else {
        if (!files.has(child)) throw transactionError("projection contains an unknown file");
        assertRegularFile(full, "projection file");
        if (child === RECEIPT_FILE) {
          const receipt = ReceiptSchema.parse(JSON.parse(readFileSync(full, "utf8")));
          if (receipt.manifest.digest !== manifest.digest) {
            throw transactionError("projection receipt does not bind the planned manifest");
          }
        } else if (digest(readFileSync(full)) !== files.get(child)) {
          throw transactionError("projection content digest does not bind the planned artifact");
        }
        actualFiles.push(child);
      }
    }
  }

  visit("");
  if (requireComplete) {
    for (const path of files.keys()) {
      if (!actualFiles.includes(path))
        throw transactionError("projection is missing an expected file");
    }
  }
  return { files: actualFiles, directories: actualDirectories };
}

function removeVerifiedTree(base: string, manifest: Manifest, requireComplete: boolean): void {
  const verified = verifyTree(base, manifest, requireComplete);
  const files = [...verified.files].sort((left, right) =>
    left < right ? 1 : left > right ? -1 : 0,
  );
  for (const path of files) unlinkSync(safeJoin(base, path));
  for (const path of [...verified.directories].sort((left, right) => right.length - left.length)) {
    rmdirSync(safeJoin(base, path));
  }
  rmdirSync(base);
}

function rollback(state: FixtureState, manifest: Manifest): void {
  if (state.stage !== undefined && existsSync(state.stage.path)) {
    const stage = assertStage(state);
    removeVerifiedTree(stage, manifest, false);
    state.stage = undefined;
  }
  if (state.containerIdentity !== undefined && existsSync(containerPath(state))) {
    assertOwner(state);
    const outputParent = join(containerPath(state), "methodology");
    if (existsSync(outputParent)) {
      assertExactChildren(outputParent, [], "owned methodology parent");
      rmdirSync(outputParent);
    }
    const expected = existsSync(lockPath(state)) ? [LOCK_FILE, OWNER_FILE] : [OWNER_FILE];
    assertExactChildren(containerPath(state), expected, "owned output parent");
    if (expected.length === 2) removeLock(state);
    unlinkSync(ownerPath(state));
    rmdirSync(containerPath(state));
    state.containerIdentity = undefined;
  }
}

function commit(
  state: FixtureState,
  manifest: Manifest,
  options: SyntheticMethodologyTransactionTestOptions | undefined,
  markCommitted: () => void,
): void {
  const stage = assertStage(state);
  verifyTree(stage, manifest, true);
  const outputParent = join(containerPath(state), "methodology");
  ensureDirectory(containerPath(state), "methodology");
  identity(outputParent, "output parent");
  const destination = join(outputParent, "v1");
  if (existsSync(destination)) throw transactionError("projection destination already exists");
  checkpoint(state, options, "before-rename");
  identity(outputParent, "output parent");
  renameSync(stage, destination);
  state.stage = undefined;
  markCommitted();
  checkpoint(state, options, "after-rename");
  verifyTree(destination, manifest, true);
}

/**
 * Create the only root capability accepted by Phase 4 transaction functions.
 * It is an opaque, process-local object backed by a newly-created OS temporary root.
 */
export function createSyntheticMethodologyTransactionFixtureRoot(): SyntheticMethodologyTransactionFixtureRoot {
  const root = mkdtempSync(join(trustedFixtureParent(), "aih-methodology-transaction-"));
  chmodSync(root, 0o700);
  const capability = {} as SyntheticMethodologyTransactionFixtureRoot;
  fixtureRoots.set(capability, {
    root,
    rootIdentity: privateFixtureRootIdentity(root, "fixture root"),
    token: randomBytes(16).toString("hex"),
  });
  return capability;
}

/** Read-only test inspection of an opaque disposable fixture root. */
export function syntheticMethodologyTransactionFixturePath(
  root: SyntheticMethodologyTransactionFixtureRoot,
): string {
  return stateFor(root).root;
}

/** Dispose only the temporary root minted by this module. */
export function disposeSyntheticMethodologyTransactionFixtureRoot(
  root: SyntheticMethodologyTransactionFixtureRoot,
): void {
  const state = stateFor(root);
  rmSync(state.root, { recursive: true, force: true });
  fixtureRoots.delete(root);
}

/**
 * Apply exact synthetic bytes only into an opaque disposable test root. No CLI calls
 * this function; it has no provider, host, package-manager, or network capability.
 */
export function applySyntheticMethodologyProjectionTransaction(
  root: SyntheticMethodologyTransactionFixtureRoot,
  value: unknown,
  options?: SyntheticMethodologyTransactionTestOptions,
): { state: "projected"; manifestDigest: string } {
  const state = stateFor(root);
  const input: TransactionInput = SyntheticMethodologyTransactionInputSchema.parse(value);
  const manifest = input.plan.manifest;
  if (input.plan.state !== "planned" || manifest === null) {
    throw transactionError("transactions require a planned synthetic projection manifest");
  }
  const contents = new Map(input.contents.map((content) => [content.id, content.bytes]));
  let committed = false;
  try {
    initializeOwner(state);
    checkpoint(state, options, "after-container");
    acquireLock(state);
    checkpoint(state, options, "after-lock");
    createStage(state);
    checkpoint(state, options, "after-stage");
    const stage = assertStage(state);
    for (const entry of manifest.entries) {
      const path = outputRelative(entry.target);
      ensureDirectory(stage, dirname(path));
      const bytes = contents.get(entry.id);
      if (bytes === undefined) throw transactionError("transaction content is missing");
      const destination = safeJoin(stage, path);
      checkpoint(state, options, "before-entry-write");
      identity(dirname(destination), "transaction staging directory");
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      assertRegularFile(destination, "staged projection file");
      if (digest(readFileSync(destination)) !== entry.source.contentDigest) {
        throw transactionError("staged content digest does not bind the planned artifact");
      }
      checkpoint(state, options, "after-entry");
    }
    writeFileSync(join(stage, RECEIPT_FILE), receiptText(manifest), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    assertRegularFile(join(stage, RECEIPT_FILE), "staged projection receipt");
    checkpoint(state, options, "after-receipt");
    checkpoint(state, options, "before-commit");
    commit(state, manifest, options, () => {
      committed = true;
    });
    checkpoint(state, options, "after-commit");
    verifyTree(outputPath(state), manifest, true);
    removeLock(state);
    return { state: "projected", manifestDigest: manifest.digest };
  } catch (error) {
    if (!committed) {
      try {
        rollback(state, manifest);
      } catch {
        // Preserve the owned marker and lock when hostile topology prevents a safe rollback.
      }
    }
    throw error;
  }
}

/** Recover only a valid committed projection left behind by an injected fixture fault. */
export function recoverSyntheticMethodologyProjectionTransaction(
  root: SyntheticMethodologyTransactionFixtureRoot,
): { state: "absent" | "present" | "recovered" } {
  const state = stateFor(root);
  if (!existsSync(containerPath(state))) return { state: "absent" };
  assertOwner(state);
  const output = outputPath(state);
  if (!existsSync(output)) throw transactionError("owned transaction recovery found no projection");
  const receipt = readReceipt(output);
  verifyTree(output, receipt.manifest, true);
  if (!existsSync(lockPath(state))) return { state: "present" };
  assertLock(state);
  removeLock(state);
  return { state: "recovered" };
}

/** Clean only a verified, owned projection inside an opaque disposable fixture root. */
export function cleanSyntheticMethodologyProjectionTransaction(
  root: SyntheticMethodologyTransactionFixtureRoot,
): { state: "absent" | "cleaned" } {
  const state = stateFor(root);
  if (!existsSync(containerPath(state))) return { state: "absent" };
  assertOwner(state);
  if (existsSync(lockPath(state)))
    throw transactionError("transaction lock exists; recover before clean");
  const output = outputPath(state);
  if (!existsSync(output))
    throw transactionError("owned output parent contains no verified projection");
  const receipt = readReceipt(output);
  verifyTree(output, receipt.manifest, true);
  assertExactChildren(
    join(containerPath(state), "methodology"),
    ["v1"],
    "owned methodology parent",
  );
  assertExactChildren(containerPath(state), [OWNER_FILE, "methodology"], "owned output parent");
  removeVerifiedTree(output, receipt.manifest, true);
  rmdirSync(join(containerPath(state), "methodology"));
  unlinkSync(ownerPath(state));
  rmdirSync(containerPath(state));
  state.containerIdentity = undefined;
  return { state: "cleaned" };
}
