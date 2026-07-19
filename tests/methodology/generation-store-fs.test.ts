import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActivationRecordSchema,
  canonicalRecordBytes,
  LockOwnerRecordSchema,
  MAX_PAYLOAD_BYTES,
  MAX_RECORD_BYTES,
  RootRecordSchema,
  sha256Bytes,
  TransactionRecordSchema,
} from "../../src/methodology/generation-store-contract.js";
import {
  assertOwnedStorePhase,
  createOrOpenOwnedStore,
  GenerationStoreFsError,
  openStoreForInspection,
  quarantineExactDirectory,
  readStoreRecord,
  removeVerifiedTree,
  verifyExpectedTree,
  verifyPartialOwnedTree,
  writeAtomicRecord,
  writeExclusiveRegularFile,
} from "../../src/methodology/generation-store-fs.js";
import {
  DEPENDENCY_BYTES,
  expectedReceiptEntries,
  makeSiblingCanary,
  makeTemporaryProject,
  payloadFixture,
  plannedFixture,
  ROOT_BYTES,
  type TemporaryProject,
} from "./generation-store-fixtures.js";

const TRANSACTION_ID = "d".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const RECEIPT_BYTES = Buffer.from('{"synthetic":"receipt"}\n');
const roots: TemporaryProject[] = [];

function temporaryProject(): TemporaryProject {
  const root = makeTemporaryProject();
  roots.push(root);
  return root;
}

function activation(manifestDigest = plannedDigest()) {
  return {
    schemaVersion: 1 as const,
    manifestDigest,
    receiptDigest: "a".repeat(64),
    generation: `generations/${manifestDigest}/content`,
  };
}

function plannedDigest(): string {
  const result = plannedFixture();
  if (result.state !== "planned") throw new Error("fixture must plan");
  return result.manifest.digest;
}

function writeActivationJournal(
  store: ReturnType<typeof createOrOpenOwnedStore>,
  transactionId: string,
  nextActivation: ReturnType<typeof activation>,
  oldActivation: ReturnType<typeof activation> | null = null,
): void {
  if (!existsSync(store.layout.transactions)) {
    mkdirSync(store.layout.transactions);
  }
  const record = {
    schemaVersion: 1 as const,
    operation: "apply" as const,
    rootId: store.rootRecord.rootId,
    transactionId,
    phase: "generation-verified" as const,
    manifestDigest: nextActivation.manifestDigest,
    oldActivation,
    newActivation: nextActivation,
    entries: expectedReceiptEntries(),
  };
  writeExclusiveRegularFile(
    store,
    join(store.layout.transactions, `${transactionId}.json`),
    canonicalRecordBytes("transaction", record),
  );
}

function generationEntries() {
  return [
    ...expectedReceiptEntries().map((entry) => ({
      ...entry,
      target: `content/${entry.target}`,
    })),
    {
      artifactId: "receipt-metadata",
      target: "receipt.json",
      sourceLocator: "synthetic:receipt-metadata",
      contentDigest: sha256Bytes(RECEIPT_BYTES),
      bytes: RECEIPT_BYTES.length,
    },
  ];
}

function materializeExpectedTree(contentRoot: string, entries = expectedReceiptEntries()): void {
  const payloadById = new Map(
    payloadFixture().map((payload) => [payload.artifactId, payload.bytes]),
  );
  payloadById.set("receipt-metadata", RECEIPT_BYTES);
  for (const entry of entries) {
    const bytes = payloadById.get(entry.artifactId);
    if (bytes === undefined) throw new Error("fixture payload is missing");
    const target = join(contentRoot, ...entry.target.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
}

function makeDirectoryLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function runCreateChild(
  projectRoot: string,
): Promise<Readonly<{ state: string; rootId?: string }>> {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "src", "methodology", "generation-store-fs.ts"),
  ).href;
  const source =
    `import { createOrOpenOwnedStore } from ${JSON.stringify(moduleUrl)};` +
    `try { const store = createOrOpenOwnedStore(${JSON.stringify(projectRoot)}); ` +
    'console.log(JSON.stringify({state:"opened",rootId:store.rootRecord.rootId})); } ' +
    'catch { console.log(JSON.stringify({state:"blocked"})); }';
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("first-open child timed out"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`first-open child exited ${String(code)}: ${stderr}`));
        return;
      }
      resolvePromise(JSON.parse(stdout.trim()) as { state: string; rootId?: string });
    });
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root.sandboxRoot, { recursive: true, force: true });
  }
});

