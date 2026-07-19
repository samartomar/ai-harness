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
    expect(storeError.findingCode).toBe(findingCode);
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
  for (const root of roots.splice(0)) {
    rmSync(root.sandboxRoot, { recursive: true, force: true });
  }
});

describe("Phase 4 cooperative generation-store lock", () => {
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

  it("retains every unrelated pre-existing stale candidate", () => {
    const { store } = temporaryStore();
    mkdirSync(store.layout.lockCandidates);
    const dead = owner(store, TOKEN_C, 1201);
    const live = owner(store, TOKEN_D, 1202);
    writeOwner(store, join(store.layout.lockCandidates, `${TOKEN_C}.stale`), dead);
    writeOwner(store, join(store.layout.lockCandidates, `${TOKEN_D}.stale`), live);

    const mismatchedPath = join(store.layout.lockCandidates, `${TOKEN_E}.stale`);
    mkdirSync(mismatchedPath);
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
    expect(existsSync(join(store.layout.lockCandidates, `${TOKEN_C}.stale`))).toBe(true);
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
    "retains an exact interrupted release after removal denial and completes on retry",
    () => {
      const { store } = temporaryStore();
      const held = acquireStoreLockInternal(store, TRANSACTION_A, runtime(1811, TOKEN_A));
      const interrupted = join(store.layout.lockCandidates, TOKEN_A);
      renameSync(store.layout.lock, interrupted);
      chmodSync(interrupted, 0o500);
      try {
        const denied = lockError(
          () => releaseStoreLock(store, held),
          "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
        );
        expect(denied.message).toBe("exact claim removal failed");
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
    "rolls back its exact publication when post-rename durability fails",
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
          "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
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
    mkdirSync(store.layout.lockCandidates);
    const emptyCandidate = join(store.layout.lockCandidates, TOKEN_A);
    mkdirSync(emptyCandidate);

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
      timeout: 5_000,
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
    "classifies lock-candidate container creation denial as a filesystem failure",
    () => {
      const { store } = temporaryStore();
      chmodSync(store.layout.root, 0o500);
      try {
        lockError(
          () => acquireStoreLockInternal(store, TRANSACTION_A, runtime(2105, TOKEN_A)),
          "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
        );
        expect(existsSync(store.layout.lockCandidates)).toBe(false);
        expect(existsSync(store.layout.lock)).toBe(false);
      } finally {
        chmodSync(store.layout.root, 0o700);
      }
    },
  );
});
