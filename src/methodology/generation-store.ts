import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type ActivationRecord,
  ActivationRecordSchema,
  type ApplyProjectionResult,
  applyResult,
  CleanProjectionInputSchema,
  type CleanProjectionResult,
  canonicalRecordBytes,
  cleanResult,
  type GenerationReceipt,
  GenerationReceiptSchema,
  GenerationStoreContractError,
  type IncompleteRecord,
  IncompleteRecordSchema,
  InspectProjectionInputSchema,
  inspectionResult,
  MAX_GENERATED_DIRECTORIES,
  MAX_WALK_BYTES,
  MAX_WALK_ENTRIES,
  type ProjectionInspectionResult,
  parseApplyProjectionInput,
  type ReceiptEntry,
  RecoverProjectionInputSchema,
  type RecoveryProjectionResult,
  recoveryResult,
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
  inspectRecoveryStoreLayout,
  type OwnedStore,
  openStoreForInspection,
  publishVerifiedScratchDirectory,
  quarantineExactDirectory,
  type RecoveryStoreLayoutInventory,
  readStoreRecord,
  removeBoundedRecoveryTemporary,
  removeExactStoreRecord,
  removeVerifiedScratchTree,
  removeVerifiedTree,
  type StoredRecordRead,
  type StoreObjectIdentity,
  type StoreWalkBudget,
  type VerifiedTree,
  verifyBoundedOwnedTreeSafety,
  verifyExpectedContainer,
  verifyExpectedTree,
  verifyPartialOwnedContainer,
  verifyPartialSourceContainer,
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

