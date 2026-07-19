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
import { afterEach, describe, expect, it } from "vitest";
import {
  assessStableStoreSnapshot,
  inspectOwnedGeneration,
  inspectProjectionStore,
  verifyStableEmptySnapshot,
  verifyStableProjectionSnapshot,
} from "../../src/methodology/generation-store.js";
import {
  type ActivationRecord,
  ActivationRecordSchema,
  canonicalRecordBytes,
  GENERATION_STORE_READ_BOUNDARY,
  type GenerationReceipt,
  type ProjectionInspectionResult,
  sha256Bytes,
} from "../../src/methodology/generation-store-contract.js";
import {
  createOrOpenOwnedStore,
  inspectFixedStoreLayout,
  readStoreRecord,
} from "../../src/methodology/generation-store-fs.js";
import {
  expectedReceiptEntries,
  makeSiblingCanary,
  makeTemporaryProject,
  payloadFixture,
  plannedFixture,
  type TemporaryProject,
} from "./generation-store-fixtures.js";

const OTHER_DIGEST = "b".repeat(64);
const TRANSACTION_ID = "d".repeat(64);
const roots: TemporaryProject[] = [];

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
