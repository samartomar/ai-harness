import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type ActivationRecord,
  ActivationRecordSchema,
  type ApplyProjectionResult,
  applyResult,
  canonicalRecordBytes,
  type GenerationReceipt,
  GenerationReceiptSchema,
  GenerationStoreContractError,
  type IncompleteRecord,
  IncompleteRecordSchema,
  InspectProjectionInputSchema,
  inspectionResult,
  type ProjectionInspectionResult,
  parseApplyProjectionInput,
  type ReceiptEntry,
  STORE_SCHEMA_VERSION,
  type StagingRecord,
  type StoreFinding,
  type StoreFindingCode,
  sha256Bytes,
  type TransactionRecord,
  TransactionRecordSchema,
  type ValidatedApplyProjectionInput,
} from "./generation-store-contract.js";
import {
  assertOwnedStorePhase,
  copyVerifiedFileToExclusivePath,
  createExclusiveOwnedDirectory,
  createOrOpenOwnedStore,
  createStoreWalkBudget,
  ensureOwnedDirectory,
  type FixedGenerationLayout,
  type FixedStoreLayoutInventory,
  GenerationStoreFsError,
  inspectFixedStoreLayout,
  type OwnedStore,
  openStoreForInspection,
  quarantineExactDirectory,
  readStoreRecord,
  removeExactStoreRecord,
  removeVerifiedTree,
  type StoredRecordRead,
  type StoreObjectIdentity,
  type StoreWalkBudget,
  verifyBoundedOwnedTreeSafety,
  verifyExpectedContainer,
  writeAtomicRecord,
  writeExclusiveRegularFile,
} from "./generation-store-fs.js";
import {
  acquireStoreLock,
  acquireStoreLockInternal,
  assertHeldStoreLock,
  type HeldStoreLock,
  type LockRuntime,
  releaseStoreLock,
} from "./generation-store-lock.js";

type GenerationInspection = Readonly<{
  state: "verified" | "drifted" | "failed-closed";
  findings: readonly StoreFinding[];
}>;

const FAILED_CLOSED_FINDINGS = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_INPUT_INVALID",
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_ROOT_UNOWNED",
  "METHODOLOGY_STORE_PATH_UNSAFE",
  "METHODOLOGY_STORE_ACTIVATION_INVALID",
  "METHODOLOGY_STORE_TRANSACTION_INVALID",
  "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
]);