function inspectInactiveHistory(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
  budget: StoreWalkBudget,
): ProjectionInspectionResult | undefined {
  for (const generation of inventory.generations) {
    const result = inspectGeneration(store, generation, null, budget);
    if (result.state === "verified") continue;
    if (result.state === "failed-closed") {
      return inspectionResult("failed-closed", null, result.findings);
    }
    return inspectionResult("failed-closed", null, [
      { code: "METHODOLOGY_STORE_TRANSACTION_INVALID", subject: generation.manifestDigest },
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

function sameRecoveryInventory(
  left: RecoveryStoreLayoutInventory,
  right: RecoveryStoreLayoutInventory,
): boolean {
  return (
    sameInventory(left, right) &&
    sameStrings(left.activationTemporaries, right.activationTemporaries) &&
    left.transactionTemporaries.length === right.transactionTemporaries.length &&
    left.transactionTemporaries.every((temporary, index) => {
      const candidate = right.transactionTemporaries[index];
      return (
        candidate !== undefined &&
        temporary.transactionId === candidate.transactionId &&
        temporary.phase === candidate.phase
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
    if (inventory.generations.length === 0) {
      return verifyStableEmptySnapshot(store, inventory);
    }
    const inactiveFailure = inspectInactiveHistory(store, inventory, createStoreWalkBudget());
    if (inactiveFailure !== undefined) return inactiveFailure;
    let finalInventory: FixedStoreLayoutInventory;
    try {
      finalInventory = inspectFixedStoreLayout(store);
    } catch (error) {
      return failedInspection(error, null);
    }
    if (
      hasPendingState(finalInventory) ||
      finalInventory.activePresent ||
      !sameInventory(inventory, finalInventory)
    ) {
      return inspectionResult("failed-closed", null, [
        { code: "METHODOLOGY_STORE_TRANSACTION_INVALID" },
      ]);
    }
    const finalFailure = inspectInactiveHistory(store, finalInventory, createStoreWalkBudget());
    return finalFailure ?? inspectionResult("empty", null, []);
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

export type RecoveryFaultPoint =
  | "after-recovery-trash-removed"
  | "after-recovery-incomplete-removed"
  | "after-recovery-staging-removed"
  | "after-recovery-activation-temporary-removed"
  | "after-recovery-transaction-temporary-removed"
  | "before-recovery-journal-removal";

type GenerationStoreRuntime = Readonly<{
  onFaultPoint: (point: ApplyFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;

type ApplyTransactionRecord = Extract<TransactionRecord, { operation: "apply" }>;

type ApplyContext = {
  previousActiveDigest: string | null;
  activeDigest: string | null;
  activationAttempted: boolean;
  mutationStarted: boolean;
};

type GenerationFootprint = Readonly<{
  entries: number;
  directories: number;
  bytes: number;
}>;

type VerifiedPreApplyState = Readonly<{
  inventory: FixedStoreLayoutInventory;
  activationRead: StoredRecordRead<ActivationRecord> | undefined;
  persistentFootprint: GenerationFootprint;
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
  if (code === "METHODOLOGY_STORE_RESOURCE_LIMIT" && context.mutationStarted) {
    code = "METHODOLOGY_STORE_TRANSACTION_INVALID";
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

function snapshotFootprint(budget: StoreWalkBudget): GenerationFootprint {
  return Object.freeze({
    entries: budget.entries,
    directories: budget.directories,
    bytes: budget.bytes,
  });
}

function generationFootprint(entries: readonly ReceiptEntry[]): GenerationFootprint {
  const directories = new Set<string>();
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    const segments = entry.target.split("/");
    let current = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      current = current === "" ? segment : `${current}/${segment}`;
      directories.add(current);
    }
  }
  return Object.freeze({
    entries: entries.length + directories.size,
    directories: directories.size,
    bytes,
  });
}

function assertProspectivePersistentCapacity(
  current: GenerationFootprint,
  candidate: GenerationFootprint,
): void {
  const fits =
    candidate.entries <= MAX_WALK_ENTRIES - current.entries &&
    candidate.directories <= MAX_GENERATED_DIRECTORIES - current.directories &&
    candidate.bytes <= MAX_WALK_BYTES - current.bytes;
  if (!fits) {
    throw new GenerationStoreFsError(
      "candidate generation exceeds persistent store capacity",
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
    );
  }
}

function transactionPath(store: OwnedStore, transactionId: string): string {
  return join(store.layout.transactions, `${transactionId}.json`);
}

function transactionTemporaryPath(
  store: OwnedStore,
  transactionId: string,
  phase: TransactionRecord["phase"],
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

function throwInspectionFailure(result: Readonly<{ findings: readonly StoreFinding[] }>): never {
  const code = result.findings[0]?.code ?? "METHODOLOGY_STORE_TRANSACTION_INVALID";
  throw new GenerationStoreFsError("owned generation verification failed", code);
}

function verifyExpectedGeneration(
  store: OwnedStore,
  generation: FixedGenerationLayout,
  receipt: GenerationReceipt,
  budget: StoreWalkBudget = createStoreWalkBudget(),
): void {
  const observed = inspectGeneration(store, generation, null, budget);
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
  } else {
    const historyFailure = inspectInactiveHistory(store, inventory, budget);
    if (historyFailure !== undefined) throwInspectionFailure(historyFailure);
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
  const recoveryInventory = inspectRecoveryStoreLayout(store);
  const incompletePresent = recoveryInventory.generations.some(incompleteGeneration);
  if (recoveryInventory.transactions.length === 0 && incompletePresent) {
    throw new GenerationStoreFsError(
      "incomplete generation has no recovery journal",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }
  let requiresFullRecovery =
    recoveryInventory.activationTemporaries.length > 0 ||
    recoveryInventory.transactionTemporaries.length > 0 ||
    recoveryInventory.trash.length > 0 ||
    incompletePresent;
  if (recoveryInventory.transactions.length === 1) {
    const transactionId = recoveryInventory.transactions[0];
    if (transactionId === undefined) {
      throw new GenerationStoreFsError(
        "pending transaction identity disappeared",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    const pending = readStoreRecord(
      store,
      transactionPath(store, transactionId),
      TransactionRecordSchema,
      "transaction",
    ).record;
    requiresFullRecovery ||= pending.phase !== "committed";
  } else if (
    recoveryInventory.transactions.length === 0 &&
    (recoveryInventory.staging.length > 0 || requiresFullRecovery)
  ) {
    requiresFullRecovery = true;
  }
  if (requiresFullRecovery) {
    recoverPendingTransactionsUnderLock(store, held);
    return inspectFixedStoreLayout(store);
  }
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
  const observedBeforeRecovery = inspectRecoveryStoreLayout(store);
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
  } else {
    const historyFailure = inspectInactiveHistory(store, inventory, budget);
    if (historyFailure !== undefined) throwInspectionFailure(historyFailure);
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
  return Object.freeze({
    inventory: finalInventory,
    activationRead,
    persistentFootprint: snapshotFootprint(budget),
  });
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
  writeAtomicRecord(store, {
    kind: "transaction",
    targetPath: transactionPath(store, journal.transactionId),
    temporaryPath: transactionTemporaryPath(store, journal.transactionId, "prepared"),
    record: journal,
    mode: "create",
  });
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
  const scratchRoot = join(store.layout.trash, transactionId);
  const stagingRoot = join(store.layout.staging, transactionId);
  assertMutationAuthority(store, held);
  createExclusiveOwnedDirectory(store, scratchRoot);
  fault("after-stage-created");
  const stagingRecord: StagingRecord = {
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    transactionId,
    manifestDigest: receipt.manifestDigest,
  };
  writeExclusiveRegularFile(
    store,
    join(scratchRoot, "staging.json"),
    canonicalRecordBytes("staging", stagingRecord),
  );
  const contentRoot = join(scratchRoot, "content");
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
  const verified = verifyPartialOwnedContainer(
    store,
    scratchRoot,
    "staging",
    stagingRecord,
    receipt.entries,
    createStoreWalkBudget(),
  );
  if (verified.missing.length !== 0) {
    throw new GenerationStoreFsError(
      "staging scratch is incomplete",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }
  assertMutationAuthority(store, held);
  return publishVerifiedScratchDirectory(store, verified, transactionId, stagingRoot);
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
  if (targetGeneration === undefined) {
    assertProspectivePersistentCapacity(
      before.persistentFootprint,
      generationFootprint(receipt.entries),
    );
  }

  context.mutationStarted = true;
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

  journal = advanceApplyJournal(store, held, journal, "generation-reserved");
  fault("after-generation-reserved");

  if (targetGeneration === undefined) {
    const scratchRoot = join(store.layout.trash, transactionId);
    const generationRoot = join(store.layout.generations, receipt.manifestDigest);
    assertMutationAuthority(store, held);
    createExclusiveOwnedDirectory(store, scratchRoot);
    const contentRoot = join(scratchRoot, "content");
    ensureContentDirectories(store, held, contentRoot, receipt.entries);
    for (const entry of receipt.entries) {
      assertMutationAuthority(store, held);
      copyVerifiedFileToExclusivePath(store, staging, `content/${entry.target}`, scratchRoot);
    }
    fault("after-generation-content");
    assertMutationAuthority(store, held);
    writeExclusiveRegularFile(
      store,
      join(scratchRoot, "receipt.json"),
      canonicalRecordBytes("receipt", receipt),
    );
    const verified = verifyPartialOwnedContainer(
      store,
      scratchRoot,
      "receipt",
      receipt,
      receipt.entries,
      createStoreWalkBudget(),
    );
    if (verified.missing.length !== 0) {
      throw new GenerationStoreFsError(
        "generation scratch is incomplete",
        "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
      );
    }
    assertMutationAuthority(store, held);
    publishVerifiedScratchDirectory(store, verified, transactionId, generationRoot);
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
    mutationStarted: false,
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
    mutationStarted: false,
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

type RecoveryActivationDecision = "old" | "new";

type RecoverySource = Readonly<{
  record: IncompleteRecord | StagingRecord;
  verified: VerifiedTree | null;
  receiptWritten: boolean;
}>;

type RecoveryTrash = Readonly<{
  transactionId: string;
  verified: VerifiedTree;
}>;

type ApplyRecoveryClassification = Readonly<{
  inventory: RecoveryStoreLayoutInventory;
  journal: ApplyTransactionRecord;
  receipt: GenerationReceipt;
  decision: RecoveryActivationDecision;
  activationRead: StoredRecordRead<ActivationRecord> | undefined;
  activationTemporary: string | undefined;
  transactionTemporary: string | undefined;
  staging: RecoverySource | undefined;
  incomplete: RecoverySource | undefined;
  trash: RecoveryTrash | undefined;
}>;

const APPLY_RECOVERY_PHASES = [
  "prepared",
  "staged",
  "generation-reserved",
  "generation-verified",
  "activation-committed",
  "committed",
] as const;

function recoveryFailure(error: unknown, activeDigest: string | null): RecoveryProjectionResult {
  const code =
    error instanceof GenerationStoreContractError || error instanceof GenerationStoreFsError
      ? error.findingCode
      : "METHODOLOGY_STORE_FILESYSTEM_FAILURE";
  return recoveryResult(
    code === "METHODOLOGY_STORE_LOCK_HELD" ? "blocked" : "failed-closed",
    activeDigest,
    [{ code }],
  );
}

function sameStoredRecord(
  left: Readonly<{ bytes: Buffer; identity: StoreObjectIdentity }>,
  right: Readonly<{ bytes: Buffer; identity: StoreObjectIdentity }>,
): boolean {
  return left.bytes.equals(right.bytes) && sameIdentity(left.identity, right.identity);
}

function applyRecoveryPhaseIndex(phase: ApplyTransactionRecord["phase"]): number {
  return APPLY_RECOVERY_PHASES.indexOf(phase);
}

function nextApplyRecoveryPhase(
  phase: ApplyTransactionRecord["phase"],
): ApplyTransactionRecord["phase"] | undefined {
  const index = applyRecoveryPhaseIndex(phase);
  return index >= 0 ? APPLY_RECOVERY_PHASES[index + 1] : undefined;
}

function exactRecoveryReceipt(
  store: OwnedStore,
  journal: ApplyTransactionRecord,
): GenerationReceipt {
  const receipt = GenerationReceiptSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    manifestDigest: journal.manifestDigest,
    entries: journal.entries,
  });
  if (
    journal.rootId !== store.rootRecord.rootId ||
    journal.newActivation.receiptDigest !== sha256Bytes(canonicalRecordBytes("receipt", receipt))
  ) {
    throw new GenerationStoreFsError(
      "apply recovery receipt is not journal-bound",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  return receipt;
}

function readRecoveryActivation(
  store: OwnedStore,
  inventory: RecoveryStoreLayoutInventory,
): StoredRecordRead<ActivationRecord> | undefined {
  return inventory.activePresent
    ? readStoreRecord(store, store.layout.active, ActivationRecordSchema, "activation")
    : undefined;
}

function decideRecoveryActivation(
  journal: ApplyTransactionRecord,
  activationRead: StoredRecordRead<ActivationRecord> | undefined,
): RecoveryActivationDecision {
  if (
    journal.oldActivation !== null &&
    sameRecordBytes("activation", journal.oldActivation, journal.newActivation)
  ) {
    throw new GenerationStoreFsError(
      "apply recovery activation sides are identical",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  const current = activationRead?.record;
  const oldMatches =
    journal.oldActivation === null
      ? current === undefined
      : current !== undefined && sameRecordBytes("activation", current, journal.oldActivation);
  const newMatches =
    current !== undefined && sameRecordBytes("activation", current, journal.newActivation);
  if (oldMatches === newMatches) {
    throw new GenerationStoreFsError(
      "apply recovery activation is neither one exact side",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  return oldMatches ? "old" : "new";
}

function completedGeneration(generation: FixedGenerationLayout): boolean {
  return sameStrings(generation.entries, ["content", "receipt.json"]);
}

function incompleteGeneration(generation: FixedGenerationLayout): boolean {
  return generation.entries.includes("incomplete.json");
}

function verifyRecoveryGenerations(
  store: OwnedStore,
  inventory: RecoveryStoreLayoutInventory,
  activationRead: StoredRecordRead<ActivationRecord> | undefined,
  expectedReceipt: GenerationReceipt,
): void {
  const persistentBudget = createStoreWalkBudget();
  const candidate = generationByDigest(inventory, expectedReceipt.manifestDigest);
  if (candidate !== undefined && completedGeneration(candidate)) {
    verifyExpectedGeneration(store, candidate, expectedReceipt, persistentBudget);
  }
  const activeDigest = activationRead?.record.manifestDigest;
  if (activationRead !== undefined && activeDigest !== expectedReceipt.manifestDigest) {
    const active = inspectOwnedGeneration(
      store,
      activationRead.record,
      inventory,
      persistentBudget,
    );
    if (active.state !== "verified") throwInspectionFailure(active);
  }
  for (const generation of inventory.generations) {
    if (incompleteGeneration(generation)) {
      if (generation.manifestDigest !== expectedReceipt.manifestDigest) {
        throw new GenerationStoreFsError(
          "recovery found an unrelated incomplete generation",
          "METHODOLOGY_STORE_TRANSACTION_INVALID",
        );
      }
      continue;
    }
    if (!completedGeneration(generation)) {
      throw new GenerationStoreFsError(
        "recovery found an unclassified generation",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    if (
      generation.manifestDigest === expectedReceipt.manifestDigest ||
      generation.manifestDigest === activeDigest
    ) {
      continue;
    }
    const history = inspectGeneration(store, generation, null, persistentBudget);
    if (history.state !== "verified") throwInspectionFailure(history);
  }
}

function exactStagingSource(
  store: OwnedStore,
  journal: ApplyTransactionRecord,
  partial: boolean,
  budget: StoreWalkBudget,
): RecoverySource {
  const record: StagingRecord = {
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    transactionId: journal.transactionId,
    manifestDigest: journal.manifestDigest,
  };
  const root = join(store.layout.staging, journal.transactionId);
  const verified = partial
    ? verifyPartialSourceContainer(store, root, "staging", record, journal.entries, budget)
    : verifyExpectedContainer(store, root, "staging", record, journal.entries, budget);
  return Object.freeze({ record, verified, receiptWritten: false });
}

function exactIncompleteSource(
  store: OwnedStore,
  journal: ApplyTransactionRecord,
  generation: FixedGenerationLayout,
  receipt: GenerationReceipt,
  budget: StoreWalkBudget,
): RecoverySource {
  const record: IncompleteRecord = {
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    transactionId: journal.transactionId,
    manifestDigest: journal.manifestDigest,
  };
  const root = join(store.layout.generations, journal.manifestDigest);
  const marker = readStoreRecord(
    store,
    join(root, "incomplete.json"),
    IncompleteRecordSchema,
    "incomplete",
  );
  if (!marker.bytes.equals(canonicalRecordBytes("incomplete", record))) {
    throw new GenerationStoreFsError(
      "incomplete generation is not journal-bound",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const triad = sameStrings(generation.entries, ["content", "incomplete.json", "receipt.json"]);
  if (triad) {
    const receiptRead = readStoreRecord(
      store,
      join(root, "receipt.json"),
      GenerationReceiptSchema,
      "receipt",
    );
    if (!receiptRead.bytes.equals(canonicalRecordBytes("receipt", receipt))) {
      throw new GenerationStoreFsError(
        "transitional receipt is not journal-bound",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    verifyExpectedTree(store, join(root, "content"), journal.entries, budget);
    return Object.freeze({ record, verified: null, receiptWritten: true });
  }
  const allowed =
    sameStrings(generation.entries, ["incomplete.json"]) ||
    sameStrings(generation.entries, ["content", "incomplete.json"]);
  if (!allowed) {
    throw new GenerationStoreFsError(
      "incomplete generation shape is not recoverable",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const verified = verifyPartialSourceContainer(
    store,
    root,
    "incomplete",
    record,
    journal.entries,
    budget,
  );
  return Object.freeze({ record, verified, receiptWritten: false });
}

function exactApplyTrash(
  store: OwnedStore,
  journal: ApplyTransactionRecord,
  budget: StoreWalkBudget,
): RecoveryTrash {
  const verified = verifyBoundedOwnedTreeSafety(
    store,
    join(store.layout.trash, journal.transactionId),
    budget,
  );
  return Object.freeze({ transactionId: journal.transactionId, verified });
}

function classifyApplyRecovery(
  store: OwnedStore,
  held: HeldStoreLock,
  initialInventory: RecoveryStoreLayoutInventory,
): ApplyRecoveryClassification {
  assertMutationAuthority(store, held);
  if (
    !initialInventory.lockPresent ||
    initialInventory.lockCandidates.length > 0 ||
    initialInventory.transactions.length !== 1
  ) {
    throw new GenerationStoreFsError(
      "recovery requires exactly one journal and no residual lock candidate",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const transactionId = initialInventory.transactions[0];
  if (transactionId === undefined) {
    throw new GenerationStoreFsError(
      "recovery journal identity is absent",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  let journalRead: StoredRecordRead<TransactionRecord>;
  try {
    journalRead = readStoreRecord(
      store,
      transactionPath(store, transactionId),
      TransactionRecordSchema,
      "transaction",
    );
  } catch {
    throw new GenerationStoreFsError(
      "recovery journal filename or record binding is invalid",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (journalRead.record.operation !== "apply") {
    throw new GenerationStoreFsError(
      "clean recovery is not yet classified by the apply recovery path",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const journal = journalRead.record;
  const receipt = exactRecoveryReceipt(store, journal);

  if (
    initialInventory.staging.some((value) => value !== transactionId) ||
    initialInventory.trash.some((value) => value !== transactionId) ||
    initialInventory.activationTemporaries.some((value) => value !== transactionId) ||
    initialInventory.transactionTemporaries.some(
      (value) => value.transactionId !== transactionId,
    ) ||
    initialInventory.staging.length > 1 ||
    initialInventory.trash.length > 1 ||
    initialInventory.activationTemporaries.length > 1 ||
    initialInventory.transactionTemporaries.length > 1
  ) {
    throw new GenerationStoreFsError(
      "recovery residue is not bound to one transaction",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }

  let transactionTemporary: string | undefined;
  const transactionTemporaryDescriptor = initialInventory.transactionTemporaries[0];
  if (transactionTemporaryDescriptor !== undefined) {
    const nextPhase = nextApplyRecoveryPhase(journal.phase);
    if (nextPhase === undefined || transactionTemporaryDescriptor.phase !== nextPhase) {
      throw new GenerationStoreFsError(
        "transaction temporary is not the immediate next phase",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    transactionTemporary = transactionTemporaryPath(store, transactionId, nextPhase);
  }

  const activationRead = readRecoveryActivation(store, initialInventory);
  const decision = decideRecoveryActivation(journal, activationRead);
  const durablePhase = applyRecoveryPhaseIndex(journal.phase);
  if (
    (decision === "old" && durablePhase > applyRecoveryPhaseIndex("generation-verified")) ||
    (decision === "new" && durablePhase < applyRecoveryPhaseIndex("generation-verified"))
  ) {
    throw new GenerationStoreFsError(
      "activation side is impossible for the durable journal phase",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }

  let activationTemporary: string | undefined;
  if (initialInventory.activationTemporaries.length === 1) {
    if (decision !== "old" || journal.phase !== "generation-verified") {
      throw new GenerationStoreFsError(
        "activation temporary is impossible for the recovered phase",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    activationTemporary = join(store.layout.root, `.active.${transactionId}.tmp`);
  }

  let staging: RecoverySource | undefined;
  if (initialInventory.staging.length === 1) {
    staging = exactStagingSource(
      store,
      journal,
      journal.phase === "prepared",
      createStoreWalkBudget(),
    );
  }

  const candidate = generationByDigest(initialInventory, journal.manifestDigest);
  let incomplete: RecoverySource | undefined;
  if (candidate !== undefined && incompleteGeneration(candidate)) {
    incomplete = exactIncompleteSource(store, journal, candidate, receipt, createStoreWalkBudget());
  }
  if (
    incomplete !== undefined &&
    (decision !== "old" ||
      durablePhase < applyRecoveryPhaseIndex("staged") ||
      durablePhase > applyRecoveryPhaseIndex("generation-reserved"))
  ) {
    throw new GenerationStoreFsError(
      "incomplete generation is impossible for the recovered phase",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }

  let trash: RecoveryTrash | undefined;
  if (initialInventory.trash.length === 1) {
    trash = exactApplyTrash(store, journal, createStoreWalkBudget());
  }

  if (
    durablePhase >= applyRecoveryPhaseIndex("generation-verified") &&
    (candidate === undefined || !completedGeneration(candidate))
  ) {
    throw new GenerationStoreFsError(
      "verified recovery generation is incomplete",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }

  verifyRecoveryGenerations(store, initialInventory, activationRead, receipt);
  assertMutationAuthority(store, held);
  const finalInventory = inspectRecoveryStoreLayout(store);
  if (!sameRecoveryInventory(initialInventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "recovery inventory changed during classification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalJournal = readStoreRecord(
    store,
    transactionPath(store, transactionId),
    TransactionRecordSchema,
    "transaction",
  );
  if (!sameStoredRecord(journalRead, finalJournal)) {
    throw new GenerationStoreFsError(
      "recovery journal changed during classification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalActivation = readRecoveryActivation(store, finalInventory);
  if (
    (activationRead === undefined) !== (finalActivation === undefined) ||
    (activationRead !== undefined &&
      finalActivation !== undefined &&
      !sameStoredRecord(activationRead, finalActivation))
  ) {
    throw new GenerationStoreFsError(
      "recovery activation changed during classification",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  return Object.freeze({
    inventory: finalInventory,
    journal,
    receipt,
    decision,
    activationRead: finalActivation,
    activationTemporary,
    transactionTemporary,
    staging,
    incomplete,
    trash,
  });
}

function removeRecoveryTrash(store: OwnedStore, held: HeldStoreLock, trash: RecoveryTrash): void {
  assertMutationAuthority(store, held);
  removeVerifiedScratchTree(store, trash.verified, trash.transactionId);
}

function removeRecoverySource(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: ApplyTransactionRecord,
  source: RecoverySource,
  kind: "incomplete" | "staging",
): void {
  let verified = source.verified;
  if (kind === "incomplete" && source.receiptWritten) {
    const receipt = exactRecoveryReceipt(store, journal);
    assertMutationAuthority(store, held);
    removeExactStoreRecord(
      store,
      join(store.layout.generations, journal.manifestDigest, "receipt.json"),
      "receipt",
      receipt,
    );
    verified = verifyPartialSourceContainer(
      store,
      join(store.layout.generations, journal.manifestDigest),
      "incomplete",
      source.record,
      journal.entries,
      createStoreWalkBudget(),
    );
  }
  if (verified === null) {
    throw new GenerationStoreFsError(
      "recovery source lacks an exact deletion proof",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  assertMutationAuthority(store, held);
  ensureOwnedDirectory(store, store.layout.trash);
  const quarantined = quarantineExactDirectory(store, verified, journal.transactionId);
  assertMutationAuthority(store, held);
  removeVerifiedTree(store, quarantined);
}

function verifyApplyRecoveryTerminal(
  store: OwnedStore,
  held: HeldStoreLock,
  classification: ApplyRecoveryClassification,
  journalPresent: boolean,
): string | null {
  assertMutationAuthority(store, held);
  const initialInventory = inspectRecoveryStoreLayout(store);
  if (
    !initialInventory.lockPresent ||
    initialInventory.lockCandidates.length > 0 ||
    !sameStrings(
      initialInventory.transactions,
      journalPresent ? [classification.journal.transactionId] : [],
    ) ||
    initialInventory.staging.length > 0 ||
    initialInventory.trash.length > 0 ||
    initialInventory.activationTemporaries.length > 0 ||
    initialInventory.transactionTemporaries.length > 0 ||
    initialInventory.generations.some((generation) => !completedGeneration(generation))
  ) {
    throw new GenerationStoreFsError(
      "recovery terminal inventory retains pending state",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (journalPresent) {
    const stored = readStoreRecord(
      store,
      transactionPath(store, classification.journal.transactionId),
      TransactionRecordSchema,
      "transaction",
    );
    if (
      stored.record.operation !== "apply" ||
      !stored.bytes.equals(canonicalRecordBytes("transaction", classification.journal))
    ) {
      throw new GenerationStoreFsError(
        "recovery terminal journal changed",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
  }
  const activationRead = readRecoveryActivation(store, initialInventory);
  if (
    decideRecoveryActivation(classification.journal, activationRead) !== classification.decision
  ) {
    throw new GenerationStoreFsError(
      "recovery terminal activation changed sides",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  verifyRecoveryGenerations(store, initialInventory, activationRead, classification.receipt);

  assertMutationAuthority(store, held);
  const finalInventory = inspectRecoveryStoreLayout(store);
  if (!sameRecoveryInventory(initialInventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "recovery terminal inventory changed during verification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalActivation = readRecoveryActivation(store, finalInventory);
  if (
    (activationRead === undefined) !== (finalActivation === undefined) ||
    (activationRead !== undefined &&
      finalActivation !== undefined &&
      !sameStoredRecord(activationRead, finalActivation))
  ) {
    throw new GenerationStoreFsError(
      "recovery terminal activation changed during verification",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  return finalActivation?.record.manifestDigest ?? null;
}

function executeApplyRecovery(
  store: OwnedStore,
  held: HeldStoreLock,
  classification: ApplyRecoveryClassification,
  fault: (point: RecoveryFaultPoint) => void,
): string | null {
  if (classification.trash !== undefined) {
    removeRecoveryTrash(store, held, classification.trash);
    fault("after-recovery-trash-removed");
  }
  if (classification.incomplete !== undefined) {
    removeRecoverySource(
      store,
      held,
      classification.journal,
      classification.incomplete,
      "incomplete",
    );
    fault("after-recovery-incomplete-removed");
  }
  if (classification.staging !== undefined) {
    removeRecoverySource(store, held, classification.journal, classification.staging, "staging");
    fault("after-recovery-staging-removed");
  }
  if (classification.activationTemporary !== undefined) {
    assertMutationAuthority(store, held);
    removeBoundedRecoveryTemporary(store, classification.activationTemporary);
    fault("after-recovery-activation-temporary-removed");
  }
  if (classification.transactionTemporary !== undefined) {
    assertMutationAuthority(store, held);
    removeBoundedRecoveryTemporary(store, classification.transactionTemporary);
    fault("after-recovery-transaction-temporary-removed");
  }

  verifyApplyRecoveryTerminal(store, held, classification, true);
  fault("before-recovery-journal-removal");
  assertMutationAuthority(store, held);
  removeExactStoreRecord(
    store,
    transactionPath(store, classification.journal.transactionId),
    "transaction",
    classification.journal,
  );
  return verifyApplyRecoveryTerminal(store, held, classification, false);
}

type CleanTransactionRecord = Extract<TransactionRecord, { operation: "clean" }>;

type CleanRecoveryClassification = Readonly<{
  inventory: RecoveryStoreLayoutInventory;
  journal: CleanTransactionRecord;
  receipt: GenerationReceipt;
  activationRead: StoredRecordRead<ActivationRecord> | undefined;
  transactionTemporary: string | undefined;
  source: VerifiedTree | undefined;
  trash: VerifiedTree | undefined;
}>;

const CLEAN_RECOVERY_PHASES = ["prepared", "quarantined", "deleting", "committed"] as const;

function cleanRecoveryPhaseIndex(phase: CleanTransactionRecord["phase"]): number {
  return CLEAN_RECOVERY_PHASES.indexOf(phase);
}

function nextCleanRecoveryPhase(
  phase: CleanTransactionRecord["phase"],
): CleanTransactionRecord["phase"] | undefined {
  const index = cleanRecoveryPhaseIndex(phase);
  return index >= 0 ? CLEAN_RECOVERY_PHASES[index + 1] : undefined;
}

function exactCleanReceipt(store: OwnedStore, journal: CleanTransactionRecord): GenerationReceipt {
  if (journal.rootId !== store.rootRecord.rootId) {
    throw new GenerationStoreFsError(
      "clean journal is not owned by this store",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  return GenerationReceiptSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    manifestDigest: journal.generationDigest,
    entries: journal.entries,
  });
}

function readCleanJournalActivation(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
  journal: CleanTransactionRecord,
): StoredRecordRead<ActivationRecord> | undefined {
  const activationRead = inventory.activePresent
    ? readStoreRecord(store, store.layout.active, ActivationRecordSchema, "activation")
    : undefined;
  if (journal.oldActivation === null) {
    if (activationRead !== undefined) {
      throw new GenerationStoreFsError(
        "clean recovery unexpectedly found an activation",
        "METHODOLOGY_STORE_ACTIVATION_INVALID",
      );
    }
  } else if (
    activationRead === undefined ||
    !sameRecordBytes("activation", activationRead.record, journal.oldActivation)
  ) {
    throw new GenerationStoreFsError(
      "clean recovery activation changed",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  if (activationRead?.record.manifestDigest === journal.generationDigest) {
    throw new GenerationStoreFsError(
      "clean recovery target became active",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  return activationRead;
}

function verifyCleanGenerations(
  store: OwnedStore,
  inventory: RecoveryStoreLayoutInventory,
  journal: CleanTransactionRecord,
  receipt: GenerationReceipt,
  activationRead: StoredRecordRead<ActivationRecord> | undefined,
  persistentBudget: StoreWalkBudget,
  targetAlreadyVerified: boolean,
): void {
  const activeDigest = activationRead?.record.manifestDigest;
  if (activationRead !== undefined) {
    const active = inspectOwnedGeneration(
      store,
      activationRead.record,
      inventory,
      persistentBudget,
    );
    if (active.state !== "verified") throwInspectionFailure(active);
  }
  for (const generation of inventory.generations) {
    if (generation.manifestDigest === journal.generationDigest) {
      if (!completedGeneration(generation)) {
        throw new GenerationStoreFsError(
          "clean recovery source is incomplete",
          "METHODOLOGY_STORE_TRANSACTION_INVALID",
        );
      }
      if (!targetAlreadyVerified) {
        verifyExpectedGeneration(store, generation, receipt, persistentBudget);
      }
      continue;
    }
    if (!completedGeneration(generation)) {
      throw new GenerationStoreFsError(
        "clean recovery found an unrelated incomplete generation",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    if (generation.manifestDigest === activeDigest) continue;
    const observed = inspectGeneration(store, generation, null, persistentBudget);
    if (observed.state !== "verified") throwInspectionFailure(observed);
  }
}

function exactCleanSource(
  store: OwnedStore,
  journal: CleanTransactionRecord,
  receipt: GenerationReceipt,
  budget: StoreWalkBudget,
): VerifiedTree {
  return verifyExpectedContainer(
    store,
    join(store.layout.generations, journal.generationDigest),
    "receipt",
    receipt,
    journal.entries,
    budget,
  );
}

function exactCleanTrash(
  store: OwnedStore,
  journal: CleanTransactionRecord,
  receipt: GenerationReceipt,
  partial: boolean,
  budget: StoreWalkBudget,
): VerifiedTree {
  const root = join(store.layout.trash, journal.transactionId);
  const verified = verifyPartialOwnedContainer(
    store,
    root,
    "receipt",
    receipt,
    journal.entries,
    budget,
  );
  if (!partial && verified.missing.length > 0) {
    throw new GenerationStoreFsError(
      "clean quarantine is incomplete before deletion",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  return verified;
}

function classifyCleanRecovery(
  store: OwnedStore,
  held: HeldStoreLock,
  initialInventory: RecoveryStoreLayoutInventory,
): CleanRecoveryClassification {
  assertMutationAuthority(store, held);
  if (
    !initialInventory.lockPresent ||
    initialInventory.lockCandidates.length > 0 ||
    initialInventory.transactions.length !== 1 ||
    initialInventory.staging.length > 0 ||
    initialInventory.activationTemporaries.length > 0 ||
    initialInventory.trash.length > 1 ||
    initialInventory.transactionTemporaries.length > 1
  ) {
    throw new GenerationStoreFsError(
      "clean recovery inventory is not singular and transaction-bound",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const transactionId = initialInventory.transactions[0];
  if (
    transactionId === undefined ||
    initialInventory.trash.some((value) => value !== transactionId) ||
    initialInventory.transactionTemporaries.some((value) => value.transactionId !== transactionId)
  ) {
    throw new GenerationStoreFsError(
      "clean recovery residue is not journal-bound",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const journalRead = readStoreRecord(
    store,
    transactionPath(store, transactionId),
    TransactionRecordSchema,
    "transaction",
  );
  if (journalRead.record.operation !== "clean") {
    throw new GenerationStoreFsError(
      "clean recovery received a non-clean journal",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const journal = journalRead.record;
  if (journal.transactionId !== transactionId) {
    throw new GenerationStoreFsError(
      "clean journal filename and identity differ",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const receipt = exactCleanReceipt(store, journal);

  let transactionTemporary: string | undefined;
  const temporaryDescriptor = initialInventory.transactionTemporaries[0];
  if (temporaryDescriptor !== undefined) {
    const nextPhase = nextCleanRecoveryPhase(journal.phase);
    if (nextPhase === undefined || temporaryDescriptor.phase !== nextPhase) {
      throw new GenerationStoreFsError(
        "clean transaction temporary is not the immediate next phase",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    transactionTemporary = transactionTemporaryPath(store, transactionId, nextPhase);
  }

  const activationRead = readCleanJournalActivation(store, initialInventory, journal);
  const persistentBudget = createStoreWalkBudget();
  const candidate = generationByDigest(initialInventory, journal.generationDigest);
  let source: VerifiedTree | undefined;
  if (candidate !== undefined) {
    if (!completedGeneration(candidate)) {
      throw new GenerationStoreFsError(
        "clean recovery source is incomplete",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    source = exactCleanSource(store, journal, receipt, persistentBudget);
  }

  let trash: VerifiedTree | undefined;
  if (initialInventory.trash.length === 1) {
    trash = exactCleanTrash(
      store,
      journal,
      receipt,
      journal.phase === "deleting",
      persistentBudget,
    );
  }
  const validShape =
    (journal.phase === "prepared" &&
      ((source !== undefined && trash === undefined) ||
        (source === undefined && trash !== undefined))) ||
    (journal.phase === "quarantined" && source === undefined && trash !== undefined) ||
    (journal.phase === "deleting" && source === undefined) ||
    (journal.phase === "committed" && source === undefined && trash === undefined);
  if (!validShape) {
    throw new GenerationStoreFsError(
      "clean recovery filesystem shape is impossible for its durable phase",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }

  verifyCleanGenerations(
    store,
    initialInventory,
    journal,
    receipt,
    activationRead,
    persistentBudget,
    source !== undefined || trash !== undefined,
  );
  assertMutationAuthority(store, held);
  const finalInventory = inspectRecoveryStoreLayout(store);
  if (!sameRecoveryInventory(initialInventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "clean recovery inventory changed during classification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalJournal = readStoreRecord(
    store,
    transactionPath(store, transactionId),
    TransactionRecordSchema,
    "transaction",
  );
  if (!sameStoredRecord(journalRead, finalJournal)) {
    throw new GenerationStoreFsError(
      "clean recovery journal changed during classification",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalActivation = readCleanJournalActivation(store, finalInventory, journal);
  if (
    (activationRead === undefined) !== (finalActivation === undefined) ||
    (activationRead !== undefined &&
      finalActivation !== undefined &&
      !sameStoredRecord(activationRead, finalActivation))
  ) {
    throw new GenerationStoreFsError(
      "clean recovery activation changed during classification",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  return Object.freeze({
    inventory: finalInventory,
    journal,
    receipt,
    activationRead: finalActivation,
    transactionTemporary,
    source,
    trash,
  });
}

function advanceCleanJournal(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: CleanTransactionRecord,
  phase: CleanTransactionRecord["phase"],
): CleanTransactionRecord {
  assertMutationAuthority(store, held);
  const next = TransactionRecordSchema.parse({ ...journal, phase });
  if (next.operation !== "clean") {
    throw new GenerationStoreFsError(
      "clean journal changed operation",
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

function verifyCleanRecoveryTerminal(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: CleanTransactionRecord,
  journalPresent: boolean,
): string | null {
  assertMutationAuthority(store, held);
  const initialInventory = inspectRecoveryStoreLayout(store);
  if (
    !initialInventory.lockPresent ||
    initialInventory.lockCandidates.length > 0 ||
    !sameStrings(initialInventory.transactions, journalPresent ? [journal.transactionId] : []) ||
    initialInventory.staging.length > 0 ||
    initialInventory.trash.length > 0 ||
    initialInventory.activationTemporaries.length > 0 ||
    initialInventory.transactionTemporaries.length > 0 ||
    generationByDigest(initialInventory, journal.generationDigest) !== undefined
  ) {
    throw new GenerationStoreFsError(
      "clean recovery terminal inventory retains pending state",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (journalPresent) {
    const stored = readStoreRecord(
      store,
      transactionPath(store, journal.transactionId),
      TransactionRecordSchema,
      "transaction",
    );
    if (
      stored.record.operation !== "clean" ||
      stored.record.phase !== "committed" ||
      !sameRecordBytes("transaction", stored.record, journal)
    ) {
      throw new GenerationStoreFsError(
        "clean recovery terminal journal changed",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
  }
  const activationRead = readCleanJournalActivation(store, initialInventory, journal);
  verifyCleanGenerations(
    store,
    initialInventory,
    journal,
    exactCleanReceipt(store, journal),
    activationRead,
    createStoreWalkBudget(),
    false,
  );
  assertMutationAuthority(store, held);
  const finalInventory = inspectRecoveryStoreLayout(store);
  if (!sameRecoveryInventory(initialInventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "clean recovery terminal inventory changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalActivation = readCleanJournalActivation(store, finalInventory, journal);
  if (
    (activationRead === undefined) !== (finalActivation === undefined) ||
    (activationRead !== undefined &&
      finalActivation !== undefined &&
      !sameStoredRecord(activationRead, finalActivation))
  ) {
    throw new GenerationStoreFsError(
      "clean recovery terminal activation changed",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  return finalActivation?.record.manifestDigest ?? null;
}

function executeCleanRecovery(
  store: OwnedStore,
  held: HeldStoreLock,
  classification: CleanRecoveryClassification,
): string | null {
  let journal = classification.journal;
  let trash = classification.trash;
  if (classification.transactionTemporary !== undefined) {
    assertMutationAuthority(store, held);
    removeBoundedRecoveryTemporary(store, classification.transactionTemporary);
  }
  if (journal.phase === "prepared") {
    if (classification.source !== undefined) {
      assertMutationAuthority(store, held);
      ensureOwnedDirectory(store, store.layout.trash);
      trash = quarantineExactDirectory(store, classification.source, journal.transactionId);
    }
    if (trash === undefined) {
      throw new GenerationStoreFsError(
        "prepared clean recovery lacks an exact source",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    journal = advanceCleanJournal(store, held, journal, "quarantined");
  }
  if (journal.phase === "quarantined") {
    if (trash === undefined) {
      throw new GenerationStoreFsError(
        "quarantined clean recovery lacks exact trash",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    journal = advanceCleanJournal(store, held, journal, "deleting");
  }
  if (journal.phase === "deleting") {
    if (trash !== undefined) {
      assertMutationAuthority(store, held);
      removeVerifiedTree(store, trash);
    }
    journal = advanceCleanJournal(store, held, journal, "committed");
  }
  verifyCleanRecoveryTerminal(store, held, journal, true);
  assertMutationAuthority(store, held);
  removeExactStoreRecord(
    store,
    transactionPath(store, journal.transactionId),
    "transaction",
    journal,
  );
  return verifyCleanRecoveryTerminal(store, held, journal, false);
}

function stableNoPendingRecovery(
  store: OwnedStore,
  held: HeldStoreLock,
  initialInventory: RecoveryStoreLayoutInventory,
): string | null {
  if (
    !initialInventory.lockPresent ||
    initialInventory.lockCandidates.length > 0 ||
    initialInventory.transactions.length > 0 ||
    initialInventory.staging.length > 0 ||
    initialInventory.trash.length > 0 ||
    initialInventory.activationTemporaries.length > 0 ||
    initialInventory.transactionTemporaries.length > 0 ||
    initialInventory.generations.some((generation) => !completedGeneration(generation))
  ) {
    throw new GenerationStoreFsError(
      "pending recovery state has no exact journal",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const activationRead = readRecoveryActivation(store, initialInventory);
  const activeDigest = activationRead?.record.manifestDigest;
  const persistentBudget = createStoreWalkBudget();
  if (activationRead !== undefined) {
    const active = inspectOwnedGeneration(
      store,
      activationRead.record,
      initialInventory,
      persistentBudget,
    );
    if (active.state !== "verified") throwInspectionFailure(active);
  }
  for (const generation of initialInventory.generations) {
    if (generation.manifestDigest === activeDigest) continue;
    const history = inspectGeneration(store, generation, null, persistentBudget);
    if (history.state !== "verified") throwInspectionFailure(history);
  }
  assertMutationAuthority(store, held);
  const finalInventory = inspectRecoveryStoreLayout(store);
  if (!sameRecoveryInventory(initialInventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "stable recovery inventory changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalActivation = readRecoveryActivation(store, finalInventory);
  if (
    (activationRead === undefined) !== (finalActivation === undefined) ||
    (activationRead !== undefined &&
      finalActivation !== undefined &&
      !sameStoredRecord(activationRead, finalActivation))
  ) {
    throw new GenerationStoreFsError(
      "stable recovery activation changed",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  return finalActivation?.record.manifestDigest ?? null;
}

function recoverPendingTransactionsUnderLock(
  store: OwnedStore,
  held: HeldStoreLock,
  fault: (point: RecoveryFaultPoint) => void = () => {},
): Readonly<{ recovered: boolean; activeDigest: string | null }> {
  assertMutationAuthority(store, held);
  const initialInventory = inspectRecoveryStoreLayout(store);
  if (initialInventory.transactions.length === 0) {
    if (initialInventory.transactionTemporaries.length === 1) {
      const temporary = initialInventory.transactionTemporaries[0];
      if (
        temporary === undefined ||
        temporary.phase !== "prepared" ||
        initialInventory.lockCandidates.length > 0 ||
        initialInventory.staging.length > 0 ||
        initialInventory.trash.length > 0 ||
        initialInventory.activationTemporaries.length > 0 ||
        initialInventory.generations.some((generation) => !completedGeneration(generation))
      ) {
        throw new GenerationStoreFsError(
          "initial journal temporary is not the only pending state",
          "METHODOLOGY_STORE_TRANSACTION_INVALID",
        );
      }
      assertMutationAuthority(store, held);
      removeBoundedRecoveryTemporary(
        store,
        transactionTemporaryPath(store, temporary.transactionId, temporary.phase),
      );
      fault("after-recovery-transaction-temporary-removed");
      const finalInventory = inspectRecoveryStoreLayout(store);
      return Object.freeze({
        recovered: true,
        activeDigest: stableNoPendingRecovery(store, held, finalInventory),
      });
    }
    return Object.freeze({
      recovered: false,
      activeDigest: stableNoPendingRecovery(store, held, initialInventory),
    });
  }
  if (initialInventory.transactions.length !== 1) {
    throw new GenerationStoreFsError(
      "multiple recovery journals are ambiguous",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const transactionId = initialInventory.transactions[0];
  if (transactionId === undefined) {
    throw new GenerationStoreFsError(
      "recovery transaction identity disappeared",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  let pending: TransactionRecord;
  try {
    pending = readStoreRecord(
      store,
      transactionPath(store, transactionId),
      TransactionRecordSchema,
      "transaction",
    ).record;
  } catch {
    throw new GenerationStoreFsError(
      "recovery journal filename or record binding is invalid",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  if (pending.operation === "clean") {
    const classification = classifyCleanRecovery(store, held, initialInventory);
    return Object.freeze({
      recovered: true,
      activeDigest: executeCleanRecovery(store, held, classification),
    });
  }
  const classification = classifyApplyRecovery(store, held, initialInventory);
  return Object.freeze({
    recovered: true,
    activeDigest: executeApplyRecovery(store, held, classification, fault),
  });
}

function strictlyObservedRecoveryActiveDigest(store: OwnedStore): string | null {
  try {
    const initialInventory = inspectRecoveryStoreLayout(store);
    const activationRead = readRecoveryActivation(store, initialInventory);
    if (activationRead === undefined) return null;
    const active = inspectOwnedGeneration(
      store,
      activationRead.record,
      initialInventory,
      createStoreWalkBudget(),
    );
    if (active.state !== "verified") return null;
    const finalInventory = inspectRecoveryStoreLayout(store);
    if (!sameRecoveryInventory(initialInventory, finalInventory)) return null;
    const finalActivation = readRecoveryActivation(store, finalInventory);
    return finalActivation !== undefined && sameStoredRecord(activationRead, finalActivation)
      ? finalActivation.record.manifestDigest
      : null;
  } catch {
    return null;
  }
}

type RecoveryGenerationStoreRuntime = Readonly<{
  onFaultPoint: (point: RecoveryFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;

function recoverProjectionInternal(
  value: unknown,
  runtime: RecoveryGenerationStoreRuntime | undefined,
): RecoveryProjectionResult {
  let projectRoot: string;
  try {
    const parsed = RecoverProjectionInputSchema.safeParse(value);
    if (!parsed.success) {
      return recoveryResult("failed-closed", null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]);
    }
    projectRoot = parsed.data.projectRoot;
  } catch {
    return recoveryResult("failed-closed", null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]);
  }

  let store: OwnedStore | undefined;
  try {
    store = openStoreForInspection(projectRoot);
  } catch (error) {
    return recoveryFailure(error, null);
  }
  if (store === undefined) {
    try {
      return openStoreForInspection(projectRoot) === undefined
        ? recoveryResult("nothing-to-recover", null, [])
        : recoveryResult("failed-closed", null, [
            { code: "METHODOLOGY_STORE_TRANSACTION_INVALID" },
          ]);
    } catch (error) {
      return recoveryFailure(error, null);
    }
  }

  let transactionId: string;
  try {
    transactionId = randomBytes(32).toString("hex");
  } catch (error) {
    return recoveryFailure(error, null);
  }
  let held: HeldStoreLock;
  try {
    held =
      runtime === undefined
        ? acquireStoreLock(store, transactionId)
        : acquireStoreLockInternal(store, transactionId, runtime.lockRuntime);
  } catch (error) {
    return recoveryFailure(error, null);
  }

  let result: Readonly<{ recovered: boolean; activeDigest: string | null }> | undefined;
  let didFail = false;
  let failure: unknown;
  let injected = false;
  let injectedError: unknown;
  const fault = (point: RecoveryFaultPoint): void => {
    if (runtime === undefined) return;
    try {
      runtime.onFaultPoint(point);
    } catch (error) {
      injected = true;
      injectedError = error;
      throw error;
    }
  };
  try {
    result = recoverPendingTransactionsUnderLock(store, held, fault);
  } catch (error) {
    didFail = true;
    failure = error;
  }
  const failureDigest = didFail ? strictlyObservedRecoveryActiveDigest(store) : null;
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
    return recoveryFailure(failure, failureDigest ?? strictlyObservedRecoveryActiveDigest(store));
  }
  if (result === undefined) {
    return recoveryFailure(
      new GenerationStoreFsError(
        "recovery completed without a result",
        "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
      ),
      strictlyObservedRecoveryActiveDigest(store),
    );
  }
  return recoveryResult(
    result.recovered ? "recovered" : "nothing-to-recover",
    result.activeDigest,
    [],
  );
}

export type CleanFaultPoint =
  | "after-clean-journal-prepared"
  | "before-clean-quarantine"
  | "after-clean-quarantine"
  | "during-clean-delete"
  | "after-clean-delete";

export function recoverProjectionStoreWithRuntime(
  value: unknown,
  runtime: RecoveryGenerationStoreRuntime,
): RecoveryProjectionResult {
  return recoverProjectionInternal(value, runtime);
}

export function recoverProjectionStore(value: unknown): RecoveryProjectionResult {
  return recoverProjectionInternal(value, undefined);
}

type CleanGenerationStoreRuntime = Readonly<{
  onFaultPoint: (point: CleanFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;

type VerifiedCleanState = Readonly<{
  inventory: FixedStoreLayoutInventory;
  activationRead: StoredRecordRead<ActivationRecord> | undefined;
  receipt: GenerationReceipt;
  source: VerifiedTree;
}>;

const CLEAN_RETAINED_FINDINGS = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
  "METHODOLOGY_STORE_GENERATION_DRIFT",
  "METHODOLOGY_STORE_CLEAN_RETAINED",
]);

function cleanFailure(error: unknown, generationDigest: string | null): CleanProjectionResult {
  let code: StoreFindingCode =
    error instanceof GenerationStoreContractError || error instanceof GenerationStoreFsError
      ? error.findingCode
      : "METHODOLOGY_STORE_FILESYSTEM_FAILURE";
  if (
    !new Set<StoreFindingCode>([
      "METHODOLOGY_STORE_INPUT_INVALID",
      "METHODOLOGY_STORE_RESOURCE_LIMIT",
      "METHODOLOGY_STORE_ROOT_UNOWNED",
      "METHODOLOGY_STORE_PATH_UNSAFE",
      "METHODOLOGY_STORE_LOCK_HELD",
      "METHODOLOGY_STORE_LOCK_INVALID",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
      "METHODOLOGY_STORE_GENERATION_DRIFT",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
      "METHODOLOGY_STORE_CLEAN_ACTIVE",
      "METHODOLOGY_STORE_CLEAN_RETAINED",
      "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
    ]).has(code)
  ) {
    code = "METHODOLOGY_STORE_FILESYSTEM_FAILURE";
  }
  if (
    code === "METHODOLOGY_STORE_INPUT_INVALID" ||
    code === "METHODOLOGY_STORE_LOCK_HELD" ||
    code === "METHODOLOGY_STORE_CLEAN_ACTIVE"
  ) {
    return cleanResult("blocked", generationDigest, [{ code }]);
  }
  if (CLEAN_RETAINED_FINDINGS.has(code)) {
    return cleanResult("retained", generationDigest, [{ code }]);
  }
  return cleanResult("failed-closed", generationDigest, [{ code }]);
}

function throwCleanTargetFailure(error: unknown): never {
  if (error instanceof GenerationStoreFsError) {
    if (
      error.findingCode === "METHODOLOGY_STORE_RESOURCE_LIMIT" ||
      error.findingCode === "METHODOLOGY_STORE_ROOT_UNOWNED" ||
      CLEAN_RETAINED_FINDINGS.has(error.findingCode)
    ) {
      throw error;
    }
  }
  throw new GenerationStoreFsError(
    "clean target is not an exact safely removable generation",
    "METHODOLOGY_STORE_CLEAN_RETAINED",
  );
}

function readExactCleanTarget(
  store: OwnedStore,
  generationDigest: string,
  budget: StoreWalkBudget,
): Readonly<{ receipt: GenerationReceipt; source: VerifiedTree }> {
  try {
    const generationRoot = join(store.layout.generations, generationDigest);
    const receiptRead = readStoreRecord(
      store,
      join(generationRoot, "receipt.json"),
      GenerationReceiptSchema,
      "receipt",
    );
    if (
      receiptRead.record.rootId !== store.rootRecord.rootId ||
      receiptRead.record.manifestDigest !== generationDigest
    ) {
      throw new GenerationStoreFsError(
        "clean receipt does not bind its owned generation",
        "METHODOLOGY_STORE_CLEAN_RETAINED",
      );
    }
    const source = verifyExpectedContainer(
      store,
      generationRoot,
      "receipt",
      receiptRead.record,
      receiptRead.record.entries,
      budget,
    );
    return Object.freeze({ receipt: receiptRead.record, source });
  } catch (error) {
    return throwCleanTargetFailure(error);
  }
}

function verifyOtherCleanGenerations(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
  excludedDigest: string,
  activeDigest: string | undefined,
  budget: StoreWalkBudget,
): void {
  for (const generation of inventory.generations) {
    if (
      generation.manifestDigest === excludedDigest ||
      generation.manifestDigest === activeDigest
    ) {
      continue;
    }
    if (!completedGeneration(generation)) {
      throw new GenerationStoreFsError(
        "clean found an unrelated incomplete generation",
        "METHODOLOGY_STORE_TRANSACTION_INVALID",
      );
    }
    const observed = inspectGeneration(store, generation, null, budget);
    if (observed.state !== "verified") throwInspectionFailure(observed);
  }
}

function readStableCleanActivation(
  store: OwnedStore,
  inventory: FixedStoreLayoutInventory,
): StoredRecordRead<ActivationRecord> | undefined {
  return inventory.activePresent
    ? readStoreRecord(store, store.layout.active, ActivationRecordSchema, "activation")
    : undefined;
}

function verifiedPreCleanState(
  store: OwnedStore,
  held: HeldStoreLock,
  generationDigest: string,
): VerifiedCleanState {
  const recoveryInventory = inspectRecoveryStoreLayout(store);
  const incompletePresent = recoveryInventory.generations.some(incompleteGeneration);
  const pending =
    recoveryInventory.transactions.length > 0 ||
    recoveryInventory.staging.length > 0 ||
    recoveryInventory.trash.length > 0 ||
    recoveryInventory.activationTemporaries.length > 0 ||
    recoveryInventory.transactionTemporaries.length > 0 ||
    incompletePresent;
  const inventory = pending
    ? recoverCommittedTransactionsUnderLock(store, held)
    : inspectFixedStoreLayout(store);
  if (
    !inventory.lockPresent ||
    inventory.lockCandidates.length > 0 ||
    inventory.transactions.length > 0 ||
    inventory.staging.length > 0 ||
    inventory.trash.length > 0
  ) {
    throw new GenerationStoreFsError(
      "clean preflight retains pending state",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const activationRead = readStableCleanActivation(store, inventory);
  if (activationRead?.record.manifestDigest === generationDigest) {
    throw new GenerationStoreFsError(
      "active generation cannot be cleaned",
      "METHODOLOGY_STORE_CLEAN_ACTIVE",
    );
  }
  const persistentBudget = createStoreWalkBudget();
  if (activationRead !== undefined) {
    const active = inspectOwnedGeneration(
      store,
      activationRead.record,
      inventory,
      persistentBudget,
    );
    if (active.state !== "verified") throwInspectionFailure(active);
  }
  const candidate = generationByDigest(inventory, generationDigest);
  if (candidate === undefined) {
    throw new GenerationStoreFsError("clean target is absent", "METHODOLOGY_STORE_CLEAN_RETAINED");
  }
  if (!completedGeneration(candidate)) {
    throw new GenerationStoreFsError(
      "clean target is incomplete",
      "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
    );
  }
  const exact = readExactCleanTarget(store, generationDigest, persistentBudget);
  verifyOtherCleanGenerations(
    store,
    inventory,
    generationDigest,
    activationRead?.record.manifestDigest,
    persistentBudget,
  );
  assertMutationAuthority(store, held);
  const finalInventory = inspectFixedStoreLayout(store);
  if (!sameInventory(inventory, finalInventory)) {
    throw new GenerationStoreFsError(
      "clean preflight inventory changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const finalActivation = readStableCleanActivation(store, finalInventory);
  if (
    (activationRead === undefined) !== (finalActivation === undefined) ||
    (activationRead !== undefined &&
      finalActivation !== undefined &&
      !sameStoredRecord(activationRead, finalActivation))
  ) {
    throw new GenerationStoreFsError(
      "clean preflight activation changed",
      "METHODOLOGY_STORE_ACTIVATION_INVALID",
    );
  }
  return Object.freeze({
    inventory: finalInventory,
    activationRead: finalActivation,
    receipt: exact.receipt,
    source: exact.source,
  });
}

function writeInitialCleanJournal(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: CleanTransactionRecord,
): void {
  assertMutationAuthority(store, held);
  writeAtomicRecord(store, {
    kind: "transaction",
    targetPath: transactionPath(store, journal.transactionId),
    temporaryPath: transactionTemporaryPath(store, journal.transactionId, "prepared"),
    record: journal,
    mode: "create",
  });
  const stored = readStoreRecord(
    store,
    transactionPath(store, journal.transactionId),
    TransactionRecordSchema,
    "transaction",
  );
  if (
    stored.record.operation !== "clean" ||
    !sameRecordBytes("transaction", stored.record, journal)
  ) {
    throw new GenerationStoreFsError(
      "prepared clean journal verification failed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
}

function verifyPreparedCleanState(
  store: OwnedStore,
  held: HeldStoreLock,
  journal: CleanTransactionRecord,
): VerifiedTree {
  assertMutationAuthority(store, held);
  const inventory = inspectFixedStoreLayout(store);
  if (
    !inventory.lockPresent ||
    inventory.lockCandidates.length > 0 ||
    !sameStrings(inventory.transactions, [journal.transactionId]) ||
    inventory.staging.length > 0 ||
    inventory.trash.length > 0 ||
    generationByDigest(inventory, journal.generationDigest) === undefined
  ) {
    throw new GenerationStoreFsError(
      "prepared clean state changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const stored = readStoreRecord(
    store,
    transactionPath(store, journal.transactionId),
    TransactionRecordSchema,
    "transaction",
  );
  if (
    stored.record.operation !== "clean" ||
    !sameRecordBytes("transaction", stored.record, journal)
  ) {
    throw new GenerationStoreFsError(
      "prepared clean journal changed",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  const activationRead = readCleanJournalActivation(store, inventory, journal);
  const persistentBudget = createStoreWalkBudget();
  let source: VerifiedTree;
  try {
    source = exactCleanSource(store, journal, exactCleanReceipt(store, journal), persistentBudget);
  } catch (error) {
    return throwCleanTargetFailure(error);
  }
  if (activationRead !== undefined) {
    const active = inspectOwnedGeneration(
      store,
      activationRead.record,
      inventory,
      persistentBudget,
    );
    if (active.state !== "verified") throwInspectionFailure(active);
  }
  verifyOtherCleanGenerations(
    store,
    inventory,
    journal.generationDigest,
    activationRead?.record.manifestDigest,
    persistentBudget,
  );
  return source;
}

function runCleanUnderLock(
  store: OwnedStore,
  held: HeldStoreLock,
  generationDigest: string,
  transactionId: string,
  fault: (point: CleanFaultPoint) => void,
): CleanProjectionResult {
  const before = verifiedPreCleanState(store, held, generationDigest);
  assertMutationAuthority(store, held);
  ensureOwnedDirectory(store, store.layout.transactions);
  ensureOwnedDirectory(store, store.layout.trash);
  let journal = TransactionRecordSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    operation: "clean",
    rootId: store.rootRecord.rootId,
    transactionId,
    phase: "prepared",
    generationDigest,
    oldActivation: before.activationRead?.record ?? null,
    entries: before.receipt.entries,
  });
  if (journal.operation !== "clean") {
    throw new GenerationStoreFsError(
      "clean journal changed operation",
      "METHODOLOGY_STORE_TRANSACTION_INVALID",
    );
  }
  writeInitialCleanJournal(store, held, journal);
  fault("after-clean-journal-prepared");

  const source = verifyPreparedCleanState(store, held, journal);
  fault("before-clean-quarantine");
  assertMutationAuthority(store, held);
  const trash = quarantineExactDirectory(store, source, transactionId);
  fault("after-clean-quarantine");

  journal = advanceCleanJournal(store, held, journal, "quarantined");
  journal = advanceCleanJournal(store, held, journal, "deleting");
  assertMutationAuthority(store, held);
  removeVerifiedTree(store, trash, () => fault("during-clean-delete"));
  fault("after-clean-delete");
  journal = advanceCleanJournal(store, held, journal, "committed");
  verifyCleanRecoveryTerminal(store, held, journal, true);
  assertMutationAuthority(store, held);
  removeExactStoreRecord(
    store,
    transactionPath(store, journal.transactionId),
    "transaction",
    journal,
  );
  verifyCleanRecoveryTerminal(store, held, journal, false);
  return cleanResult("cleaned", generationDigest, []);
}

function cleanProjectionInternal(
  value: unknown,
  runtime: CleanGenerationStoreRuntime | undefined,
): CleanProjectionResult {
  let parsed: ReturnType<typeof CleanProjectionInputSchema.safeParse>;
  try {
    parsed = CleanProjectionInputSchema.safeParse(value);
  } catch {
    return cleanResult("blocked", null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]);
  }
  if (!parsed.success) {
    return cleanResult("blocked", null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]);
  }
  const input = parsed.data;
  let store: OwnedStore | undefined;
  try {
    store = openStoreForInspection(input.projectRoot);
  } catch (error) {
    return cleanFailure(error, input.generationDigest);
  }
  if (store === undefined) {
    return cleanResult("retained", input.generationDigest, [
      { code: "METHODOLOGY_STORE_CLEAN_RETAINED" },
    ]);
  }
  let transactionId: string;
  try {
    transactionId = randomBytes(32).toString("hex");
  } catch (error) {
    return cleanFailure(error, input.generationDigest);
  }
  let held: HeldStoreLock;
  try {
    held =
      runtime === undefined
        ? acquireStoreLock(store, transactionId)
        : acquireStoreLockInternal(store, transactionId, runtime.lockRuntime);
  } catch (error) {
    return cleanFailure(error, input.generationDigest);
  }

  let injected = false;
  let injectedError: unknown;
  const fault = (point: CleanFaultPoint): void => {
    if (runtime === undefined) return;
    try {
      runtime.onFaultPoint(point);
    } catch (error) {
      injected = true;
      injectedError = error;
      throw error;
    }
  };
  let result: CleanProjectionResult | undefined;
  let failure: unknown;
  try {
    result = runCleanUnderLock(store, held, input.generationDigest, transactionId, fault);
  } catch (error) {
    failure = error;
  }
  try {
    releaseStoreLock(store, held);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    if (injected && Object.is(failure, injectedError)) throw failure;
    return cleanFailure(failure, input.generationDigest);
  }
  return (
    result ??
    cleanFailure(
      new GenerationStoreFsError(
        "clean completed without a result",
        "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
      ),
      input.generationDigest,
    )
  );
}

export function cleanProjectionGenerationWithRuntime(
  value: unknown,
  runtime: CleanGenerationStoreRuntime,
): CleanProjectionResult {
  return cleanProjectionInternal(value, runtime);
}

export function cleanProjectionGeneration(value: unknown): CleanProjectionResult {
  return cleanProjectionInternal(value, undefined);
}
