import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as generationStoreModule from "../../src/methodology/generation-store.js";
import {
  type ActivationRecord,
  ActivationRecordSchema,
  type ApplyProjectionResult,
  canonicalRecordBytes,
  GENERATION_STORE_MUTATION_BOUNDARY,
  GENERATION_STORE_READ_BOUNDARY,
  type GenerationReceipt,
  type ProjectionInspectionResult,
  sha256Bytes,
  type TransactionRecord,
} from "../../src/methodology/generation-store-contract.js";
import {
  createOrOpenOwnedStore,
  inspectFixedStoreLayout,
  readStoreRecord,
} from "../../src/methodology/generation-store-fs.js";
import type { LockRuntime } from "../../src/methodology/generation-store-lock.js";
import {
  aggregateOverflowPayloadFixture,
  alternatePayloadFixture,
  alternatePlannedFixture,
  binaryPayloadFixture,
  binaryPlannedFixture,
  blockedFixture,
  collisionBlockedFixture,
  expectedReceiptEntries,
  makeSiblingCanary,
  makeTemporaryProject,
  payloadFixture,
  plannedFixture,
  plannedPayloadSet,
  type TemporaryProject,
} from "./generation-store-fixtures.js";

const {
  assessStableStoreSnapshot,
  inspectOwnedGeneration,
  inspectProjectionStore,
  verifyStableEmptySnapshot,
  verifyStableProjectionSnapshot,
} = generationStoreModule;
const OTHER_DIGEST = "b".repeat(64);
const TRANSACTION_ID = "d".repeat(64);
const LOCK_TOKEN = "a".repeat(64);
const FIXED_ROOT_ID = "f".repeat(64);
const roots: TemporaryProject[] = [];
const ORIGINAL_UMASK = process.platform === "win32" ? undefined : process.umask();

beforeAll(() => {
  if (ORIGINAL_UMASK !== undefined) process.umask(0o077);
});

afterAll(() => {
  if (ORIGINAL_UMASK !== undefined) process.umask(ORIGINAL_UMASK);
});

type ApplyProjectionFunction = (value: unknown) => ApplyProjectionResult;
type ApplyFaultPoint =
  | "after-journal-prepared"
  | "after-stage-created"
  | "after-stage-verified"
  | "after-generation-reserved"
  | "after-generation-content"
  | "after-receipt-written"
  | "before-activation-rename"
  | "after-activation-rename"
  | "after-journal-committed";
type ApplyRuntime = Readonly<{
  onFaultPoint: (point: ApplyFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;
type ApplyProjectionWithRuntimeFunction = (
  value: unknown,
  runtime: ApplyRuntime,
) => ApplyProjectionResult;

function applyProjection(value: unknown): ApplyProjectionResult {
  const implementation = (
    generationStoreModule as unknown as { applyProjection?: ApplyProjectionFunction }
  ).applyProjection;
  if (implementation === undefined) throw new Error("applyProjection is not implemented");
  return implementation(value);
}

function applyProjectionWithRuntime(value: unknown, runtime: ApplyRuntime): ApplyProjectionResult {
  const implementation = (
    generationStoreModule as unknown as {
      applyProjectionWithRuntime?: ApplyProjectionWithRuntimeFunction;
    }
  ).applyProjectionWithRuntime;
  if (implementation === undefined) {
    throw new Error("applyProjectionWithRuntime is not implemented");
  }
  return implementation(value, runtime);
}

type MaterializedStore = Readonly<{
  root: TemporaryProject;
  store: ReturnType<typeof createOrOpenOwnedStore>;
  manifestDigest: string;
  generationRoot: string;
  contentRoot: string;
  receipt: GenerationReceipt;
  receiptBytes: Buffer;
  activation: ActivationRecord;
}>;

function temporaryProject(): TemporaryProject {
  const root = makeTemporaryProject();
  roots.push(root);
  return root;
}

function writeCanonical(path: string, kind: "activation" | "receipt", record: unknown): void {
  writeFileSync(path, canonicalRecordBytes(kind, record), { mode: 0o600 });
}

function tryCreateFileSymlink(source: string, target: string): boolean {
  try {
    symlinkSync(source, target, "file");
    return true;
  } catch {
    return false;
  }
}

function tryCreateHardLink(source: string, target: string): boolean {
  try {
    linkSync(source, target);
    return true;
  } catch {
    return false;
  }
}

function writeExpectedContent(contentRoot: string): void {
  const payloadById = new Map(
    payloadFixture().map((payload) => [payload.artifactId, payload.bytes] as const),
  );
  for (const entry of expectedReceiptEntries()) {
    const bytes = payloadById.get(entry.artifactId);
    if (bytes === undefined) throw new Error("fixture payload is missing");
    const target = join(contentRoot, ...entry.target.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
}

function materializeActiveStore(): MaterializedStore {
  const root = temporaryProject();
  const store = createOrOpenOwnedStore(root.projectRoot);
  const entries = expectedReceiptEntries();
  const plan = plannedFixture();
  if (plan.state !== "planned") throw new Error("fixture must plan");
  const manifestDigest = plan.manifest.digest;
  const generationRoot = join(store.layout.generations, manifestDigest);
  const contentRoot = join(generationRoot, "content");
  mkdirSync(contentRoot, { recursive: true, mode: 0o700 });
  writeExpectedContent(contentRoot);
  const receipt: GenerationReceipt = {
    schemaVersion: 1,
    rootId: store.rootRecord.rootId,
    manifestDigest,
    entries,
  };
  const receiptBytes = canonicalRecordBytes("receipt", receipt);
  writeFileSync(join(generationRoot, "receipt.json"), receiptBytes, { mode: 0o600 });
  const activation: ActivationRecord = {
    schemaVersion: 1,
    manifestDigest,
    receiptDigest: sha256Bytes(receiptBytes),
    generation: `generations/${manifestDigest}/content`,
  };
  writeCanonical(store.layout.active, "activation", activation);
  return Object.freeze({
    root,
    store,
    manifestDigest,
    generationRoot,
    contentRoot,
    receipt,
    receiptBytes,
    activation,
  });
}

function materializeInactiveGeneration(fixture: MaterializedStore, manifestDigest: string): void {
  const generationRoot = join(fixture.store.layout.generations, manifestDigest);
  const contentRoot = join(generationRoot, "content");
  mkdirSync(contentRoot, { recursive: true, mode: 0o700 });
  writeExpectedContent(contentRoot);
  const receipt: GenerationReceipt = {
    schemaVersion: 1,
    rootId: fixture.store.rootRecord.rootId,
    manifestDigest,
    entries: expectedReceiptEntries(),
  };
  writeCanonical(join(generationRoot, "receipt.json"), "receipt", receipt);
}

function expectBoundary(result: ProjectionInspectionResult): void {
  expect(result.boundary).toEqual(GENERATION_STORE_READ_BOUNDARY);
  expect(result.boundary).toEqual({
    providerRead: false,
    providerExecution: false,
    hostExecution: false,
    network: false,
    packageManager: false,
    cli: false,
    writeCapability: "none",
  });
}

function expectInspection(
  result: ProjectionInspectionResult,
  state: ProjectionInspectionResult["state"],
  activeDigest: string | null,
  findingCode?: string,
): void {
  expect(result.state).toBe(state);
  expect(result.activeDigest).toBe(activeDigest);
  if (findingCode === undefined) {
    expect(result.findings).toEqual([]);
  } else {
    expect(result.findings.map(({ code }) => code)).toContain(findingCode);
  }
  expectBoundary(result);
}

function treeMtimes(root: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  const visit = (path: string, relativePath: string): void => {
    const stats = lstatSync(path, { bigint: true });
    values[relativePath] = stats.mtimeNs.toString(10);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath === "" ? name : `${relativePath}/${name}`);
    }
  };
  visit(root, "");
  return Object.freeze(values);
}

function applyInput(
  projectRoot: string,
  plan: unknown,
  payloads: readonly unknown[],
  expectedActiveDigest: string | null,
) {
  return {
    mode: "apply" as const,
    projectRoot,
    plan,
    payloads,
    expectedActiveDigest,
  };
}

function expectApply(
  result: ApplyProjectionResult,
  state: ApplyProjectionResult["state"],
  previousActiveDigest: string | null,
  activeDigest: string | null,
  findingCode?: string,
): void {
  expect(result.state).toBe(state);
  expect(result.previousActiveDigest).toBe(previousActiveDigest);
  expect(result.activeDigest).toBe(activeDigest);
  if (findingCode === undefined) {
    expect(result.findings).toEqual([]);
  } else {
    expect(result.findings.map(({ code }) => code)).toContain(findingCode);
  }
  expect(result.boundary).toBe(GENERATION_STORE_MUTATION_BOUNDARY);
  expect(result.boundary).toEqual({
    providerRead: false,
    providerExecution: false,
    hostExecution: false,
    network: false,
    packageManager: false,
    cli: false,
    writeCapability: "aih-owned-project-root",
  });
}

function requirePlanned<T extends { state: string }>(plan: T): Extract<T, { state: "planned" }> {
  if (plan.state !== "planned") throw new Error("fixture must produce a planned projection");
  return plan as Extract<T, { state: "planned" }>;
}

function deterministicTreeSnapshot(root: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  const visit = (path: string, relativePath: string): void => {
    const stats = lstatSync(path, { bigint: true });
    const mode = Number(stats.mode & 0o777n).toString(8);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      values[relativePath] = `directory:${mode}`;
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath === "" ? name : `${relativePath}/${name}`);
      }
      return;
    }
    values[relativePath] = `file:${mode}:${readFileSync(path).toString("hex")}`;
  };
  visit(root, "");
  return Object.freeze(values);
}

