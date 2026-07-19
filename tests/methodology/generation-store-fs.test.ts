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
  GenerationReceiptSchema,
  IncompleteRecordSchema,
  LockOwnerRecordSchema,
  MAX_MANIFEST_ENTRIES,
  MAX_PAYLOAD_BYTES,
  MAX_RECORD_BYTES,
  RootRecordSchema,
  StagingRecordSchema,
  sha256Bytes,
  TransactionRecordSchema,
} from "../../src/methodology/generation-store-contract.js";
import {
  assertOwnedStorePhase,
  createOrOpenOwnedStore,
  GenerationStoreFsError,
  isGenerationDigest,
  isStoreObjectId,
  openStoreForInspection,
  quarantineExactDirectory,
  readStoreRecord,
  removeVerifiedTree,
  verifyExpectedContainer,
  verifyExpectedTree,
  verifyPartialOwnedContainer,
  verifyPartialOwnedTree,
  verifyPartialSourceContainer,
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
const roots: TemporaryProject[] = [];

function temporaryProject(): TemporaryProject {
  const root = makeTemporaryProject();
  roots.push(root);
  return root;
}

function expectFsFinding(operation: () => unknown, findingCode: string): void {
  try {
    operation();
    throw new Error("expected generation-store filesystem refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(GenerationStoreFsError);
    expect((error as GenerationStoreFsError).findingCode).toBe(findingCode);
  }
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

function materializeExpectedTree(contentRoot: string, entries = expectedReceiptEntries()): void {
  const payloadById = new Map(
    payloadFixture().map((payload) => [payload.artifactId, payload.bytes]),
  );
  for (const entry of entries) {
    const bytes = payloadById.get(entry.artifactId);
    if (bytes === undefined) throw new Error("fixture payload is missing");
    const target = join(contentRoot, ...entry.target.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
}

function generationReceipt(
  store: ReturnType<typeof createOrOpenOwnedStore>,
  entries = expectedReceiptEntries(),
) {
  return {
    schemaVersion: 1 as const,
    rootId: store.rootRecord.rootId,
    manifestDigest: plannedDigest(),
    entries,
  };
}

function materializeGeneration(
  store: ReturnType<typeof createOrOpenOwnedStore>,
  generation: string,
  entries = expectedReceiptEntries(),
): ReturnType<typeof generationReceipt> {
  mkdirSync(join(generation, "content"), { recursive: true });
  materializeExpectedTree(join(generation, "content"), entries);
  const receipt = generationReceipt(store, entries);
  writeExclusiveRegularFile(
    store,
    join(generation, "receipt.json"),
    canonicalRecordBytes("receipt", receipt),
  );
  return receipt;
}

function uniformEntries(count: number, directoriesPerEntry: number) {
  const bytes = Buffer.from("x");
  return Array.from({ length: count }, (_unused, index) => {
    const suffix = index.toString(36).padStart(2, "0");
    const directories = Array.from(
      { length: directoriesPerEntry },
      (_unusedDirectory, depth) => `e${suffix}-d${String(depth)}`,
    );
    return {
      artifactId: `artifact-${suffix}`,
      target: [...directories, `file-${suffix}.md`].join("/"),
      sourceLocator: `synthetic:artifact-${suffix}`,
      contentDigest: sha256Bytes(bytes),
      bytes: bytes.length,
    };
  });
}

function materializeUniformTree(
  contentRoot: string,
  entries: ReturnType<typeof uniformEntries>,
): void {
  const bytes = Buffer.from("x");
  for (const entry of entries) {
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

  it("infers every record kind and reports its fixed malformed-record finding", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const generation = join(store.layout.generations, plannedDigest());
    const staging = join(store.layout.staging, TRANSACTION_ID);
    mkdirSync(generation, { recursive: true });
    mkdirSync(staging, { recursive: true });
    mkdirSync(store.layout.lock);
    mkdirSync(store.layout.transactions);

    const cases: ReadonlyArray<
      Readonly<{
        path: string;
        schema: Readonly<{ parse: (value: unknown) => unknown }>;
        findingCode: string;
      }>
    > = [
      {
        path: store.layout.active,
        schema: ActivationRecordSchema,
        findingCode: "METHODOLOGY_STORE_ACTIVATION_INVALID",
      },
      {
        path: join(generation, "receipt.json"),
        schema: GenerationReceiptSchema,
        findingCode: "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
      },
      {
        path: join(generation, "incomplete.json"),
        schema: IncompleteRecordSchema,
        findingCode: "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
      },
      {
        path: join(staging, "staging.json"),
        schema: StagingRecordSchema,
        findingCode: "METHODOLOGY_STORE_TRANSACTION_INVALID",
      },
      {
        path: join(store.layout.lock, "owner.json"),
        schema: LockOwnerRecordSchema,
        findingCode: "METHODOLOGY_STORE_LOCK_INVALID",
      },
      {
        path: join(store.layout.transactions, `${TRANSACTION_ID}.json`),
        schema: TransactionRecordSchema,
        findingCode: "METHODOLOGY_STORE_TRANSACTION_INVALID",
      },
    ];
    for (const testCase of cases) {
      writeExclusiveRegularFile(store, testCase.path, Buffer.from("{\n"));
      expectFsFinding(
        () => readStoreRecord(store, testCase.path, testCase.schema),
        testCase.findingCode,
      );
    }

    const unknown = join(store.layout.root, "unknown-record.json");
    writeExclusiveRegularFile(store, unknown, Buffer.from("{}\n"));
    expectFsFinding(
      () => readStoreRecord(store, unknown, RootRecordSchema),
      "METHODOLOGY_STORE_PATH_UNSAFE",
    );
  });

  it("rejects valid records whose paths do not bind their identities", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const holder = join(store.layout.root, "holder");
    const wrongGeneration = join(store.layout.generations, OTHER_DIGEST);
    const wrongStaging = join(store.layout.staging, OTHER_DIGEST);
    const wrongCandidate = join(store.layout.lockCandidates, OTHER_DIGEST);
    mkdirSync(holder);
    mkdirSync(wrongGeneration, { recursive: true });
    mkdirSync(wrongStaging, { recursive: true });
    mkdirSync(wrongCandidate, { recursive: true });

    const wrongRootPath = join(holder, "root.json");
    writeExclusiveRegularFile(store, wrongRootPath, canonicalRecordBytes("root", store.rootRecord));
    expect(() => readStoreRecord(store, wrongRootPath, RootRecordSchema)).toThrow();

    const wrongActivationPath = join(holder, "active.json");
    writeExclusiveRegularFile(
      store,
      wrongActivationPath,
      canonicalRecordBytes("activation", activation()),
    );
    expect(() => readStoreRecord(store, wrongActivationPath, ActivationRecordSchema)).toThrow();

    const receipt = generationReceipt(store);
    const wrongReceiptPath = join(wrongGeneration, "receipt.json");
    writeExclusiveRegularFile(store, wrongReceiptPath, canonicalRecordBytes("receipt", receipt));
    expect(() => readStoreRecord(store, wrongReceiptPath, GenerationReceiptSchema)).toThrow();

    const incomplete = {
      schemaVersion: 1 as const,
      rootId: store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    const wrongIncompletePath = join(wrongGeneration, "incomplete.json");
    writeExclusiveRegularFile(
      store,
      wrongIncompletePath,
      canonicalRecordBytes("incomplete", incomplete),
    );
    expect(() => readStoreRecord(store, wrongIncompletePath, IncompleteRecordSchema)).toThrow();

    const staging = {
      schemaVersion: 1 as const,
      rootId: store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    const wrongStagingPath = join(wrongStaging, "staging.json");
    writeExclusiveRegularFile(store, wrongStagingPath, canonicalRecordBytes("staging", staging));
    expect(() => readStoreRecord(store, wrongStagingPath, StagingRecordSchema)).toThrow();

    const owner = {
      schemaVersion: 1 as const,
      rootId: store.rootRecord.rootId,
      token: TRANSACTION_ID,
      pid: 1,
      transactionId: TRANSACTION_ID,
    };
    const wrongOwnerPath = join(wrongCandidate, "owner.json");
    writeExclusiveRegularFile(store, wrongOwnerPath, canonicalRecordBytes("lock-owner", owner));
    expect(() => readStoreRecord(store, wrongOwnerPath, LockOwnerRecordSchema)).toThrow();

    const transaction = {
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
    const wrongTransactionPath = join(holder, `${TRANSACTION_ID}.json`);
    writeExclusiveRegularFile(
      store,
      wrongTransactionPath,
      canonicalRecordBytes("transaction", transaction),
    );
    expect(() => readStoreRecord(store, wrongTransactionPath, TransactionRecordSchema)).toThrow();
  });

  it("rejects unsupported and unbound atomic replacement shapes before writing", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.transactions);
    mkdirSync(store.layout.lock);
    const generation = join(store.layout.generations, plannedDigest());
    mkdirSync(generation, { recursive: true });

    expectFsFinding(
      () =>
        writeAtomicRecord(store, {
          kind: "activation",
          targetPath: store.layout.active,
          temporaryPath: join(store.layout.root, `.active.${TRANSACTION_ID}.tmp`),
          record: {},
        }),
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );

    expect(() =>
      writeAtomicRecord(store, {
        kind: "activation",
        targetPath: store.layout.active,
        temporaryPath: join(store.layout.transactions, `.active.${TRANSACTION_ID}.tmp`),
        record: activation(),
      }),
    ).toThrow();
    expect(() =>
      writeAtomicRecord(store, {
        kind: "activation",
        targetPath: store.layout.active,
        temporaryPath: join(store.layout.root, ".active.not-bound.tmp"),
        record: activation(),
      }),
    ).toThrow();

    const receipt = generationReceipt(store);
    expect(() =>
      writeAtomicRecord(store, {
        kind: "receipt",
        targetPath: join(generation, "receipt.json"),
        temporaryPath: join(generation, ".receipt.tmp"),
        record: receipt,
      }),
    ).toThrow();
    expect(() =>
      writeAtomicRecord(store, {
        kind: "root",
        targetPath: store.layout.rootRecord,
        temporaryPath: join(store.layout.root, ".root.tmp"),
        record: store.rootRecord,
      }),
    ).toThrow();
    const owner = {
      schemaVersion: 1 as const,
      rootId: store.rootRecord.rootId,
      token: TRANSACTION_ID,
      pid: 1,
      transactionId: TRANSACTION_ID,
    };
    expect(() =>
      writeAtomicRecord(store, {
        kind: "lock-owner",
        targetPath: join(store.layout.lock, "owner.json"),
        temporaryPath: join(store.layout.lock, ".owner.tmp"),
        record: owner,
      }),
    ).toThrow();

    const transaction = {
      schemaVersion: 1 as const,
      operation: "apply" as const,
      rootId: store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      phase: "staged" as const,
      manifestDigest: plannedDigest(),
      oldActivation: null,
      newActivation: activation(),
      entries: expectedReceiptEntries(),
    };
    expect(() =>
      writeAtomicRecord(store, {
        kind: "transaction",
        targetPath: join(store.layout.transactions, `${TRANSACTION_ID}.json`),
        temporaryPath: join(store.layout.transactions, ".not-bound.tmp"),
        record: transaction,
      }),
    ).toThrow();
  });

  it("binds first activation publication to an explicitly empty prior state", () => {
    const successfulRoot = temporaryProject();
    const successfulStore = createOrOpenOwnedStore(realpathSync(successfulRoot.projectRoot));
    const next = activation();
    writeActivationJournal(successfulStore, TRANSACTION_ID, next);
    writeAtomicRecord(successfulStore, {
      kind: "activation",
      targetPath: successfulStore.layout.active,
      temporaryPath: join(successfulStore.layout.root, `.active.${TRANSACTION_ID}.tmp`),
      record: next,
    });
    expect(
      readStoreRecord(successfulStore, successfulStore.layout.active, ActivationRecordSchema)
        .record,
    ).toEqual(next);

    const priorRoot = temporaryProject();
    const priorStore = createOrOpenOwnedStore(realpathSync(priorRoot.projectRoot));
    writeActivationJournal(priorStore, TRANSACTION_ID, next, activation(OTHER_DIGEST));
    expect(() =>
      writeAtomicRecord(priorStore, {
        kind: "activation",
        targetPath: priorStore.layout.active,
        temporaryPath: join(priorStore.layout.root, `.active.${TRANSACTION_ID}.tmp`),
        record: next,
      }),
    ).toThrow();
    expect(existsSync(priorStore.layout.active)).toBe(false);

    const mismatchedRoot = temporaryProject();
    const mismatchedStore = createOrOpenOwnedStore(realpathSync(mismatchedRoot.projectRoot));
    writeActivationJournal(mismatchedStore, TRANSACTION_ID, next);
    expect(() =>
      writeAtomicRecord(mismatchedStore, {
        kind: "activation",
        targetPath: mismatchedStore.layout.active,
        temporaryPath: join(mismatchedStore.layout.root, `.active.${TRANSACTION_ID}.tmp`),
        record: activation(OTHER_DIGEST),
      }),
    ).toThrow();
    expect(existsSync(mismatchedStore.layout.active)).toBe(false);
  });

  it("rejects a correctly named transaction temporary that skips a phase", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.transactions);
    const prepared = {
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
    const targetPath = join(store.layout.transactions, `${TRANSACTION_ID}.json`);
    writeExclusiveRegularFile(store, targetPath, canonicalRecordBytes("transaction", prepared));
    expect(() =>
      writeAtomicRecord(store, {
        kind: "transaction",
        targetPath,
        temporaryPath: join(
          store.layout.transactions,
          `.${TRANSACTION_ID}.generation-verified.tmp`,
        ),
        record: { ...prepared, phase: "generation-verified" as const },
      }),
    ).toThrow();
    expect(
      readStoreRecord(store, targetPath, TransactionRecordSchema, "transaction").record,
    ).toEqual(prepared);
  });

  it("recognizes only closed digest and store-object identities", () => {
    expect(isGenerationDigest(plannedDigest())).toBe(true);
    expect(isGenerationDigest("not-a-digest")).toBe(false);
    expect(isStoreObjectId(TRANSACTION_ID)).toBe(true);
    expect(isStoreObjectId("not-an-object-id")).toBe(false);
  });

  it("reports every expected absence in an empty transaction-bound trash container", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const trash = join(store.layout.trash, TRANSACTION_ID);
    mkdirSync(trash, { recursive: true });
    const incomplete = {
      schemaVersion: 1 as const,
      rootId: store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    const verified = verifyPartialOwnedContainer(
      store,
      trash,
      "incomplete",
      incomplete,
      expectedReceiptEntries(),
    );
    expect(verified.missing).toEqual([
      "content/rules/dependency.md",
      "content/rules/root.md",
      "incomplete.json",
    ]);
  });

  it("rejects malformed, unbound, drifted, and incomplete container shapes", () => {
    const newStore = () => {
      const root = temporaryProject();
      return createOrOpenOwnedStore(realpathSync(root.projectRoot));
    };
    const incompleteFor = (
      store: ReturnType<typeof createOrOpenOwnedStore>,
      rootId = store.rootRecord.rootId,
      manifestDigest = plannedDigest(),
    ) => ({
      schemaVersion: 1 as const,
      rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest,
    });
    const makeTrash = (store: ReturnType<typeof createOrOpenOwnedStore>) => {
      const trash = join(store.layout.trash, TRANSACTION_ID);
      mkdirSync(trash, { recursive: true });
      return trash;
    };
    const entries = expectedReceiptEntries();

    {
      const store = newStore();
      const trash = makeTrash(store);
      expectFsFinding(
        () => verifyPartialOwnedContainer(store, trash, "incomplete", {}, entries),
        "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
      );
    }

    {
      const store = newStore();
      const receipt = generationReceipt(store);
      expect(() =>
        verifyExpectedContainer(
          store,
          join(store.layout.generations, plannedDigest()),
          "receipt",
          receipt,
          uniformEntries(1, 0),
        ),
      ).toThrow();
    }

    {
      const store = newStore();
      const trash = makeTrash(store);
      expect(() =>
        verifyPartialOwnedContainer(
          store,
          trash,
          "incomplete",
          incompleteFor(store, OTHER_DIGEST),
          entries,
        ),
      ).toThrow();
    }

    {
      const store = newStore();
      const trash = makeTrash(store);
      writeFileSync(join(trash, "unexpected"), "unexpected");
      expect(() =>
        verifyPartialOwnedContainer(store, trash, "incomplete", incompleteFor(store), entries),
      ).toThrow();
    }

    {
      const store = newStore();
      const trash = makeTrash(store);
      mkdirSync(join(trash, "incomplete.json"));
      expect(() =>
        verifyPartialOwnedContainer(store, trash, "incomplete", incompleteFor(store), entries),
      ).toThrow();
    }

    {
      const store = newStore();
      const trash = makeTrash(store);
      writeExclusiveRegularFile(
        store,
        join(trash, "incomplete.json"),
        canonicalRecordBytes("incomplete", incompleteFor(store, undefined, OTHER_DIGEST)),
      );
      expectFsFinding(
        () =>
          verifyPartialOwnedContainer(store, trash, "incomplete", incompleteFor(store), entries),
        "METHODOLOGY_STORE_GENERATION_DRIFT",
      );
    }

    {
      const store = newStore();
      const trash = makeTrash(store);
      writeFileSync(join(trash, "content"), "not-a-directory");
      expect(() =>
        verifyPartialOwnedContainer(store, trash, "incomplete", incompleteFor(store), entries),
      ).toThrow();
    }

    {
      const store = newStore();
      const generation = join(store.layout.generations, plannedDigest());
      mkdirSync(generation, { recursive: true });
      const receipt = generationReceipt(store);
      writeExclusiveRegularFile(
        store,
        join(generation, "receipt.json"),
        canonicalRecordBytes("receipt", receipt),
      );
      expectFsFinding(
        () => verifyExpectedContainer(store, generation, "receipt", receipt, entries),
        "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
      );
    }
  });

  it("refuses a missing or replaced owned-root marker", () => {
    const missingRoot = temporaryProject();
    mkdirSync(join(missingRoot.projectRoot, ".aih", "methodology", "v1"), { recursive: true });
    expectFsFinding(
      () => openStoreForInspection(realpathSync(missingRoot.projectRoot)),
      "METHODOLOGY_STORE_ROOT_UNOWNED",
    );

    const changedRoot = temporaryProject();
    const changedStore = createOrOpenOwnedStore(realpathSync(changedRoot.projectRoot));
    writeFileSync(
      changedStore.layout.rootRecord,
      canonicalRecordBytes("root", {
        ...changedStore.rootRecord,
        rootId: OTHER_DIGEST,
      }),
    );
    expectFsFinding(() => assertOwnedStorePhase(changedStore), "METHODOLOGY_STORE_ROOT_UNOWNED");
  });

  it("refuses canonical stored metadata that differs from the expected record", () => {
    const receiptRoot = temporaryProject();
    const receiptStore = createOrOpenOwnedStore(realpathSync(receiptRoot.projectRoot));
    const generation = join(receiptStore.layout.generations, plannedDigest());
    mkdirSync(generation, { recursive: true });
    const storedReceipt = generationReceipt(receiptStore, uniformEntries(1, 0));
    writeExclusiveRegularFile(
      receiptStore,
      join(generation, "receipt.json"),
      canonicalRecordBytes("receipt", storedReceipt),
    );
    const expectedReceipt = generationReceipt(receiptStore);
    expect(() =>
      verifyExpectedContainer(
        receiptStore,
        generation,
        "receipt",
        expectedReceipt,
        expectedReceipt.entries,
      ),
    ).toThrow();

    const stagingRoot = temporaryProject();
    const stagingStore = createOrOpenOwnedStore(realpathSync(stagingRoot.projectRoot));
    const stagingDirectory = join(stagingStore.layout.staging, TRANSACTION_ID);
    mkdirSync(stagingDirectory, { recursive: true });
    const storedStaging = {
      schemaVersion: 1 as const,
      rootId: stagingStore.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    writeExclusiveRegularFile(
      stagingStore,
      join(stagingDirectory, "staging.json"),
      canonicalRecordBytes("staging", storedStaging),
    );
    expect(() =>
      verifyPartialSourceContainer(
        stagingStore,
        stagingDirectory,
        "staging",
        { ...storedStaging, manifestDigest: OTHER_DIGEST },
        expectedReceiptEntries(),
      ),
    ).toThrow();
  });

  it("binds trash metadata to its transaction and refuses containerless deletion", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const wrongTrash = join(store.layout.trash, OTHER_DIGEST);
    mkdirSync(wrongTrash, { recursive: true });
    const workRecord = {
      schemaVersion: 1 as const,
      rootId: store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    expect(() =>
      verifyPartialOwnedContainer(
        store,
        wrongTrash,
        "staging",
        workRecord,
        expectedReceiptEntries(),
      ),
    ).toThrow();
    expect(() =>
      verifyPartialOwnedContainer(
        store,
        wrongTrash,
        "incomplete",
        workRecord,
        expectedReceiptEntries(),
      ),
    ).toThrow();

    const emptyTrash = join(store.layout.trash, TRANSACTION_ID);
    mkdirSync(emptyTrash);
    const containerless = verifyPartialOwnedTree(store, emptyTrash, expectedReceiptEntries());
    expect(() => removeVerifiedTree(store, containerless)).toThrow();
    expect(existsSync(emptyTrash)).toBe(true);
  });

  it("refuses a verified container whose retained descriptor is no longer JSON", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const generation = join(store.layout.generations, plannedDigest());
    mkdirSync(store.layout.trash, { recursive: true });
    mkdirSync(generation, { recursive: true });
    const receipt = materializeGeneration(store, generation);
    const verified = verifyExpectedContainer(
      store,
      generation,
      "receipt",
      receipt,
      receipt.entries,
    );
    if (verified.container === null) throw new Error("container fixture is missing");
    const forged = {
      ...verified,
      container: {
        ...verified.container,
        metadataCanonical: "{",
      },
    };
    expect(() => quarantineExactDirectory(store, forged, TRANSACTION_ID)).toThrow();
    expect(existsSync(generation)).toBe(true);
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

  it("keeps fixed container overhead outside entry, directory, and depth maxima", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    const generation = join(store.layout.generations, plannedDigest());
    mkdirSync(join(generation, "content"), { recursive: true });
    const maximumEntries = uniformEntries(MAX_MANIFEST_ENTRIES, 8);
    materializeUniformTree(join(generation, "content"), maximumEntries);
    const receipt = generationReceipt(store, maximumEntries);
    writeExclusiveRegularFile(
      store,
      join(generation, "receipt.json"),
      canonicalRecordBytes("receipt", receipt),
    );
    const verified = verifyExpectedContainer(store, generation, "receipt", receipt, maximumEntries);
    expect(verified.files).toHaveLength(MAX_MANIFEST_ENTRIES + 1);
    expect(verified.directories).toHaveLength(514);

    const deepRoot = temporaryProject();
    const deepStore = createOrOpenOwnedStore(realpathSync(deepRoot.projectRoot));
    const deepGeneration = join(deepStore.layout.generations, plannedDigest());
    mkdirSync(join(deepGeneration, "content"), { recursive: true });
    const shallowEntry = uniformEntries(1, 0)[0];
    if (shallowEntry === undefined) throw new Error("maximum-depth fixture is missing");
    const maximumDepth = [
      {
        ...shallowEntry,
        target: [...Array.from({ length: 31 }, () => "d"), "f"].join("/"),
      },
    ];
    expect(maximumDepth[0]?.target.split("/")).toHaveLength(32);
    materializeUniformTree(join(deepGeneration, "content"), maximumDepth);
    const deepReceipt = generationReceipt(deepStore, maximumDepth);
    writeExclusiveRegularFile(
      deepStore,
      join(deepGeneration, "receipt.json"),
      canonicalRecordBytes("receipt", deepReceipt),
    );
    expect(
      verifyExpectedContainer(deepStore, deepGeneration, "receipt", deepReceipt, maximumDepth)
        .missing,
    ).toEqual([]);
  });

  it("quarantines exact and partial transaction-bound incomplete and staging remnants", () => {
    const exactRoot = temporaryProject();
    const exactStore = createOrOpenOwnedStore(realpathSync(exactRoot.projectRoot));
    mkdirSync(exactStore.layout.generations);
    mkdirSync(exactStore.layout.trash);
    const entries = expectedReceiptEntries();
    const exactGeneration = join(exactStore.layout.generations, plannedDigest());
    mkdirSync(join(exactGeneration, "content"), { recursive: true });
    materializeExpectedTree(join(exactGeneration, "content"), entries);
    const exactIncomplete = {
      schemaVersion: 1 as const,
      rootId: exactStore.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    writeExclusiveRegularFile(
      exactStore,
      join(exactGeneration, "incomplete.json"),
      canonicalRecordBytes("incomplete", exactIncomplete),
    );
    const exactVerified = verifyExpectedContainer(
      exactStore,
      exactGeneration,
      "incomplete",
      exactIncomplete,
      entries,
    );
    const exactTrash = quarantineExactDirectory(exactStore, exactVerified, TRANSACTION_ID);
    removeVerifiedTree(exactStore, exactTrash);
    expect(existsSync(join(exactStore.layout.trash, TRANSACTION_ID))).toBe(false);

    const partialRoot = temporaryProject();
    const partialStore = createOrOpenOwnedStore(realpathSync(partialRoot.projectRoot));
    mkdirSync(partialStore.layout.generations);
    mkdirSync(partialStore.layout.trash);
    const partialGeneration = join(partialStore.layout.generations, plannedDigest());
    mkdirSync(join(partialGeneration, "content", "rules"), { recursive: true });
    writeFileSync(join(partialGeneration, "content", "rules", "root.md"), ROOT_BYTES);
    const partialIncomplete = {
      schemaVersion: 1 as const,
      rootId: partialStore.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    writeExclusiveRegularFile(
      partialStore,
      join(partialGeneration, "incomplete.json"),
      canonicalRecordBytes("incomplete", partialIncomplete),
    );
    const partialVerified = verifyPartialSourceContainer(
      partialStore,
      partialGeneration,
      "incomplete",
      partialIncomplete,
      entries,
    );
    expect(partialVerified.missing).toEqual(["content/rules/dependency.md"]);
    expect(() => quarantineExactDirectory(partialStore, partialVerified, OTHER_DIGEST)).toThrow();
    expect(existsSync(partialGeneration)).toBe(true);
    quarantineExactDirectory(partialStore, partialVerified, TRANSACTION_ID);
    const partialTrash = join(partialStore.layout.trash, TRANSACTION_ID);
    const recoveredPartial = verifyPartialOwnedContainer(
      partialStore,
      partialTrash,
      "incomplete",
      partialIncomplete,
      entries,
    );
    removeVerifiedTree(partialStore, recoveredPartial);
    expect(existsSync(partialTrash)).toBe(false);

    const stagingRoot = temporaryProject();
    const stagingStore = createOrOpenOwnedStore(realpathSync(stagingRoot.projectRoot));
    mkdirSync(stagingStore.layout.staging);
    mkdirSync(stagingStore.layout.trash);
    const staging = join(stagingStore.layout.staging, TRANSACTION_ID);
    mkdirSync(join(staging, "content", "rules"), { recursive: true });
    writeFileSync(join(staging, "content", "rules", "root.md"), ROOT_BYTES);
    const stagingRecord = {
      schemaVersion: 1 as const,
      rootId: stagingStore.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: plannedDigest(),
    };
    writeExclusiveRegularFile(
      stagingStore,
      join(staging, "staging.json"),
      canonicalRecordBytes("staging", stagingRecord),
    );
    const stagingVerified = verifyPartialSourceContainer(
      stagingStore,
      staging,
      "staging",
      stagingRecord,
      entries,
    );
    expect(() => quarantineExactDirectory(stagingStore, stagingVerified, OTHER_DIGEST)).toThrow();
    expect(existsSync(staging)).toBe(true);
    quarantineExactDirectory(stagingStore, stagingVerified, TRANSACTION_ID);
    const stagingTrash = join(stagingStore.layout.trash, TRANSACTION_ID);
    const recoveredStaging = verifyPartialOwnedContainer(
      stagingStore,
      stagingTrash,
      "staging",
      stagingRecord,
      entries,
    );
    removeVerifiedTree(stagingStore, recoveredStaging);
    expect(existsSync(stagingTrash)).toBe(false);
  });

  it("quarantines an exact verified directory and removes only its revalidated tree", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.generations);
    mkdirSync(store.layout.trash);
    const entries = expectedReceiptEntries();
    const generation = join(store.layout.generations, plannedDigest());
    mkdirSync(generation);
    const receipt = materializeGeneration(store, generation, entries);
    const verified = verifyExpectedContainer(store, generation, "receipt", receipt, entries);
    expect(() => quarantineExactDirectory(store, verified, "not-a-transaction-id")).toThrow();
    expect(existsSync(generation)).toBe(true);
    if (verified.container === null) throw new Error("container fixture is missing");
    const forged = {
      ...verified,
      container: {
        ...verified.container,
        rootId: OTHER_DIGEST,
      },
    };
    expect(() => quarantineExactDirectory(store, forged, TRANSACTION_ID)).toThrow();
    expect(existsSync(generation)).toBe(true);

    const quarantined = quarantineExactDirectory(store, verified, TRANSACTION_ID);
    const trash = join(store.layout.trash, TRANSACTION_ID);
    const receiptBytes = canonicalRecordBytes("receipt", receipt);
    expect(existsSync(generation)).toBe(false);
    expect(existsSync(trash)).toBe(true);
    expect(readFileSync(join(trash, "receipt.json"))).toEqual(receiptBytes);
    removeVerifiedTree(store, quarantined);
    expect(existsSync(trash)).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("resumes deletion from an exact verified expected subset after interruption", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.generations);
    mkdirSync(store.layout.trash);
    const entries = expectedReceiptEntries();
    const generation = join(store.layout.generations, plannedDigest());
    mkdirSync(generation);
    const receipt = materializeGeneration(store, generation, entries);
    const verified = verifyExpectedContainer(store, generation, "receipt", receipt, entries);
    quarantineExactDirectory(store, verified, TRANSACTION_ID);
    const trash = join(store.layout.trash, TRANSACTION_ID);
    rmSync(join(trash, "content", "rules", "root.md"));
    const partial = verifyPartialOwnedContainer(store, trash, "receipt", receipt, entries);
    expect(partial.missing).toEqual(["content/rules/root.md"]);
    removeVerifiedTree(store, partial);
    expect(existsSync(trash)).toBe(false);
  });

  it("retains a verified tree when bytes drift before removal", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(realpathSync(root.projectRoot));
    mkdirSync(store.layout.generations);
    mkdirSync(store.layout.trash);
    const entries = expectedReceiptEntries();
    const generation = join(store.layout.generations, plannedDigest());
    mkdirSync(generation);
    const receipt = materializeGeneration(store, generation, entries);
    const verified = verifyExpectedContainer(store, generation, "receipt", receipt, entries);
    const quarantined = quarantineExactDirectory(store, verified, TRANSACTION_ID);
    const trash = join(store.layout.trash, TRANSACTION_ID);
    writeFileSync(join(trash, "content", "rules", "root.md"), "changed");
    expect(() => removeVerifiedTree(store, quarantined)).toThrow();
    expect(existsSync(trash)).toBe(true);
  });
});
