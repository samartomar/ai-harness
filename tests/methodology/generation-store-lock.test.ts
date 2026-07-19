import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRecordBytes,
  LockOwnerRecordSchema,
  MAX_PID,
  type StoreFindingCode,
} from "../../src/methodology/generation-store-contract.js";
import {
  createOrOpenOwnedStore,
  GenerationStoreFsError,
  readStoreRecord,
  writeExclusiveRegularFile,
} from "../../src/methodology/generation-store-fs.js";
import {
  acquireStoreLock,
  acquireStoreLockInternal,
  assertHeldStoreLock,
  GENERATION_STORE_LOCK_BOUNDARY,
  type HeldStoreLock,
  type LockRuntime,
  releaseStoreLock,
} from "../../src/methodology/generation-store-lock.js";
import {
  makeSiblingCanary,
  makeTemporaryProject,
  type TemporaryProject,
} from "./generation-store-fixtures.js";

const TRANSACTION_A = "a".repeat(64);
const TRANSACTION_B = "b".repeat(64);
const TOKEN_A = "1".repeat(64);
const TOKEN_B = "2".repeat(64);
const TOKEN_C = "3".repeat(64);
const TOKEN_D = "4".repeat(64);
const TOKEN_E = "5".repeat(64);
const TOKEN_F = "6".repeat(64);
const roots: TemporaryProject[] = [];

const mutableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const originalFs = Object.freeze({
  closeSync: mutableFs.closeSync,
  fsyncSync: mutableFs.fsyncSync,
  lstatSync: mutableFs.lstatSync,
  mkdirSync: mutableFs.mkdirSync,
  openSync: mutableFs.openSync,
  opendirSync: mutableFs.opendirSync,
  realpathSync: mutableFs.realpathSync,
  renameSync: mutableFs.renameSync,
  rmdirSync: mutableFs.rmdirSync,
  unlinkSync: mutableFs.unlinkSync,
});

type FaultableFs = typeof originalFs;

function injectFsFault(overrides: Partial<FaultableFs>): void {
  Object.assign(mutableFs, overrides);
  syncBuiltinESMExports();
}

function restoreFs(): void {
  Object.assign(mutableFs, originalFs);
  syncBuiltinESMExports();
}

function syntheticFsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code} filesystem failure`), { code });
}

function injectDirectoryStreamFault(absPath: string, operation: "readSync" | "closeSync"): void {
  injectFsFault({
    opendirSync: ((...args: unknown[]) => {
      const directory = Reflect.apply(originalFs.opendirSync, mutableFs, args);
      if (String(args[0]) !== absPath) return directory;
      return new Proxy(directory, {
        get(target, property) {
          if (property === operation) {
            return () => {
              if (operation === "closeSync") target.closeSync();
              throw syntheticFsError("EIO");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof originalFs.opendirSync,
  });
}

type Store = ReturnType<typeof createOrOpenOwnedStore>;

function temporaryStore(): Readonly<{ root: TemporaryProject; store: Store }> {
  const root = makeTemporaryProject();
  roots.push(root);
  return {
    root,
    store: createOrOpenOwnedStore(realpathSync(root.projectRoot)),
  };
}

function runtime(
  pid: number,
  token: string,
  states: ReadonlyMap<number, "alive" | "absent" | "indeterminate"> = new Map(),
): LockRuntime {
  return Object.freeze({
    pid,
    randomToken: () => token,
    pidState: (candidatePid) => states.get(candidatePid) ?? "indeterminate",
  });
}

function owner(store: Store, token: string, pid: number, transactionId = TRANSACTION_A) {
  return {
    schemaVersion: 1 as const,
    rootId: store.rootRecord.rootId,
    token,
    pid,
    transactionId,
  };
}

function writeOwner(store: Store, directory: string, record: ReturnType<typeof owner>): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeExclusiveRegularFile(
    store,
    join(directory, "owner.json"),
    canonicalRecordBytes("lock-owner", record),
  );
}

function lockError(action: () => unknown, findingCode: StoreFindingCode): GenerationStoreFsError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GenerationStoreFsError);
    const storeError = error as GenerationStoreFsError;
    expect(storeError.findingCode, storeError.message).toBe(findingCode);
    return storeError;
  }
  throw new Error("expected lock operation to fail");
}

function readLiveOwner(store: Store) {
  return readStoreRecord(
    store,
    join(store.layout.lock, "owner.json"),
    LockOwnerRecordSchema,
    "lock-owner",
  ).record;
}

afterEach(() => {
  restoreFs();
  for (const root of roots.splice(0)) {
    rmSync(root.sandboxRoot, { recursive: true, force: true });
  }
});

describe("Phase 4 cooperative generation-store lock", { timeout: 30_000 }, () => {
  it("revalidates only the exact live held-lock claim", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(100, TOKEN_A));

    const asserted = assertHeldStoreLock(store, held);
    expect(asserted).toEqual(held);
    expect(Object.isFrozen(asserted)).toBe(true);

    const mismatched = Object.freeze({
      ...held,
      transactionId: TRANSACTION_B,
    });
    lockError(() => assertHeldStoreLock(store, mismatched), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(readLiveOwner(store)).toEqual(held);

    const malformed = Object.freeze({ ...held, pid: 0 }) as HeldStoreLock;
    lockError(() => assertHeldStoreLock(store, malformed), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(readLiveOwner(store)).toEqual(held);

    releaseStoreLock(store, held);
    lockError(() => assertHeldStoreLock(store, held), "METHODOLOGY_STORE_LOCK_INVALID");
  });

  it("rejects another store claim and a hard-linked live owner without mutation", () => {
    const { root, store } = temporaryStore();
    const other = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(101, TOKEN_A));
    const foreignClaim = Object.freeze({
      ...held,
      rootId: other.store.rootRecord.rootId,
    });

    lockError(() => assertHeldStoreLock(store, foreignClaim), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(readLiveOwner(store)).toEqual(held);

    const ownerPath = join(store.layout.lock, "owner.json");
    const hardLink = join(root.sandboxRoot, "held-owner-hard-link.json");
    linkSync(ownerPath, hardLink);
    lockError(() => assertHeldStoreLock(store, held), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(readFileSync(ownerPath)).toEqual(canonicalRecordBytes("lock-owner", held));
    expect(readFileSync(hardLink)).toEqual(canonicalRecordBytes("lock-owner", held));
  });

  it("publishes a complete claim, serializes contenders, and releases only the exact claim", () => {
    const { store } = temporaryStore();
    const first = acquireStoreLockInternal(store, TRANSACTION_A, runtime(101, TOKEN_A));
    expect(first).toEqual(owner(store, TOKEN_A, 101));
    expect(readLiveOwner(store)).toEqual(first);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_A))).toBe(false);

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_B,
          runtime(202, TOKEN_B, new Map([[101, "alive"]])),
        ),
      "METHODOLOGY_STORE_LOCK_HELD",
    );
    expect(readLiveOwner(store)).toEqual(first);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);

    const wrong: HeldStoreLock = Object.freeze({ ...first, token: TOKEN_C });
    lockError(() => releaseStoreLock(store, wrong), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(readLiveOwner(store)).toEqual(first);

    releaseStoreLock(store, first);
    expect(existsSync(store.layout.lock)).toBe(false);

    const second = acquireStoreLockInternal(store, TRANSACTION_B, runtime(202, TOKEN_B));
    expect(readLiveOwner(store)).toEqual(second);
    releaseStoreLock(store, second);
  });

  it("reaps only dead PID-bound pending candidates before publishing a claim", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const emptyPending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.3001`);
    const tornPending = join(store.layout.lockCandidates, `${TOKEN_B}.pending.3002`);
    mkdirSync(emptyPending, { mode: 0o700 });
    mkdirSync(tornPending, { mode: 0o700 });
    writeFileSync(join(tornPending, "owner.json"), "{", { mode: 0o600 });

    const held = acquireStoreLockInternal(
      store,
      TRANSACTION_B,
      runtime(
        3003,
        TOKEN_C,
        new Map([
          [3001, "absent"],
          [3002, "absent"],
        ]),
      ),
    );

    expect(existsSync(emptyPending)).toBe(false);
    expect(existsSync(tornPending)).toBe(false);
    expect(readLiveOwner(store)).toEqual(held);
    releaseStoreLock(store, held);
    expect(readdirSync(store.layout.lockCandidates)).toEqual([]);
  });

  it("reaps an exact dead candidate but retains a live pending contender", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const deadCandidate = join(store.layout.lockCandidates, TOKEN_A);
    const livePending = join(store.layout.lockCandidates, `${TOKEN_B}.pending.3012`);
    writeOwner(store, deadCandidate, owner(store, TOKEN_A, 3011));
    mkdirSync(livePending, { mode: 0o700 });

    const held = acquireStoreLockInternal(
      store,
      TRANSACTION_B,
      runtime(
        3013,
        TOKEN_C,
        new Map([
          [3011, "absent"],
          [3012, "alive"],
        ]),
      ),
    );

    expect(existsSync(deadCandidate)).toBe(false);
    expect(existsSync(livePending)).toBe(true);
    releaseStoreLock(store, held);
    expect(existsSync(livePending)).toBe(true);
  });

  it("retains and fails closed on an unsafe dead pending candidate", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const pending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.3021`);
    mkdirSync(pending, { mode: 0o700 });
    writeFileSync(join(pending, "unexpected"), "retained", { mode: 0o600 });

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_B,
          runtime(3022, TOKEN_B, new Map([[3021, "absent"]])),
        ),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readFileSync(join(pending, "unexpected"), "utf8")).toBe("retained");
    expect(existsSync(store.layout.lock)).toBe(false);
  });

  it("constructs production claims internally and never accepts a runtime through public input", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLock(store, TRANSACTION_A);
    expect(held.pid).toBe(process.pid);
    expect(held.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readLiveOwner(store)).toEqual(held);
    releaseStoreLock(store, held);
  });

  it("discloses the bounded-scan and fail-closed candidate contract without a hard-cap claim", () => {
    expect(GENERATION_STORE_LOCK_BOUNDARY).toEqual({
      cooperativeOnly: true,
      sameUserTamperProof: false,
      candidateInventoryScanLimit: 128,
      concurrentCandidateHardCap: false,
      ambiguousCandidateAutoRepair: false,
      destructiveCleanupRecoverable: true,
      staleFenceRequiresQuiescence: true,
      providerRead: false,
      providerExecution: false,
      hostExecution: false,
      network: false,
      packageManager: false,
      native: false,
    });
  });

  it.each([
    ["live", "alive" as const],
    ["EPERM or otherwise indeterminate", "indeterminate" as const],
    ["PID reuse", "alive" as const],
  ])("leaves a valid %s owner held", (_label, state) => {
    const { store } = temporaryStore();
    const first = acquireStoreLockInternal(store, TRANSACTION_A, runtime(303, TOKEN_A));
    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_B,
          runtime(404, TOKEN_B, new Map([[303, state]])),
        ),
      "METHODOLOGY_STORE_LOCK_HELD",
    );
    expect(readLiveOwner(store)).toEqual(first);
    releaseStoreLock(store, first);
  });

  it("quarantines a definitively dead owner and removes its fence only after quiescence", () => {
    const { store } = temporaryStore();
    acquireStoreLockInternal(store, TRANSACTION_A, runtime(505, TOKEN_A));
    const next = acquireStoreLockInternal(
      store,
      TRANSACTION_B,
      runtime(606, TOKEN_B, new Map([[505, "absent"]])),
    );
    expect(next).toEqual(owner(store, TOKEN_B, 606, TRANSACTION_B));
    expect(readLiveOwner(store)).toEqual(next);
    expect(existsSync(join(store.layout.lockCandidates, `${TOKEN_A}.stale`))).toBe(false);
    releaseStoreLock(store, next);
  });

  it("fails closed when the deterministic stale destination already exists", () => {
    const { store } = temporaryStore();
    const first = acquireStoreLockInternal(store, TRANSACTION_A, runtime(707, TOKEN_A));
    const stale = join(store.layout.lockCandidates, `${TOKEN_A}.stale`);
    writeOwner(store, stale, first);

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_B,
          runtime(808, TOKEN_B, new Map([[707, "absent"]])),
        ),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readLiveOwner(store)).toEqual(first);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);
    releaseStoreLock(store, first);
  });

  it("retains empty, malformed, and linked live locks without adopting or replacing them", () => {
    const empty = temporaryStore();
    mkdirSync(empty.store.layout.lock);
    lockError(
      () => acquireStoreLockInternal(empty.store, TRANSACTION_A, runtime(909, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readdirSync(empty.store.layout.lock)).toEqual([]);
    expect(existsSync(join(empty.store.layout.lockCandidates, TOKEN_A))).toBe(false);

    const malformed = temporaryStore();
    mkdirSync(malformed.store.layout.lock);
    writeFileSync(join(malformed.store.layout.lock, "owner.json"), "{}\n");
    lockError(
      () => acquireStoreLockInternal(malformed.store, TRANSACTION_A, runtime(910, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readFileSync(join(malformed.store.layout.lock, "owner.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(malformed.store.layout.lockCandidates, TOKEN_A))).toBe(false);

    const linked = temporaryStore();
    const outside = makeSiblingCanary(linked.root);
    mkdirSync(linked.store.layout.lock);
    let linkCreated = false;
    try {
      symlinkSync(outside.canary, join(linked.store.layout.lock, "owner.json"), "file");
      linkCreated = true;
    } catch {
      // Windows may require Developer Mode for a file symlink.
    }
    if (linkCreated) {
      lockError(
        () => acquireStoreLockInternal(linked.store, TRANSACTION_A, runtime(911, TOKEN_A)),
        "METHODOLOGY_STORE_LOCK_INVALID",
      );
      expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
      expect(existsSync(join(linked.store.layout.lock, "owner.json"))).toBe(true);
      expect(existsSync(join(linked.store.layout.lockCandidates, TOKEN_A))).toBe(false);
    }
  });

  it("rejects invalid transaction and token identities before creating a candidate", () => {
    const invalidTransaction = temporaryStore();
    lockError(
      () =>
        acquireStoreLockInternal(
          invalidTransaction.store,
          "not-a-transaction",
          runtime(1001, TOKEN_A),
        ),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(invalidTransaction.store.layout.lock)).toBe(false);

    const invalidToken = temporaryStore();
    lockError(
      () =>
        acquireStoreLockInternal(invalidToken.store, TRANSACTION_A, runtime(1002, "A".repeat(64))),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(invalidToken.store.layout.lock)).toBe(false);
    if (existsSync(invalidToken.store.layout.lockCandidates)) {
      expect(readdirSync(invalidToken.store.layout.lockCandidates)).toEqual([]);
    }
  });

  it("refuses capacity for a 129th candidate and retains malformed candidate names", () => {
    const bounded = temporaryStore();
    mkdirSync(bounded.store.layout.lockCandidates);
    for (let index = 0; index < 128; index += 1) {
      mkdirSync(join(bounded.store.layout.lockCandidates, index.toString(16).padStart(64, "0")));
    }
    lockError(
      () => acquireStoreLockInternal(bounded.store, TRANSACTION_A, runtime(1101, TOKEN_F)),
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
    expect(readdirSync(bounded.store.layout.lockCandidates)).toHaveLength(128);
    expect(existsSync(join(bounded.store.layout.lockCandidates, TOKEN_F))).toBe(false);

    const malformed = temporaryStore();
    mkdirSync(malformed.store.layout.lockCandidates);
    mkdirSync(join(malformed.store.layout.lockCandidates, "INVALID"));
    lockError(
      () => acquireStoreLockInternal(malformed.store, TRANSACTION_A, runtime(1102, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(join(malformed.store.layout.lockCandidates, "INVALID"))).toBe(true);
    expect(existsSync(join(malformed.store.layout.lockCandidates, TOKEN_A))).toBe(false);
  });

  it("reaps only exact dead unrelated stale candidates after a quiescent claim", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const dead = owner(store, TOKEN_C, 1201);
    const live = owner(store, TOKEN_D, 1202);
    writeOwner(store, join(store.layout.lockCandidates, `${TOKEN_C}.stale`), dead);
    writeOwner(store, join(store.layout.lockCandidates, `${TOKEN_D}.stale`), live);

    const mismatchedPath = join(store.layout.lockCandidates, `${TOKEN_E}.stale`);
    mkdirSync(mismatchedPath, { mode: 0o700 });
    writeFileSync(
      join(mismatchedPath, "owner.json"),
      canonicalRecordBytes("lock-owner", owner(store, TOKEN_F, 1203)),
    );

    const held = acquireStoreLockInternal(
      store,
      TRANSACTION_B,
      runtime(
        1204,
        TOKEN_A,
        new Map([
          [1201, "absent"],
          [1202, "alive"],
          [1203, "absent"],
        ]),
      ),
    );
    expect(existsSync(join(store.layout.lockCandidates, `${TOKEN_C}.stale`))).toBe(false);
    expect(existsSync(join(store.layout.lockCandidates, `${TOKEN_D}.stale`))).toBe(true);
    expect(existsSync(mismatchedPath)).toBe(true);
    releaseStoreLock(store, held);
  });

  it("refuses release after owner drift or an unexpected descendant and leaves the lock", () => {
    const drifted = temporaryStore();
    const driftedHeld = acquireStoreLockInternal(
      drifted.store,
      TRANSACTION_A,
      runtime(1301, TOKEN_A),
    );
    rmSync(join(drifted.store.layout.lock, "owner.json"));
    writeFileSync(
      join(drifted.store.layout.lock, "owner.json"),
      canonicalRecordBytes("lock-owner", {
        ...driftedHeld,
        transactionId: TRANSACTION_B,
      }),
    );
    lockError(() => releaseStoreLock(drifted.store, driftedHeld), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(existsSync(drifted.store.layout.lock)).toBe(true);

    const populated = temporaryStore();
    const populatedHeld = acquireStoreLockInternal(
      populated.store,
      TRANSACTION_A,
      runtime(1302, TOKEN_B),
    );
    writeFileSync(join(populated.store.layout.lock, "unexpected"), "retain");
    lockError(
      () => releaseStoreLock(populated.store, populatedHeld),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readFileSync(join(populated.store.layout.lock, "unexpected"), "utf8")).toBe("retain");
  });

  it("builds and verifies a complete candidate before diagnosing a live lock", () => {
    const { store } = temporaryStore();
    const first = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1401, TOKEN_A));
    let candidateBytes: string | undefined;
    const contenderRuntime: LockRuntime = Object.freeze({
      pid: 1402,
      randomToken: () => TOKEN_B,
      pidState: () => {
        candidateBytes = readFileSync(
          join(store.layout.lockCandidates, TOKEN_B, "owner.json"),
          "utf8",
        );
        return "alive";
      },
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_B, contenderRuntime),
      "METHODOLOGY_STORE_LOCK_HELD",
    );
    expect(candidateBytes).toBe(
      canonicalRecordBytes("lock-owner", owner(store, TOKEN_B, 1402, TRANSACTION_B)).toString(
        "utf8",
      ),
    );
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);
    expect(readLiveOwner(store)).toEqual(first);
    releaseStoreLock(store, first);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    MAX_PID + 1,
  ])("rejects invalid runtime PID %s before filesystem mutation", (pid) => {
    const { store } = temporaryStore();
    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(pid, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(store.layout.lockCandidates)).toBe(false);
  });

  it("converts token-generation failure into a closed lock finding without residue", () => {
    const { store } = temporaryStore();
    const failingRuntime: LockRuntime = Object.freeze({
      pid: 1403,
      randomToken: () => {
        throw new Error("synthetic entropy failure");
      },
      pidState: () => "indeterminate",
    });
    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, failingRuntime),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(store.layout.lockCandidates)).toBe(false);
  });

  it.each([
    "rootId",
    "token",
    "pid",
    "transactionId",
  ] as const)("refuses release when the held %s does not match", (field) => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1501, TOKEN_A));
    const replacement =
      field === "rootId"
        ? "f".repeat(64)
        : field === "token"
          ? TOKEN_C
          : field === "pid"
            ? 1502
            : TRANSACTION_B;
    const forged = Object.freeze({ ...held, [field]: replacement }) as HeldStoreLock;

    lockError(() => releaseStoreLock(store, forged), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(readLiveOwner(store)).toEqual(held);
    expect(existsSync(join(store.layout.lockCandidates, forged.token))).toBe(false);
    releaseStoreLock(store, held);
  });

  it("finishes only the exact interrupted release candidate", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1503, TOKEN_A));
    const interrupted = join(store.layout.lockCandidates, held.token);
    renameSync(store.layout.lock, interrupted);

    releaseStoreLock(store, held);
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(interrupted)).toBe(false);
  });

  it("retries an exact release interrupted after destructive cleanup begins", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1507, TOKEN_A));
    let injected = false;
    injectFsFault({
      rmdirSync: ((...args: unknown[]) => {
        const candidate = String(args[0]);
        if (
          !injected &&
          candidate !== store.layout.lockCandidates &&
          candidate.startsWith(store.layout.lockCandidates)
        ) {
          injected = true;
          throw syntheticFsError("EIO");
        }
        return Reflect.apply(originalFs.rmdirSync, mutableFs, args);
      }) as typeof originalFs.rmdirSync,
    });

    lockError(() => releaseStoreLock(store, held), "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    expect(injected).toBe(true);

    restoreFs();
    releaseStoreLock(store, held);
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(readdirSync(store.layout.lockCandidates)).toEqual([]);
  });

  it("reaps an exact interrupted release cleanup after its owner process is absent", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1508, TOKEN_A));
    let injected = false;
    injectFsFault({
      rmdirSync: ((...args: unknown[]) => {
        const candidate = String(args[0]);
        if (
          !injected &&
          candidate !== store.layout.lockCandidates &&
          candidate.startsWith(store.layout.lockCandidates)
        ) {
          injected = true;
          throw syntheticFsError("EIO");
        }
        return Reflect.apply(originalFs.rmdirSync, mutableFs, args);
      }) as typeof originalFs.rmdirSync,
    });

    lockError(() => releaseStoreLock(store, held), "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    expect(injected).toBe(true);

    restoreFs();
    const next = acquireStoreLockInternal(
      store,
      TRANSACTION_B,
      runtime(1509, TOKEN_B, new Map([[held.pid, "absent"]])),
    );
    expect(readdirSync(store.layout.lockCandidates)).toEqual([]);
    releaseStoreLock(store, next);
  });

  it("completes an exact interrupted release at the 128-candidate boundary", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1504, TOKEN_A));
    for (let index = 0; index < 127; index += 1) {
      mkdirSync(join(store.layout.lockCandidates, index.toString(16).padStart(64, "0")));
    }
    const interrupted = join(store.layout.lockCandidates, held.token);
    renameSync(store.layout.lock, interrupted);
    expect(readdirSync(store.layout.lockCandidates)).toHaveLength(128);

    releaseStoreLock(store, held);
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(interrupted)).toBe(false);
    expect(readdirSync(store.layout.lockCandidates)).toHaveLength(127);
  });

  it("retains an exact interrupted release when total candidate inventory reaches 129", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1504, TOKEN_A));
    const interrupted = join(store.layout.lockCandidates, held.token);
    renameSync(store.layout.lock, interrupted);
    for (let index = 0; index < 128; index += 1) {
      mkdirSync(join(store.layout.lockCandidates, index.toString(16).padStart(64, "0")));
    }

    lockError(() => releaseStoreLock(store, held), "METHODOLOGY_STORE_RESOURCE_LIMIT");
    expect(existsSync(interrupted)).toBe(true);
    expect(readdirSync(store.layout.lockCandidates)).toHaveLength(129);
  });

  it("retains an exact interrupted release beside a malformed candidate", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1505, TOKEN_A));
    const interrupted = join(store.layout.lockCandidates, held.token);
    renameSync(store.layout.lock, interrupted);
    const malformed = join(store.layout.lockCandidates, "INVALID");
    mkdirSync(malformed);

    lockError(() => releaseStoreLock(store, held), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(existsSync(interrupted)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
  });

  it("retains an exact interrupted release beside a linked candidate", () => {
    const { root, store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1506, TOKEN_A));
    const interrupted = join(store.layout.lockCandidates, held.token);
    renameSync(store.layout.lock, interrupted);
    const outsideDirectory = join(root.sandboxRoot, "outside-release-candidate");
    const canary = join(outsideDirectory, "canary.txt");
    mkdirSync(outsideDirectory);
    writeFileSync(canary, "outside-release-canary\n");
    const linked = join(store.layout.lockCandidates, TOKEN_B);
    let linkCreated = false;
    try {
      symlinkSync(outsideDirectory, linked, process.platform === "win32" ? "junction" : "dir");
      linkCreated = true;
    } catch {
      // A restricted Windows host may prohibit creating the junction fixture.
    }
    if (!linkCreated) return;

    lockError(() => releaseStoreLock(store, held), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(existsSync(interrupted)).toBe(true);
    expect(existsSync(linked)).toBe(true);
    expect(readFileSync(canary, "utf8")).toBe("outside-release-canary\n");
  });

  it("retains a direct linked lock and cleans only its own candidate", () => {
    const { root, store } = temporaryStore();
    const outsideDirectory = join(root.sandboxRoot, "outside-lock");
    const canary = join(outsideDirectory, "canary.txt");
    mkdirSync(outsideDirectory);
    writeFileSync(canary, "outside-lock-canary\n");
    let linkCreated = false;
    try {
      symlinkSync(
        outsideDirectory,
        store.layout.lock,
        process.platform === "win32" ? "junction" : "dir",
      );
      linkCreated = true;
    } catch {
      // A restricted Windows host may prohibit creating the junction fixture.
    }
    if (!linkCreated) return;

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(1504, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readFileSync(canary, "utf8")).toBe("outside-lock-canary\n");
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_A))).toBe(false);
  });

  it("retains a hard-linked owner and cleans only its own candidate", () => {
    const { root, store } = temporaryStore();
    const outside = makeSiblingCanary(root);
    const linkedClaim = owner(store, TOKEN_C, 1505);
    const linkedBytes = canonicalRecordBytes("lock-owner", linkedClaim);
    writeFileSync(outside.canary, linkedBytes);
    mkdirSync(store.layout.lock);
    linkSync(outside.canary, join(store.layout.lock, "owner.json"));

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(1506, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readFileSync(outside.canary)).toEqual(linkedBytes);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_A))).toBe(false);
  });

  it.each([
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
  ])("rejects malformed transaction identity %s before token generation", (transactionId) => {
    const { store } = temporaryStore();
    let tokenCalls = 0;
    const invalidRuntime: LockRuntime = Object.freeze({
      pid: 1601,
      randomToken: () => {
        tokenCalls += 1;
        return TOKEN_A;
      },
      pidState: () => "indeterminate",
    });
    lockError(
      () => acquireStoreLockInternal(store, transactionId, invalidRuntime),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(tokenCalls).toBe(0);
    expect(existsSync(store.layout.lockCandidates)).toBe(false);
  });

  it.each([
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
  ])("rejects malformed token identity %s without candidate residue", (token) => {
    const { store } = temporaryStore();
    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(1602, token)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(store.layout.lockCandidates)).toBe(false);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("synthetic PID seam failure");
      },
    ],
    ["returns an unknown state", () => "unknown" as never],
  ] as const)("conservatively holds when PID classification %s", (_label, pidState) => {
    const { store } = temporaryStore();
    const first = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1603, TOKEN_A));
    const contenderRuntime: LockRuntime = Object.freeze({
      pid: 1604,
      randomToken: () => TOKEN_B,
      pidState,
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_B, contenderRuntime),
      "METHODOLOGY_STORE_LOCK_HELD",
    );
    expect(readLiveOwner(store)).toEqual(first);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);
    releaseStoreLock(store, first);
  });

  it.each([
    "alive",
    "indeterminate",
  ] as const)("acquires but retains the exact ABA fence when its PID becomes %s after quarantine", (laterState) => {
    const { store } = temporaryStore();
    acquireStoreLockInternal(store, TRANSACTION_A, runtime(1701, TOKEN_A));
    let oldPidChecks = 0;
    const recoveryRuntime: LockRuntime = Object.freeze({
      pid: 1702,
      randomToken: () => TOKEN_B,
      pidState: (pid) => {
        if (pid !== 1701) return "indeterminate";
        oldPidChecks += 1;
        return oldPidChecks === 1 ? "absent" : laterState;
      },
    });

    const held = acquireStoreLockInternal(store, TRANSACTION_B, recoveryRuntime);
    expect(held).toEqual(owner(store, TOKEN_B, 1702, TRANSACTION_B));
    expect(readLiveOwner(store)).toEqual(held);
    expect(oldPidChecks).toBe(2);
    expect(existsSync(join(store.layout.lockCandidates, `${TOKEN_A}.stale`))).toBe(true);
    releaseStoreLock(store, held);
  });

  it("reaps accumulated exact dead ABA fences across a quiescent takeover", () => {
    const { store } = temporaryStore();
    const oldFence = join(store.layout.lockCandidates, `${TOKEN_A}.stale`);
    const newlyDead = owner(store, TOKEN_B, 1702, TRANSACTION_B);
    writeOwner(store, oldFence, owner(store, TOKEN_A, 1701));
    writeOwner(store, store.layout.lock, newlyDead);

    const held = acquireStoreLockInternal(
      store,
      TRANSACTION_A,
      runtime(
        1703,
        TOKEN_C,
        new Map([
          [1701, "absent"],
          [1702, "absent"],
        ]),
      ),
    );

    expect(held).toEqual(owner(store, TOKEN_C, 1703));
    expect(readLiveOwner(store)).toEqual(held);
    expect(readdirSync(store.layout.lockCandidates)).toEqual([]);
    releaseStoreLock(store, held);
  });

  it("reaps 127 exact dead fences before reserving a dead-lock takeover", () => {
    const { store } = temporaryStore();
    for (let index = 0; index < 127; index += 1) {
      const token = (index + 16).toString(16).padStart(64, "0");
      const pid = 3000 + index;
      writeOwner(
        store,
        join(store.layout.lockCandidates, `${token}.stale`),
        owner(store, token, pid),
      );
    }
    writeOwner(store, store.layout.lock, owner(store, TOKEN_A, 2900));

    const held = acquireStoreLockInternal(
      store,
      TRANSACTION_B,
      Object.freeze({
        pid: 2901,
        randomToken: () => TOKEN_B,
        pidState: () => "absent" as const,
      }),
    );

    expect(held).toEqual(owner(store, TOKEN_B, 2901, TRANSACTION_B));
    expect(readLiveOwner(store)).toEqual(held);
    expect(readdirSync(store.layout.lockCandidates)).toEqual([]);
    releaseStoreLock(store, held);
  });

  it.runIf(process.platform !== "win32")(
    "classifies candidate permission denial as a filesystem failure",
    () => {
      const { store } = temporaryStore();
      mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
      chmodSync(store.layout.lockCandidates, 0o500);
      try {
        lockError(
          () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(1801, TOKEN_A)),
          "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
        );
        expect(existsSync(store.layout.lock)).toBe(false);
        expect(existsSync(join(store.layout.lockCandidates, TOKEN_A))).toBe(false);
      } finally {
        chmodSync(store.layout.lockCandidates, 0o700);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "classifies an unreadable candidate inventory as a filesystem failure",
    () => {
      const { store } = temporaryStore();
      mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
      chmodSync(store.layout.lockCandidates, 0o300);
      try {
        lockError(
          () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(1806, TOKEN_A)),
          "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
        );
        expect(existsSync(store.layout.lock)).toBe(false);
        expect(existsSync(join(store.layout.lockCandidates, TOKEN_A))).toBe(false);
      } finally {
        chmodSync(store.layout.lockCandidates, 0o700);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans its contender when the live claim directory is unreadable",
    () => {
      const { store } = temporaryStore();
      const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1807, TOKEN_A));
      chmodSync(store.layout.lock, 0o300);
      try {
        lockError(
          () => acquireStoreLockInternal(store, TRANSACTION_B, runtime(1808, TOKEN_B)),
          "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
        );
        expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);
      } finally {
        chmodSync(store.layout.lock, 0o700);
      }
      expect(readLiveOwner(store)).toEqual(held);
      releaseStoreLock(store, held);
    },
  );

  it("cleans its contender when a dead lock disappears before quarantine", () => {
    const { store } = temporaryStore();
    const dead = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1809, TOKEN_A));
    let removed = false;
    const disappearingRuntime: LockRuntime = Object.freeze({
      pid: 1810,
      randomToken: () => TOKEN_B,
      pidState: (pid) => {
        expect(pid).toBe(dead.pid);
        rmSync(store.layout.lock, { recursive: true });
        removed = true;
        return "absent";
      },
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_B, disappearingRuntime),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(removed).toBe(true);
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "retains an exact interrupted release after permission drift and completes on retry",
    () => {
      const { store } = temporaryStore();
      const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1811, TOKEN_A));
      const interrupted = join(store.layout.lockCandidates, TOKEN_A);
      renameSync(store.layout.lock, interrupted);
      chmodSync(interrupted, 0o500);
      try {
        lockError(() => releaseStoreLock(store, held), "METHODOLOGY_STORE_LOCK_INVALID");
        expect(existsSync(store.layout.lock)).toBe(false);
        expect(existsSync(interrupted)).toBe(true);
        expect(readFileSync(join(interrupted, "owner.json"))).toEqual(
          canonicalRecordBytes("lock-owner", held),
        );
      } finally {
        if (existsSync(interrupted)) chmodSync(interrupted, 0o700);
      }

      releaseStoreLock(store, held);
      expect(existsSync(interrupted)).toBe(false);
      expect(existsSync(store.layout.lock)).toBe(false);
    },
  );

  it("retains a token-mismatched interrupted release candidate", () => {
    const { store } = temporaryStore();
    const interrupted = join(store.layout.lockCandidates, TOKEN_A);
    writeOwner(store, interrupted, owner(store, TOKEN_B, 1802));
    const expectedClaim = Object.freeze(owner(store, TOKEN_A, 1802));

    lockError(() => releaseStoreLock(store, expectedClaim), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(existsSync(interrupted)).toBe(true);
    expect(readFileSync(join(interrupted, "owner.json"))).toEqual(
      canonicalRecordBytes("lock-owner", owner(store, TOKEN_B, 1802)),
    );
  });

  it("rechecks capacity before dead-lock quarantine and cleans only its contender", () => {
    const { store } = temporaryStore();
    const dead = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1803, TOKEN_A));
    for (let index = 0; index < 127; index += 1) {
      mkdirSync(join(store.layout.lockCandidates, index.toString(16).padStart(64, "0")));
    }

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_B,
          runtime(1804, TOKEN_B, new Map([[1803, "absent"]])),
        ),
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
    expect(readLiveOwner(store)).toEqual(dead);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);
    expect(readdirSync(store.layout.lockCandidates)).toHaveLength(127);
    releaseStoreLock(store, dead);
  });

  it.runIf(process.platform !== "win32")(
    "fails before publication when root permissions drift",
    () => {
      const { store } = temporaryStore();
      mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
      let restricted = false;
      const durabilityFailureRuntime: LockRuntime = Object.freeze({
        pid: 1805,
        randomToken: () => {
          chmodSync(store.layout.root, 0o300);
          restricted = true;
          return TOKEN_A;
        },
        pidState: () => "indeterminate",
      });
      try {
        lockError(
          () => acquireStoreLockInternal(store, TRANSACTION_A, durabilityFailureRuntime),
          "METHODOLOGY_STORE_PATH_UNSAFE",
        );
      } finally {
        if (restricted) chmodSync(store.layout.root, 0o700);
      }
      expect(existsSync(store.layout.lock)).toBe(false);
      expect(existsSync(join(store.layout.lockCandidates, TOKEN_A))).toBe(false);
    },
  );

  it("keeps a dead-owner fence so a paused contender cannot displace the winner", () => {
    const { store } = temporaryStore();
    acquireStoreLockInternal(store, TRANSACTION_A, runtime(1901, TOKEN_A));
    let winner: HeldStoreLock | undefined;
    let nested = false;
    const pausedRuntime: LockRuntime = Object.freeze({
      pid: 1903,
      randomToken: () => TOKEN_C,
      pidState: (pid) => {
        if (pid === 1901 && !nested) {
          nested = true;
          winner = acquireStoreLockInternal(
            store,
            TRANSACTION_B,
            runtime(1902, TOKEN_B, new Map([[1901, "absent"]])),
          );
          return "absent";
        }
        return "indeterminate";
      },
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_B, pausedRuntime),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(winner).toEqual(owner(store, TOKEN_B, 1902, TRANSACTION_B));
    expect(readLiveOwner(store)).toEqual(winner);
    expect(existsSync(join(store.layout.lockCandidates, `${TOKEN_A}.stale`))).toBe(true);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_C))).toBe(false);
    releaseStoreLock(store, winner as HeldStoreLock);
  });

  it("retains an ambiguous empty candidate while a different token acquires", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const emptyCandidate = join(store.layout.lockCandidates, TOKEN_A);
    mkdirSync(emptyCandidate, { mode: 0o700 });

    const held = acquireStoreLockInternal(store, TRANSACTION_B, runtime(2001, TOKEN_B));
    expect(readLiveOwner(store)).toEqual(held);
    expect(readdirSync(emptyCandidate)).toEqual([]);
    releaseStoreLock(store, held);
    expect(existsSync(emptyCandidate)).toBe(true);
  });

  it("fails closed without changing a live lock when 128 candidates prevent release", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(2002, TOKEN_A));
    for (let index = 0; index < 128; index += 1) {
      mkdirSync(join(store.layout.lockCandidates, index.toString(16).padStart(64, "0")));
    }

    lockError(() => releaseStoreLock(store, held), "METHODOLOGY_STORE_RESOURCE_LIMIT");
    expect(readLiveOwner(store)).toEqual(held);
    expect(readdirSync(store.layout.lockCandidates)).toHaveLength(128);
  });

  it("refuses token reuse while its stale ABA fence exists", () => {
    const { store } = temporaryStore();
    const fence = join(store.layout.lockCandidates, `${TOKEN_A}.stale`);
    writeOwner(store, fence, owner(store, TOKEN_A, 2003));

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_B, runtime(2004, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(fence)).toBe(true);
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_A))).toBe(false);
  });

  it("uses production PID liveness for both a live owner and a reaped owner", () => {
    const live = temporaryStore();
    const liveClaim = acquireStoreLockInternal(
      live.store,
      TRANSACTION_A,
      runtime(process.pid, TOKEN_A),
    );
    lockError(() => acquireStoreLock(live.store, TRANSACTION_B), "METHODOLOGY_STORE_LOCK_HELD");
    expect(readLiveOwner(live.store)).toEqual(liveClaim);
    releaseStoreLock(live.store, liveClaim);

    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.status).toBe(0);
    expect(child.pid).toBeTypeOf("number");
    const reaped = temporaryStore();
    acquireStoreLockInternal(reaped.store, TRANSACTION_A, runtime(child.pid as number, TOKEN_A));
    const recovered = acquireStoreLock(reaped.store, TRANSACTION_B);
    expect(recovered.pid).toBe(process.pid);
    expect(readLiveOwner(reaped.store)).toEqual(recovered);
    releaseStoreLock(reaped.store, recovered);
  });

  it("rejects invalid and absent release claims without filesystem mutation", () => {
    const { store } = temporaryStore();
    const invalid = Object.freeze({ ...owner(store, TOKEN_A, 1), pid: 0 }) as HeldStoreLock;
    lockError(() => releaseStoreLock(store, invalid), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(existsSync(store.layout.lockCandidates)).toBe(false);

    const absent = Object.freeze(owner(store, TOKEN_A, 2101));
    lockError(() => releaseStoreLock(store, absent), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(readdirSync(store.layout.lockCandidates)).toEqual([]);
  });

  it("retains a same-token interrupted release candidate with a different owner", () => {
    const { store } = temporaryStore();
    const interrupted = join(store.layout.lockCandidates, TOKEN_A);
    writeOwner(store, interrupted, owner(store, TOKEN_A, 2102, TRANSACTION_B));
    const expectedClaim = Object.freeze(owner(store, TOKEN_A, 2103, TRANSACTION_A));

    lockError(() => releaseStoreLock(store, expectedClaim), "METHODOLOGY_STORE_LOCK_INVALID");
    expect(existsSync(interrupted)).toBe(true);
    expect(readFileSync(join(interrupted, "owner.json"))).toEqual(
      canonicalRecordBytes("lock-owner", owner(store, TOKEN_A, 2102, TRANSACTION_B)),
    );
  });

  it("retains a pre-existing exact candidate on token collision", () => {
    const { store } = temporaryStore();
    const collisionRuntime: LockRuntime = Object.freeze({
      pid: 2104,
      randomToken: () => {
        mkdirSync(join(store.layout.lockCandidates, TOKEN_A), { recursive: true });
        return TOKEN_A;
      },
      pidState: () => "indeterminate",
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, collisionRuntime),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readdirSync(join(store.layout.lockCandidates, TOKEN_A))).toEqual([]);
    expect(existsSync(store.layout.lock)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "classifies unsafe root permissions before lock-candidate creation",
    () => {
      const { store } = temporaryStore();
      chmodSync(store.layout.root, 0o500);
      try {
        lockError(
          () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2105, TOKEN_A)),
          "METHODOLOGY_STORE_PATH_UNSAFE",
        );
        expect(existsSync(store.layout.lockCandidates)).toBe(false);
        expect(existsSync(store.layout.lock)).toBe(false);
      } finally {
        chmodSync(store.layout.root, 0o700);
      }
    },
  );

  it.each([
    ["inaccessible identity", "lstat"],
    ["inaccessible realpath", "realpath"],
    ["an outside realpath", "outside"],
  ] as const)("fails closed on a pending candidate with %s", (_label, fault) => {
    const { root, store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const pending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.2201`);

    if (fault === "lstat") {
      injectFsFault({
        lstatSync: ((...args: unknown[]) => {
          if (String(args[0]) === pending) throw syntheticFsError("EACCES");
          return Reflect.apply(originalFs.lstatSync, mutableFs, args);
        }) as typeof originalFs.lstatSync,
      });
    } else {
      injectFsFault({
        realpathSync: ((...args: unknown[]) => {
          if (String(args[0]) === pending) {
            if (fault === "realpath") throw syntheticFsError("EACCES");
            return join(root.sandboxRoot, "outside-pending");
          }
          return Reflect.apply(originalFs.realpathSync, mutableFs, args);
        }) as typeof originalFs.realpathSync,
      });
    }

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2201, TOKEN_A)),
      fault === "outside"
        ? "METHODOLOGY_STORE_LOCK_INVALID"
        : "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(pending)).toBe(true);
  });

  it("reports lock-directory sync and close failures without publishing", () => {
    const syncFailure = temporaryStore();
    mkdirSync(syncFailure.store.layout.lockCandidates, { mode: 0o700 });
    let candidateDirectoryDescriptor: number | undefined;
    let injectedSyncFailure = false;
    injectFsFault({
      openSync: ((...args: unknown[]) => {
        const descriptor = Reflect.apply(originalFs.openSync, mutableFs, args) as number;
        if (String(args[0]) === syncFailure.store.layout.lockCandidates) {
          candidateDirectoryDescriptor = descriptor;
        }
        return descriptor;
      }) as typeof originalFs.openSync,
      fsyncSync: ((descriptor: number) => {
        if (descriptor === candidateDirectoryDescriptor && !injectedSyncFailure) {
          injectedSyncFailure = true;
          throw syntheticFsError("EIO");
        }
        return originalFs.fsyncSync(descriptor);
      }) as typeof originalFs.fsyncSync,
    });

    lockError(
      () => acquireStoreLockInternal(syncFailure.store, TRANSACTION_A, runtime(2202, TOKEN_A)),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(injectedSyncFailure).toBe(true);
    expect(existsSync(syncFailure.store.layout.lock)).toBe(false);
    expect(readdirSync(syncFailure.store.layout.lockCandidates)).toEqual([]);

    restoreFs();
    const closeFailure = temporaryStore();
    let rootDescriptor: number | undefined;
    let injectedCloseFailure = false;
    injectFsFault({
      openSync: ((...args: unknown[]) => {
        const descriptor = Reflect.apply(originalFs.openSync, mutableFs, args) as number;
        if (String(args[0]) === closeFailure.store.layout.root) rootDescriptor = descriptor;
        return descriptor;
      }) as typeof originalFs.openSync,
      closeSync: ((descriptor: number) => {
        if (descriptor === rootDescriptor && !injectedCloseFailure) {
          injectedCloseFailure = true;
          originalFs.closeSync(descriptor);
          throw syntheticFsError("EIO");
        }
        return originalFs.closeSync(descriptor);
      }) as typeof originalFs.closeSync,
    });

    lockError(
      () => acquireStoreLockInternal(closeFailure.store, TRANSACTION_A, runtime(2203, TOKEN_B)),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(injectedCloseFailure).toBe(true);
    expect(existsSync(closeFailure.store.layout.lock)).toBe(false);
  });

  it.each([
    ["read", "readSync"],
    ["close", "closeSync"],
  ] as const)("classifies candidate-inventory %s failure", (_label, operation) => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    injectDirectoryStreamFault(store.layout.lockCandidates, operation);

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2204, TOKEN_A)),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(existsSync(store.layout.lock)).toBe(false);
  });

  it.each([
    ["read", "readSync"],
    ["close", "closeSync"],
  ] as const)("classifies live-claim inventory %s failure and cleans its contender", (_label, operation) => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(2205, TOKEN_A));
    injectDirectoryStreamFault(store.layout.lock, operation);

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_B, runtime(2206, TOKEN_B)),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(existsSync(join(store.layout.lockCandidates, TOKEN_B))).toBe(false);
    restoreFs();
    expect(readLiveOwner(store)).toEqual(held);
    releaseStoreLock(store, held);
  });

  it("rejects non-private and non-regular dead pending candidates without deleting them", () => {
    const nonPrivate = temporaryStore();
    mkdirSync(nonPrivate.store.layout.lockCandidates, { mode: 0o700 });
    const nonPrivatePending = join(
      nonPrivate.store.layout.lockCandidates,
      `${TOKEN_A}.pending.2207`,
    );
    mkdirSync(nonPrivatePending, { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(nonPrivatePending, 0o755);

    if (process.platform !== "win32") {
      lockError(
        () =>
          acquireStoreLockInternal(
            nonPrivate.store,
            TRANSACTION_A,
            runtime(2208, TOKEN_B, new Map([[2207, "absent"]])),
          ),
        "METHODOLOGY_STORE_LOCK_INVALID",
      );
      expect(existsSync(nonPrivatePending)).toBe(true);
    }

    const linkedOwner = temporaryStore();
    mkdirSync(linkedOwner.store.layout.lockCandidates, { mode: 0o700 });
    const linkedPending = join(linkedOwner.store.layout.lockCandidates, `${TOKEN_C}.pending.2209`);
    mkdirSync(linkedPending, { mode: 0o700 });
    const outside = makeSiblingCanary(linkedOwner.root);
    linkSync(outside.canary, join(linkedPending, "owner.json"));

    lockError(
      () =>
        acquireStoreLockInternal(
          linkedOwner.store,
          TRANSACTION_A,
          runtime(2210, TOKEN_D, new Map([[2209, "absent"]])),
        ),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
    expect(existsSync(linkedPending)).toBe(true);
  });

  it.each([
    "unlink",
    "rmdir",
  ] as const)("retains a dead pending candidate when exact %s fails", (operation) => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const pending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.2211`);
    mkdirSync(pending, { mode: 0o700 });
    const ownerPath = join(pending, "owner.json");
    if (operation === "unlink") writeFileSync(ownerPath, "torn", { mode: 0o600 });

    injectFsFault(
      operation === "unlink"
        ? {
            unlinkSync: ((...args: unknown[]) => {
              if (String(args[0]) === ownerPath) throw syntheticFsError("EACCES");
              return Reflect.apply(originalFs.unlinkSync, mutableFs, args);
            }) as typeof originalFs.unlinkSync,
          }
        : {
            rmdirSync: ((...args: unknown[]) => {
              if (String(args[0]) === pending) throw syntheticFsError("EACCES");
              return Reflect.apply(originalFs.rmdirSync, mutableFs, args);
            }) as typeof originalFs.rmdirSync,
          },
    );

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_A,
          runtime(2212, TOKEN_B, new Map([[2211, "absent"]])),
        ),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(existsSync(pending)).toBe(true);
  });

  it("detects a pending-candidate identity change before removal", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const pending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.2213`);
    mkdirSync(pending, { mode: 0o700 });
    let pendingStats = 0;
    injectFsFault({
      lstatSync: ((...args: unknown[]) => {
        const stats = Reflect.apply(originalFs.lstatSync, mutableFs, args);
        if (String(args[0]) !== pending) return stats;
        pendingStats += 1;
        if (pendingStats !== 3) return stats;
        return new Proxy(stats, {
          get(target, property) {
            if (property === "ino") return target.ino + 1n;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof originalFs.lstatSync,
    });

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_A,
          runtime(2214, TOKEN_B, new Map([[2213, "absent"]])),
        ),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(pendingStats).toBe(3);
    expect(existsSync(pending)).toBe(true);
  });

  it("propagates a filesystem failure from an ambiguous complete candidate", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const candidate = join(store.layout.lockCandidates, TOKEN_A);
    mkdirSync(candidate, { mode: 0o700 });
    injectFsFault({
      opendirSync: ((...args: unknown[]) => {
        if (String(args[0]) === candidate) throw syntheticFsError("EACCES");
        return Reflect.apply(originalFs.opendirSync, mutableFs, args);
      }) as typeof originalFs.opendirSync,
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2215, TOKEN_B)),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(existsSync(candidate)).toBe(true);
  });

  it("retains a live PID-bound pending candidate and rejects its exact-name collision", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const pending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.2216`);
    mkdirSync(pending, { mode: 0o700 });

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_A,
          runtime(2216, TOKEN_A, new Map([[2216, "alive"]])),
        ),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(existsSync(pending)).toBe(true);
    expect(existsSync(store.layout.lock)).toBe(false);
  });

  it("removes a bounded pending candidate after an unexpected owner-write failure", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    const pending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.2217`);
    const ownerPath = join(pending, "owner.json");
    injectFsFault({
      openSync: ((...args: unknown[]) => {
        if (String(args[0]) === ownerPath) throw new Error("synthetic owner-write failure");
        return Reflect.apply(originalFs.openSync, mutableFs, args);
      }) as typeof originalFs.openSync,
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2217, TOKEN_A)),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(store.layout.lock)).toBe(false);
  });

  it("rolls back an exact publication when rename completion is reported as uncertain", () => {
    const { store } = temporaryStore();
    const candidate = join(store.layout.lockCandidates, TOKEN_A);
    let injected = false;
    injectFsFault({
      renameSync: ((...args: unknown[]) => {
        if (!injected && String(args[0]) === candidate && String(args[1]) === store.layout.lock) {
          Reflect.apply(originalFs.renameSync, mutableFs, args);
          injected = true;
          throw new Error("synthetic post-rename uncertainty");
        }
        return Reflect.apply(originalFs.renameSync, mutableFs, args);
      }) as typeof originalFs.renameSync,
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2301, TOKEN_A)),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(injected).toBe(true);
    expect(existsSync(store.layout.lock)).toBe(false);
    expect(existsSync(candidate)).toBe(false);
  });

  it("cleans its candidate when the claim destination becomes malformed", () => {
    const { store } = temporaryStore();
    const candidate = join(store.layout.lockCandidates, TOKEN_A);
    let injected = false;
    injectFsFault({
      renameSync: ((...args: unknown[]) => {
        if (!injected && String(args[0]) === candidate && String(args[1]) === store.layout.lock) {
          mkdirSync(store.layout.lock, { mode: 0o700 });
          injected = true;
          throw syntheticFsError("EEXIST");
        }
        return Reflect.apply(originalFs.renameSync, mutableFs, args);
      }) as typeof originalFs.renameSync,
    });

    lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2302, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(injected).toBe(true);
    expect(readdirSync(store.layout.lock)).toEqual([]);
    expect(existsSync(candidate)).toBe(false);
  });

  it.each([
    ["held", "alive"],
    ["dead", "absent"],
  ] as const)("does not displace a different %s claim that wins publication", (_label, state) => {
    const { store } = temporaryStore();
    const candidate = join(store.layout.lockCandidates, TOKEN_A);
    const winner = Object.freeze(owner(store, TOKEN_C, 2304, TRANSACTION_B));
    let injected = false;
    injectFsFault({
      renameSync: ((...args: unknown[]) => {
        if (!injected && String(args[0]) === candidate && String(args[1]) === store.layout.lock) {
          writeOwner(store, store.layout.lock, winner);
          injected = true;
          throw syntheticFsError("EEXIST");
        }
        return Reflect.apply(originalFs.renameSync, mutableFs, args);
      }) as typeof originalFs.renameSync,
    });

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_A,
          runtime(2303, TOKEN_A, new Map([[winner.pid, state]])),
        ),
      state === "alive" ? "METHODOLOGY_STORE_LOCK_HELD" : "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(injected).toBe(true);
    expect(readLiveOwner(store)).toEqual(winner);
    expect(existsSync(candidate)).toBe(false);

    restoreFs();
    releaseStoreLock(store, winner);
  });

  it("retains both exact objects when a moved candidate changes identity", () => {
    const { store } = temporaryStore();
    const pending = join(store.layout.lockCandidates, `${TOKEN_A}.pending.2305`);
    const candidate = join(store.layout.lockCandidates, TOKEN_A);
    const parked = join(store.layout.trash, TOKEN_F);
    const expected = Object.freeze(owner(store, TOKEN_A, 2305));
    mkdirSync(store.layout.trash, { recursive: true, mode: 0o700 });
    let injected = false;
    injectFsFault({
      renameSync: ((...args: unknown[]) => {
        if (!injected && String(args[0]) === pending && String(args[1]) === candidate) {
          Reflect.apply(originalFs.renameSync, mutableFs, args);
          originalFs.renameSync(candidate, parked);
          writeOwner(store, candidate, expected);
          injected = true;
          return;
        }
        return Reflect.apply(originalFs.renameSync, mutableFs, args);
      }) as typeof originalFs.renameSync,
    });

    const failure = lockError(
      () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2305, TOKEN_A)),
      "METHODOLOGY_STORE_LOCK_INVALID",
    );
    expect(failure.message).toBe("renamed claim changed identity");
    expect(injected).toBe(true);
    expect(existsSync(candidate)).toBe(true);
    expect(existsSync(parked)).toBe(true);
    expect(existsSync(store.layout.lock)).toBe(false);
  });

  it("retains and later reaps a PID-bound deleting contender when exact cleanup fails", () => {
    const { store } = temporaryStore();
    const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(2306, TOKEN_A));
    const contender = join(store.layout.lockCandidates, TOKEN_B);
    const deleting = join(store.layout.lockCandidates, `${TOKEN_B}.deleting.2307`);
    const deletingOwner = join(deleting, "owner.json");
    injectFsFault({
      unlinkSync: ((...args: unknown[]) => {
        if (String(args[0]) === deletingOwner) throw syntheticFsError("EACCES");
        return Reflect.apply(originalFs.unlinkSync, mutableFs, args);
      }) as typeof originalFs.unlinkSync,
    });

    lockError(
      () =>
        acquireStoreLockInternal(
          store,
          TRANSACTION_B,
          runtime(2307, TOKEN_B, new Map([[held.pid, "alive"]])),
        ),
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    );
    expect(existsSync(contender)).toBe(false);
    expect(readFileSync(deletingOwner)).toEqual(
      canonicalRecordBytes("lock-owner", owner(store, TOKEN_B, 2307, TRANSACTION_B)),
    );

    restoreFs();
    expect(readLiveOwner(store)).toEqual(held);
    releaseStoreLock(store, held);
    const next = acquireStoreLockInternal(
      store,
      TRANSACTION_A,
      runtime(2308, TOKEN_C, new Map([[2307, "absent"]])),
    );
    expect(existsSync(deleting)).toBe(false);
    releaseStoreLock(store, next);
  });
});