function identityTreeSnapshot(root: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  const visit = (path: string, relativePath: string): void => {
    const stats = lstatSync(path, { bigint: true });
    const identity = [
      stats.dev,
      stats.ino,
      stats.mode,
      stats.nlink,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ]
      .map(String)
      .join(":");
    values[relativePath] = stats.isFile()
      ? `${identity}:${readFileSync(path).toString("hex")}`
      : identity;
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath === "" ? name : `${relativePath}/${name}`);
    }
  };
  visit(root, "");
  return Object.freeze(values);
}

function namesIfPresent(path: string): readonly string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}

function fixOwnedRootId(root: TemporaryProject): ReturnType<typeof createOrOpenOwnedStore> {
  const store = createOrOpenOwnedStore(root.projectRoot);
  writeFileSync(
    store.layout.rootRecord,
    canonicalRecordBytes("root", {
      schemaVersion: 1,
      rootId: FIXED_ROOT_ID,
      rootDevice: store.layout.projectDevice,
    }),
    { mode: 0o600 },
  );
  return createOrOpenOwnedStore(root.projectRoot);
}

function readActivation(
  store: ReturnType<typeof createOrOpenOwnedStore>,
): Readonly<{ record: ActivationRecord; bytes: Buffer }> {
  const read = readStoreRecord(store, store.layout.active, ActivationRecordSchema, "activation");
  return Object.freeze({ record: read.record, bytes: Buffer.from(read.bytes) });
}

function writePendingTransaction(fixture: MaterializedStore, operation: "apply" | "clean"): string {
  mkdirSync(fixture.store.layout.transactions, { recursive: true, mode: 0o700 });
  const record: TransactionRecord =
    operation === "apply"
      ? {
          schemaVersion: 1,
          operation: "apply",
          rootId: fixture.store.rootRecord.rootId,
          transactionId: TRANSACTION_ID,
          phase: "committed",
          manifestDigest: fixture.manifestDigest,
          oldActivation: null,
          newActivation: fixture.activation,
          entries: fixture.receipt.entries,
        }
      : {
          schemaVersion: 1,
          operation: "clean",
          rootId: fixture.store.rootRecord.rootId,
          transactionId: TRANSACTION_ID,
          phase: "committed",
          generationDigest: OTHER_DIGEST,
          oldActivation: fixture.activation,
          entries: fixture.receipt.entries,
        };
  const path = join(fixture.store.layout.transactions, `${TRANSACTION_ID}.json`);
  writeFileSync(path, canonicalRecordBytes("transaction", record), { mode: 0o600 });
  return path;
}

function faultRuntime(point: ApplyFaultPoint): ApplyRuntime {
  return Object.freeze({
    onFaultPoint(candidate: ApplyFaultPoint): void {
      if (candidate === point) throw new Error(`injected:${point}`);
    },
    lockRuntime: Object.freeze({
      pid: process.pid,
      randomToken: () => LOCK_TOKEN,
      pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
    }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root.sandboxRoot, { recursive: true, force: true });
  }
});

