import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as generationStoreModule from "../../src/methodology/generation-store.js";
import {
  type ActivationRecord,
  ActivationRecordSchema,
  type ApplyProjectionResult,
  type CleanProjectionResult,
  canonicalRecordBytes,
  type GenerationReceipt,
  MAX_PAYLOAD_BYTES,
  MAX_RECOVERY_RECORDS,
  MAX_TOTAL_PAYLOAD_BYTES,
  type ProjectionPayload,
  type RecoveryProjectionResult,
  type StagingRecord,
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
  alternatePayloadFixture,
  alternatePlannedFixture,
  binaryPayloadFixture,
  binaryPlannedFixture,
  makeSiblingCanary,
  makeTemporaryProject,
  payloadFixture,
  plannedFixture,
  plannedPayloadSet,
  type TemporaryProject,
} from "./generation-store-fixtures.js";

const APPLY_FAULT_POINTS = [
  "after-journal-prepared",
  "after-stage-created",
  "after-stage-verified",
  "after-generation-reserved",
  "after-generation-content",
  "after-receipt-written",
  "before-activation-rename",
  "after-activation-rename",
  "after-journal-committed",
] as const;
const CLEAN_FAULT_POINTS = [
  "after-clean-journal-prepared",
  "before-clean-quarantine",
  "after-clean-quarantine",
  "during-clean-delete",
  "after-clean-delete",
] as const;

const TRANSACTION_ID = "d".repeat(64);
const OTHER_TRANSACTION_ID = "b".repeat(64);
const LOCK_TOKEN = "a".repeat(64);
const HELPER_PATH = realpathSync(
  join(process.cwd(), "tests", "methodology", "helpers", "generation-store-child.ts"),
);
const roots: TemporaryProject[] = [];
const POST_ACTIVATION_POINTS = new Set<(typeof APPLY_FAULT_POINTS)[number]>([
  "after-activation-rename",
  "after-journal-committed",
]);
const COMPLETED_NEXT_GENERATION_POINTS = new Set<(typeof APPLY_FAULT_POINTS)[number]>([
  "after-receipt-written",
  "before-activation-rename",
  "after-activation-rename",
  "after-journal-committed",
]);
const MAX_CHILD_REQUEST_BYTES = 64 * 1024;

type ApplyFaultPoint = (typeof APPLY_FAULT_POINTS)[number];
type RecoveryFaultPoint =
  | "after-recovery-trash-removed"
  | "after-recovery-incomplete-removed"
  | "after-recovery-staging-removed"
  | "after-recovery-activation-temporary-removed"
  | "after-recovery-transaction-temporary-removed"
  | "before-recovery-journal-removal";
const RECOVERY_FAULT_POINTS: readonly RecoveryFaultPoint[] = [
  "after-recovery-trash-removed",
  "after-recovery-incomplete-removed",
  "after-recovery-staging-removed",
  "after-recovery-activation-temporary-removed",
  "after-recovery-transaction-temporary-removed",
  "before-recovery-journal-removal",
] as const;