function failedFinding(error: unknown): StoreFinding {
  if (error instanceof GenerationStoreFsError && FAILED_CLOSED_FINDINGS.has(error.findingCode)) {
    return Object.freeze({ code: error.findingCode });
  }
  return Object.freeze({ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" });
}

function failedInspection(error: unknown, activeDigest: string | null): ProjectionInspectionResult {
  return inspectionResult("failed-closed", activeDigest, [failedFinding(error)]);
}

function generationDrift(
  code: "METHODOLOGY_STORE_GENERATION_INCOMPLETE" | "METHODOLOGY_STORE_GENERATION_DRIFT",
): GenerationInspection {
  return Object.freeze({
    state: "drifted",
    findings: Object.freeze([Object.freeze({ code })]),
  });
}

function failedGeneration(error: unknown): GenerationInspection {
  return Object.freeze({
    state: "failed-closed",
    findings: Object.freeze([failedFinding(error)]),
  });
}

function readIncompleteMarker(
  store: OwnedStore,
  generation: FixedGenerationLayout,
  generationRoot: string,
): IncompleteRecord | undefined {
  if (!generation.entries.includes("incomplete.json")) return undefined;
  try {
    return readStoreRecord<IncompleteRecord>(
      store,
      join(generationRoot, "incomplete.json"),
      IncompleteRecordSchema,
      "incomplete",
    ).record;
  } catch (error) {
    if (
      error instanceof GenerationStoreFsError &&
      (error.findingCode === "METHODOLOGY_STORE_ROOT_UNOWNED" ||
        error.findingCode === "METHODOLOGY_STORE_PATH_UNSAFE" ||
        error.findingCode === "METHODOLOGY_STORE_FILESYSTEM_FAILURE")
    ) {
      throw error;
    }
    throw new GenerationStoreFsError(
      "incomplete marker ownership is invalid",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
}

function inspectGeneration(
  store: OwnedStore,
  generation: FixedGenerationLayout,
  expectedReceiptDigest: string | null,
  budget: StoreWalkBudget,
): GenerationInspection {
  const generationRoot = join(store.layout.generations, generation.manifestDigest);
  let incomplete: IncompleteRecord | undefined;
  try {
    incomplete = readIncompleteMarker(store, generation, generationRoot);
  } catch (error) {
    return failedGeneration(error);
  }
  const contentPresent = generation.entries.includes("content");
  const receiptPresent = generation.entries.includes("receipt.json");
  if (incomplete !== undefined || !receiptPresent || !contentPresent) {
    if (contentPresent) {
      try {
        verifyBoundedOwnedTreeSafety(store, join(generationRoot, "content"), budget);
      } catch (error) {
        return failedGeneration(error);
      }
    }
    return generationDrift("METHODOLOGY_STORE_GENERATION_INCOMPLETE");
  }

  let receiptRead: ReturnType<typeof readStoreRecord<GenerationReceipt>>;
  try {
    receiptRead = readStoreRecord(
      store,
      join(generationRoot, "receipt.json"),
      GenerationReceiptSchema,
      "receipt",
    );
  } catch (error) {
    if (
      error instanceof GenerationStoreFsError &&
      error.findingCode === "METHODOLOGY_STORE_ROOT_UNOWNED"
    ) {
      return failedGeneration(error);
    }
    // A present receipt that cannot establish closed ownership is ambiguous,
    // not an observable missing-file drift.
    return failedGeneration(
      new GenerationStoreFsError(
        "generation receipt ownership is ambiguous",
        "METHODOLOGY_STORE_PATH_UNSAFE",
      ),
    );
  }

  try {
    verifyExpectedContainer(
      store,
      generationRoot,
      "receipt",
      receiptRead.record,
      receiptRead.record.entries,
      budget,
    );
  } catch (error) {
    if (error instanceof GenerationStoreFsError) {
      if (error.findingCode === "METHODOLOGY_STORE_GENERATION_INCOMPLETE") {
        return generationDrift("METHODOLOGY_STORE_GENERATION_INCOMPLETE");
      }
      if (error.findingCode === "METHODOLOGY_STORE_GENERATION_DRIFT") {
        return generationDrift("METHODOLOGY_STORE_GENERATION_DRIFT");
      }
    }
    return failedGeneration(error);
  }

  if (expectedReceiptDigest !== null && sha256Bytes(receiptRead.bytes) !== expectedReceiptDigest) {
    return generationDrift("METHODOLOGY_STORE_GENERATION_DRIFT");
  }

  return Object.freeze({ state: "verified", findings: Object.freeze([]) });
}

function generationByDigest(
  inventory: FixedStoreLayoutInventory,
  digest: string,
): FixedGenerationLayout | undefined {
  return inventory.generations.find(({ manifestDigest }) => manifestDigest === digest);
}

export function inspectOwnedGeneration(
  store: OwnedStore,
  rawActivation: ActivationRecord,
  inventory?: FixedStoreLayoutInventory,
  budget: StoreWalkBudget = createStoreWalkBudget(),
): ProjectionInspectionResult {
  let activation: ActivationRecord;
  try {
    activation = ActivationRecordSchema.parse(rawActivation);
  } catch {
    return inspectionResult("failed-closed", null, [
      { code: "METHODOLOGY_STORE_ACTIVATION_INVALID" },
    ]);
  }

  let fixedLayout: FixedStoreLayoutInventory;
  try {
    fixedLayout = inventory ?? inspectFixedStoreLayout(store);
  } catch (error) {
    return failedInspection(error, activation.manifestDigest);
  }
  const generation = generationByDigest(fixedLayout, activation.manifestDigest);
  if (generation === undefined) {
    return inspectionResult("drifted", activation.manifestDigest, [
      { code: "METHODOLOGY_STORE_GENERATION_INCOMPLETE" },
    ]);
  }
  const result = inspectGeneration(store, generation, activation.receiptDigest, budget);
  return inspectionResult(result.state, activation.manifestDigest, result.findings);
}

function hasPendingState(inventory: FixedStoreLayoutInventory): boolean {
  return (
    inventory.lockPresent ||
    inventory.lockCandidates.length > 0 ||
    inventory.transactions.length > 0 ||
    inventory.staging.length > 0 ||
    inventory.trash.length > 0
  );
}

function inspectHistory(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
  activeDigest: string,
  budget: StoreWalkBudget,
): ProjectionInspectionResult | undefined {
  for (const generation of inventory.generations) {
    if (generation.manifestDigest === activeDigest) continue;
    const result = inspectGeneration(store, generation, null, budget);
    if (result.state === "verified") continue;
    if (result.state === "failed-closed") {
      return inspectionResult("failed-closed", activeDigest, result.findings);
    }
    return inspectionResult("failed-closed", activeDigest, [
      {
        code: "METHODOLOGY_STORE_TRANSACTION_INVALID",
        subject: generation.manifestDigest,
      },
    ]);
  }
  return undefined;
}

function sameIdentity(left: StoreObjectIdentity, right: StoreObjectIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameInventory(left: FixedStoreLayoutInventory, right: FixedStoreLayoutInventory): boolean {
  return (
    left.activePresent === right.activePresent &&
    left.lockPresent === right.lockPresent &&
    sameStrings(left.lockCandidates, right.lockCandidates) &&
    sameStrings(left.transactions, right.transactions) &&
    sameStrings(left.staging, right.staging) &&
    sameStrings(left.trash, right.trash) &&
    left.generations.length === right.generations.length &&
    left.generations.every((generation, index) => {
      const candidate = right.generations[index];
      return (
        candidate !== undefined &&
        generation.manifestDigest === candidate.manifestDigest &&
        sameStrings(generation.entries, candidate.entries)
      );
    })
  );
}

function stableActivation(
  before: StoredRecordRead<ActivationRecord>,
  after: StoredRecordRead<ActivationRecord>,
): boolean {
  return before.bytes.equals(after.bytes) && sameIdentity(before.identity, after.identity);
}

export function assessStableStoreSnapshot(
  initialInventory: FixedStoreLayoutInventory,
  finalInventory: FixedStoreLayoutInventory,
  initialActivation: StoredRecordRead<ActivationRecord>,
  finalActivation: StoredRecordRead<ActivationRecord> | undefined,
): "METHODOLOGY_STORE_ACTIVATION_INVALID" | "METHODOLOGY_STORE_TRANSACTION_INVALID" | undefined {
  if (hasPendingState(finalInventory)) return "METHODOLOGY_STORE_TRANSACTION_INVALID";
  if (!finalInventory.activePresent || finalActivation === undefined) {
    return "METHODOLOGY_STORE_ACTIVATION_INVALID";
  }
  if (!stableActivation(initialActivation, finalActivation)) {
    return "METHODOLOGY_STORE_ACTIVATION_INVALID";
  }
  if (!sameInventory(initialInventory, finalInventory)) {
    return "METHODOLOGY_STORE_TRANSACTION_INVALID";
  }
  return undefined;
}

export function verifyStableProjectionSnapshot(
  store: OwnedStore,
  initialInventory: FixedStoreLayoutInventory,
  initialActivation: StoredRecordRead<ActivationRecord>,
  budget: StoreWalkBudget = createStoreWalkBudget(),
): ProjectionInspectionResult | undefined {
  let finalInventory: FixedStoreLayoutInventory;
  let finalActivation: StoredRecordRead<ActivationRecord> | undefined;
  try {
    finalInventory = inspectFixedStoreLayout(store);
    if (finalInventory.activePresent) {
      finalActivation = readStoreRecord(
        store,
        store.layout.active,
        ActivationRecordSchema,
        "activation",
      );
    }
  } catch (error) {
    return failedInspection(error, initialActivation.record.manifestDigest);
  }
  const findingCode = assessStableStoreSnapshot(
    initialInventory,
    finalInventory,
    initialActivation,
    finalActivation,
  );
  if (findingCode !== undefined) {
    return inspectionResult("failed-closed", initialActivation.record.manifestDigest, [
      { code: findingCode },
    ]);
  }
  if (finalActivation === undefined) {
    return inspectionResult("failed-closed", initialActivation.record.manifestDigest, [
      { code: "METHODOLOGY_STORE_ACTIVATION_INVALID" },
    ]);
  }
  const active = inspectOwnedGeneration(store, finalActivation.record, finalInventory, budget);
  if (active.state !== "verified") return active;
  const historyFailure = inspectHistory(
    store,
    finalInventory,
    finalActivation.record.manifestDigest,
    budget,
  );
  if (historyFailure !== undefined) return historyFailure;
  return verifyTerminalStoreMetadata(store, finalInventory, finalActivation);
}

function verifyTerminalStoreMetadata(
  store: OwnedStore,
  referenceInventory: FixedStoreLayoutInventory,
  referenceActivation: StoredRecordRead<ActivationRecord>,
): ProjectionInspectionResult | undefined {
  let terminalInventory: FixedStoreLayoutInventory;
  let terminalActivation: StoredRecordRead<ActivationRecord> | undefined;
  try {
    terminalInventory = inspectFixedStoreLayout(store);
    if (terminalInventory.activePresent) {
      terminalActivation = readStoreRecord(
        store,
        store.layout.active,
        ActivationRecordSchema,
        "activation",
      );
    }
  } catch (error) {
    return failedInspection(error, referenceActivation.record.manifestDigest);
  }
  const findingCode = assessStableStoreSnapshot(
    referenceInventory,
    terminalInventory,
    referenceActivation,
    terminalActivation,
  );
  if (findingCode === undefined) return undefined;
  return inspectionResult("failed-closed", referenceActivation.record.manifestDigest, [
    { code: findingCode },
  ]);
}

export function verifyStableEmptySnapshot(
  store: OwnedStore,
  initialInventory: FixedStoreLayoutInventory,
): ProjectionInspectionResult {
  let finalInventory: FixedStoreLayoutInventory;
  try {
    finalInventory = inspectFixedStoreLayout(store);
  } catch (error) {
    return failedInspection(error, null);
  }
  if (
    hasPendingState(finalInventory) ||
    finalInventory.activePresent ||
    finalInventory.generations.length > 0 ||
    !sameInventory(initialInventory, finalInventory)
  ) {
    return inspectionResult("failed-closed", null, [
      { code: "METHODOLOGY_STORE_TRANSACTION_INVALID" },
    ]);
  }
  return inspectionResult("empty", null, []);
}

function verifyAbsentStoreSnapshot(projectRoot: string): ProjectionInspectionResult {
  try {
    if (openStoreForInspection(projectRoot) === undefined) {
      return inspectionResult("empty", null, []);
    }
    return inspectionResult("failed-closed", null, [
      { code: "METHODOLOGY_STORE_TRANSACTION_INVALID" },
    ]);
  } catch (error) {
    return failedInspection(error, null);
  }
}

export function inspectProjectionStore(value: unknown): ProjectionInspectionResult {
  let input: { projectRoot: string };
  try {
    const parsed = InspectProjectionInputSchema.safeParse(value);
    if (!parsed.success) {
      return inspectionResult("failed-closed", null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]);
    }
    input = parsed.data;
  } catch {
    return inspectionResult("failed-closed", null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]);
  }

  let store: OwnedStore | undefined;
  try {
    store = openStoreForInspection(input.projectRoot);
  } catch (error) {
    return failedInspection(error, null);
  }
  if (store === undefined) return verifyAbsentStoreSnapshot(input.projectRoot);

  let inventory: FixedStoreLayoutInventory;
  try {
    inventory = inspectFixedStoreLayout(store);
  } catch (error) {
    return failedInspection(error, null);
  }

  let activationRead: StoredRecordRead<ActivationRecord> | undefined;
  if (inventory.activePresent) {
    try {
      activationRead = readStoreRecord(
        store,
        store.layout.active,
        ActivationRecordSchema,
        "activation",
      );
    } catch (error) {
      return failedInspection(error, null);
    }
  }
  const activation = activationRead?.record;
  const activeDigest = activation?.manifestDigest ?? null;

  if (hasPendingState(inventory)) {
    return inspectionResult("failed-closed", activeDigest, [
      { code: "METHODOLOGY_STORE_TRANSACTION_INVALID" },
    ]);
  }
  if (activation === undefined) {
    if (inventory.generations.length > 0) {
      return inspectionResult("failed-closed", null, [
        {
          code: "METHODOLOGY_STORE_TRANSACTION_INVALID",
          subject: inventory.generations[0]?.manifestDigest,
        },
      ]);
    }
    return verifyStableEmptySnapshot(store, inventory);
  }

  const budget = createStoreWalkBudget();
  const active = inspectOwnedGeneration(store, activation, inventory, budget);
  if (active.state !== "verified") return active;
  const historyFailure = inspectHistory(store, inventory, activation.manifestDigest, budget);
  if (historyFailure !== undefined) return historyFailure;
  if (activationRead === undefined) {
    return inspectionResult("failed-closed", activation.manifestDigest, [
      { code: "METHODOLOGY_STORE_ACTIVATION_INVALID" },
    ]);
  }
  const unstable = verifyStableProjectionSnapshot(store, inventory, activationRead);
  return unstable ?? active;
}
export type ApplyFaultPoint =
  | "after-journal-prepared"
  | "after-stage-created"
  | "after-stage-verified"
  | "after-generation-reserved"
  | "after-generation-content"
  | "after-receipt-written"
  | "before-activation-rename"
  | "after-activation-rename"
  | "after-journal-committed";

type GenerationStoreRuntime = Readonly<{
  onFaultPoint: (point: ApplyFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;

type ApplyTransactionRecord = Extract<TransactionRecord, { operation: "apply" }>;

type ApplyContext = {
  previousActiveDigest: string | null;
  activeDigest: string | null;
  activationAttempted: boolean;
};

type VerifiedPreApplyState = Readonly<{
  inventory: FixedStoreLayoutInventory;
  activationRead: StoredRecordRead<ActivationRecord> | undefined;
}>;

const APPLY_BLOCKED_FINDINGS = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_INPUT_INVALID",
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_PAYLOAD_COVERAGE",
  "METHODOLOGY_STORE_PAYLOAD_DIGEST",
  "METHODOLOGY_STORE_LOCK_HELD",
  "METHODOLOGY_STORE_PLAN_STALE",
  "METHODOLOGY_STORE_DESTINATION_COLLISION",
]);

function applyFailure(error: unknown, context: Readonly<ApplyContext>): ApplyProjectionResult {
  let code: StoreFindingCode;
  if (error instanceof GenerationStoreContractError || error instanceof GenerationStoreFsError) {
    code = error.findingCode;
  } else {
    code = "METHODOLOGY_STORE_FILESYSTEM_FAILURE";
  }
  if (
    !APPLY_BLOCKED_FINDINGS.has(code) &&
    !new Set<StoreFindingCode>([
      "METHODOLOGY_STORE_ROOT_UNOWNED",
      "METHODOLOGY_STORE_PATH_UNSAFE",
      "METHODOLOGY_STORE_LOCK_INVALID",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
      "METHODOLOGY_STORE_GENERATION_DRIFT",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    ]).has(code)
  ) {
    code = "METHODOLOGY_STORE_FILESYSTEM_FAILURE";
  }
  return applyResult(
    APPLY_BLOCKED_FINDINGS.has(code) ? "blocked" : "failed-closed",
    context.previousActiveDigest,
    context.activeDigest,
    [{ code }],
  );
}

function transactionPath(store: OwnedStore, transactionId: string): string {
  return join(store.layout.transactions, `${transactionId}.json`);
}

function transactionTemporaryPath(
  store: OwnedStore,
  transactionId: string,
  phase: ApplyTransactionRecord["phase"],
): string {
  return join(store.layout.transactions, `.${transactionId}.${phase}.tmp`);
}

function assertMutationAuthority(store: OwnedStore, held: HeldStoreLock): void {
  assertHeldStoreLock(store, held);
  assertOwnedStorePhase(store);
}

function sameRecordBytes(
  kind: "activation" | "transaction",
  left: unknown,
  right: unknown,
): boolean {
  return canonicalRecordBytes(kind, left).equals(canonicalRecordBytes(kind, right));
}

function exactReceipt(store: OwnedStore, input: ValidatedApplyProjectionInput): GenerationReceipt {
  const payloadById = new Map(input.payloads.map((payload) => [payload.artifactId, payload]));
  const entries: ReceiptEntry[] = input.plan.manifest.entries.map((entry) => {
    const payload = payloadById.get(entry.artifactId);
    if (payload === undefined) {
      throw new GenerationStoreContractError(
        "validated payload coverage changed",
        "METHODOLOGY_STORE_PAYLOAD_COVERAGE",
      );
    }
    return {
      artifactId: entry.artifactId,
      target: entry.target,
      sourceLocator: entry.sourceLocator,
      contentDigest: entry.contentDigest,
      bytes: payload.bytes.byteLength,
    };
  });
  return GenerationReceiptSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    manifestDigest: input.plan.manifest.digest,
    entries,
  });
}

function ensureContentDirectories(
  store: OwnedStore,
  held: HeldStoreLock,
  contentRoot: string,
  entries: readonly ReceiptEntry[],
): void {
  assertMutationAuthority(store, held);
  ensureOwnedDirectory(store, contentRoot);
  const relativeDirectories = new Set<string>();
  for (const entry of entries) {
    const segments = entry.target.split("/");
    let current = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      current = current === "" ? segment : `${current}/${segment}`;
      relativeDirectories.add(current);
    }
  }
  const ordered = [...relativeDirectories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? (left < right ? -1 : left > right ? 1 : 0) : depth;
  });
  for (const relativeDirectory of ordered) {
    assertMutationAuthority(store, held);
    ensureOwnedDirectory(store, join(contentRoot, ...relativeDirectory.split("/")));
  }
}