describe("generation store inspection", () => {
  it("returns empty without creating a store or acquiring a lock", () => {
    const root = temporaryProject();

    const result = inspectProjectionStore({ projectRoot: root.projectRoot });

    expectInspection(result, "empty", null);
    expect(existsSync(join(root.projectRoot, ".aih"))).toBe(false);
  });

  it("returns empty for an owned root with no activation or pending residue", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(root.projectRoot);
    const before = treeMtimes(store.layout.root);

    const result = inspectProjectionStore({ projectRoot: root.projectRoot });

    expectInspection(result, "empty", null);
    expect(treeMtimes(store.layout.root)).toEqual(before);
  });

  it("verifies the exact activation, receipt digest, and owned generation tree read-only", () => {
    const fixture = materializeActiveStore();
    const before = treeMtimes(fixture.store.layout.root);

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(result, "verified", fixture.manifestDigest);
    expect(treeMtimes(fixture.store.layout.root)).toEqual(before);
    expect(existsSync(fixture.store.layout.lock)).toBe(false);
    expect(existsSync(fixture.store.layout.lockCandidates)).toBe(false);
  });

  it("fails closed when active bytes are replaced by a new exact-contents object", () => {
    const fixture = materializeActiveStore();
    const initialInventory = inspectFixedStoreLayout(fixture.store);
    const initialActivation = readStoreRecord(
      fixture.store,
      fixture.store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    unlinkSync(fixture.store.layout.active);
    writeCanonical(fixture.store.layout.active, "activation", fixture.activation);
    const finalInventory = inspectFixedStoreLayout(fixture.store);
    const finalActivation = readStoreRecord(
      fixture.store,
      fixture.store.layout.active,
      ActivationRecordSchema,
      "activation",
    );

    expect(
      assessStableStoreSnapshot(
        initialInventory,
        finalInventory,
        initialActivation,
        finalActivation,
      ),
    ).toBe("METHODOLOGY_STORE_ACTIVATION_INVALID");
  });

  it("fails closed when pending state changes after the initial snapshot", () => {
    const fixture = materializeActiveStore();
    const initialInventory = inspectFixedStoreLayout(fixture.store);
    const initialActivation = readStoreRecord(
      fixture.store,
      fixture.store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    mkdirSync(fixture.store.layout.transactions);
    writeFileSync(join(fixture.store.layout.transactions, `${TRANSACTION_ID}.json`), "{}\n");
    const finalInventory = inspectFixedStoreLayout(fixture.store);
    const finalActivation = readStoreRecord(
      fixture.store,
      fixture.store.layout.active,
      ActivationRecordSchema,
      "activation",
    );

    expect(
      assessStableStoreSnapshot(
        initialInventory,
        finalInventory,
        initialActivation,
        finalActivation,
      ),
    ).toBe("METHODOLOGY_STORE_TRANSACTION_INVALID");
  });

  it("fails closed when activation disappears between stable snapshot checks", () => {
    const fixture = materializeActiveStore();
    const initialInventory = inspectFixedStoreLayout(fixture.store);
    const initialActivation = readStoreRecord(
      fixture.store,
      fixture.store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    const finalInventory = Object.freeze({ ...initialInventory, activePresent: false });

    expect(
      assessStableStoreSnapshot(initialInventory, finalInventory, initialActivation, undefined),
    ).toBe("METHODOLOGY_STORE_ACTIVATION_INVALID");
  });

  it("revalidates active content before returning a stable verified result", () => {
    const fixture = materializeActiveStore();
    const initialInventory = inspectFixedStoreLayout(fixture.store);
    const initialActivation = readStoreRecord(
      fixture.store,
      fixture.store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    writeFileSync(
      join(fixture.contentRoot, "rules", "root.md"),
      Buffer.from("# changed after first walk\n"),
    );

    const result = verifyStableProjectionSnapshot(
      fixture.store,
      initialInventory,
      initialActivation,
    );
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("stable verification must detect active drift");

    expectInspection(
      result,
      "drifted",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_DRIFT",
    );
  });

  it("revalidates inactive history before returning a stable verified result", () => {
    const fixture = materializeActiveStore();
    materializeInactiveGeneration(fixture, OTHER_DIGEST);
    const initialInventory = inspectFixedStoreLayout(fixture.store);
    const initialActivation = readStoreRecord(
      fixture.store,
      fixture.store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    writeFileSync(
      join(fixture.store.layout.generations, OTHER_DIGEST, "content", "rules", "root.md"),
      Buffer.from("# changed history\n"),
    );

    const result = verifyStableProjectionSnapshot(
      fixture.store,
      initialInventory,
      initialActivation,
    );
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("stable verification must detect history drift");

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  });

  it("fails closed when an initially empty store changes before confirmation", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(root.projectRoot);
    const initialInventory = inspectFixedStoreLayout(store);
    mkdirSync(store.layout.transactions);
    writeFileSync(join(store.layout.transactions, `${TRANSACTION_ID}.json`), "{}\n");

    const result = verifyStableEmptySnapshot(store, initialInventory);

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_TRANSACTION_INVALID");
  });

  it("preserves failed-closed filesystem findings from inactive history", () => {
    const fixture = materializeActiveStore();
    materializeInactiveGeneration(fixture, OTHER_DIGEST);
    writeCanonical(
      join(fixture.store.layout.generations, OTHER_DIGEST, "receipt.json"),
      "receipt",
      {
        schemaVersion: 1,
        rootId: "e".repeat(64),
        manifestDigest: OTHER_DIGEST,
        entries: expectedReceiptEntries(),
      },
    );

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_ROOT_UNOWNED",
    );
  });

  it("keeps a complete inactive generation as valid immutable history", () => {
    const fixture = materializeActiveStore();
    materializeInactiveGeneration(fixture, OTHER_DIGEST);

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(result, "verified", fixture.manifestDigest);
  });

  it.each([
    "lock",
    "lock-candidates",
    "transactions",
    "staging",
    "trash",
  ] as const)("fails closed while %s pending state exists", (kind) => {
    const fixture = materializeActiveStore();
    if (kind === "lock") {
      mkdirSync(fixture.store.layout.lock);
    } else if (kind === "lock-candidates") {
      mkdirSync(join(fixture.store.layout.lockCandidates, OTHER_DIGEST), { recursive: true });
    } else if (kind === "transactions") {
      mkdirSync(fixture.store.layout.transactions);
      writeFileSync(join(fixture.store.layout.transactions, `${TRANSACTION_ID}.json`), "{}\n");
    } else {
      mkdirSync(join(fixture.store.layout[kind], TRANSACTION_ID), { recursive: true });
    }

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  });

  it("does not report empty when transaction residue exists without an activation", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(root.projectRoot);
    mkdirSync(store.layout.transactions);
    writeFileSync(join(store.layout.transactions, `${TRANSACTION_ID}.json`), "{}\n");

    const result = inspectProjectionStore({ projectRoot: root.projectRoot });

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_TRANSACTION_INVALID");
  });

  it("fails closed for malformed input without creating project state", () => {
    const root = temporaryProject();

    const result = inspectProjectionStore({ projectRoot: root.projectRoot, repair: true });

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_INPUT_INVALID");
    expect(existsSync(join(root.projectRoot, ".aih"))).toBe(false);
  });

  it("rejects a malformed activation at the owned-generation boundary", () => {
    const fixture = materializeActiveStore();
    const malformed = {
      ...fixture.activation,
      generation: "../outside",
    } as unknown as ActivationRecord;

    const result = inspectOwnedGeneration(fixture.store, malformed);

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_ACTIVATION_INVALID");
  });

  it("fails closed when input reflection invokes a hostile trap", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile input trap");
        },
      },
    );

    const result = inspectProjectionStore(hostile);

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_INPUT_INVALID");
  });

  it("fails closed for a malformed root marker", () => {
    const root = temporaryProject();
    const storeRoot = join(root.projectRoot, ".aih", "methodology", "v1");
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(join(storeRoot, "root.json"), "{}\n");

    const result = inspectProjectionStore({ projectRoot: root.projectRoot });

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_ROOT_UNOWNED");
  });

  it.each([
    ["malformed JSON", "not-json\n"],
    [
      "an activation path outside generations",
      `${JSON.stringify({
        schemaVersion: 1,
        manifestDigest: OTHER_DIGEST,
        receiptDigest: OTHER_DIGEST,
        generation: "../../outside",
      })}\n`,
    ],
  ])("fails closed for %s", (_label, bytes) => {
    const fixture = materializeActiveStore();
    writeFileSync(fixture.store.layout.active, bytes);

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_ACTIVATION_INVALID");
  });

  it("reports an owned missing receipt as incomplete drift", () => {
    const fixture = materializeActiveStore();
    unlinkSync(join(fixture.generationRoot, "receipt.json"));

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "drifted",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  });

  it("fails closed when a receipt is bound to another root", () => {
    const fixture = materializeActiveStore();
    const unownedReceipt = { ...fixture.receipt, rootId: "e".repeat(64) };
    const receiptBytes = canonicalRecordBytes("receipt", unownedReceipt);
    writeFileSync(join(fixture.generationRoot, "receipt.json"), receiptBytes);
    writeCanonical(fixture.store.layout.active, "activation", {
      ...fixture.activation,
      receiptDigest: sha256Bytes(receiptBytes),
    });

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_ROOT_UNOWNED",
    );
  });

  it("reports receipt byte digest drift without trusting another generation", () => {
    const fixture = materializeActiveStore();
    writeCanonical(fixture.store.layout.active, "activation", {
      ...fixture.activation,
      receiptDigest: OTHER_DIGEST,
    });

    const fallbackRoot = join(fixture.store.layout.generations, OTHER_DIGEST);
    mkdirSync(join(fallbackRoot, "content"), { recursive: true });

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "drifted",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_DRIFT",
    );
  });

  it("reports missing content as incomplete drift", () => {
    const fixture = materializeActiveStore();
    unlinkSync(join(fixture.contentRoot, "rules", "dependency.md"));

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "drifted",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  });

  it.each([
    [
      "extra content",
      (fixture: MaterializedStore) =>
        writeFileSync(join(fixture.contentRoot, "rules", "extra.md"), "extra\n"),
    ],
    [
      "changed bytes",
      (fixture: MaterializedStore) =>
        writeFileSync(join(fixture.contentRoot, "rules", "root.md"), Buffer.from("# evil\n")),
    ],
  ])("reports owned %s as generation drift", (_label, mutate) => {
    const fixture = materializeActiveStore();
    mutate(fixture);

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "drifted",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_DRIFT",
    );
  });

  it("fails closed for a linked content entry", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const target = join(fixture.contentRoot, "rules", "root.md");
    unlinkSync(target);
    if (!tryCreateFileSymlink(outside.canary, target)) return;

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_PATH_UNSAFE",
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("fails closed for a hard-linked content entry", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const target = join(fixture.contentRoot, "rules", "root.md");
    unlinkSync(target);
    if (!tryCreateHardLink(outside.canary, target)) return;

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_PATH_UNSAFE",
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it.each([
    "incomplete",
    "missing-receipt",
    "receipt-digest",
  ] as const)("does not let %s state mask an unsafe content link", (kind) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const target = join(fixture.contentRoot, "rules", "root.md");
    unlinkSync(target);
    if (!tryCreateFileSymlink(outside.canary, target)) return;

    if (kind === "incomplete") {
      writeFileSync(
        join(fixture.generationRoot, "incomplete.json"),
        canonicalRecordBytes("incomplete", {
          schemaVersion: 1,
          rootId: fixture.store.rootRecord.rootId,
          transactionId: TRANSACTION_ID,
          manifestDigest: fixture.manifestDigest,
        }),
      );
    } else if (kind === "missing-receipt") {
      unlinkSync(join(fixture.generationRoot, "receipt.json"));
    } else {
      writeCanonical(fixture.store.layout.active, "activation", {
        ...fixture.activation,
        receiptDigest: OTHER_DIGEST,
      });
    }

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_PATH_UNSAFE",
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("fails closed when a top-level unknown object appears in the owned store", () => {
    const fixture = materializeActiveStore();
    writeFileSync(join(fixture.store.layout.root, "unknown"), "unexpected\n");

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_PATH_UNSAFE");
  });

  it("reports an owned incomplete marker as incomplete drift", () => {
    const fixture = materializeActiveStore();
    const incomplete = {
      schemaVersion: 1 as const,
      rootId: fixture.store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      manifestDigest: fixture.manifestDigest,
    };
    writeFileSync(
      join(fixture.generationRoot, "incomplete.json"),
      canonicalRecordBytes("incomplete", incomplete),
    );

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "drifted",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  });

  it("fails closed when an incomplete marker cannot prove ownership", () => {
    const fixture = materializeActiveStore();
    writeFileSync(join(fixture.generationRoot, "incomplete.json"), "{}\n");

    const result = inspectProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectInspection(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  });

  it("fails closed and reports an orphan generation without selecting it", () => {
    const root = temporaryProject();
    const store = createOrOpenOwnedStore(root.projectRoot);
    mkdirSync(join(store.layout.generations, OTHER_DIGEST), { recursive: true });

    const result = inspectProjectionStore({ projectRoot: root.projectRoot });

    expectInspection(result, "failed-closed", null, "METHODOLOGY_STORE_TRANSACTION_INVALID");
  });
});

describe("generation store apply", () => {
  it("apply writes exact binary payloads into one verified private generation", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const plan = requirePlanned(binaryPlannedFixture());
    const payloads = binaryPayloadFixture();

    const result = applyProjection(applyInput(root.projectRoot, plan, payloads, null));

    expectApply(result, "applied", null, plan.manifest.digest);
    const store = createOrOpenOwnedStore(root.projectRoot);
    const generationRoot = join(store.layout.generations, plan.manifest.digest);
    const contentRoot = join(generationRoot, "content");
    const payloadById = new Map(payloads.map((payload) => [payload.artifactId, payload.bytes]));
    for (const entry of plan.manifest.entries) {
      expect(readFileSync(join(contentRoot, ...entry.target.split("/")))).toEqual(
        payloadById.get(entry.artifactId),
      );
    }
    const activation = readActivation(store);
    const receiptBytes = readFileSync(join(generationRoot, "receipt.json"));
    expect(activation.record).toEqual({
      schemaVersion: 1,
      manifestDigest: plan.manifest.digest,
      receiptDigest: sha256Bytes(receiptBytes),
      generation: `generations/${plan.manifest.digest}/content`,
    });
    const inventory = inspectFixedStoreLayout(store);
    expect(inventory).toMatchObject({
      activePresent: true,
      lockPresent: false,
      lockCandidates: [],
      transactions: [],
      staging: [],
      trash: [],
    });
    if (process.platform !== "win32") {
      expect(Number(lstatSync(generationRoot, { bigint: true }).mode & 0o777n)).toBe(0o700);
      expect(Number(lstatSync(contentRoot, { bigint: true }).mode & 0o777n)).toBe(0o700);
      for (const entry of plan.manifest.entries) {
        expect(
          Number(
            lstatSync(join(contentRoot, ...entry.target.split("/")), { bigint: true }).mode &
              0o777n,
          ),
        ).toBe(0o600);
      }
    }
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply creates private transaction scratch before any generated publication", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const plan = requirePlanned(binaryPlannedFixture());

    expect(() =>
      applyProjectionWithRuntime(
        applyInput(root.projectRoot, plan, binaryPayloadFixture(), null),
        faultRuntime("after-stage-created"),
      ),
    ).toThrow("injected:after-stage-created");

    const scratchRoot = join(root.projectRoot, ".aih", "methodology", "v1", "trash");
    const stagedTransactions = namesIfPresent(scratchRoot);
    expect(stagedTransactions).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(
        Number(
          lstatSync(join(scratchRoot, stagedTransactions[0] as string), { bigint: true }).mode &
            0o777n,
        ),
      ).toBe(0o700);
    }
    expect(
      existsSync(
        join(root.projectRoot, ".aih", "methodology", "v1", "generations", plan.manifest.digest),
      ),
    ).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply revalidates terminal activation before removing recovery evidence", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const plan = requirePlanned(binaryPlannedFixture());

    const result = applyProjectionWithRuntime(
      applyInput(root.projectRoot, plan, binaryPayloadFixture(), null),
      Object.freeze({
        onFaultPoint(point: ApplyFaultPoint): void {
          if (point === "after-journal-committed") {
            writeFileSync(
              join(root.projectRoot, ".aih", "methodology", "v1", "active.json"),
              "{}\n",
            );
          }
        },
        lockRuntime: Object.freeze({
          pid: process.pid,
          randomToken: () => LOCK_TOKEN,
          pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
        }),
      }),
    );

    expectApply(result, "failed-closed", null, null, "METHODOLOGY_STORE_ACTIVATION_INVALID");
    const store = createOrOpenOwnedStore(root.projectRoot);
    const inventory = inspectFixedStoreLayout(store);
    expect(inventory.transactions).toHaveLength(1);
    expect(inventory.staging).toHaveLength(1);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply produces deterministic receipt, generation, and activation bytes across stores and payload order", () => {
    const firstRoot = temporaryProject();
    const secondRoot = temporaryProject();
    const firstStore = fixOwnedRootId(firstRoot);
    const secondStore = fixOwnedRootId(secondRoot);
    expect(firstStore.rootRecord.rootId).toBe(FIXED_ROOT_ID);
    expect(secondStore.rootRecord.rootId).toBe(FIXED_ROOT_ID);
    const plan = requirePlanned(binaryPlannedFixture());
    const payloads = binaryPayloadFixture();

    const first = applyProjection(applyInput(firstRoot.projectRoot, plan, payloads, null));
    const second = applyProjection(
      applyInput(secondRoot.projectRoot, plan, [...payloads].reverse(), null),
    );

    expectApply(first, "applied", null, plan.manifest.digest);
    expectApply(second, "applied", null, plan.manifest.digest);
    const firstGeneration = join(firstStore.layout.generations, plan.manifest.digest);
    const secondGeneration = join(secondStore.layout.generations, plan.manifest.digest);
    expect(readFileSync(join(firstGeneration, "receipt.json"))).toEqual(
      readFileSync(join(secondGeneration, "receipt.json")),
    );
    expect(deterministicTreeSnapshot(firstGeneration)).toEqual(
      deterministicTreeSnapshot(secondGeneration),
    );
    const firstActivation = readActivation(firstStore);
    const secondActivation = readActivation(secondStore);
    expect(firstActivation.bytes).toEqual(secondActivation.bytes);
    expect(firstActivation.record.generation).toBe(secondActivation.record.generation);
  });

  it("apply reuses an exact active generation without rewriting content or activation", () => {
    const root = temporaryProject();
    const plan = requirePlanned(binaryPlannedFixture());
    const payloads = binaryPayloadFixture();
    const first = applyProjection(applyInput(root.projectRoot, plan, payloads, null));
    expectApply(first, "applied", null, plan.manifest.digest);
    const store = createOrOpenOwnedStore(root.projectRoot);
    const generationRoot = join(store.layout.generations, plan.manifest.digest);
    const generationBefore = identityTreeSnapshot(generationRoot);
    const activationBefore = identityTreeSnapshot(store.layout.active);

    const reapplied = applyProjection(
      applyInput(root.projectRoot, plan, [...payloads].reverse(), plan.manifest.digest),
    );

    expectApply(reapplied, "already-active", plan.manifest.digest, plan.manifest.digest);
    expect(identityTreeSnapshot(generationRoot)).toEqual(generationBefore);
    expect(identityTreeSnapshot(store.layout.active)).toEqual(activationBefore);
  });

  it("apply publishes a second immutable generation while preserving the prior generation", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const firstPlan = requirePlanned(binaryPlannedFixture());
    const secondPlan = requirePlanned(alternatePlannedFixture());
    expect(secondPlan.manifest.digest).not.toBe(firstPlan.manifest.digest);
    const first = applyProjection(
      applyInput(root.projectRoot, firstPlan, binaryPayloadFixture(), null),
    );
    expectApply(first, "applied", null, firstPlan.manifest.digest);
    const store = createOrOpenOwnedStore(root.projectRoot);
    const oldGeneration = join(store.layout.generations, firstPlan.manifest.digest);
    const oldSnapshot = identityTreeSnapshot(oldGeneration);
    const oldActivationBytes = readActivation(store).bytes;

    const second = applyProjection(
      applyInput(
        root.projectRoot,
        secondPlan,
        alternatePayloadFixture(),
        firstPlan.manifest.digest,
      ),
    );

    expectApply(second, "applied", firstPlan.manifest.digest, secondPlan.manifest.digest);
    expect(identityTreeSnapshot(oldGeneration)).toEqual(oldSnapshot);
    expect(readActivation(store).bytes).not.toEqual(oldActivationBytes);
    expect(namesIfPresent(store.layout.generations)).toEqual(
      [firstPlan.manifest.digest, secondPlan.manifest.digest].sort(),
    );
    const secondPayloadById = new Map(
      alternatePayloadFixture().map((payload) => [payload.artifactId, payload.bytes]),
    );
    for (const entry of secondPlan.manifest.entries) {
      expect(
        readFileSync(
          join(
            store.layout.generations,
            secondPlan.manifest.digest,
            "content",
            ...entry.target.split("/"),
          ),
        ),
      ).toEqual(secondPayloadById.get(entry.artifactId));
    }
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply reuses an exact inactive generation without rewriting it", () => {
    const root = temporaryProject();
    const firstPlan = requirePlanned(binaryPlannedFixture());
    const secondPlan = requirePlanned(alternatePlannedFixture());
    expectApply(
      applyProjection(applyInput(root.projectRoot, firstPlan, binaryPayloadFixture(), null)),
      "applied",
      null,
      firstPlan.manifest.digest,
    );
    expectApply(
      applyProjection(
        applyInput(
          root.projectRoot,
          secondPlan,
          alternatePayloadFixture(),
          firstPlan.manifest.digest,
        ),
      ),
      "applied",
      firstPlan.manifest.digest,
      secondPlan.manifest.digest,
    );
    const store = createOrOpenOwnedStore(root.projectRoot);
    const inactiveRoot = join(store.layout.generations, firstPlan.manifest.digest);
    const inactiveBefore = identityTreeSnapshot(inactiveRoot);

    const result = applyProjection(
      applyInput(root.projectRoot, firstPlan, binaryPayloadFixture(), secondPlan.manifest.digest),
    );

    expectApply(result, "applied", secondPlan.manifest.digest, firstPlan.manifest.digest);
    expect(identityTreeSnapshot(inactiveRoot)).toEqual(inactiveBefore);
  });

  it("apply blocks a stale expected activation before staging or generation creation", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const plan = requirePlanned(binaryPlannedFixture());
    const activeBefore = readFileSync(fixture.store.layout.active);
    const stagingBefore = namesIfPresent(fixture.store.layout.staging);
    const transactionsBefore = namesIfPresent(fixture.store.layout.transactions);

    const result = applyProjection(
      applyInput(fixture.root.projectRoot, plan, binaryPayloadFixture(), OTHER_DIGEST),
    );

    expectApply(
      result,
      "blocked",
      fixture.manifestDigest,
      fixture.manifestDigest,
      "METHODOLOGY_STORE_PLAN_STALE",
    );
    expect(readFileSync(fixture.store.layout.active)).toEqual(activeBefore);
    expect(namesIfPresent(fixture.store.layout.staging)).toEqual(stagingBefore);
    expect(namesIfPresent(fixture.store.layout.transactions)).toEqual(transactionsBefore);
    expect(existsSync(join(fixture.store.layout.generations, plan.manifest.digest))).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });
});

