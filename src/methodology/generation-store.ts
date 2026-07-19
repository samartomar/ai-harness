import { join } from "node:path";
import {
  type ActivationRecord,
  ActivationRecordSchema,
  type GenerationReceipt,
  GenerationReceiptSchema,
  type IncompleteRecord,
  IncompleteRecordSchema,
  InspectProjectionInputSchema,
  inspectionResult,
  type ProjectionInspectionResult,
  type StoreFinding,
  type StoreFindingCode,
  sha256Bytes,
} from "./generation-store-contract.js";
import {
  createStoreWalkBudget,
  type FixedGenerationLayout,
  type FixedStoreLayoutInventory,
  GenerationStoreFsError,
  inspectFixedStoreLayout,
  type OwnedStore,
  openStoreForInspection,
  readStoreRecord,
  type StoredRecordRead,
  type StoreObjectIdentity,
  type StoreWalkBudget,
  verifyBoundedOwnedTreeSafety,
  verifyExpectedContainer,
} from "./generation-store-fs.js";

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