describe("Phase 4 bounded generation-store filesystem", () => {
  it("performs zero writes when inspection finds no store", () => {
    const root = temporaryProject();
    const before = readdirSync(root.projectRoot);
    expect(openStoreForInspection(realpathSync(root.projectRoot))).toBeUndefined();
    expect(readdirSync(root.projectRoot)).toEqual(before);
  });

  it("creates only the fixed owned root and reopens the same identity", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const projectRoot = realpathSync(root.projectRoot);
    const first = createOrOpenOwnedStore(projectRoot);
    expect(first.layout.root).toBe(join(projectRoot, ".aih", "methodology", "v1"));
    expect(readdirSync(projectRoot)).toEqual([".aih"]);
    expect(readdirSync(first.layout.root)).toEqual(["root.json"]);
    expect(RootRecordSchema.safeParse(first.rootRecord).success).toBe(true);

    const second = createOrOpenOwnedStore(projectRoot);
    expect(second.rootRecord).toEqual(first.rootRecord);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("allows two cooperating first-open processes to converge or block cleanly", async () => {
    const root = temporaryProject();
    const projectRoot = realpathSync(root.projectRoot);
    const outcomes = await Promise.all([runCreateChild(projectRoot), runCreateChild(projectRoot)]);
    expect(outcomes.every(({ state }) => state === "opened" || state === "blocked")).toBe(true);
    expect(outcomes.some(({ state }) => state === "opened")).toBe(true);
    const opened = createOrOpenOwnedStore(projectRoot);
    for (const outcome of outcomes) {
      if (outcome.state === "opened") expect(outcome.rootId).toBe(opened.rootRecord.rootId);
    }
  }, 60_000);

  it("rejects non-canonical, linked, unmarked, malformed, and non-directory roots", () => {
    const relativeRoot = temporaryProject();
    expect(() =>
      createOrOpenOwnedStore(relative(process.cwd(), relativeRoot.projectRoot)),
    ).toThrow();
    expect(() =>
      createOrOpenOwnedStore(`${realpathSync(relativeRoot.projectRoot)}/../project`),
    ).toThrow();

    const linkedRoot = temporaryProject();
    const projectLink = join(linkedRoot.sandboxRoot, "project-link");
    if (makeDirectoryLink(linkedRoot.projectRoot, projectLink)) {
      expect(() => createOrOpenOwnedStore(projectLink)).toThrow();
    }

    const unmarked = temporaryProject();
    mkdirSync(join(unmarked.projectRoot, ".aih", "methodology", "v1"), { recursive: true });
    expect(() => createOrOpenOwnedStore(realpathSync(unmarked.projectRoot))).toThrow();

    const malformed = temporaryProject();
    const malformedRoot = join(malformed.projectRoot, ".aih", "methodology", "v1");
    mkdirSync(malformedRoot, { recursive: true });
    writeFileSync(join(malformedRoot, "root.json"), "{}\n");
    expect(() => createOrOpenOwnedStore(realpathSync(malformed.projectRoot))).toThrow();

    const nonDirectory = temporaryProject();
    writeFileSync(join(nonDirectory.projectRoot, ".aih"), "not-a-directory");
    expect(() => createOrOpenOwnedStore(realpathSync(nonDirectory.projectRoot))).toThrow();
  });

  it("rejects linked fixed ancestors and preserves the sibling canary", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const externalDirectory = join(root.sandboxRoot, "external-directory");
    mkdirSync(externalDirectory);
    if (makeDirectoryLink(externalDirectory, join(root.projectRoot, ".aih"))) {
      expect(() => createOrOpenOwnedStore(realpathSync(root.projectRoot))).toThrow();
      expect(readdirSync(externalDirectory)).toEqual([]);
      expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
    }
  });

  it("revalidates root identity, realpath, and captured device before mutation", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    expect(() => assertOwnedStorePhase(store)).not.toThrow();
    const forged = {
      ...store,
      layout: { ...store.layout, projectDevice: String(BigInt(store.layout.projectDevice) + 1n) },
    };
    expect(() => assertOwnedStorePhase(forged)).toThrow();
  });

  it("detects a static link or type substitution before the next write", () => {
    const linkedRoot = temporaryProject();
    const outside = makeSiblingCanary(linkedRoot);
    const linkedStore = createOrOpenOwnedStore(realpathSync(linkedRoot.projectRoot));
    const linkedStaging = join(linkedStore.layout.root, "staging");
    const outsideDirectory = join(linkedRoot.sandboxRoot, "outside-directory");
    mkdirSync(linkedStaging);
    mkdirSync(outsideDirectory);
    rmSync(linkedStaging, { recursive: true });
    if (makeDirectoryLink(outsideDirectory, linkedStaging)) {
      expect(() =>
        writeExclusiveRegularFile(linkedStore, join(linkedStaging, "escaped"), Buffer.from("x")),
      ).toThrow();
      expect(readdirSync(outsideDirectory)).toEqual([]);
      expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
    }

    const typedRoot = temporaryProject();
    const typedStore = createOrOpenOwnedStore(realpathSync(typedRoot.projectRoot));
    const typedStaging = join(typedStore.layout.root, "staging");
    mkdirSync(typedStaging);
    rmSync(typedStaging, { recursive: true });
    writeFileSync(typedStaging, "not-a-directory");
    expect(() =>
      writeExclusiveRegularFile(typedStore, join(typedStaging, "child"), Buffer.from("x")),
    ).toThrow();
  });

  it("writes exact binary bytes exclusively and verifies mode where supported", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const staging = join(store.layout.root, "staging");
    mkdirSync(staging);
    const target = join(staging, "binary.dat");
    const bytes = Buffer.from([0, 255, 128, 10]);
    const written = writeExclusiveRegularFile(store, target, bytes);
    expect(readFileSync(target)).toEqual(bytes);
    expect(written.digest).toBe(sha256Bytes(bytes));
    expect(() => writeExclusiveRegularFile(store, target, bytes)).toThrow();
    const oversized = join(staging, "oversized.dat");
    expect(() =>
      writeExclusiveRegularFile(store, oversized, Buffer.alloc(MAX_PAYLOAD_BYTES + 1)),
    ).toThrow();
    expect(existsSync(oversized)).toBe(false);
    if (process.platform !== "win32") {
      expect(lstatSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it("reads only bounded, canonical, single-link owned records", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    expect(readStoreRecord(store, store.layout.rootRecord, RootRecordSchema).record).toEqual(
      store.rootRecord,
    );

    const linkedParent = join(store.layout.root, "linked-parent");
    if (makeDirectoryLink(dirname(store.layout.rootRecord), linkedParent)) {
      expect(() =>
        readStoreRecord(store, join(linkedParent, "root.json"), RootRecordSchema, "root"),
      ).toThrow();
    }

    const hardlink = join(root.sandboxRoot, "root-hardlink.json");
    let hardlinkCreated = false;
    try {
      linkSync(store.layout.rootRecord, hardlink);
      hardlinkCreated = true;
    } catch {
      // Hard-link creation is not available on every test filesystem.
    }
    if (hardlinkCreated) {
      expect(() => readStoreRecord(store, store.layout.rootRecord, RootRecordSchema)).toThrow();
      rmSync(hardlink);
    }

    const nonCanonicalRoot = temporaryProject();
    const nonCanonicalStore = createOrOpenOwnedStore(realpathSync(nonCanonicalRoot.projectRoot));
    writeFileSync(
      nonCanonicalStore.layout.rootRecord,
      Buffer.from(
        JSON.stringify({
          rootDevice: nonCanonicalStore.rootRecord.rootDevice,
          rootId: nonCanonicalStore.rootRecord.rootId,
          schemaVersion: 1,
        }),
      ),
    );
    try {
      openStoreForInspection(realpathSync(nonCanonicalRoot.projectRoot));
      throw new Error("expected non-canonical root refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationStoreFsError);
      expect((error as GenerationStoreFsError).findingCode).toBe("METHODOLOGY_STORE_ROOT_UNOWNED");
    }

    const oversizedRoot = temporaryProject();
    const oversizedStore = createOrOpenOwnedStore(realpathSync(oversizedRoot.projectRoot));
    writeFileSync(oversizedStore.layout.rootRecord, Buffer.alloc(MAX_RECORD_BYTES + 1));
    expect(() => openStoreForInspection(realpathSync(oversizedRoot.projectRoot))).toThrow();
  });

  it("binds transaction filenames to the strict transaction identity", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.transactions);
    const record = {
      schemaVersion: 1 as const,
      operation: "apply" as const,
      rootId: store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      phase: "prepared" as const,
      manifestDigest: plannedDigest(),
      oldActivation: null,
      newActivation: activation(),
      entries: expectedReceiptEntries(),
    };
    const validPath = join(store.layout.transactions, `${TRANSACTION_ID}.json`);
    writeExclusiveRegularFile(store, validPath, canonicalRecordBytes("transaction", record));
    expect(
      readStoreRecord(store, validPath, TransactionRecordSchema, "transaction").record,
    ).toEqual(record);

    const mismatchedPath = join(store.layout.transactions, `${OTHER_DIGEST}.json`);
    writeExclusiveRegularFile(store, mismatchedPath, canonicalRecordBytes("transaction", record));
    expect(() =>
      readStoreRecord(store, mismatchedPath, TransactionRecordSchema, "transaction"),
    ).toThrow();

    const stagedRecord = { ...record, phase: "staged" as const };
    expect(() =>
      writeAtomicRecord(store, {
        kind: "transaction",
        targetPath: validPath,
        temporaryPath: join(
          store.layout.transactions,
          `.${TRANSACTION_ID}.definitely-not-a-phase.tmp`,
        ),
        record: stagedRecord,
      }),
    ).toThrow();
    expect(
      readStoreRecord(store, validPath, TransactionRecordSchema, "transaction").record,
    ).toEqual(record);

    writeAtomicRecord(store, {
      kind: "transaction",
      targetPath: validPath,
      temporaryPath: join(store.layout.transactions, `.${TRANSACTION_ID}.staged.tmp`),
      record: stagedRecord,
    });
    expect(
      readStoreRecord(store, validPath, TransactionRecordSchema, "transaction").record,
    ).toEqual(stagedRecord);

    const missingTransactionId = "e".repeat(64);
    const missingRecord = {
      ...stagedRecord,
      transactionId: missingTransactionId,
    };
    expect(() =>
      writeAtomicRecord(store, {
        kind: "transaction",
        targetPath: join(store.layout.transactions, `${missingTransactionId}.json`),
        temporaryPath: join(store.layout.transactions, `.${missingTransactionId}.staged.tmp`),
        record: missingRecord,
      }),
    ).toThrow();
  });

  it("reads a strictly bound stale lock-candidate owner record", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.lockCandidates);
    const staleCandidate = join(store.layout.lockCandidates, `${OTHER_DIGEST}.stale`);
    mkdirSync(staleCandidate);
    const owner = {
      schemaVersion: 1 as const,
      rootId: store.rootRecord.rootId,
      token: OTHER_DIGEST,
      pid: 42,
      transactionId: TRANSACTION_ID,
    };
    const ownerPath = join(staleCandidate, "owner.json");
    writeExclusiveRegularFile(store, ownerPath, canonicalRecordBytes("lock-owner", owner));
    expect(readStoreRecord(store, ownerPath, LockOwnerRecordSchema, "lock-owner").record).toEqual(
      owner,
    );
  });

  it("verifies an exact expected tree and rejects missing, extra, linked, and hard-linked leaves", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const content = join(store.layout.root, "content");
    mkdirSync(content);
    materializeExpectedTree(content);
    const verified = verifyExpectedTree(store, content, expectedReceiptEntries());
    expect(verified.files).toHaveLength(2);
    expect(verified.missing).toEqual([]);

    const rootFile = join(content, "rules", "root.md");
    rmSync(rootFile);
    expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();
    writeFileSync(rootFile, ROOT_BYTES);

    const extra = join(content, "rules", "extra.md");
    writeFileSync(extra, "extra");
    expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();
    rmSync(extra);

    const outsideFile = join(root.sandboxRoot, "outside-bytes.md");
    writeFileSync(outsideFile, "outside");
    rmSync(rootFile);
    let symlinkCreated = false;
    try {
      symlinkSync(outsideFile, rootFile, "file");
      symlinkCreated = true;
    } catch {
      // Symlink creation may require extra privilege on Windows.
    }
    if (symlinkCreated) {
      expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();
      rmSync(rootFile);
    }
    writeFileSync(rootFile, ROOT_BYTES);

    const outsideHardlink = join(root.sandboxRoot, "outside-hardlink.md");
    let hardlinkCreated = false;
    try {
      linkSync(rootFile, outsideHardlink);
      hardlinkCreated = true;
    } catch {
      // Hard-link creation is not available on every test filesystem.
    }
    if (hardlinkCreated) {
      expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();
      rmSync(outsideHardlink);
    }
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("enforces depth, entry, byte, and outside-root walk bounds", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const content = join(store.layout.root, "bounded-content");
    mkdirSync(content);
    const deep = join(content, ...Array.from({ length: 34 }, () => "d"));
    mkdirSync(deep, { recursive: true });
    expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();
    rmSync(content, { recursive: true });

    mkdirSync(content);
    for (let index = 0; index < 1_025; index += 1) {
      writeFileSync(join(content, `extra-${index}`), "");
    }
    expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();
    rmSync(content, { recursive: true });

    mkdirSync(join(content, "rules"), { recursive: true });
    writeFileSync(join(content, "rules", "root.md"), Buffer.alloc(MAX_PAYLOAD_BYTES + 1));
    writeFileSync(join(content, "rules", "dependency.md"), DEPENDENCY_BYTES);
    expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();

    const outside = join(root.sandboxRoot, "outside-tree");
    mkdirSync(outside);
    rmSync(content, { recursive: true });
    if (makeDirectoryLink(outside, content)) {
      expect(() => verifyExpectedTree(store, content, expectedReceiptEntries())).toThrow();
    }
  });

  it("allows only absent expected leaves in a partial owned tree", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const content = join(store.layout.root, "partial");
    mkdirSync(content);
    const empty = verifyPartialOwnedTree(store, content, expectedReceiptEntries());
    expect(empty.missing).toEqual(["rules/dependency.md", "rules/root.md"]);

    mkdirSync(join(content, "rules"));
    writeFileSync(join(content, "rules", "root.md"), ROOT_BYTES);
    const partial = verifyPartialOwnedTree(store, content, expectedReceiptEntries());
    expect(partial.missing).toEqual(["rules/dependency.md"]);

    writeFileSync(join(content, "rules", "unexpected.md"), "unexpected");
    expect(() => verifyPartialOwnedTree(store, content, expectedReceiptEntries())).toThrow();
  });

  it("atomically replaces a record through one exact transaction-bound sibling", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    writeExclusiveRegularFile(
      store,
      store.layout.active,
      canonicalRecordBytes("activation", activation()),
    );
    const next = activation(OTHER_DIGEST);
    writeActivationJournal(store, TRANSACTION_ID, next, activation());
    writeAtomicRecord(store, {
      kind: "activation",
      targetPath: store.layout.active,
      temporaryPath: join(store.layout.root, `.active.${TRANSACTION_ID}.tmp`),
      record: next,
    });
    const observed = readStoreRecord(store, store.layout.active, ActivationRecordSchema).record;
    expect(observed).toEqual(next);

    const staleTransactionId = "c".repeat(64);
    writeActivationJournal(store, staleTransactionId, activation(), activation());
    expect(() =>
      writeAtomicRecord(store, {
        kind: "activation",
        targetPath: store.layout.active,
        temporaryPath: join(store.layout.root, `.active.${staleTransactionId}.tmp`),
        record: activation(),
      }),
    ).toThrow();
    expect(readStoreRecord(store, store.layout.active, ActivationRecordSchema).record).toEqual(
      next,
    );

    expect(() =>
      writeAtomicRecord(store, {
        kind: "activation",
        targetPath: store.layout.active,
        temporaryPath: join(root.sandboxRoot, "outside.tmp"),
        record: activation(),
      }),
    ).toThrow();

    const hostileRoot = temporaryProject();
    const hostileStore = createOrOpenOwnedStore(realpathSync(hostileRoot.projectRoot));
    const outsideActivation = join(hostileRoot.sandboxRoot, "outside-active.json");
    writeFileSync(outsideActivation, "outside-active\n");
    let activeLinkCreated = false;
    try {
      symlinkSync(outsideActivation, hostileStore.layout.active, "file");
      activeLinkCreated = true;
    } catch {
      // Symlink creation may require extra privilege on Windows.
    }
    if (activeLinkCreated) {
      writeActivationJournal(hostileStore, TRANSACTION_ID, activation());
      expect(() =>
        writeAtomicRecord(hostileStore, {
          kind: "activation",
          targetPath: hostileStore.layout.active,
          temporaryPath: join(hostileStore.layout.root, `.active.${TRANSACTION_ID}.tmp`),
          record: activation(),
        }),
      ).toThrow();
      expect(lstatSync(hostileStore.layout.active).isSymbolicLink()).toBe(true);
      expect(readFileSync(outsideActivation, "utf8")).toBe("outside-active\n");
    }
  });

  it("never exposes torn activation bytes to a concurrent observer", async () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    writeExclusiveRegularFile(
      store,
      store.layout.active,
      canonicalRecordBytes("activation", activation()),
    );
    const allowedActivationBytes = [
      canonicalRecordBytes("activation", activation()).toString("utf8"),
      canonicalRecordBytes("activation", activation(OTHER_DIGEST)).toString("utf8"),
    ];
    const observerSource = [
      'const fs = require("node:fs");',
      `const target = ${JSON.stringify(store.layout.active)};`,
      `const allowed = new Set(${JSON.stringify(allowedActivationBytes)});`,
      'process.stdout.write("ready\\n");',
      "const deadline = Date.now() + 750;",
      "while (Date.now() < deadline) {",
      "  try {",
      '    const bytes = fs.readFileSync(target, "utf8");',
      '    if (!allowed.has(bytes)) throw new Error("torn or unexpected activation bytes");',
      "  } catch (error) {",
      "    process.stderr.write(String(error));",
      "    process.exit(2);",
      "  }",
      "}",
    ].join("\n");
    const observer = spawn(process.execPath, ["-e", observerSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let observerError = "";
    observer.stderr.on("data", (chunk: Buffer) => {
      observerError += chunk.toString("utf8");
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        observer.kill();
        rejectPromise(new Error("activation observer did not become ready"));
      }, 30_000);
      observer.stdout.once("data", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      observer.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
    });

    let currentActivation = activation();
    for (let index = 1; index <= 20; index += 1) {
      const transactionId = index.toString(16).padStart(64, "0");
      const nextActivation = activation(index % 2 === 0 ? plannedDigest() : OTHER_DIGEST);
      writeActivationJournal(store, transactionId, nextActivation, currentActivation);
      writeAtomicRecord(store, {
        kind: "activation",
        targetPath: store.layout.active,
        temporaryPath: join(store.layout.root, `.active.${transactionId}.tmp`),
        record: nextActivation,
      });
      currentActivation = nextActivation;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        observer.kill();
        rejectPromise(new Error("activation observer did not close"));
      }, 30_000);
      observer.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`activation observer failed: ${observerError}`));
      });
      observer.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
    });
  }, 60_000);

  it("quarantines an exact verified directory and removes only its revalidated tree", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.generations);
    mkdirSync(store.layout.trash);
    const entries = generationEntries();
    const generation = join(store.layout.generations, plannedDigest());
    mkdirSync(generation);
    materializeExpectedTree(generation, entries);
    const verified = verifyExpectedTree(store, generation, entries);
    expect(() => quarantineExactDirectory(store, verified, "not-a-transaction-id")).toThrow();
    expect(existsSync(generation)).toBe(true);

    const quarantined = quarantineExactDirectory(store, verified, TRANSACTION_ID);
    const trash = join(store.layout.trash, TRANSACTION_ID);
    expect(existsSync(generation)).toBe(false);
    expect(existsSync(trash)).toBe(true);
    expect(readFileSync(join(trash, "receipt.json"))).toEqual(RECEIPT_BYTES);
    removeVerifiedTree(store, quarantined);
    expect(existsSync(trash)).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("resumes deletion from an exact verified expected subset after interruption", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.trash);
    const entries = generationEntries();
    const trash = join(store.layout.trash, TRANSACTION_ID);
    mkdirSync(trash);
    materializeExpectedTree(trash, entries);
    verifyExpectedTree(store, trash, entries);
    rmSync(join(trash, "content", "rules", "root.md"));
    const partial = verifyPartialOwnedTree(store, trash, entries);
    expect(partial.missing).toEqual(["content/rules/root.md"]);
    removeVerifiedTree(store, partial);
    expect(existsSync(trash)).toBe(false);
  });

  it("retains a verified tree when bytes drift before removal", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.trash);
    const entries = generationEntries();
    const trash = join(store.layout.trash, TRANSACTION_ID);
    mkdirSync(trash);
    materializeExpectedTree(trash, entries);
    const verified = verifyExpectedTree(store, trash, entries);
    writeFileSync(join(trash, "content", "rules", "root.md"), "changed");
    expect(() => removeVerifiedTree(store, verified)).toThrow();
    expect(existsSync(trash)).toBe(true);
  });
});