describe("generation store apply refusals and pending-state contract", () => {
  it.each([
    {
      label: "a blocked Phase 3 result",
      build: () => ({ plan: blockedFixture(), payloads: payloadFixture() }),
      findingCode: "METHODOLOGY_STORE_INPUT_INVALID",
    },
    {
      label: "payload digest drift",
      build: () => ({
        plan: plannedFixture(),
        payloads: [{ artifactId: "root", bytes: Buffer.from("wrong digest") }, payloadFixture()[1]],
      }),
      findingCode: "METHODOLOGY_STORE_PAYLOAD_DIGEST",
    },
    {
      label: "payload coverage loss",
      build: () => ({ plan: plannedFixture(), payloads: payloadFixture().slice(1) }),
      findingCode: "METHODOLOGY_STORE_PAYLOAD_COVERAGE",
    },
    {
      label: "aggregate resource overflow",
      build: () => {
        const payloads = aggregateOverflowPayloadFixture();
        return { plan: plannedPayloadSet(payloads), payloads };
      },
      findingCode: "METHODOLOGY_STORE_RESOURCE_LIMIT",
    },
  ])("apply blocks $label before creating an owned store", ({ build, findingCode }) => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const candidate = build();

    const result = applyProjection(
      applyInput(root.projectRoot, candidate.plan, candidate.payloads, null),
    );

    expectApply(result, "blocked", null, null, findingCode);
    expect(existsSync(join(root.projectRoot, ".aih"))).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply maps untyped schema parse failures to blocked input", () => {
    const result = applyProjection(applyInput("", plannedFixture(), payloadFixture(), null));

    expectApply(result, "blocked", null, null, "METHODOLOGY_STORE_INPUT_INVALID");
  });

  it("apply enforces one aggregate walk budget across active and history", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const store = createOrOpenOwnedStore(root.projectRoot);
    const payloadById = new Map<string, Buffer>();
    const entries = Array.from({ length: 64 }, (_, index) => {
      const suffix = index.toString().padStart(2, "0");
      const artifactId = `item-${suffix}`;
      const bytes = Buffer.from([index]);
      payloadById.set(artifactId, bytes);
      return {
        artifactId,
        target: `rules/file-${suffix}.md`,
        sourceLocator: `synthetic:${artifactId}`,
        contentDigest: sha256Bytes(bytes),
        bytes: bytes.byteLength,
      };
    });
    const generationDigests = Array.from({ length: 16 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    for (const manifestDigest of generationDigests) {
      const generationRoot = join(store.layout.generations, manifestDigest);
      const contentRoot = join(generationRoot, "content");
      mkdirSync(join(contentRoot, "rules"), {
        recursive: true,
        mode: 0o700,
      });
      for (const entry of entries) {
        const bytes = payloadById.get(entry.artifactId);
        if (bytes === undefined) throw new Error("dense fixture payload is missing");
        writeFileSync(join(contentRoot, ...entry.target.split("/")), bytes, { mode: 0o600 });
      }
      writeCanonical(join(generationRoot, "receipt.json"), "receipt", {
        schemaVersion: 1,
        rootId: store.rootRecord.rootId,
        manifestDigest,
        entries,
      });
    }
    const activeDigest = generationDigests[0];
    if (activeDigest === undefined) throw new Error("dense fixture needs an active digest");
    const activeReceiptBytes = readFileSync(
      join(store.layout.generations, activeDigest, "receipt.json"),
    );
    writeCanonical(store.layout.active, "activation", {
      schemaVersion: 1,
      manifestDigest: activeDigest,
      receiptDigest: sha256Bytes(activeReceiptBytes),
      generation: `generations/${activeDigest}/content`,
    });
    const plan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(root.projectRoot, plan, binaryPayloadFixture(), activeDigest),
    );

    expectApply(result, "blocked", activeDigest, activeDigest, "METHODOLOGY_STORE_RESOURCE_LIMIT");
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  }, 30_000);

  it("blocks prospective aggregate directory overflow before creating transaction state", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const payloads = Array.from({ length: 64 }, (_, index) => ({
      artifactId: `capacity-${index}`,
      bytes: Buffer.from([index]),
    }));
    const plan = requirePlanned(
      plannedPayloadSet(payloads, (artifactId) => `${artifactId}/d0/d1/d2/d3/d4/d5/d6/file.md`),
    );
    const first = applyProjection(applyInput(root.projectRoot, plan, payloads, null));
    expectApply(first, "applied", null, plan.manifest.digest);

    const store = createOrOpenOwnedStore(root.projectRoot);
    const activeBefore = readFileSync(store.layout.active);
    const generationBefore = identityTreeSnapshot(
      join(store.layout.generations, plan.manifest.digest),
    );
    const candidatePlan = requirePlanned(plannedFixture());
    expect(candidatePlan.manifest.digest).not.toBe(plan.manifest.digest);

    const result = applyProjection(
      applyInput(root.projectRoot, candidatePlan, payloadFixture(), plan.manifest.digest),
    );

    expectApply(
      result,
      "blocked",
      plan.manifest.digest,
      plan.manifest.digest,
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
    expect(readFileSync(store.layout.active)).toEqual(activeBefore);
    expect(identityTreeSnapshot(join(store.layout.generations, plan.manifest.digest))).toEqual(
      generationBefore,
    );
    expect(namesIfPresent(store.layout.generations)).toEqual([plan.manifest.digest]);
    expect(namesIfPresent(store.layout.transactions)).toEqual([]);
    expect(namesIfPresent(store.layout.staging)).toEqual([]);
    expect(namesIfPresent(store.layout.trash)).toEqual([]);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  }, 60_000);

  it("apply reports a deterministic Phase 3 destination collision without mutation", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const plan = collisionBlockedFixture();
    expect(plan.state).toBe("blocked");

    const result = applyProjection(applyInput(root.projectRoot, plan, payloadFixture(), null));

    expectApply(result, "blocked", null, null, "METHODOLOGY_STORE_DESTINATION_COLLISION");
    expect(existsSync(join(root.projectRoot, ".aih"))).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply fails closed on an incomplete pre-existing destination generation", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const store = createOrOpenOwnedStore(root.projectRoot);
    const plan = requirePlanned(binaryPlannedFixture());
    const generationRoot = join(store.layout.generations, plan.manifest.digest);
    mkdirSync(join(generationRoot, "content"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(generationRoot, "incomplete.json"),
      canonicalRecordBytes("incomplete", {
        schemaVersion: 1,
        rootId: store.rootRecord.rootId,
        transactionId: TRANSACTION_ID,
        manifestDigest: plan.manifest.digest,
      }),
      { mode: 0o600 },
    );

    const result = applyProjection(
      applyInput(root.projectRoot, plan, binaryPayloadFixture(), null),
    );

    expectApply(result, "failed-closed", null, null, "METHODOLOGY_STORE_GENERATION_INCOMPLETE");
    expect(existsSync(store.layout.active)).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply fails closed on a malformed existing root before activation", () => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const storeRoot = join(root.projectRoot, ".aih", "methodology", "v1");
    mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(storeRoot, "root.json"), "{}\n", { mode: 0o600 });
    const plan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(root.projectRoot, plan, binaryPayloadFixture(), null),
    );

    expectApply(result, "failed-closed", null, null, "METHODOLOGY_STORE_ROOT_UNOWNED");
    expect(existsSync(join(storeRoot, "active.json"))).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply retains a drifted active generation and fails closed before replacement", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    writeFileSync(join(fixture.contentRoot, "rules", "root.md"), "drifted\n");
    const activeBefore = readFileSync(fixture.store.layout.active);
    const plan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(fixture.root.projectRoot, plan, binaryPayloadFixture(), fixture.manifestDigest),
    );

    expectApply(
      result,
      "failed-closed",
      fixture.manifestDigest,
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_DRIFT",
    );
    expect(readFileSync(fixture.store.layout.active)).toEqual(activeBefore);
    expect(existsSync(join(fixture.store.layout.generations, plan.manifest.digest))).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("apply reports active drift before a stale expected activation", () => {
    const fixture = materializeActiveStore();
    writeFileSync(join(fixture.contentRoot, "rules", "root.md"), "drifted\n");
    const plan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(fixture.root.projectRoot, plan, binaryPayloadFixture(), OTHER_DIGEST),
    );

    expectApply(
      result,
      "failed-closed",
      fixture.manifestDigest,
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_DRIFT",
    );
    expect(existsSync(join(fixture.store.layout.generations, plan.manifest.digest))).toBe(false);
  });

  it("apply revalidates the prior active generation after the pre-activation callback", () => {
    const fixture = materializeActiveStore();
    const activeBefore = readFileSync(fixture.store.layout.active);
    const plan = requirePlanned(binaryPlannedFixture());

    const result = applyProjectionWithRuntime(
      applyInput(fixture.root.projectRoot, plan, binaryPayloadFixture(), fixture.manifestDigest),
      Object.freeze({
        onFaultPoint(point: ApplyFaultPoint): void {
          if (point === "before-activation-rename") {
            writeFileSync(join(fixture.contentRoot, "rules", "root.md"), "drifted\n");
          }
        },
        lockRuntime: Object.freeze({
          pid: process.pid,
          randomToken: () => LOCK_TOKEN,
          pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
        }),
      }),
    );

    expectApply(
      result,
      "failed-closed",
      fixture.manifestDigest,
      null,
      "METHODOLOGY_STORE_GENERATION_DRIFT",
    );
    expect(readFileSync(fixture.store.layout.active)).toEqual(activeBefore);
  });

  it("apply revalidates candidate bytes after the pre-activation callback", () => {
    const root = temporaryProject();
    const plan = requirePlanned(binaryPlannedFixture());
    const firstEntry = plan.manifest.entries[0];
    if (firstEntry === undefined) throw new Error("fixture must have an entry");

    const result = applyProjectionWithRuntime(
      applyInput(root.projectRoot, plan, binaryPayloadFixture(), null),
      Object.freeze({
        onFaultPoint(point: ApplyFaultPoint): void {
          if (point === "before-activation-rename") {
            writeFileSync(
              join(
                root.projectRoot,
                ".aih",
                "methodology",
                "v1",
                "generations",
                plan.manifest.digest,
                "content",
                ...firstEntry.target.split("/"),
              ),
              "drifted\n",
            );
          }
        },
        lockRuntime: Object.freeze({
          pid: process.pid,
          randomToken: () => LOCK_TOKEN,
          pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
        }),
      }),
    );

    expectApply(result, "failed-closed", null, null, "METHODOLOGY_STORE_GENERATION_DRIFT");
    expect(existsSync(join(root.projectRoot, ".aih", "methodology", "v1", "active.json"))).toBe(
      false,
    );
  });

  it("apply reports the exact alternate activation observed at the pre-activation boundary", () => {
    const fixture = materializeActiveStore();
    materializeInactiveGeneration(fixture, OTHER_DIGEST);
    const alternateReceiptBytes = readFileSync(
      join(fixture.store.layout.generations, OTHER_DIGEST, "receipt.json"),
    );
    const alternateActivation: ActivationRecord = {
      schemaVersion: 1,
      manifestDigest: OTHER_DIGEST,
      receiptDigest: sha256Bytes(alternateReceiptBytes),
      generation: `generations/${OTHER_DIGEST}/content`,
    };
    const nextPlan = requirePlanned(binaryPlannedFixture());

    const result = applyProjectionWithRuntime(
      applyInput(
        fixture.root.projectRoot,
        nextPlan,
        binaryPayloadFixture(),
        fixture.manifestDigest,
      ),
      Object.freeze({
        onFaultPoint(point: ApplyFaultPoint): void {
          if (point === "before-activation-rename") {
            writeCanonical(fixture.store.layout.active, "activation", alternateActivation);
          }
        },
        lockRuntime: Object.freeze({
          pid: process.pid,
          randomToken: () => LOCK_TOKEN,
          pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
        }),
      }),
    );

    expectApply(
      result,
      "failed-closed",
      fixture.manifestDigest,
      OTHER_DIGEST,
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
    expect(readActivation(fixture.store).record).toEqual(alternateActivation);
  });

  it("apply propagates an injected undefined throw instead of converting it to a result", () => {
    const root = temporaryProject();
    const plan = requirePlanned(binaryPlannedFixture());
    let caught = false;

    try {
      applyProjectionWithRuntime(
        applyInput(root.projectRoot, plan, binaryPayloadFixture(), null),
        Object.freeze({
          onFaultPoint(point: ApplyFaultPoint): void {
            if (point === "after-journal-prepared") throw undefined;
          },
          lockRuntime: Object.freeze({
            pid: process.pid,
            randomToken: () => LOCK_TOKEN,
            pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
          }),
        }),
      );
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }

    expect(caught).toBe(true);
    const store = createOrOpenOwnedStore(root.projectRoot);
    expect(existsSync(store.layout.lock)).toBe(false);
  });

  it.each([
    "apply",
    "clean",
  ] as const)("apply recovers an exact committed %s journal before starting the next transaction", (operation) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const pendingPath = writePendingTransaction(fixture, operation);
    const nextPlan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(
        fixture.root.projectRoot,
        nextPlan,
        binaryPayloadFixture(),
        fixture.manifestDigest,
      ),
    );

    expectApply(result, "applied", fixture.manifestDigest, nextPlan.manifest.digest);
    expect(existsSync(pendingPath)).toBe(false);
    expect(readActivation(fixture.store).record.manifestDigest).toBe(nextPlan.manifest.digest);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });
  it("apply retains every journal when more than one pending journal is present", () => {
    const fixture = materializeActiveStore();
    const validPath = writePendingTransaction(fixture, "apply");
    const malformedId = "f".repeat(64);
    const malformedPath = join(fixture.store.layout.transactions, `${malformedId}.json`);
    writeFileSync(malformedPath, "{}\n", { mode: 0o600 });
    const nextPlan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(
        fixture.root.projectRoot,
        nextPlan,
        binaryPayloadFixture(),
        fixture.manifestDigest,
      ),
    );

    expectApply(
      result,
      "failed-closed",
      fixture.manifestDigest,
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(existsSync(validPath)).toBe(true);
    expect(existsSync(malformedPath)).toBe(true);
  });

  it("apply retains a committed journal when unrelated generation state is incomplete", () => {
    const fixture = materializeActiveStore();
    const pendingPath = writePendingTransaction(fixture, "apply");
    const incompleteRoot = join(fixture.store.layout.generations, OTHER_DIGEST);
    mkdirSync(join(incompleteRoot, "content"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(incompleteRoot, "incomplete.json"),
      canonicalRecordBytes("incomplete", {
        schemaVersion: 1,
        rootId: fixture.store.rootRecord.rootId,
        transactionId: "e".repeat(64),
        manifestDigest: OTHER_DIGEST,
      }),
      { mode: 0o600 },
    );
    const nextPlan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(
        fixture.root.projectRoot,
        nextPlan,
        binaryPayloadFixture(),
        fixture.manifestDigest,
      ),
    );

    expectApply(
      result,
      "failed-closed",
      fixture.manifestDigest,
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(existsSync(pendingPath)).toBe(true);
    expect(existsSync(join(incompleteRoot, "incomplete.json"))).toBe(true);
  });

  it.each([
    "malformed-journal",
    "unjournaled-staging",
  ] as const)("apply refuses uncertain pending state: %s", (kind) => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const store = createOrOpenOwnedStore(root.projectRoot);
    if (kind === "malformed-journal") {
      mkdirSync(store.layout.transactions, { recursive: true, mode: 0o700 });
      writeFileSync(join(store.layout.transactions, `${TRANSACTION_ID}.json`), "{}\n", {
        mode: 0o600,
      });
    } else {
      mkdirSync(join(store.layout.staging, TRANSACTION_ID), {
        recursive: true,
        mode: 0o700,
      });
    }
    const plan = requirePlanned(binaryPlannedFixture());

    const result = applyProjection(
      applyInput(root.projectRoot, plan, binaryPayloadFixture(), null),
    );

    expectApply(result, "failed-closed", null, null, "METHODOLOGY_STORE_TRANSACTION_INVALID");
    expect(existsSync(store.layout.active)).toBe(false);
    expect(existsSync(join(store.layout.generations, plan.manifest.digest))).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });
});