type ApplyRuntime = Readonly<{
  onFaultPoint: (point: ApplyFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;
type ApplyProjectionWithRuntimeFunction = (value: unknown, runtime: ApplyRuntime) => unknown;
type CleanFaultPoint = (typeof CLEAN_FAULT_POINTS)[number];
type CleanRuntime = Readonly<{
  onFaultPoint: (point: CleanFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;
type CleanProjectionWithRuntimeFunction = (
  value: unknown,
  runtime: CleanRuntime,
) => CleanProjectionResult;
type RecoverProjectionFunction = (value: unknown) => RecoveryProjectionResult;
type RecoveryRuntime = Readonly<{
  onFaultPoint: (point: RecoveryFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;
type RecoverProjectionWithRuntimeFunction = (
  value: unknown,
  runtime: RecoveryRuntime,
) => RecoveryProjectionResult;
type PlannedFixture = Extract<ReturnType<typeof plannedFixture>, { state: "planned" }>;
type MaterializedStore = Readonly<{
  root: TemporaryProject;
  store: ReturnType<typeof createOrOpenOwnedStore>;
  manifestDigest: string;
  generationRoot: string;
  receipt: GenerationReceipt;
  activation: ActivationRecord;
}>;
type MaterializedCleanStore = Readonly<{
  fixture: MaterializedStore;
  activeGenerationRoot: string;
  activeActivation: ActivationRecord;
}>;

function temporaryProject(): TemporaryProject {
  const root = makeTemporaryProject();
  roots.push(root);
  return root;
}

function requirePlanned<T extends { state: string }>(value: T): Extract<T, { state: "planned" }> {
  if (value.state !== "planned") throw new Error("fixture must produce a planned projection");
  return value as Extract<T, { state: "planned" }>;
}

function receiptEntries(
  plan: PlannedFixture,
  payloads: readonly ProjectionPayload[],
): GenerationReceipt["entries"] {
  const payloadById = new Map(payloads.map((payload) => [payload.artifactId, payload.bytes]));
  return plan.manifest.entries.map((entry) => {
    const bytes = payloadById.get(entry.artifactId);
    if (bytes === undefined) throw new Error("fixture payload is missing");
    return Object.freeze({ ...entry, bytes: bytes.byteLength });
  });
}

function materializeGeneration(
  store: ReturnType<typeof createOrOpenOwnedStore>,
  plan: PlannedFixture,
  payloads: readonly ProjectionPayload[],
): Readonly<{
  generationRoot: string;
  receipt: GenerationReceipt;
  activation: ActivationRecord;
}> {
  const generationRoot = join(store.layout.generations, plan.manifest.digest);
  const contentRoot = join(generationRoot, "content");
  mkdirSync(contentRoot, { recursive: true, mode: 0o700 });
  const payloadById = new Map(payloads.map((payload) => [payload.artifactId, payload.bytes]));
  for (const entry of plan.manifest.entries) {
    const bytes = payloadById.get(entry.artifactId);
    if (bytes === undefined) throw new Error("fixture payload is missing");
    const target = join(contentRoot, ...entry.target.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
  const receipt: GenerationReceipt = {
    schemaVersion: 1,
    rootId: store.rootRecord.rootId,
    manifestDigest: plan.manifest.digest,
    entries: receiptEntries(plan, payloads),
  };
  const receiptBytes = canonicalRecordBytes("receipt", receipt);
  writeFileSync(join(generationRoot, "receipt.json"), receiptBytes, { mode: 0o600 });
  const activation: ActivationRecord = {
    schemaVersion: 1,
    manifestDigest: plan.manifest.digest,
    receiptDigest: sha256Bytes(receiptBytes),
    generation: `generations/${plan.manifest.digest}/content`,
  };
  return Object.freeze({ generationRoot, receipt, activation });
}

function expectedGenerationRecords(
  store: ReturnType<typeof createOrOpenOwnedStore>,
  plan: PlannedFixture,
  payloads: readonly ProjectionPayload[],
): Readonly<{ receipt: GenerationReceipt; activation: ActivationRecord }> {
  const receipt: GenerationReceipt = {
    schemaVersion: 1,
    rootId: store.rootRecord.rootId,
    manifestDigest: plan.manifest.digest,
    entries: receiptEntries(plan, payloads),
  };
  const receiptBytes = canonicalRecordBytes("receipt", receipt);
  const activation: ActivationRecord = {
    schemaVersion: 1,
    manifestDigest: plan.manifest.digest,
    receiptDigest: sha256Bytes(receiptBytes),
    generation: `generations/${plan.manifest.digest}/content`,
  };
  return Object.freeze({ receipt, activation });
}

function materializeStaging(
  fixture: MaterializedStore,
  transactionId: string,
  plan: PlannedFixture,
  payloads: readonly ProjectionPayload[],
): string {
  const stagingRoot = join(fixture.store.layout.staging, transactionId);
  const contentRoot = join(stagingRoot, "content");
  mkdirSync(contentRoot, { recursive: true, mode: 0o700 });
  const payloadById = new Map(payloads.map((payload) => [payload.artifactId, payload.bytes]));
  for (const entry of plan.manifest.entries) {
    const bytes = payloadById.get(entry.artifactId);
    if (bytes === undefined) throw new Error("fixture payload is missing");
    const target = join(contentRoot, ...entry.target.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
  const staging: StagingRecord = {
    schemaVersion: 1,
    rootId: fixture.store.rootRecord.rootId,
    transactionId,
    manifestDigest: plan.manifest.digest,
  };
  writeFileSync(join(stagingRoot, "staging.json"), canonicalRecordBytes("staging", staging), {
    mode: 0o600,
  });
  return stagingRoot;
}

function materializeActiveStore(): MaterializedStore {
  const root = temporaryProject();
  const store = createOrOpenOwnedStore(root.projectRoot);
  const plan = requirePlanned(plannedFixture());
  const materialized = materializeGeneration(store, plan, payloadFixture());
  writeFileSync(store.layout.active, canonicalRecordBytes("activation", materialized.activation), {
    mode: 0o600,
  });
  return Object.freeze({
    root,
    store,
    manifestDigest: plan.manifest.digest,
    generationRoot: materialized.generationRoot,
    receipt: materialized.receipt,
    activation: materialized.activation,
  });
}

function maximumDirectoryPayloads(): ProjectionPayload[] {
  return Array.from({ length: 64 }, (_, index) => ({
    artifactId: `maximum-${index}`,
    bytes: Buffer.from([index]),
  }));
}

function maximumDirectoryPlan(payloads: readonly ProjectionPayload[]): PlannedFixture {
  return requirePlanned(
    plannedPayloadSet(payloads, (artifactId) => `${artifactId}/d0/d1/d2/d3/d4/d5/d6/file.md`),
  );
}

function materializeOverCapacityStore(): MaterializedStore {
  const root = temporaryProject();
  const store = createOrOpenOwnedStore(root.projectRoot);
  const payloads = maximumDirectoryPayloads();
  const plan = maximumDirectoryPlan(payloads);
  const materialized = materializeGeneration(store, plan, payloads);
  writeFileSync(store.layout.active, canonicalRecordBytes("activation", materialized.activation), {
    mode: 0o600,
  });
  materializeGeneration(store, requirePlanned(plannedFixture()), payloadFixture());
  return Object.freeze({
    root,
    store,
    manifestDigest: plan.manifest.digest,
    generationRoot: materialized.generationRoot,
    receipt: materialized.receipt,
    activation: materialized.activation,
  });
}
function materializeCleanStore(): MaterializedCleanStore {
  const fixture = materializeActiveStore();
  const activePlan = requirePlanned(alternatePlannedFixture());
  const active = materializeGeneration(fixture.store, activePlan, alternatePayloadFixture());
  writeFileSync(
    fixture.store.layout.active,
    canonicalRecordBytes("activation", active.activation),
    { mode: 0o600 },
  );
  return Object.freeze({
    fixture,
    activeGenerationRoot: active.generationRoot,
    activeActivation: active.activation,
  });
}

function applyInput(fixture: MaterializedStore) {
  return {
    mode: "apply" as const,
    projectRoot: fixture.root.projectRoot,
    plan: binaryPlannedFixture(),
    payloads: binaryPayloadFixture(),
    expectedActiveDigest: fixture.manifestDigest,
  };
}

function applyProjectionWithRuntime(value: unknown, runtime: ApplyRuntime): unknown {
  const implementation = (
    generationStoreModule as unknown as {
      applyProjectionWithRuntime?: ApplyProjectionWithRuntimeFunction;
    }
  ).applyProjectionWithRuntime;
  if (implementation === undefined)
    throw new Error("applyProjectionWithRuntime is not implemented");
  return implementation(value, runtime);
}

function cleanProjectionGenerationWithRuntime(
  value: unknown,
  runtime: CleanRuntime,
): CleanProjectionResult {
  const implementation = (
    generationStoreModule as unknown as {
      cleanProjectionGenerationWithRuntime?: CleanProjectionWithRuntimeFunction;
    }
  ).cleanProjectionGenerationWithRuntime;
  if (implementation === undefined) {
    throw new Error("cleanProjectionGenerationWithRuntime is not implemented");
  }
  return implementation(value, runtime);
}

function recoverProjectionStore(value: unknown): RecoveryProjectionResult {
  const implementation = (
    generationStoreModule as unknown as {
      recoverProjectionStore?: RecoverProjectionFunction;
    }
  ).recoverProjectionStore;
  if (implementation === undefined) throw new Error("recoverProjectionStore is not implemented");
  return implementation(value);
}

function recoverProjectionStoreWithRuntime(
  value: unknown,
  runtime: RecoveryRuntime,
): RecoveryProjectionResult {
  const implementation = (
    generationStoreModule as unknown as {
      recoverProjectionStoreWithRuntime?: RecoverProjectionWithRuntimeFunction;
    }
  ).recoverProjectionStoreWithRuntime;
  if (implementation === undefined) {
    throw new Error("recoverProjectionStoreWithRuntime is not implemented");
  }
  return implementation(value, runtime);
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

function recoveryFaultRuntime(point: RecoveryFaultPoint): RecoveryRuntime {
  return Object.freeze({
    onFaultPoint(candidate: RecoveryFaultPoint): void {
      if (candidate === point) throw new Error(`injected:${point}`);
    },
    lockRuntime: Object.freeze({
      pid: process.pid,
      randomToken: () => LOCK_TOKEN,
      pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
    }),
  });
}

function readActivation(store: ReturnType<typeof createOrOpenOwnedStore>): ActivationRecord | null {
  if (!existsSync(store.layout.active)) return null;
  return readStoreRecord(store, store.layout.active, ActivationRecordSchema, "activation").record;
}

function expectRecovery(
  result: RecoveryProjectionResult,
  state: RecoveryProjectionResult["state"],
  activeDigest: string | null,
  findingCode?: string,
): void {
  expect(result.state, JSON.stringify(result)).toBe(state);
  expect(result.activeDigest).toBe(activeDigest);
  if (findingCode === undefined) {
    expect(result.findings).toEqual([]);
  } else {
    expect(result.findings.map((finding) => finding.code)).toContain(findingCode);
  }
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

function namesIfPresent(path: string): readonly string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
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

function pathSnapshot(path: string): Readonly<Record<string, string>> | null {
  return existsSync(path) ? identityTreeSnapshot(path) : null;
}

function generationSnapshots(
  store: ReturnType<typeof createOrOpenOwnedStore>,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const inventory = inspectFixedStoreLayout(store);
  return Object.freeze(
    Object.fromEntries(
      inventory.generations.map(({ manifestDigest }) => [
        manifestDigest,
        identityTreeSnapshot(join(store.layout.generations, manifestDigest)),
      ]),
    ),
  );
}

function inventorySnapshot(store: ReturnType<typeof createOrOpenOwnedStore>): unknown {
  try {
    return inspectFixedStoreLayout(store);
  } catch (error) {
    return Object.freeze({
      error: error instanceof Error ? error.message : "unknown inventory failure",
    });
  }
}

function fixedStoreSnapshot(fixture: MaterializedStore): Readonly<Record<string, unknown>> {
  const { layout } = fixture.store;
  return Object.freeze({
    rootRecord: pathSnapshot(layout.rootRecord),
    active: pathSnapshot(layout.active),
    inventory: inventorySnapshot(fixture.store),
    transactions: pathSnapshot(layout.transactions),
    staging: pathSnapshot(layout.staging),
    generations: pathSnapshot(layout.generations),
    trash: pathSnapshot(layout.trash),
  });
}

function expectExactActivation(
  store: ReturnType<typeof createOrOpenOwnedStore>,
  expected: ActivationRecord,
): void {
  const expectedBytes = canonicalRecordBytes("activation", expected);
  expect(readFileSync(store.layout.active)).toEqual(expectedBytes);
  expect(readActivation(store)).toEqual(expected);
  expect(readActivation(store)?.receiptDigest).toBe(expected.receiptDigest);
}

function nextApplyState(
  fixture: MaterializedStore,
  transactionId: string,
  phase: Extract<TransactionRecord, { operation: "apply" }>["phase"],
): Readonly<{
  plan: PlannedFixture;
  payloads: readonly ProjectionPayload[];
  receipt: GenerationReceipt;
  activation: ActivationRecord;
  journal: Extract<TransactionRecord, { operation: "apply" }>;
}> {
  const plan = requirePlanned(binaryPlannedFixture());
  const payloads = binaryPayloadFixture();
  const { receipt, activation } = expectedGenerationRecords(fixture.store, plan, payloads);
  const journal: Extract<TransactionRecord, { operation: "apply" }> = {
    schemaVersion: 1,
    operation: "apply",
    rootId: fixture.store.rootRecord.rootId,
    transactionId,
    phase,
    manifestDigest: plan.manifest.digest,
    oldActivation: fixture.activation,
    newActivation: activation,
    entries: receipt.entries,
  };
  return Object.freeze({ plan, payloads, receipt, activation, journal });
}

function writeTransactionTemporary(
  fixture: MaterializedStore,
  transactionId: string,
  phase: Extract<TransactionRecord, { operation: "apply" }>["phase"],
  record: Extract<TransactionRecord, { operation: "apply" }>,
): string {
  const path = join(fixture.store.layout.transactions, `.${transactionId}.${phase}.tmp`);
  writeFileSync(path, canonicalRecordBytes("transaction", record), { mode: 0o600 });
  return path;
}

function transactionFor(
  fixture: MaterializedStore,
  transactionId: string,
  phase: Extract<TransactionRecord, { operation: "apply" }>["phase"] = "committed",
): Extract<TransactionRecord, { operation: "apply" }> {
  return {
    schemaVersion: 1,
    operation: "apply",
    rootId: fixture.store.rootRecord.rootId,
    transactionId,
    phase,
    manifestDigest: fixture.manifestDigest,
    oldActivation: null,
    newActivation: fixture.activation,
    entries: fixture.receipt.entries,
  };
}

function writeTransaction(
  fixture: MaterializedStore,
  transactionId: string,
  record: TransactionRecord = transactionFor(fixture, transactionId),
): string {
  mkdirSync(fixture.store.layout.transactions, { recursive: true, mode: 0o700 });
  const path = join(fixture.store.layout.transactions, `${transactionId}.json`);
  writeFileSync(path, canonicalRecordBytes("transaction", record), { mode: 0o600 });
  return path;
}

function materializeLegacyIncompleteGeneration(
  fixture: MaterializedStore,
  state: ReturnType<typeof nextApplyState>,
  options: Readonly<{
    content?: boolean;
    receipt?: GenerationReceipt;
    markerTransactionId?: string;
  }> = {},
): string {
  const generationRoot = join(fixture.store.layout.generations, state.plan.manifest.digest);
  mkdirSync(generationRoot, { recursive: true, mode: 0o700 });
  if (options.content !== false) {
    const contentRoot = join(generationRoot, "content");
    mkdirSync(contentRoot, { recursive: true, mode: 0o700 });
    const payloadById = new Map(
      state.payloads.map((payload) => [payload.artifactId, payload.bytes] as const),
    );
    for (const entry of state.plan.manifest.entries) {
      const bytes = payloadById.get(entry.artifactId);
      if (bytes === undefined) throw new Error("legacy fixture payload is missing");
      const target = join(contentRoot, ...entry.target.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
    }
  }
  writeFileSync(
    join(generationRoot, "incomplete.json"),
    canonicalRecordBytes("incomplete", {
      schemaVersion: 1,
      rootId: fixture.store.rootRecord.rootId,
      transactionId: options.markerTransactionId ?? state.journal.transactionId,
      manifestDigest: state.plan.manifest.digest,
    }),
    { mode: 0o600 },
  );
  if (options.receipt !== undefined) {
    writeFileSync(
      join(generationRoot, "receipt.json"),
      canonicalRecordBytes("receipt", options.receipt),
      { mode: 0o600 },
    );
  }
  return generationRoot;
}

type ChildRequest = Readonly<Record<string, unknown>>;

function spawnHelper(requestPath: string) {
  return spawnSync(process.execPath, ["--import", "tsx", HELPER_PATH, requestPath], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
}

function spawnHelperAsync(requestPath: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["--import", "tsx", HELPER_PATH, requestPath], {
    windowsHide: true,
    stdio: "pipe",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

function waitForChildMarker(
  child: ChildProcessWithoutNullStreams,
  marker: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`child did not emit ${marker} within ${timeoutMs}ms; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(marker)) finish();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      if (!stdout.includes(marker)) {
        finish(
          new Error(
            `child exited before ${marker}; code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
          ),
        );
      }
    });
    child.once("error", (error) => finish(error));
  });
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 30_000,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(Object.freeze({ code: child.exitCode, signal: child.signalCode }));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise(Object.freeze({ code, signal }));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}
function runChild(root: TemporaryProject, label: string, request: ChildRequest) {
  const requestPath = join(root.sandboxRoot, `${label}-request.json`);
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  const child = spawnHelper(requestPath);
  rmSync(requestPath, { force: true });
  return child;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root.sandboxRoot, { recursive: true, force: true });
  }
});

describe("generation store deterministic recovery", () => {
  it.each(
    APPLY_FAULT_POINTS,
  )("recovers an in-process interruption at %s idempotently without changing the old generation", (point) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);
    const next = requirePlanned(binaryPlannedFixture());
    const nextRecords = expectedGenerationRecords(fixture.store, next, binaryPayloadFixture());

    expect(() => applyProjectionWithRuntime(applyInput(fixture), faultRuntime(point))).toThrow(
      `injected:${point}`,
    );
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expect(namesIfPresent(fixture.store.layout.transactions).length).toBeGreaterThan(0);
    const expectedActivation = POST_ACTIVATION_POINTS.has(point)
      ? nextRecords.activation
      : fixture.activation;
    expectExactActivation(fixture.store, expectedActivation);
    expect(expectedActivation.receiptDigest).toBe(
      POST_ACTIVATION_POINTS.has(point)
        ? sha256Bytes(canonicalRecordBytes("receipt", nextRecords.receipt))
        : sha256Bytes(canonicalRecordBytes("receipt", fixture.receipt)),
    );
    const nextGenerationRoot = join(fixture.store.layout.generations, next.manifest.digest);
    const completedNextBeforeRecovery = COMPLETED_NEXT_GENERATION_POINTS.has(point)
      ? identityTreeSnapshot(nextGenerationRoot)
      : null;
    if (completedNextBeforeRecovery !== null) {
      expect(readFileSync(join(nextGenerationRoot, "receipt.json"))).toEqual(
        canonicalRecordBytes("receipt", nextRecords.receipt),
      );
    }

    const recovered = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });
    const expectedDigest = POST_ACTIVATION_POINTS.has(point)
      ? next.manifest.digest
      : fixture.manifestDigest;
    expectRecovery(recovered, "recovered", expectedDigest);
    expectExactActivation(fixture.store, expectedActivation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    if (completedNextBeforeRecovery !== null) {
      expect(identityTreeSnapshot(nextGenerationRoot)).toEqual(completedNextBeforeRecovery);
    }
    const inventory = inspectFixedStoreLayout(fixture.store);
    expect(inventory).toMatchObject({
      lockPresent: false,
      lockCandidates: [],
      transactions: [],
      staging: [],
      trash: [],
    });
    for (const generation of inventory.generations) {
      expect(
        existsSync(
          join(fixture.store.layout.generations, generation.manifestDigest, "incomplete.json"),
        ),
      ).toBe(false);
    }

    const inventoryAfterFirstRecovery = inspectFixedStoreLayout(fixture.store);
    const activationAfterFirstRecovery = readFileSync(fixture.store.layout.active);
    const generationsAfterFirstRecovery = generationSnapshots(fixture.store);
    const repeated = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });
    expectRecovery(repeated, "nothing-to-recover", expectedDigest);
    expect(inspectFixedStoreLayout(fixture.store)).toEqual(inventoryAfterFirstRecovery);
    expect(readFileSync(fixture.store.layout.active)).toEqual(activationAfterFirstRecovery);
    expect(generationSnapshots(fixture.store)).toEqual(generationsAfterFirstRecovery);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("recovers a legal maximum-directory plan after receipt publication", () => {
    const root = temporaryProject();
    const payloads = maximumDirectoryPayloads();
    const plan = maximumDirectoryPlan(payloads);

    expect(() =>
      applyProjectionWithRuntime(
        {
          mode: "apply",
          projectRoot: root.projectRoot,
          plan,
          payloads,
          expectedActiveDigest: null,
        },
        faultRuntime("after-receipt-written"),
      ),
    ).toThrow("injected:after-receipt-written");

    expect(recoverProjectionStore({ projectRoot: root.projectRoot })).toMatchObject({
      state: "recovered",
      activeDigest: null,
      findings: [],
    });
    expect(recoverProjectionStore({ projectRoot: root.projectRoot })).toMatchObject({
      state: "nothing-to-recover",
      activeDigest: null,
      findings: [],
    });
  }, 90_000);

  it("recovers a legal 64 MiB transient apply without sharing persistent and staging budgets", () => {
    const root = temporaryProject();
    const chunk = Buffer.alloc(MAX_PAYLOAD_BYTES);
    const payloads = Array.from(
      { length: MAX_TOTAL_PAYLOAD_BYTES / MAX_PAYLOAD_BYTES },
      (_, index) => ({
        artifactId: `maximum-byte-${index}`,
        bytes: chunk,
      }),
    );
    const plan = requirePlanned(plannedPayloadSet(payloads));
    expect(payloads.reduce((total, payload) => total + payload.bytes.byteLength, 0)).toBe(
      MAX_TOTAL_PAYLOAD_BYTES,
    );

    expect(() =>
      applyProjectionWithRuntime(
        {
          mode: "apply",
          projectRoot: root.projectRoot,
          plan,
          payloads,
          expectedActiveDigest: null,
        },
        faultRuntime("after-receipt-written"),
      ),
    ).toThrow("injected:after-receipt-written");

    expectRecovery(recoverProjectionStore({ projectRoot: root.projectRoot }), "recovered", null);
    expectRecovery(
      recoverProjectionStore({ projectRoot: root.projectRoot }),
      "nothing-to-recover",
      null,
    );
  }, 180_000);

  it("fails closed without mutation when stable persistent history exceeds its aggregate budget", () => {
    const fixture = materializeOverCapacityStore();
    const outside = makeSiblingCanary(fixture.root);
    const before = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  }, 60_000);

  it("fails closed before cleaning pending state when persistent history exceeds its aggregate budget", () => {
    const fixture = materializeOverCapacityStore();
    const outside = makeSiblingCanary(fixture.root);
    const nextPlan = requirePlanned(binaryPlannedFixture());
    const next = expectedGenerationRecords(fixture.store, nextPlan, binaryPayloadFixture());
    const journal: Extract<TransactionRecord, { operation: "apply" }> = {
      schemaVersion: 1,
      operation: "apply",
      rootId: fixture.store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      phase: "prepared",
      manifestDigest: nextPlan.manifest.digest,
      oldActivation: fixture.activation,
      newActivation: next.activation,
      entries: next.receipt.entries,
    };
    writeTransaction(fixture, TRANSACTION_ID, journal);
    const before = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  }, 60_000);

  it("shares one persistent-history budget across a pending clean target and retained generations", () => {
    const fixture = materializeOverCapacityStore();
    const outside = makeSiblingCanary(fixture.root);
    const targetPlan = requirePlanned(plannedFixture());
    const target = expectedGenerationRecords(fixture.store, targetPlan, payloadFixture());
    const journal: Extract<TransactionRecord, { operation: "clean" }> = {
      schemaVersion: 1,
      operation: "clean",
      rootId: fixture.store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      phase: "prepared",
      generationDigest: targetPlan.manifest.digest,
      oldActivation: fixture.activation,
      entries: target.receipt.entries,
    };
    writeTransaction(fixture, TRANSACTION_ID, journal);
    const before = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  }, 60_000);

  it.each(
    APPLY_FAULT_POINTS,
  )("recovers a first-apply interruption at %s without inventing an activation", (point) => {
    const root = temporaryProject();
    const outside = makeSiblingCanary(root);
    const store = createOrOpenOwnedStore(root.projectRoot);
    const plan = requirePlanned(binaryPlannedFixture());
    const payloads = binaryPayloadFixture();
    const records = expectedGenerationRecords(store, plan, payloads);

    expect(() =>
      applyProjectionWithRuntime(
        {
          mode: "apply",
          projectRoot: root.projectRoot,
          plan,
          payloads,
          expectedActiveDigest: null,
        },
        faultRuntime(point),
      ),
    ).toThrow(`injected:${point}`);

    if (POST_ACTIVATION_POINTS.has(point)) {
      expectExactActivation(store, records.activation);
    } else {
      expect(existsSync(store.layout.active)).toBe(false);
    }
    const generationRoot = join(store.layout.generations, plan.manifest.digest);
    const completedBeforeRecovery = COMPLETED_NEXT_GENERATION_POINTS.has(point)
      ? identityTreeSnapshot(generationRoot)
      : null;

    const recovered = recoverProjectionStore({ projectRoot: root.projectRoot });
    const expectedDigest = POST_ACTIVATION_POINTS.has(point) ? plan.manifest.digest : null;
    expectRecovery(recovered, "recovered", expectedDigest);
    if (POST_ACTIVATION_POINTS.has(point)) {
      expectExactActivation(store, records.activation);
    } else {
      expect(existsSync(store.layout.active)).toBe(false);
    }
    if (completedBeforeRecovery !== null) {
      expect(identityTreeSnapshot(generationRoot)).toEqual(completedBeforeRecovery);
    }
    expectRecovery(
      recoverProjectionStore({ projectRoot: root.projectRoot }),
      "nothing-to-recover",
      expectedDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it.each(
    APPLY_FAULT_POINTS,
  )("preserves a pre-existing exact candidate across recovery at %s", (point) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const plan = requirePlanned(binaryPlannedFixture());
    const payloads = binaryPayloadFixture();
    const candidate = materializeGeneration(fixture.store, plan, payloads);
    const candidateBefore = identityTreeSnapshot(candidate.generationRoot);
    const oldBefore = identityTreeSnapshot(fixture.generationRoot);

    expect(() =>
      applyProjectionWithRuntime(
        {
          mode: "apply",
          projectRoot: fixture.root.projectRoot,
          plan,
          payloads,
          expectedActiveDigest: fixture.manifestDigest,
        },
        faultRuntime(point),
      ),
    ).toThrow(`injected:${point}`);

    const recovered = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });
    const expectedDigest = POST_ACTIVATION_POINTS.has(point)
      ? plan.manifest.digest
      : fixture.manifestDigest;
    expectRecovery(recovered, "recovered", expectedDigest);
    expect(identityTreeSnapshot(candidate.generationRoot)).toEqual(candidateBefore);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldBefore);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("removes bounded torn ordinary scratch created before staging publication", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);
    expect(() =>
      applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-stage-created")),
    ).toThrow("injected:after-stage-created");
    const transactionId = namesIfPresent(fixture.store.layout.transactions)[0]?.replace(
      /\.json$/u,
      "",
    );
    expect(transactionId).toBeDefined();
    if (transactionId === undefined) throw new Error("transaction id is absent");
    const scratchRoot = join(fixture.store.layout.trash, transactionId);
    const tornPath = join(scratchRoot, "torn.bin");
    writeFileSync(tornPath, Buffer.from([0x7b, 0xff, 0x00, 0x7d]), { mode: 0o600 });
    expect(existsSync(tornPath)).toBe(true);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expect(existsSync(scratchRoot)).toBe(false);
    expect(namesIfPresent(fixture.store.layout.transactions)).toEqual([]);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("removes bounded corrupted ordinary scratch created before receipt publication", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const next = requirePlanned(binaryPlannedFixture());
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);
    expect(() =>
      applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-generation-content")),
    ).toThrow("injected:after-generation-content");
    const transactionId = namesIfPresent(fixture.store.layout.transactions)[0]?.replace(
      /\.json$/u,
      "",
    );
    expect(transactionId).toBeDefined();
    if (transactionId === undefined) throw new Error("transaction id is absent");
    const target = next.manifest.entries[0]?.target;
    if (target === undefined) throw new Error("next target entry is absent");
    const scratchRoot = join(fixture.store.layout.trash, transactionId);
    const corruptedPath = join(scratchRoot, "content", ...target.split("/"));
    writeFileSync(corruptedPath, Buffer.from("corrupted unpublished scratch\n", "utf8"), {
      mode: 0o600,
    });
    expect(readFileSync(corruptedPath, "utf8")).toBe("corrupted unpublished scratch\n");

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expect(existsSync(scratchRoot)).toBe(false);
    expect(namesIfPresent(fixture.store.layout.transactions)).toEqual([]);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("fails closed and retains hard-linked unpublished scratch", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    expect(() =>
      applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-stage-created")),
    ).toThrow("injected:after-stage-created");
    const transactionId = namesIfPresent(fixture.store.layout.transactions)[0]?.replace(
      /\.json$/u,
      "",
    );
    expect(transactionId).toBeDefined();
    if (transactionId === undefined) throw new Error("transaction id is absent");
    const scratchRoot = join(fixture.store.layout.trash, transactionId);
    linkSync(outside.canary, join(scratchRoot, "hard-linked-canary"));
    const scratchBefore = identityTreeSnapshot(scratchRoot);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_PATH_UNSAFE",
    );
    expect(identityTreeSnapshot(scratchRoot)).toEqual(scratchBefore);
    expectExactActivation(fixture.store, fixture.activation);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("fails closed and retains symbolic-linked unpublished scratch", ({ skip }) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    expect(() =>
      applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-stage-created")),
    ).toThrow("injected:after-stage-created");
    const transactionId = namesIfPresent(fixture.store.layout.transactions)[0]?.replace(
      /\.json$/u,
      "",
    );
    expect(transactionId).toBeDefined();
    if (transactionId === undefined) throw new Error("transaction id is absent");
    const scratchRoot = join(fixture.store.layout.trash, transactionId);
    try {
      symlinkSync(outside.canary, join(scratchRoot, "symbolic-canary"), "file");
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String(error.code)
          : "unknown";
      expect(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]).toContain(code);
      skip(`symbolic-link fixture is unavailable on this runner: ${code}`);
      return;
    }
    const scratchBefore = identityTreeSnapshot(scratchRoot);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_PATH_UNSAFE",
    );
    expect(identityTreeSnapshot(scratchRoot)).toEqual(scratchBefore);
    expectExactActivation(fixture.store, fixture.activation);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("converges a legacy receipt-complete incomplete generation without selecting it", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-reserved");
    const incompleteRoot = materializeLegacyIncompleteGeneration(fixture, state, {
      receipt: state.receipt,
    });
    const journalPath = writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const activeBefore = identityTreeSnapshot(fixture.generationRoot);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expect(existsSync(incompleteRoot)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(activeBefore);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("converges a legacy partial incomplete generation without receipt authority", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "staged");
    const incompleteRoot = materializeLegacyIncompleteGeneration(fixture, state);
    writeTransaction(fixture, TRANSACTION_ID, state.journal);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expect(existsSync(incompleteRoot)).toBe(false);
    expectExactActivation(fixture.store, fixture.activation);
  });

  it("retains a legacy incomplete generation whose marker is not journal-bound", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-reserved");
    materializeLegacyIncompleteGeneration(fixture, state, {
      markerTransactionId: OTHER_TRANSACTION_ID,
    });
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("retains a legacy incomplete generation whose receipt is not journal-bound", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-reserved");
    materializeLegacyIncompleteGeneration(fixture, state, {
      receipt: {
        ...state.receipt,
        entries: state.receipt.entries.map((entry, index) =>
          index === 0 ? { ...entry, bytes: entry.bytes + 1 } : entry,
        ),
      },
    });
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("retains an unclassified legacy marker-plus-receipt shape", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-reserved");
    materializeLegacyIncompleteGeneration(fixture, state, {
      content: false,
      receipt: state.receipt,
    });
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("fails closed when a generation-verified journal has no complete generation", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-verified");
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("fails closed when an apply journal receipt digest is not journal-bound", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    const journal: Extract<TransactionRecord, { operation: "apply" }> = {
      ...state.journal,
      newActivation: { ...state.activation, receiptDigest: "f".repeat(64) },
    };
    writeTransaction(fixture, TRANSACTION_ID, journal);
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("fails closed when an apply journal records identical activation sides", () => {
    const fixture = materializeActiveStore();
    const journal: Extract<TransactionRecord, { operation: "apply" }> = {
      ...transactionFor(fixture, TRANSACTION_ID, "prepared"),
      oldActivation: fixture.activation,
    };
    writeTransaction(fixture, TRANSACTION_ID, journal);
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("fails closed on an unrelated unclassified generation during apply recovery", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    const unrelatedRoot = join(fixture.store.layout.generations, OTHER_TRANSACTION_ID);
    mkdirSync(unrelatedRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(unrelatedRoot, "receipt.json"),
      canonicalRecordBytes("receipt", {
        ...fixture.receipt,
        manifestDigest: OTHER_TRANSACTION_ID,
      }),
      { mode: 0o600 },
    );
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("rejects a non-immediate apply journal temporary", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const temporaryPath = join(
      fixture.store.layout.transactions,
      `.${TRANSACTION_ID}.generation-reserved.tmp`,
    );
    writeFileSync(temporaryPath, Buffer.from("torn", "utf8"), { mode: 0o600 });
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("rejects an activation temporary outside the activation-ready phase", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    writeFileSync(
      join(fixture.store.layout.root, `.active.${TRANSACTION_ID}.tmp`),
      Buffer.from("torn", "utf8"),
      { mode: 0o600 },
    );
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("rejects apply residue bound to a different transaction", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    mkdirSync(join(fixture.store.layout.staging, OTHER_TRANSACTION_ID), {
      recursive: true,
      mode: 0o700,
    });
    const before = fixedStoreSnapshot(fixture);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
  });

  it("retains exact staging and unpublished scratch remnants until recovery", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const next = requirePlanned(binaryPlannedFixture());

    expect(() =>
      applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-generation-content")),
    ).toThrow("injected:after-generation-content");
    expect(namesIfPresent(fixture.store.layout.staging)).toHaveLength(1);
    expect(namesIfPresent(fixture.store.layout.trash)).toHaveLength(1);
    expect(existsSync(join(fixture.store.layout.generations, next.manifest.digest))).toBe(false);

    const recovered = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });
    expectRecovery(recovered, "recovered", fixture.manifestDigest);
    expect(namesIfPresent(fixture.store.layout.staging)).toEqual([]);
    expect(namesIfPresent(fixture.store.layout.trash)).toEqual([]);
    expect(existsSync(join(fixture.store.layout.generations, next.manifest.digest))).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("rejects unrelated incomplete residue before removing journal-bound recovery state", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    expect(() =>
      applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-generation-content")),
    ).toThrow("injected:after-generation-content");
    const unrelatedDigest = requirePlanned(alternatePlannedFixture()).manifest.digest;
    const unrelatedRoot = join(fixture.store.layout.generations, unrelatedDigest);
    mkdirSync(unrelatedRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(unrelatedRoot, "incomplete.json"),
      canonicalRecordBytes("incomplete", {
        schemaVersion: 1,
        rootId: fixture.store.rootRecord.rootId,
        transactionId: OTHER_TRANSACTION_ID,
        manifestDigest: unrelatedDigest,
      }),
      { mode: 0o600 },
    );
    const before = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it.each(
    RECOVERY_FAULT_POINTS,
  )("converges after recovery itself is interrupted at %s", (point) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);

    switch (point) {
      case "after-recovery-trash-removed":
        expect(() =>
          applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-stage-created")),
        ).toThrow("injected:after-stage-created");
        break;
      case "after-recovery-incomplete-removed": {
        const state = nextApplyState(fixture, TRANSACTION_ID, "generation-reserved");
        materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
        const generation = materializeGeneration(fixture.store, state.plan, state.payloads);
        rmSync(join(generation.generationRoot, "receipt.json"));
        writeFileSync(
          join(generation.generationRoot, "incomplete.json"),
          canonicalRecordBytes("incomplete", {
            schemaVersion: 1,
            rootId: fixture.store.rootRecord.rootId,
            transactionId: TRANSACTION_ID,
            manifestDigest: state.plan.manifest.digest,
          }),
          { mode: 0o600 },
        );
        writeTransaction(fixture, TRANSACTION_ID, state.journal);
        break;
      }
      case "after-recovery-activation-temporary-removed": {
        const state = nextApplyState(fixture, TRANSACTION_ID, "generation-verified");
        materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
        materializeGeneration(fixture.store, state.plan, state.payloads);
        writeTransaction(fixture, TRANSACTION_ID, state.journal);
        writeFileSync(
          join(fixture.store.layout.root, `.active.${TRANSACTION_ID}.tmp`),
          canonicalRecordBytes("activation", state.activation),
          { mode: 0o600 },
        );
        break;
      }
      case "after-recovery-transaction-temporary-removed": {
        const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
        materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
        writeTransaction(fixture, TRANSACTION_ID, state.journal);
        writeTransactionTemporary(fixture, TRANSACTION_ID, "staged", {
          ...state.journal,
          phase: "staged",
        });
        break;
      }
      default:
        expect(() =>
          applyProjectionWithRuntime(
            applyInput(fixture),
            faultRuntime("after-generation-reserved"),
          ),
        ).toThrow("injected:after-generation-reserved");
    }

    expect(() =>
      recoverProjectionStoreWithRuntime(
        { projectRoot: fixture.root.projectRoot },
        recoveryFaultRuntime(point),
      ),
    ).toThrow(`injected:${point}`);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expect(inspectFixedStoreLayout(fixture.store)).toMatchObject({
      lockPresent: false,
      transactions: [],
      staging: [],
      trash: [],
    });
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("removes a lone correctly named torn prepared temporary as non-authoritative", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);
    mkdirSync(fixture.store.layout.transactions, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      fixture.store.layout.transactions,
      `.${TRANSACTION_ID}.prepared.tmp`,
    );
    writeFileSync(temporaryPath, Buffer.from('{"schemaVersion":', "utf8"), { mode: 0o600 });

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expect(existsSync(temporaryPath)).toBe(false);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("removes torn bytes from the exact journal-bound next-phase temporary", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    const stagingRoot = materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
    const journalPath = writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const temporaryPath = join(fixture.store.layout.transactions, `.${TRANSACTION_ID}.staged.tmp`);
    writeFileSync(temporaryPath, Buffer.from([0x7b, 0x22, 0xff, 0x00]), { mode: 0o600 });
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("removes torn bytes from the journal-bound activation temporary without selecting it", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-verified");
    const stagingRoot = materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
    const nextGeneration = materializeGeneration(fixture.store, state.plan, state.payloads);
    const nextGenerationBefore = identityTreeSnapshot(nextGeneration.generationRoot);
    const oldGenerationBefore = identityTreeSnapshot(fixture.generationRoot);
    const journalPath = writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const temporaryPath = join(fixture.store.layout.root, `.active.${TRANSACTION_ID}.tmp`);
    writeFileSync(temporaryPath, Buffer.from('{"schemaVersion":1', "utf8"), { mode: 0o600 });

    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "recovered",
      fixture.manifestDigest,
    );
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGenerationBefore);
    expect(identityTreeSnapshot(nextGeneration.generationRoot)).toEqual(nextGenerationBefore);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("accepts only the exact journal-bound next-phase transaction temporary", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    const stagingRoot = materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
    const journalPath = writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const stagedJournal: Extract<TransactionRecord, { operation: "apply" }> = {
      ...state.journal,
      phase: "staged",
    };
    const temporaryPath = writeTransactionTemporary(
      fixture,
      TRANSACTION_ID,
      "staged",
      stagedJournal,
    );
    expect(readFileSync(temporaryPath)).toEqual(canonicalRecordBytes("transaction", stagedJournal));
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(result, "recovered", fixture.manifestDigest);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("accepts an exact journal-bound activation temporary without selecting it as fallback", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-verified");
    const stagingRoot = materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
    const nextGeneration = materializeGeneration(fixture.store, state.plan, state.payloads);
    const nextGenerationBefore = identityTreeSnapshot(nextGeneration.generationRoot);
    const oldGenerationBefore = identityTreeSnapshot(fixture.generationRoot);
    const journalPath = writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const temporaryPath = join(fixture.store.layout.root, `.active.${TRANSACTION_ID}.tmp`);
    writeFileSync(temporaryPath, canonicalRecordBytes("activation", state.activation), {
      mode: 0o600,
    });

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(result, "recovered", fixture.manifestDigest);
    expectExactActivation(fixture.store, fixture.activation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGenerationBefore);
    expect(identityTreeSnapshot(nextGeneration.generationRoot)).toEqual(nextGenerationBefore);
    expect(readFileSync(join(nextGeneration.generationRoot, "receipt.json"))).toEqual(
      canonicalRecordBytes("receipt", state.receipt),
    );
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("never treats a next-phase journal temporary as durable activation authority", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-reserved");
    materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
    materializeGeneration(fixture.store, state.plan, state.payloads);
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const temporaryJournal: Extract<TransactionRecord, { operation: "apply" }> = {
      ...state.journal,
      phase: "generation-verified",
    };
    writeTransactionTemporary(fixture, TRANSACTION_ID, "generation-verified", temporaryJournal);
    writeFileSync(
      fixture.store.layout.active,
      canonicalRecordBytes("activation", state.activation),
      { mode: 0o600 },
    );
    const before = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      state.activation.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("removes exact bounded scratch on the new activation side", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const state = nextApplyState(fixture, TRANSACTION_ID, "generation-verified");
    materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
    const activeGeneration = materializeGeneration(fixture.store, state.plan, state.payloads);
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    writeFileSync(
      fixture.store.layout.active,
      canonicalRecordBytes("activation", state.activation),
      { mode: 0o600 },
    );
    const trashRoot = join(fixture.store.layout.trash, TRANSACTION_ID);
    mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(trashRoot, "incomplete.json"),
      canonicalRecordBytes("incomplete", {
        schemaVersion: 1,
        rootId: fixture.store.rootRecord.rootId,
        transactionId: TRANSACTION_ID,
        manifestDigest: state.plan.manifest.digest,
      }),
      { mode: 0o600 },
    );
    const activeBefore = identityTreeSnapshot(activeGeneration.generationRoot);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(result, "recovered", state.activation.manifestDigest);
    expectExactActivation(fixture.store, state.activation);
    expect(identityTreeSnapshot(activeGeneration.generationRoot)).toEqual(activeBefore);
    expect(existsSync(trashRoot)).toBe(false);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      state.activation.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it.each([
    ["after-generation-reserved", false],
    ["after-activation-rename", true],
  ] as const)("resumes after exact cleanup sources are already absent at %s", (point, activated) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const next = requirePlanned(binaryPlannedFixture());

    expect(() => applyProjectionWithRuntime(applyInput(fixture), faultRuntime(point))).toThrow(
      `injected:${point}`,
    );
    const transactionId = namesIfPresent(fixture.store.layout.transactions)[0]?.replace(
      /\.json$/u,
      "",
    );
    expect(transactionId).toBeDefined();
    if (transactionId === undefined) throw new Error("transaction id is absent");
    rmSync(join(fixture.store.layout.staging, transactionId), {
      recursive: true,
      force: true,
    });
    if (!activated) {
      rmSync(join(fixture.store.layout.generations, next.manifest.digest), {
        recursive: true,
        force: true,
      });
    }

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });
    const expectedDigest = activated ? next.manifest.digest : fixture.manifestDigest;
    expectRecovery(result, "recovered", expectedDigest);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      expectedDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("resumes markerless exact quarantine deletion without guessing the wrong source", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    expect(() =>
      applyProjectionWithRuntime(applyInput(fixture), faultRuntime("after-generation-content")),
    ).toThrow("injected:after-generation-content");
    const transactionId = namesIfPresent(fixture.store.layout.transactions)[0]?.replace(
      /\.json$/u,
      "",
    );
    expect(transactionId).toBeDefined();
    if (transactionId === undefined) throw new Error("transaction id is absent");
    const trashRoot = join(fixture.store.layout.trash, transactionId);
    expect(existsSync(trashRoot)).toBe(true);
    expect(existsSync(join(trashRoot, "receipt.json"))).toBe(false);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(result, "recovered", fixture.manifestDigest);
    expectRecovery(
      recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
      "nothing-to-recover",
      fixture.manifestDigest,
    );
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("recovers an exact journal temporary before starting a later apply", () => {
    const fixture = materializeActiveStore();
    const state = nextApplyState(fixture, TRANSACTION_ID, "prepared");
    materializeStaging(fixture, TRANSACTION_ID, state.plan, state.payloads);
    writeTransaction(fixture, TRANSACTION_ID, state.journal);
    const nextJournal: Extract<TransactionRecord, { operation: "apply" }> = {
      ...state.journal,
      phase: "staged",
    };
    writeTransactionTemporary(fixture, TRANSACTION_ID, "staged", nextJournal);

    const result = generationStoreModule.applyProjection(applyInput(fixture));

    expect(result.state).toBe("applied");
    expect(result.activeDigest).toBe(state.plan.manifest.digest);
    expect(namesIfPresent(fixture.store.layout.transactions)).toEqual([]);
    expect(namesIfPresent(fixture.store.layout.staging)).toEqual([]);
  });

  it("allows exactly 128 aggregate recovery records before semantic fail-closed classification", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const pendingTransactionCount = MAX_RECOVERY_RECORDS - 1;
    for (let index = 1; index <= pendingTransactionCount; index += 1) {
      const transactionId = index.toString(16).padStart(64, "0");
      writeTransaction(fixture, transactionId);
    }
    const quarantineId = "0".repeat(64);
    const quarantinePath = join(fixture.store.layout.trash, quarantineId);
    mkdirSync(quarantinePath, { recursive: true, mode: 0o700 });
    const before = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(result.findings.map(({ code }) => code)).not.toContain(
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("counts the 129th cross-category recovery record before mutating uncertain state", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const pendingTransactionCount = MAX_RECOVERY_RECORDS - 1;
    for (let index = 1; index <= pendingTransactionCount; index += 1) {
      const transactionId = index.toString(16).padStart(64, "0");
      writeTransaction(fixture, transactionId);
    }
    mkdirSync(join(fixture.store.layout.trash, "0".repeat(64)), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(fixture.store.layout.staging, "f".repeat(64)), {
      recursive: true,
      mode: 0o700,
    });
    const before = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(result, "failed-closed", null, "METHODOLOGY_STORE_RESOURCE_LIMIT");
    expect(fixedStoreSnapshot(fixture)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it.each([
    "malformed-journal",
    "unjournaled-staging",
    "unjournaled-trash",
    "unjournaled-incomplete",
    "activation-temporary",
    "journal-temporary",
    "filename-record-mismatch",
  ] as const)("retains uncertain residue and fails closed: %s", (kind) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    let residuePath: string;
    switch (kind) {
      case "malformed-journal":
        mkdirSync(fixture.store.layout.transactions, { recursive: true, mode: 0o700 });
        residuePath = join(fixture.store.layout.transactions, `${TRANSACTION_ID}.json`);
        writeFileSync(residuePath, "{}\n", { mode: 0o600 });
        break;
      case "unjournaled-staging":
        residuePath = join(fixture.store.layout.staging, TRANSACTION_ID);
        mkdirSync(residuePath, { recursive: true, mode: 0o700 });
        break;
      case "unjournaled-trash":
        residuePath = join(fixture.store.layout.trash, TRANSACTION_ID);
        mkdirSync(residuePath, { recursive: true, mode: 0o700 });
        break;
      case "unjournaled-incomplete": {
        const next = requirePlanned(binaryPlannedFixture());
        residuePath = join(fixture.store.layout.generations, next.manifest.digest);
        mkdirSync(join(residuePath, "content"), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(residuePath, "incomplete.json"),
          canonicalRecordBytes("incomplete", {
            schemaVersion: 1,
            rootId: fixture.store.rootRecord.rootId,
            transactionId: TRANSACTION_ID,
            manifestDigest: next.manifest.digest,
          }),
          { mode: 0o600 },
        );
        break;
      }
      case "activation-temporary":
        residuePath = join(fixture.store.layout.root, `.active.${TRANSACTION_ID}.tmp`);
        writeFileSync(residuePath, canonicalRecordBytes("activation", fixture.activation), {
          mode: 0o600,
        });
        break;
      case "journal-temporary":
        mkdirSync(fixture.store.layout.transactions, { recursive: true, mode: 0o700 });
        residuePath = join(fixture.store.layout.transactions, `.${TRANSACTION_ID}.staged.tmp`);
        writeFileSync(
          residuePath,
          canonicalRecordBytes("transaction", transactionFor(fixture, TRANSACTION_ID, "staged")),
          { mode: 0o600 },
        );
        break;
      case "filename-record-mismatch":
        residuePath = writeTransaction(
          fixture,
          OTHER_TRANSACTION_ID,
          transactionFor(fixture, TRANSACTION_ID),
        );
        break;
    }
    const residueBefore = identityTreeSnapshot(residuePath);
    const storeBefore = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      fixture.manifestDigest,
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
    expect(identityTreeSnapshot(residuePath)).toEqual(residueBefore);
    expect(fixedStoreSnapshot(fixture)).toEqual(storeBefore);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("never falls back when a third exact complete activation is neither recorded old nor new", () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const nextPlan = requirePlanned(binaryPlannedFixture());
    const nextReceipt: GenerationReceipt = {
      schemaVersion: 1,
      rootId: fixture.store.rootRecord.rootId,
      manifestDigest: nextPlan.manifest.digest,
      entries: receiptEntries(nextPlan, binaryPayloadFixture()),
    };
    const nextActivation: ActivationRecord = {
      schemaVersion: 1,
      manifestDigest: nextPlan.manifest.digest,
      receiptDigest: sha256Bytes(canonicalRecordBytes("receipt", nextReceipt)),
      generation: `generations/${nextPlan.manifest.digest}/content`,
    };
    const journal: TransactionRecord = {
      schemaVersion: 1,
      operation: "apply",
      rootId: fixture.store.rootRecord.rootId,
      transactionId: TRANSACTION_ID,
      phase: "prepared",
      manifestDigest: nextPlan.manifest.digest,
      oldActivation: fixture.activation,
      newActivation: nextActivation,
      entries: nextReceipt.entries,
    };
    writeTransaction(fixture, TRANSACTION_ID, journal);
    const thirdPlan = requirePlanned(alternatePlannedFixture());
    const thirdGeneration = materializeGeneration(
      fixture.store,
      thirdPlan,
      alternatePayloadFixture(),
    );
    writeFileSync(
      fixture.store.layout.active,
      canonicalRecordBytes("activation", thirdGeneration.activation),
    );
    const storeBefore = fixedStoreSnapshot(fixture);

    const result = recoverProjectionStore({ projectRoot: fixture.root.projectRoot });

    expectRecovery(
      result,
      "failed-closed",
      thirdPlan.manifest.digest,
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
    expectExactActivation(fixture.store, thirdGeneration.activation);
    expect(fixedStoreSnapshot(fixture)).toEqual(storeBefore);
    expect(result.boundary.providerRead).toBe(false);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });
});

describe("generation store POSIX clean deletion recovery", () => {
  it.runIf(process.platform !== "win32")(
    "retains quarantined bytes after a real permission failure and recovers after restoration",
    () => {
      const { fixture, activeGenerationRoot, activeActivation } = materializeCleanStore();
      const outside = makeSiblingCanary(fixture.root);
      const activeBefore = identityTreeSnapshot(activeGenerationRoot);
      const activationBefore = readFileSync(fixture.store.layout.active);
      let restrictedDirectory: string | undefined;
      let retainedPath: string | undefined;
      let retainedBytes: Buffer | undefined;
      let transactionId: string | undefined;
      let result: CleanProjectionResult | undefined;

      try {
        result = cleanProjectionGenerationWithRuntime(
          {
            projectRoot: fixture.root.projectRoot,
            generationDigest: fixture.manifestDigest,
          },
          Object.freeze({
            onFaultPoint(point: CleanFaultPoint): void {
              if (point !== "during-clean-delete" || restrictedDirectory !== undefined) return;
              transactionId = namesIfPresent(fixture.store.layout.trash)[0];
              if (transactionId === undefined) throw new Error("clean quarantine is absent");
              const trashRoot = join(fixture.store.layout.trash, transactionId);
              const survivor = fixture.receipt.entries
                .map(({ target }) => join(trashRoot, "content", ...target.split("/")))
                .find((path) => existsSync(path));
              if (survivor === undefined) throw new Error("clean payload survivor is absent");
              retainedPath = survivor;
              retainedBytes = readFileSync(survivor);
              restrictedDirectory = dirname(survivor);
              chmodSync(restrictedDirectory, 0o500);
            },
            lockRuntime: Object.freeze({
              pid: process.pid,
              randomToken: () => LOCK_TOKEN,
              pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
            }),
          }),
        );
      } finally {
        if (restrictedDirectory !== undefined) chmodSync(restrictedDirectory, 0o700);
      }

      expect(result).toMatchObject({
        state: "failed-closed",
        generationDigest: fixture.manifestDigest,
        findings: [{ code: "METHODOLOGY_STORE_PATH_UNSAFE" }],
      });
      expect(transactionId).toBeDefined();
      expect(retainedPath).toBeDefined();
      expect(retainedBytes).toBeDefined();
      if (
        transactionId === undefined ||
        retainedPath === undefined ||
        retainedBytes === undefined
      ) {
        throw new Error("permission-failure fixture did not retain quarantined bytes");
      }
      expect(readFileSync(retainedPath)).toEqual(retainedBytes);
      expect(existsSync(fixture.generationRoot)).toBe(false);
      expect(readFileSync(fixture.store.layout.active)).toEqual(activationBefore);
      expect(identityTreeSnapshot(activeGenerationRoot)).toEqual(activeBefore);
      expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");

      expectRecovery(
        recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
        "recovered",
        activeActivation.manifestDigest,
      );
      expect(existsSync(join(fixture.store.layout.trash, transactionId))).toBe(false);
      expect(namesIfPresent(fixture.store.layout.transactions)).toEqual([]);
      expectRecovery(
        recoverProjectionStore({ projectRoot: fixture.root.projectRoot }),
        "nothing-to-recover",
        activeActivation.manifestDigest,
      );
      expectExactActivation(fixture.store, activeActivation);
      expect(identityTreeSnapshot(activeGenerationRoot)).toEqual(activeBefore);
    },
    30_000,
  );
});

describe("generation store fresh-process crash recovery", () => {
  it.each(
    APPLY_FAULT_POINTS,
  )("recovers a fresh-process crash at %s within finite child bounds", (point) => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const oldGeneration = identityTreeSnapshot(fixture.generationRoot);
    const next = requirePlanned(binaryPlannedFixture());
    const nextRecords = expectedGenerationRecords(fixture.store, next, binaryPayloadFixture());
    const crash = runChild(fixture.root, `crash-${point}`, {
      action: "crash-at",
      projectRoot: fixture.root.projectRoot,
      expectedActiveDigest: fixture.manifestDigest,
      faultPoint: point,
    });
    expect(crash.error).toBeUndefined();
    expect(crash.status).toBe(86);
    expect(crash.signal).toBeNull();
    expect(crash.stdout).toContain(`READY:${point}`);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    const expectedActivation = POST_ACTIVATION_POINTS.has(point)
      ? nextRecords.activation
      : fixture.activation;
    expectExactActivation(fixture.store, expectedActivation);
    const nextGenerationRoot = join(fixture.store.layout.generations, next.manifest.digest);
    const completedNextBeforeRecovery = COMPLETED_NEXT_GENERATION_POINTS.has(point)
      ? identityTreeSnapshot(nextGenerationRoot)
      : null;
    if (completedNextBeforeRecovery !== null) {
      expect(readFileSync(join(nextGenerationRoot, "receipt.json"))).toEqual(
        canonicalRecordBytes("receipt", nextRecords.receipt),
      );
    }

    const recovery = runChild(fixture.root, `recover-${point}`, {
      action: "recover",
      projectRoot: fixture.root.projectRoot,
    });
    expect(recovery.error).toBeUndefined();
    expect(recovery.status, recovery.stderr).toBe(0);
    const result = JSON.parse(recovery.stdout.trim()) as RecoveryProjectionResult;
    const expectedDigest = POST_ACTIVATION_POINTS.has(point)
      ? next.manifest.digest
      : fixture.manifestDigest;
    expectRecovery(result, "recovered", expectedDigest);
    expectExactActivation(fixture.store, expectedActivation);
    expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(oldGeneration);
    if (completedNextBeforeRecovery !== null) {
      expect(identityTreeSnapshot(nextGenerationRoot)).toEqual(completedNextBeforeRecovery);
    }
    const afterFirstRecovery = fixedStoreSnapshot(fixture);
    const repeated = runChild(fixture.root, `recover-repeat-${point}`, {
      action: "recover",
      projectRoot: fixture.root.projectRoot,
    });
    expect(repeated.error).toBeUndefined();
    expect(repeated.status, repeated.stderr).toBe(0);
    const repeatedResult = JSON.parse(repeated.stdout.trim()) as RecoveryProjectionResult;
    expectRecovery(repeatedResult, "nothing-to-recover", expectedDigest);
    expect(fixedStoreSnapshot(fixture)).toEqual(afterFirstRecovery);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  }, 90_000);

  it("rejects a child request whose project root is outside the OS temporary directory", () => {
    const root = temporaryProject();
    const child = runChild(root, "outside-root", {
      action: "read-activation",
      projectRoot: process.cwd(),
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(child.stderr).toContain("below the OS temporary directory");
  }, 60_000);
});

describe("generation store fresh-process clean recovery", () => {
  it.each(
    CLEAN_FAULT_POINTS,
  )("recovers a fresh-process clean crash at %s and converges idempotently", (point) => {
    const { fixture, activeGenerationRoot, activeActivation } = materializeCleanStore();
    const outside = makeSiblingCanary(fixture.root);
    const activeGenerationBefore = identityTreeSnapshot(activeGenerationRoot);
    const crash = runChild(fixture.root, `clean-crash-${point}`, {
      action: "clean-crash-at",
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.manifestDigest,
      faultPoint: point,
    });

    expect(crash.error).toBeUndefined();
    expect(crash.status).toBe(87);
    expect(crash.signal).toBeNull();
    expect(crash.stdout).toContain(`READY:${point}`);
    expectExactActivation(fixture.store, activeActivation);
    expect(identityTreeSnapshot(activeGenerationRoot)).toEqual(activeGenerationBefore);

    const recovery = runChild(fixture.root, `clean-recover-${point}`, {
      action: "recover",
      projectRoot: fixture.root.projectRoot,
    });
    expect(recovery.error).toBeUndefined();
    expect(recovery.status, recovery.stderr).toBe(0);
    const result = JSON.parse(recovery.stdout.trim()) as RecoveryProjectionResult;
    expectRecovery(result, "recovered", activeActivation.manifestDigest);
    expect(existsSync(fixture.generationRoot)).toBe(false);
    expectExactActivation(fixture.store, activeActivation);
    expect(identityTreeSnapshot(activeGenerationRoot)).toEqual(activeGenerationBefore);
    expect(inspectFixedStoreLayout(fixture.store)).toMatchObject({
      transactions: [],
      staging: [],
      trash: [],
      lockPresent: false,
    });

    const repeated = runChild(fixture.root, `clean-recover-repeat-${point}`, {
      action: "recover",
      projectRoot: fixture.root.projectRoot,
    });
    expect(repeated.error).toBeUndefined();
    expect(repeated.status, repeated.stderr).toBe(0);
    const repeatedResult = JSON.parse(repeated.stdout.trim()) as RecoveryProjectionResult;
    expectRecovery(repeatedResult, "nothing-to-recover", activeActivation.manifestDigest);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  }, 90_000);
});

describe("generation store fresh-process lock contention", () => {
  it("serializes a live holder and contender without displacing the holder", async () => {
    const fixture = materializeActiveStore();
    const outside = makeSiblingCanary(fixture.root);
    const generationBefore = identityTreeSnapshot(fixture.generationRoot);
    const requestPath = join(fixture.root.sandboxRoot, "hold-lock-request.json");
    writeFileSync(
      requestPath,
      `${JSON.stringify({
        action: "hold-lock",
        projectRoot: fixture.root.projectRoot,
        holdMilliseconds: 30_000,
      })}\n`,
      { mode: 0o600 },
    );
    const holder = spawnHelperAsync(requestPath);
    try {
      await waitForChildMarker(holder, "READY:hold-lock", 30_000);
      rmSync(requestPath, { force: true });

      const contender = runChild(fixture.root, "lock-contender", {
        action: "apply",
        projectRoot: fixture.root.projectRoot,
        expectedActiveDigest: fixture.manifestDigest,
      });
      expect(contender.error).toBeUndefined();
      expect(contender.status, contender.stderr).toBe(0);
      const blocked = JSON.parse(contender.stdout.trim()) as ApplyProjectionResult;
      expect(blocked.state).toBe("blocked");
      expect(blocked.findings).toEqual([{ code: "METHODOLOGY_STORE_LOCK_HELD" }]);
      holder.stdin.end("release\n");

      const holderExit = await waitForChildExit(holder, 30_000);
      expect(holderExit).toEqual({ code: 0, signal: null });

      expectExactActivation(fixture.store, fixture.activation);
      expect(identityTreeSnapshot(fixture.generationRoot)).toEqual(generationBefore);
      expect(inspectFixedStoreLayout(fixture.store)).toMatchObject({
        transactions: [],
        staging: [],
        trash: [],
        lockPresent: false,
      });
      expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
    } finally {
      rmSync(requestPath, { force: true });
      if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    }
  }, 90_000);
});

describe("generation store child request boundary", () => {
  it("rejects malformed and non-closed requests in finite child processes", () => {
    const root = temporaryProject();
    const cases = [
      ["malformed", "{\n", "request JSON is malformed"],
      [
        "unknown-action",
        JSON.stringify({ action: "delete", projectRoot: root.projectRoot }),
        "action is invalid",
      ],
      [
        "invalid-fault",
        JSON.stringify({
          action: "crash-at",
          projectRoot: root.projectRoot,
          expectedActiveDigest: null,
          faultPoint: "after-magic",
        }),
        "fault point is invalid",
      ],
      [
        "excessive-hold",
        JSON.stringify({
          action: "hold-lock",
          projectRoot: root.projectRoot,
          holdMilliseconds: 30_001,
        }),
        "hold duration is invalid",
      ],
      [
        "unknown-field",
        JSON.stringify({ action: "recover", projectRoot: root.projectRoot, extra: true }),
        "fields are not closed",
      ],
    ] as const;
    for (const [label, contents, message] of cases) {
      const requestPath = join(root.sandboxRoot, `${label}.json`);
      writeFileSync(requestPath, contents, { mode: 0o600 });
      const child = spawnHelper(requestPath);
      rmSync(requestPath, { force: true });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(2);
      expect(child.stderr).toContain(message);
    }
  }, 90_000);

  it("rejects an oversized request before decoding JSON", () => {
    const root = temporaryProject();
    const requestPath = join(root.sandboxRoot, "oversized.json");
    writeFileSync(requestPath, Buffer.alloc(MAX_CHILD_REQUEST_BYTES + 1, 0x20), { mode: 0o600 });
    const child = spawnHelper(requestPath);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(2);
    expect(child.stderr).toContain("bounded single-link regular file");
  }, 60_000);

  it("rejects hard-linked and symbolic-linked request files", () => {
    const root = temporaryProject();
    const sourcePath = join(root.sandboxRoot, "linked-source.json");
    writeFileSync(
      sourcePath,
      `${JSON.stringify({ action: "recover", projectRoot: root.projectRoot })}\n`,
      { mode: 0o600 },
    );
    const hardLinkPath = join(root.sandboxRoot, "hard-linked-request.json");
    linkSync(sourcePath, hardLinkPath);
    const hardLinkChild = spawnHelper(hardLinkPath);
    expect(hardLinkChild.error).toBeUndefined();
    expect(hardLinkChild.status, hardLinkChild.stderr).toBe(2);
    expect(hardLinkChild.stderr).toContain("bounded single-link regular file");

    const symbolicLinkPath = join(root.sandboxRoot, "symbolic-linked-request.json");
    try {
      symlinkSync(sourcePath, symbolicLinkPath, "file");
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String(error.code)
          : "unknown";
      expect(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]).toContain(code);
      return;
    }
    const symbolicLinkChild = spawnHelper(symbolicLinkPath);
    expect(symbolicLinkChild.error).toBeUndefined();
    expect(symbolicLinkChild.status, symbolicLinkChild.stderr).toBe(2);
    expect(symbolicLinkChild.stderr).toContain("bounded single-link regular file");
  }, 60_000);

  it("rejects a request file outside the OS temporary directory", () => {
    const requestPath = realpathSync(join(process.cwd(), "package.json"));
    const child = spawnHelper(requestPath);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(2);
    expect(child.stderr).toContain("request file must remain below the OS temporary directory");
  }, 60_000);
});