function advanceApplyJournal(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: ApplyTransactionRecord,
  phase: ApplyTransactionRecord["phase"],
): ApplyTransactionRecord {
  assertMutationAuthority(store, held);
  const next = TransactionRecordSchema.parse({ ...journal, phase });
  if (next.operation !== "apply") {
    throw new GenerationStoreFsError(
      "apply journal changed operation",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  writeAtomicRecord(store, {
    kind: "transaction",
    targetPath: transactionPath(store, journal.transactionId),
    temporaryPath: transactionTemporaryPath(store, journal.transactionId, phase),
    record: next,
  });
  return next;
}

function throwInspectionFailure(result: ProjectionInspectionResult): never {
  const code = result.findings[0]?.code ?? "METHODOLOGY_STORE_TRANSACTION_INVALID";
  throw new GenerationStoreFsError("owned generation verification failed", code);
}

function verifyExpectedGeneration(
  store: OwnedStore,
  generation: FixedGenerationLayout,
  receipt: GenerationReceipt,
): void {
  const observed = inspectGeneration(store, generation, null, createStoreWalkBudget());
  if (observed.state !== "verified") {
    throw new GenerationStoreFsError(
      "destination generation is not complete",
      observed.findings[0]?.code ?? "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }
  const generationRoot = join(store.layout.generations, receipt.manifestDigest);
  const receiptRead = readStoreRecord(
    store,
    join(generationRoot, "receipt.json"),
    GenerationReceiptSchema,
    "receipt",
  );
  if (!receiptRead.bytes.equals(canonicalRecordBytes("receipt", receipt))) {
    throw new GenerationStoreFsError(
      "destination generation receipt differs from the plan",
      "METHODOLOGY_STORE_GENERATION_DRIFT",
    );
  }
  verifyExpectedContainer(
    store,
    generationRoot,
    "receipt",
    receipt,
    receipt.entries,
    createStoreWalkBudget(),
  );
}

function verifyCommittedApply(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
  record: ApplyTransactionRecord,
): void {
  if (!inventory.activePresent) {
    throw new GenerationStoreFsError(
      "committed apply has no activation",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const active = readStoreRecord(
    store,
    store.layout.active,
    ActivationRecordSchema,
    "activation",
  ).record;
  if (!sameRecordBytes("activation", active, record.newActivation)) {
    throw new GenerationStoreFsError(
      "committed apply activation changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const generation = generationByDigest(inventory, record.manifestDigest);
  if (generation === undefined) {
    throw new GenerationStoreFsError(
      "committed apply generation is absent",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }
  const receipt: GenerationReceipt = GenerationReceiptSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    manifestDigest: record.manifestDigest,
    entries: record.entries,
  });
  verifyExpectedGeneration(store, generation, receipt);
  if (
    record.newActivation.receiptDigest !== sha256Bytes(canonicalRecordBytes("receipt", receipt))
  ) {
    throw new GenerationStoreFsError(
      "committed apply receipt binding changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
}

function verifyCommittedClean(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
  record: Extract<TransactionRecord, { operation: "clean" }>,
): void {
  if (record.oldActivation === null) {
    if (inventory.activePresent) {
      throw new GenerationStoreFsError(
        "committed clean unexpectedly changed activation",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
  } else {
    if (!inventory.activePresent) {
      throw new GenerationStoreFsError(
        "committed clean lost activation",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    const active = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    ).record;
    if (!sameRecordBytes("activation", active, record.oldActivation)) {
      throw new GenerationStoreFsError(
        "committed clean changed activation",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
  }
  if (generationByDigest(inventory, record.generationDigest) !== undefined) {
    throw new GenerationStoreFsError(
      "committed clean retained its generation",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
}

function cleanupExactStaging(
  store: OwnedStore,
  held: HeldStoreLock,
  record: ApplyTransactionRecord,
): void {
  const stagingRecord: StagingRecord = {
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    transactionId: record.transactionId,
    manifestDigest: record.manifestDigest,
  };
  const stagingRoot = join(store.layout.staging, record.transactionId);
  const verified = verifyExpectedContainer(
    store,
    stagingRoot,
    "staging",
    stagingRecord,
    record.entries,
    createStoreWalkBudget(),
  );
  assertMutationAuthority(store, held);
  ensureOwnedDirectory(store, store.layout.trash);
  const quarantined = quarantineExactDirectory(store, verified, record.transactionId);
  assertMutationAuthority(store, held);
  removeVerifiedTree(store, quarantined);
}
function terminalStagingRecord(store: OwnedStore, journal: ApplyTransactionRecord): StagingRecord {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    transactionId: journal.transactionId,
    manifestDigest: journal.manifestDigest,
  };
}

function verifyTerminalActivation(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
  expectedActivation: ActivationRecord,
  receipt: GenerationReceipt,
): StoredRecordRead<ActivationRecord> {
  if (!inventory.activePresent) {
    throw new GenerationStoreFsError(
      "terminal activation is absent",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  const activationRead = readStoreRecord(
    store,
    store.layout.active,
    ActivationRecordSchema,
    "activation",
  );
  if (!sameRecordBytes("activation", activationRead.record, expectedActivation)) {
    throw new GenerationStoreFsError(
      "terminal activation changed",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  const budget = createStoreWalkBudget();
  const active = inspectOwnedGeneration(store, activationRead.record, inventory, budget);
  if (active.state !== "verified") throwInspectionFailure(active);
  const historyFailure = inspectHistory(
    store,
    inventory,
    activationRead.record.manifestDigest,
    budget,
  );
  if (historyFailure !== undefined) throwInspectionFailure(historyFailure);
  const generation = generationByDigest(inventory, receipt.manifestDigest);
  if (generation === undefined) {
    throw new GenerationStoreFsError(
      "terminal generation is absent",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }
  verifyExpectedGeneration(store, generation, receipt);
  return activationRead;
}

function verifyTerminalApplyState(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: ApplyTransactionRecord,
  receipt: GenerationReceipt,
  pendingCleanup: boolean,
): void {
  assertMutationAuthority(store, held);
  const initialInventory = inspectFixedStoreLayout(store);
  const expectedTransactions = pendingCleanup ? [journal.transactionId] : [];
  const expectedStaging = pendingCleanup ? [journal.transactionId] : [];
  if (
    !initialInventory.lockPresent ||
    initialInventory.lockCandidates.length > 0 ||
    !sameStrings(initialInventory.transactions, expectedTransactions) ||
    !sameStrings(initialInventory.staging, expectedStaging) ||
    initialInventory.trash.length > 0
  ) {
    throw new GenerationStoreFsError(
      "terminal pending-state inventory changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (pendingCleanup) {
    const storedJournal = readStoreRecord(
      store,
      transactionPath(store, journal.transactionId),
      TransactionRecordSchema,
      "transaction",
    ).record;
    if (
      storedJournal.operation !== "apply" ||
      storedJournal.phase !== "committed" ||
      !sameRecordBytes("transaction", storedJournal, journal)
    ) {
      throw new GenerationStoreFsError(
        "terminal apply journal changed",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    const stagingRecord = terminalStagingRecord(store, journal);
    verifyExpectedContainer(
      store,
      join(store.layout.staging, journal.transactionId),
      "staging",
      stagingRecord,
      receipt.entries,
      createStoreWalkBudget(),
    );
  }

  const activationRead = verifyTerminalActivation(
    store,
    initialInventory,
    journal.newActivation,
    receipt,
  );
  assertMutationAuthority(store, held);
  const finalInventory = inspectFixedStoreLayout(store);
  if (!sameInventory(initialInventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "terminal store inventory changed during verification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalActivation = readStoreRecord(
    store,
    store.layout.active,
    ActivationRecordSchema,
    "activation",
  );
  if (!stableActivation(activationRead, finalActivation)) {
    throw new GenerationStoreFsError(
      "terminal activation changed during verification",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
}

function strictlyObservedActiveDigest(store: OwnedStore): string | null {
  try {
    const initialInventory = inspectFixedStoreLayout(store);
    if (!initialInventory.activePresent) return null;
    const activationRead = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    const budget = createStoreWalkBudget();
    const active = inspectOwnedGeneration(store, activationRead.record, initialInventory, budget);
    if (active.state !== "verified") return null;
    const historyFailure = inspectHistory(
      store,
      initialInventory,
      activationRead.record.manifestDigest,
      budget,
    );
    if (historyFailure !== undefined) return null;
    const finalInventory = inspectFixedStoreLayout(store);
    if (!sameInventory(initialInventory, finalInventory) || !finalInventory.activePresent) {
      return null;
    }
    const finalActivation = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    return stableActivation(activationRead, finalActivation)
      ? finalActivation.record.manifestDigest
      : null;
  } catch {
    return null;
  }
}

function verifyRecoveryInventoryBeforeMutation(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
): void {
  const budget = createStoreWalkBudget();
  let activationRead: StoredRecordRead<ActivationRecord> | undefined;
  if (inventory.activePresent) {
    activationRead = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    const active = inspectOwnedGeneration(store, activationRead.record, inventory, budget);
    if (active.state !== "verified") throwInspectionFailure(active);
    const historyFailure = inspectHistory(
      store,
      inventory,
      activationRead.record.manifestDigest,
      budget,
    );
    if (historyFailure !== undefined) throwInspectionFailure(historyFailure);
  } else if (inventory.generations.length > 0) {
    const first = inventory.generations[0];
    if (first === undefined) {
      throw new GenerationStoreFsError(
        "recovery generation inventory changed",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    const result = inspectGeneration(store, first, null, budget);
    if (result.state !== "verified") {
      throw new GenerationStoreFsError(
        "recovery found an incomplete orphan generation",
        result.findings[0]?.code ?? "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    throw new GenerationStoreFsError(
      "recovery found a complete orphan generation",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }

  const finalInventory = inspectFixedStoreLayout(store);
  if (!sameInventory(inventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "recovery inventory changed during classification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (activationRead !== undefined) {
    const finalActivation = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    if (!stableActivation(activationRead, finalActivation)) {
      throw new GenerationStoreFsError(
        "recovery activation changed during classification",
        "METHODOLOGY_STORE_ACTIVATION_INVALID",
      );
    }
  }
}

function recoverCommittedTransactionsUnderLock(
  store: OwnedStore,
  held: HeldStoreLock,
): FixedStoreLayoutInventory {
  assertMutationAuthority(store, held);
  let inventory = inspectFixedStoreLayout(store);
  if (!inventory.lockPresent || inventory.lockCandidates.length > 0 || inventory.trash.length > 0) {
    throw new GenerationStoreFsError(
      "pending store state is not exactly recoverable",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (inventory.transactions.length > 1) {
    throw new GenerationStoreFsError(
      "multiple pending journals require explicit recovery",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const transactionIds = new Set(inventory.transactions);
  if (inventory.staging.some((transactionId) => !transactionIds.has(transactionId))) {
    throw new GenerationStoreFsError(
      "staging has no exact transaction journal",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  verifyRecoveryInventoryBeforeMutation(store, inventory);

  for (const transactionId of inventory.transactions) {
    assertMutationAuthority(store, held);
    const path = transactionPath(store, transactionId);
    const read = readStoreRecord(store, path, TransactionRecordSchema, "transaction");
    const record = read.record;
    if (record.phase !== "committed") {
      throw new GenerationStoreFsError(
        "non-terminal transaction requires explicit recovery",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    if (record.operation === "apply") {
      verifyCommittedApply(store, inventory, record);
      if (inventory.staging.includes(transactionId)) {
        cleanupExactStaging(store, held, record);
      }
    } else {
      if (inventory.staging.includes(transactionId)) {
        throw new GenerationStoreFsError(
          "clean transaction owns no staging",
          "METHODOLOGY_STORE_TRANSACTION_INVALID",
        );
      }
      verifyCommittedClean(store, inventory, record);
    }
    assertMutationAuthority(store, held);
    removeExactStoreRecord(store, path, "transaction", record);
    inventory = inspectFixedStoreLayout(store);
  }

  if (
    inventory.transactions.length > 0 ||
    inventory.staging.length > 0 ||
    inventory.trash.length > 0 ||
    inventory.lockCandidates.length > 0 ||
    !inventory.lockPresent
  ) {
    throw new GenerationStoreFsError(
      "pending store state remains after recovery",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  return inventory;
}

function verifiedPreApplyState(
  store: OwnedStore,
  held: HeldStoreLock,
  context: ApplyContext,
): VerifiedPreApplyState {
  assertMutationAuthority(store, held);
  const observedBeforeRecovery = inspectFixedStoreLayout(store);
  if (observedBeforeRecovery.activePresent) {
    const observedActivation = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    context.previousActiveDigest = observedActivation.record.manifestDigest;
    context.activeDigest = observedActivation.record.manifestDigest;
  }
  const inventory = recoverCommittedTransactionsUnderLock(store, held);
  const budget = createStoreWalkBudget();
  let activationRead: StoredRecordRead<ActivationRecord> | undefined;
  if (inventory.activePresent) {
    activationRead = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    context.previousActiveDigest = activationRead.record.manifestDigest;
    context.activeDigest = activationRead.record.manifestDigest;
    const active = inspectOwnedGeneration(store, activationRead.record, inventory, budget);
    if (active.state !== "verified") throwInspectionFailure(active);
    const historyFailure = inspectHistory(
      store,
      inventory,
      activationRead.record.manifestDigest,
      budget,
    );
    if (historyFailure !== undefined) throwInspectionFailure(historyFailure);
  } else if (inventory.generations.length > 0) {
    const first = inventory.generations[0];
    if (first === undefined) {
      throw new GenerationStoreFsError(
        "generation inventory changed",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    const result = inspectGeneration(store, first, null, createStoreWalkBudget());
    if (result.state !== "verified") {
      throw new GenerationStoreFsError(
        "orphan generation is incomplete",
        result.findings[0]?.code ?? "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    throw new GenerationStoreFsError(
      "complete generation has no activation",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }

  assertMutationAuthority(store, held);
  const finalInventory = inspectFixedStoreLayout(store);
  if (!sameInventory(inventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "store changed during pre-apply verification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (activationRead !== undefined) {
    const finalActivation = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    if (!stableActivation(activationRead, finalActivation)) {
      throw new GenerationStoreFsError(
        "activation changed during pre-apply verification",
        "METHODOLOGY_STORE_ACTIVATION_INVALID",
      );
    }
    activationRead = finalActivation;
  }
  return Object.freeze({ inventory: finalInventory, activationRead });
}

function sameGenerationLayout(left: FixedGenerationLayout, right: FixedGenerationLayout): boolean {
  return left.manifestDigest === right.manifestDigest && sameStrings(left.entries, right.entries);
}

function verifyPriorStateBeforeActivation(
  store: OwnedStore,
  held: HeldStoreLock,
  before: VerifiedPreApplyState,
  journal: ApplyTransactionRecord,
  receipt: GenerationReceipt,
): void {
  assertMutationAuthority(store, held);
  const initialInventory = inspectFixedStoreLayout(store);
  if (
    !initialInventory.lockPresent ||
    initialInventory.lockCandidates.length > 0 ||
    !sameStrings(initialInventory.transactions, [journal.transactionId]) ||
    !sameStrings(initialInventory.staging, [journal.transactionId]) ||
    initialInventory.trash.length > 0
  ) {
    throw new GenerationStoreFsError(
      "pre-activation pending state changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const storedJournal = readStoreRecord(
    store,
    transactionPath(store, journal.transactionId),
    TransactionRecordSchema,
    "transaction",
  ).record;
  if (
    storedJournal.operation !== "apply" ||
    storedJournal.phase !== "generation-verified" ||
    !sameRecordBytes("transaction", storedJournal, journal)
  ) {
    throw new GenerationStoreFsError(
      "pre-activation journal changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const stagingRecord = terminalStagingRecord(store, journal);
  verifyExpectedContainer(
    store,
    join(store.layout.staging, journal.transactionId),
    "staging",
    stagingRecord,
    receipt.entries,
    createStoreWalkBudget(),
  );

  const priorByDigest = new Map(
    before.inventory.generations.map((generation) => [generation.manifestDigest, generation]),
  );
  const candidateWasPresent = priorByDigest.has(receipt.manifestDigest);
  const expectedGenerationCount =
    before.inventory.generations.length + (candidateWasPresent ? 0 : 1);
  if (initialInventory.generations.length !== expectedGenerationCount) {
    throw new GenerationStoreFsError(
      "pre-activation generation inventory changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  for (const generation of initialInventory.generations) {
    const prior = priorByDigest.get(generation.manifestDigest);
    if (generation.manifestDigest === receipt.manifestDigest) {
      if (prior !== undefined && !sameGenerationLayout(prior, generation)) {
        throw new GenerationStoreFsError(
          "candidate generation layout changed",
          "METHODOLOGY_STORE_GENERATION_DRIFT",
        );
      }
      verifyExpectedGeneration(store, generation, receipt);
      continue;
    }
    if (prior === undefined || !sameGenerationLayout(prior, generation)) {
      throw new GenerationStoreFsError(
        "prior generation inventory changed",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
  }

  let activationRead: StoredRecordRead<ActivationRecord> | undefined;
  if (before.activationRead === undefined) {
    if (initialInventory.activePresent) {
      throw new GenerationStoreFsError(
        "activation appeared before publication",
        "METHODOLOGY_STORE_ACTIVATION_INVALID",
      );
    }
  } else {
    if (!initialInventory.activePresent) {
      throw new GenerationStoreFsError(
        "prior activation disappeared",
        "METHODOLOGY_STORE_ACTIVATION_INVALID",
      );
    }
    activationRead = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    if (!stableActivation(before.activationRead, activationRead)) {
      throw new GenerationStoreFsError(
        "prior activation changed before publication",
        "METHODOLOGY_STORE_ACTIVATION_INVALID",
      );
    }
    const budget = createStoreWalkBudget();
    const active = inspectOwnedGeneration(store, activationRead.record, initialInventory, budget);
    if (active.state !== "verified") throwInspectionFailure(active);
    const historyFailure = inspectHistory(
      store,
      initialInventory,
      activationRead.record.manifestDigest,
      budget,
    );
    if (historyFailure !== undefined) throwInspectionFailure(historyFailure);
  }

  assertMutationAuthority(store, held);
  const finalInventory = inspectFixedStoreLayout(store);
  if (!sameInventory(initialInventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "pre-activation inventory changed during verification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (activationRead !== undefined) {
    const finalActivation = readStoreRecord(
      store,
      store.layout.active,
      ActivationRecordSchema,
      "activation",
    );
    if (!stableActivation(activationRead, finalActivation)) {
      throw new GenerationStoreFsError(
        "prior activation changed during verification",
        "METHODOLOGY_STORE_ACTIVATION_INVALID",
      );
    }
  }
}
function writeInitialJournal(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: ApplyTransactionRecord,
): void {
  assertMutationAuthority(store, held);
  writeExclusiveRegularFile(
    store,
    transactionPath(store, journal.transactionId),
    canonicalRecordBytes("transaction", journal),
  );
  const read = readStoreRecord(
    store,
    transactionPath(store, journal.transactionId),
    TransactionRecordSchema,
    "transaction",
  );
  if (read.record.operation !== "apply" || !sameRecordBytes("transaction", read.record, journal)) {
    throw new GenerationStoreFsError(
      "prepared journal verification failed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
}

function materializeStaging(
  store: OwnedStore,
  held: HeldStoreLock,
  input: ValidatedApplyProjectionInput,
  receipt: GenerationReceipt,
  transactionId: string,
  fault: (point: ApplyFaultPoint) => void,
): ReturnType<typeof verifyExpectedContainer> {
  const stagingRoot = join(store.layout.staging, transactionId);
  assertMutationAuthority(store, held);
  createExclusiveOwnedDirectory(store, stagingRoot);
  const stagingRecord: StagingRecord = {
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    transactionId,
    manifestDigest: receipt.manifestDigest,
  };
  writeExclusiveRegularFile(
    store,
    join(stagingRoot, "staging.json"),
    canonicalRecordBytes("staging", stagingRecord),
  );
  fault("after-stage-created");

  const contentRoot = join(stagingRoot, "content");
  ensureContentDirectories(store, held, contentRoot, receipt.entries);
  const payloadById = new Map(input.payloads.map((payload) => [payload.artifactId, payload]));
  for (const entry of receipt.entries) {
    const payload = payloadById.get(entry.artifactId);
    if (payload === undefined) {
      throw new GenerationStoreContractError(
        "validated payload coverage changed",
        "METHODOLOGY_STORE_PAYLOAD_COVERAGE",
      );
    }
    assertMutationAuthority(store, held);
    writeExclusiveRegularFile(store, join(contentRoot, ...entry.target.split("/")), payload.bytes);
  }
  return verifyExpectedContainer(
    store,
    stagingRoot,
    "staging",
    stagingRecord,
    receipt.entries,
    createStoreWalkBudget(),
  );
}

function runApplyUnderLock(
  store: OwnedStore,
  held: HeldStoreLock,
  input: ValidatedApplyProjectionInput,
  transactionId: string,
  fault: (point: ApplyFaultPoint) => void,
  context: ApplyContext,
): ApplyProjectionResult {
  const before = verifiedPreApplyState(store, held, context);
  const receipt = exactReceipt(store, input);
  const targetGeneration = generationByDigest(before.inventory, receipt.manifestDigest);
  if (targetGeneration !== undefined) {
    verifyExpectedGeneration(store, targetGeneration, receipt);
  }

  if (context.activeDigest !== input.expectedActiveDigest) {
    return applyResult("blocked", context.previousActiveDigest, context.activeDigest, [
      { code: "METHODOLOGY_STORE_PLAN_STALE" },
    ]);
  }
  if (context.activeDigest === receipt.manifestDigest) {
    return applyResult("already-active", context.previousActiveDigest, context.activeDigest, []);
  }

  assertMutationAuthority(store, held);
  ensureOwnedDirectory(store, store.layout.transactions);
  ensureOwnedDirectory(store, store.layout.staging);
  ensureOwnedDirectory(store, store.layout.generations);
  ensureOwnedDirectory(store, store.layout.trash);

  const activation: ActivationRecord = ActivationRecordSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    manifestDigest: receipt.manifestDigest,
    receiptDigest: sha256Bytes(canonicalRecordBytes("receipt", receipt)),
    generation: `generations/${receipt.manifestDigest}/content`,
  });
  let journal: ApplyTransactionRecord = {
    schemaVersion: STORE_SCHEMA_VERSION,
    operation: "apply",
    rootId: store.rootRecord.rootId,
    transactionId,
    phase: "prepared",
    manifestDigest: receipt.manifestDigest,
    oldActivation: before.activationRead?.record ?? null,
    newActivation: activation,
    entries: receipt.entries,
  };
  writeInitialJournal(store, held, journal);
  fault("after-journal-prepared");

  const staging = materializeStaging(store, held, input, receipt, transactionId, fault);
  journal = advanceApplyJournal(store, held, journal, "staged");
  fault("after-stage-verified");

  if (targetGeneration === undefined) {
    const generationRoot = join(store.layout.generations, receipt.manifestDigest);
    assertMutationAuthority(store, held);
    createExclusiveOwnedDirectory(store, generationRoot);
    const incomplete: IncompleteRecord = {
      schemaVersion: STORE_SCHEMA_VERSION,
      rootId: store.rootRecord.rootId,
      transactionId,
      manifestDigest: receipt.manifestDigest,
    };
    writeExclusiveRegularFile(
      store,
      join(generationRoot, "incomplete.json"),
      canonicalRecordBytes("incomplete", incomplete),
    );
  }
  journal = advanceApplyJournal(store, held, journal, "generation-reserved");
  fault("after-generation-reserved");

  if (targetGeneration === undefined) {
    const generationRoot = join(store.layout.generations, receipt.manifestDigest);
    const incomplete: IncompleteRecord = {
      schemaVersion: STORE_SCHEMA_VERSION,
      rootId: store.rootRecord.rootId,
      transactionId,
      manifestDigest: receipt.manifestDigest,
    };
    const contentRoot = join(generationRoot, "content");
    ensureContentDirectories(store, held, contentRoot, receipt.entries);
    for (const entry of receipt.entries) {
      assertMutationAuthority(store, held);
      copyVerifiedFileToExclusivePath(store, staging, `content/${entry.target}`, generationRoot);
    }
    verifyExpectedContainer(
      store,
      generationRoot,
      "incomplete",
      incomplete,
      receipt.entries,
      createStoreWalkBudget(),
    );
    fault("after-generation-content");
    assertMutationAuthority(store, held);
    writeExclusiveRegularFile(
      store,
      join(generationRoot, "receipt.json"),
      canonicalRecordBytes("receipt", receipt),
    );
    assertMutationAuthority(store, held);
    removeExactStoreRecord(
      store,
      join(generationRoot, "incomplete.json"),
      "incomplete",
      incomplete,
    );
    verifyExpectedContainer(
      store,
      generationRoot,
      "receipt",
      receipt,
      receipt.entries,
      createStoreWalkBudget(),
    );
  } else {
    fault("after-generation-content");
    verifyExpectedGeneration(store, targetGeneration, receipt);
  }
  journal = advanceApplyJournal(store, held, journal, "generation-verified");
  fault("after-receipt-written");

  context.activationAttempted = true;
  fault("before-activation-rename");
  verifyPriorStateBeforeActivation(store, held, before, journal, receipt);
  assertMutationAuthority(store, held);
  writeAtomicRecord(store, {
    kind: "activation",
    targetPath: store.layout.active,
    temporaryPath: join(store.layout.root, `.active.${transactionId}.tmp`),
    record: activation,
  });
  context.activeDigest = receipt.manifestDigest;
  fault("after-activation-rename");

  journal = advanceApplyJournal(store, held, journal, "activation-committed");
  const activationRead = readStoreRecord(
    store,
    store.layout.active,
    ActivationRecordSchema,
    "activation",
  );
  if (!sameRecordBytes("activation", activationRead.record, activation)) {
    throw new GenerationStoreFsError(
      "activation verification failed",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  const finalInventory = inspectFixedStoreLayout(store);
  const finalGeneration = generationByDigest(finalInventory, receipt.manifestDigest);
  if (finalGeneration === undefined) {
    throw new GenerationStoreFsError(
      "activated generation disappeared",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }
  verifyExpectedGeneration(store, finalGeneration, receipt);

  journal = advanceApplyJournal(store, held, journal, "committed");
  fault("after-journal-committed");
  verifyTerminalApplyState(store, held, journal, receipt, true);
  cleanupExactStaging(store, held, journal);
  assertMutationAuthority(store, held);
  removeExactStoreRecord(store, transactionPath(store, transactionId), "transaction", journal);
  verifyTerminalApplyState(store, held, journal, receipt, false);
  context.activeDigest = receipt.manifestDigest;
  return applyResult("applied", context.previousActiveDigest, context.activeDigest, []);
}

function applyProjectionInternal(
  value: unknown,
  runtime: GenerationStoreRuntime | undefined,
): ApplyProjectionResult {
  const emptyContext: ApplyContext = {
    previousActiveDigest: null,
    activeDigest: null,
    activationAttempted: false,
  };
  let input: ValidatedApplyProjectionInput;
  try {
    input = parseApplyProjectionInput(value);
  } catch (error) {
    return error instanceof GenerationStoreContractError
      ? applyFailure(error, emptyContext)
      : applyResult("blocked", null, null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]);
  }

  let store: OwnedStore;
  try {
    store = createOrOpenOwnedStore(input.projectRoot);
  } catch (error) {
    return applyFailure(error, emptyContext);
  }

  let transactionId: string;
  try {
    transactionId = randomBytes(32).toString("hex");
  } catch (error) {
    return applyFailure(error, emptyContext);
  }
  let held: HeldStoreLock;
  try {
    held =
      runtime === undefined
        ? acquireStoreLock(store, transactionId)
        : acquireStoreLockInternal(store, transactionId, runtime.lockRuntime);
  } catch (error) {
    return applyFailure(error, emptyContext);
  }

  const context: ApplyContext = {
    previousActiveDigest: null,
    activeDigest: null,
    activationAttempted: false,
  };
  let injected = false;
  let injectedError: unknown;
  const fault = (point: ApplyFaultPoint): void => {
    if (runtime === undefined) return;
    try {
      runtime.onFaultPoint(point);
    } catch (error) {
      injected = true;
      injectedError = error;
      throw error;
    }
  };

  let result: ApplyProjectionResult | undefined;
  let didFail = false;
  let failure: unknown;
  try {
    result = runApplyUnderLock(store, held, input, transactionId, fault, context);
  } catch (error) {
    didFail = true;
    failure = error;
  }
  try {
    releaseStoreLock(store, held);
  } catch (error) {
    if (!didFail) {
      didFail = true;
      failure = error;
    }
  }

  if (didFail) {
    if (injected && Object.is(failure, injectedError)) throw failure;
    if (context.activationAttempted) {
      context.activeDigest = strictlyObservedActiveDigest(store);
    }
    return applyFailure(failure, context);
  }
  if (result === undefined) {
    if (context.activationAttempted) {
      context.activeDigest = strictlyObservedActiveDigest(store);
    }
    return applyFailure(
      new GenerationStoreFsError(
        "apply completed without a result",
        "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
      ),
      context,
    );
  }
  return result;
}

export function applyProjectionWithRuntime(
  value: unknown,
  runtime: GenerationStoreRuntime,
): ApplyProjectionResult {
  return applyProjectionInternal(value, runtime);
}

export function applyProjection(value: unknown): ApplyProjectionResult {
  return applyProjectionInternal(value, undefined);
}
