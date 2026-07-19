import { describe, expect, it } from "vitest";
import {
  ActivationRecordSchema,
  ApplyProjectionInputSchema,
  applyResult,
  CleanProjectionInputSchema,
  canonicalRecordBytes,
  cleanResult,
  GENERATION_STORE_MUTATION_BOUNDARY,
  GENERATION_STORE_READ_BOUNDARY,
  GenerationReceiptSchema,
  IncompleteRecordSchema,
  InspectProjectionInputSchema,
  inspectionResult,
  isCanonicalProjectionTarget,
  isGenerationDirectoryName,
  isLockCandidateName,
  isStagingDirectoryName,
  isTransactionFilename,
  LockOwnerRecordSchema,
  MAX_FINDING_SUBJECT_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PID,
  ProjectionInspectionResultSchema,
  parseApplyProjectionInput,
  RecoverProjectionInputSchema,
  RootRecordSchema,
  recoveryResult,
  StagingRecordSchema,
  StoreFindingSchema,
  sha256Bytes,
  TransactionRecordSchema,
} from "../../src/methodology/generation-store-contract.js";
import {
  aggregateOverflowPayloadFixture,
  DEPENDENCY_BYTES,
  payloadFixture,
  plannedFixture,
  plannedPayloadSet,
  ROOT_BYTES,
} from "./generation-store-fixtures.js";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const ROOT_ID = "c".repeat(64);
const TRANSACTION_ID = "d".repeat(64);

function planned() {
  const result = plannedFixture();
  if (result.state !== "planned") throw new Error("fixture must plan");
  return result;
}

function receipt() {
  return {
    schemaVersion: 1,
    rootId: ROOT_ID,
    manifestDigest: planned().manifest.digest,
    entries: planned().manifest.entries.map((entry) => ({
      ...entry,
      bytes: entry.artifactId === "root" ? ROOT_BYTES.length : DEPENDENCY_BYTES.length,
    })),
  };
}

function activation() {
  return {
    schemaVersion: 1,
    manifestDigest: planned().manifest.digest,
    receiptDigest: DIGEST,
    generation: `generations/${planned().manifest.digest}/content`,
  };
}

function applyTransaction(entries = receipt().entries) {
  return {
    schemaVersion: 1,
    operation: "apply" as const,
    rootId: ROOT_ID,
    transactionId: TRANSACTION_ID,
    phase: "prepared" as const,
    manifestDigest: planned().manifest.digest,
    oldActivation: null,
    newActivation: activation(),
    entries,
  };
}

function cleanTransaction(entries = receipt().entries) {
  return {
    schemaVersion: 1,
    operation: "clean" as const,
    rootId: ROOT_ID,
    transactionId: TRANSACTION_ID,
    phase: "prepared" as const,
    generationDigest: planned().manifest.digest,
    oldActivation: activation(),
    entries,
  };
}

describe("Phase 4 generation-store contract", () => {
  it("accepts exactly one complete, digest-bound Phase 3 payload set and copies its bytes", () => {
    const source = payloadFixture();
    const parsed = parseApplyProjectionInput({
      mode: "apply",
      projectRoot: "/work/project",
      plan: planned(),
      payloads: source,
      expectedActiveDigest: null,
    });

    expect(parsed.plan.manifest.digest).toBe(planned().manifest.digest);
    expect(parsed.payloads.map((payload) => payload.artifactId)).toEqual(["dependency", "root"]);
    source[0]?.bytes.fill(0);
    expect(parsed.payloads.find((payload) => payload.artifactId === "root")?.bytes).toEqual(
      ROOT_BYTES,
    );
    expect(ApplyProjectionInputSchema.safeParse({ ...parsed, unexpected: true }).success).toBe(
      false,
    );
  });

  it.each([
    [
      "blocked plan",
      { ...planned(), state: "blocked", findings: [{ code: "METHODOLOGY_TARGET_INVALID" }] },
    ],
    ["missing payload", payloadFixture().slice(1)],
    ["extra payload", [...payloadFixture(), { artifactId: "extra", bytes: Buffer.from("x") }]],
    ["duplicate payload", [...payloadFixture(), payloadFixture()[0]]],
    ["digest mismatch", [{ artifactId: "root", bytes: Buffer.from("wrong") }, payloadFixture()[1]]],
    [
      "individual payload overflow",
      [{ artifactId: "root", bytes: Buffer.alloc(MAX_PAYLOAD_BYTES + 1) }, payloadFixture()[1]],
    ],
  ])("rejects %s", (_label, candidate) => {
    const value = {
      mode: "apply",
      projectRoot: "/work/project",
      plan: Array.isArray(candidate) ? planned() : candidate,
      payloads: Array.isArray(candidate) ? candidate : payloadFixture(),
      expectedActiveDigest: null,
    };
    expect(() => parseApplyProjectionInput(value)).toThrow();
  });

  it("rejects total payload overflow when every individual payload is within its limit", () => {
    const payloads = aggregateOverflowPayloadFixture();
    const plan = plannedPayloadSet(payloads);
    expect(plan.state).toBe("planned");
    expect(payloads.every(({ bytes }) => bytes.byteLength === MAX_PAYLOAD_BYTES)).toBe(true);
    expect(() =>
      parseApplyProjectionInput({
        mode: "apply",
        projectRoot: "/work/project",
        plan,
        payloads,
        expectedActiveDigest: null,
      }),
    ).toThrow();
  });

  it("rejects accessor-backed payload fields before evaluating them", () => {
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, "artifactId", { enumerable: true, value: "root" });
    Object.defineProperty(payload, "bytes", {
      enumerable: true,
      get() {
        throw new Error("accessor must not run");
      },
    });
    expect(() =>
      parseApplyProjectionInput({
        mode: "apply",
        projectRoot: "/work/project",
        plan: planned(),
        payloads: [payload, payloadFixture()[1]],
        expectedActiveDigest: null,
      }),
    ).toThrow();
  });

  it("rejects non-canonical targets independently of the Phase 3 parser", () => {
    const tooDeep = Array.from({ length: 33 }, () => "x").join("/");
    for (const target of [
      tooDeep,
      "rules\\root.md",
      "/rules/root.md",
      "rules//root.md",
      ".",
      "..",
      "rules/./root.md",
      "rules/../root.md",
      "rules/root.md.",
      "rules/con",
    ]) {
      expect(isCanonicalProjectionTarget(target)).toBe(false);
    }
    expect(isCanonicalProjectionTarget("rules/root.md")).toBe(true);
  });

  it("strictly validates stored records, bounded findings, and result keys", () => {
    expect(
      RootRecordSchema.safeParse({ schemaVersion: 1, rootId: ROOT_ID, rootDevice: "0" }).success,
    ).toBe(true);
    expect(
      RootRecordSchema.safeParse({ schemaVersion: 1, rootId: ROOT_ID, rootDevice: "01" }).success,
    ).toBe(false);
    expect(
      RootRecordSchema.safeParse({ schemaVersion: 1, rootId: ROOT_ID, rootDevice: "1".repeat(21) })
        .success,
    ).toBe(false);
    expect(
      RootRecordSchema.safeParse({
        schemaVersion: 1,
        rootId: ROOT_ID,
        rootDevice: "18446744073709551616",
      }).success,
    ).toBe(false);
    expect(GenerationReceiptSchema.safeParse(receipt()).success).toBe(true);
    expect(
      ActivationRecordSchema.safeParse({ ...activation(), generation: "elsewhere" }).success,
    ).toBe(false);
    expect(
      IncompleteRecordSchema.safeParse({
        schemaVersion: 1,
        rootId: ROOT_ID,
        transactionId: TRANSACTION_ID,
        manifestDigest: DIGEST,
      }).success,
    ).toBe(true);
    expect(
      IncompleteRecordSchema.safeParse({
        schemaVersion: 1,
        rootId: ROOT_ID,
        transactionId: TRANSACTION_ID,
        manifestDigest: DIGEST,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      StagingRecordSchema.safeParse({
        schemaVersion: 1,
        rootId: ROOT_ID,
        transactionId: TRANSACTION_ID,
        manifestDigest: DIGEST,
      }).success,
    ).toBe(true);
    expect(
      LockOwnerRecordSchema.safeParse({
        schemaVersion: 1,
        rootId: ROOT_ID,
        token: DIGEST,
        pid: MAX_PID + 1,
        transactionId: TRANSACTION_ID,
      }).success,
    ).toBe(false);
    expect(StoreFindingSchema.safeParse({ code: "UNKNOWN" }).success).toBe(false);
    expect(
      StoreFindingSchema.safeParse({
        code: "METHODOLOGY_STORE_INPUT_INVALID",
        subject: "é".repeat(MAX_FINDING_SUBJECT_BYTES / 2 + 1),
      }).success,
    ).toBe(false);
    expect(
      applyResult("blocked", null, null, [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }]),
    ).toMatchObject({ boundary: GENERATION_STORE_MUTATION_BOUNDARY });
    expect(() => applyResult("blocked", null, null, [])).toThrow();
    expect(() =>
      cleanResult("cleaned", null, [{ code: "METHODOLOGY_STORE_CLEAN_RETAINED" }]),
    ).toThrow();
    expect(() =>
      inspectionResult("failed-closed", null, [{ code: "METHODOLOGY_STORE_CLEAN_ACTIVE" }]),
    ).toThrow();
    expect(() =>
      applyResult("failed-closed", null, null, [{ code: "METHODOLOGY_STORE_CLEAN_ACTIVE" }]),
    ).toThrow();
    expect(recoveryResult("nothing-to-recover", null, [])).toMatchObject({
      boundary: GENERATION_STORE_MUTATION_BOUNDARY,
    });
    expect(
      CleanProjectionInputSchema.safeParse({
        projectRoot: "/work/project",
        generationDigest: DIGEST,
        extra: true,
      }).success,
    ).toBe(false);
    expect(InspectProjectionInputSchema.safeParse({ projectRoot: "/work/project" }).success).toBe(
      true,
    );
    expect(
      InspectProjectionInputSchema.safeParse({ projectRoot: "/work/project", extra: true }).success,
    ).toBe(false);
    expect(RecoverProjectionInputSchema.safeParse({ projectRoot: "/work/project" }).success).toBe(
      true,
    );
    expect(
      RecoverProjectionInputSchema.safeParse({ projectRoot: "/work/project", extra: true }).success,
    ).toBe(false);
    const inspected = inspectionResult("empty", null, []);
    expect(inspected.boundary).toBe(GENERATION_STORE_READ_BOUNDARY);
    expect(ProjectionInspectionResultSchema.safeParse({ ...inspected, extra: true }).success).toBe(
      false,
    );
    expect(GENERATION_STORE_READ_BOUNDARY.writeCapability).toBe("none");
  });
  it("rejects receipt aggregate overflow and file/directory ancestor collisions", () => {
    const overflowEntries = Array.from({ length: 9 }, (_, index) => ({
      artifactId: `overflow-${index}`,
      target: `rules/overflow-${index}.md`,
      sourceLocator: `synthetic:overflow-${index}`,
      contentDigest: DIGEST,
      bytes: MAX_PAYLOAD_BYTES,
    }));
    expect(
      GenerationReceiptSchema.safeParse({ ...receipt(), entries: overflowEntries }).success,
    ).toBe(false);

    const first = receipt().entries[0];
    const second = receipt().entries[1];
    if (first === undefined || second === undefined) {
      throw new Error("fixture must contain two receipt entries");
    }
    expect(
      GenerationReceiptSchema.safeParse({
        ...receipt(),
        entries: [
          { ...first, target: "rules" },
          {
            ...first,
            artifactId: "interleaved",
            sourceLocator: "synthetic:interleaved",
            target: "rules-x",
          },
          { ...second, target: "rules/root.md" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects transaction resource, collision, directory, and digest inconsistencies", () => {
    const overflowEntries = Array.from({ length: 9 }, (_, index) => ({
      artifactId: `overflow-${index}`,
      target: `rules/overflow-${index}.md`,
      sourceLocator: `synthetic:overflow-${index}`,
      contentDigest: DIGEST,
      bytes: MAX_PAYLOAD_BYTES,
    }));
    expect(TransactionRecordSchema.safeParse(applyTransaction(overflowEntries)).success).toBe(
      false,
    );

    const first = receipt().entries[0];
    const second = receipt().entries[1];
    if (first === undefined || second === undefined) {
      throw new Error("fixture must contain two receipt entries");
    }
    expect(
      TransactionRecordSchema.safeParse(
        applyTransaction([
          { ...first, target: "rules" },
          {
            ...first,
            artifactId: "interleaved",
            sourceLocator: "synthetic:interleaved",
            target: "rules-x",
          },
          { ...second, target: "rules/root.md" },
        ]),
      ).success,
    ).toBe(false);

    const directoryHeavyEntries = Array.from({ length: 64 }, (_, index) => ({
      artifactId: `entry-${index}`,
      target: `root-${index}/${Array.from({ length: 9 }, (_unused, part) => `d${part}`).join("/")}/file.md`,
      sourceLocator: `synthetic:entry-${index}`,
      contentDigest: DIGEST,
      bytes: 0,
    }));
    expect(TransactionRecordSchema.safeParse(cleanTransaction(directoryHeavyEntries)).success).toBe(
      false,
    );

    expect(
      TransactionRecordSchema.safeParse({
        ...applyTransaction(),
        manifestDigest: OTHER_DIGEST,
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe identifiers and verifies exact record/path-name bindings", () => {
    for (const value of ["a/b", "a\\b", ".", "..", "CON", "a".repeat(65), "A".repeat(64)]) {
      expect(
        RootRecordSchema.safeParse({ schemaVersion: 1, rootId: value, rootDevice: "1" }).success,
      ).toBe(false);
    }
    expect(
      ActivationRecordSchema.safeParse({
        ...activation(),
        receiptDigest: OTHER_DIGEST.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(isTransactionFilename(`${TRANSACTION_ID}.json`, TRANSACTION_ID)).toBe(true);
    expect(isTransactionFilename(`${TRANSACTION_ID}.tmp`, TRANSACTION_ID)).toBe(false);
    expect(isTransactionFilename(`${OTHER_DIGEST}.json`, TRANSACTION_ID)).toBe(false);
    expect(isStagingDirectoryName(TRANSACTION_ID, TRANSACTION_ID)).toBe(true);
    expect(isStagingDirectoryName(OTHER_DIGEST, TRANSACTION_ID)).toBe(false);
    expect(isGenerationDirectoryName(planned().manifest.digest, planned().manifest.digest)).toBe(
      true,
    );
    expect(isGenerationDirectoryName(OTHER_DIGEST, planned().manifest.digest)).toBe(false);
    expect(isLockCandidateName(`${DIGEST}.stale`, DIGEST, true)).toBe(true);
    expect(isLockCandidateName(`${DIGEST}.stale`, DIGEST, false)).toBe(false);
    expect(isLockCandidateName(`${OTHER_DIGEST}.stale`, DIGEST, true)).toBe(false);
  });

  it("emits schema-specific canonical JSON independent of caller insertion or receipt order", () => {
    const forward = receipt();
    const reversed = {
      entries: [...forward.entries].reverse().map((entry) => ({
        bytes: entry.bytes,
        contentDigest: entry.contentDigest,
        sourceLocator: entry.sourceLocator,
        target: entry.target,
        artifactId: entry.artifactId,
      })),
      manifestDigest: forward.manifestDigest,
      rootId: forward.rootId,
      schemaVersion: forward.schemaVersion,
    };
    const again = receipt();
    const bytes = canonicalRecordBytes("receipt", forward);
    expect(bytes).toEqual(canonicalRecordBytes("receipt", reversed));
    expect(bytes).toEqual(canonicalRecordBytes("receipt", again));
    expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
    expect(sha256Bytes(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strictly serializes transaction variants and rejects malformed fields", () => {
    const transaction = applyTransaction();
    expect(TransactionRecordSchema.safeParse(transaction).success).toBe(true);
    expect(TransactionRecordSchema.safeParse({ ...transaction, phase: "unknown" }).success).toBe(
      false,
    );
    expect(canonicalRecordBytes("transaction", transaction)).toEqual(
      canonicalRecordBytes("transaction", structuredClone(transaction)),
    );
    const clean = cleanTransaction();
    expect(TransactionRecordSchema.safeParse(clean).success).toBe(true);
    expect(canonicalRecordBytes("transaction", clean)).toEqual(
      canonicalRecordBytes("transaction", structuredClone(clean)),
    );
  });

  it("maps clean filesystem failures to retained only", () => {
    expect(
      cleanResult("retained", DIGEST, [{ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" }]),
    ).toMatchObject({ state: "retained", generationDigest: DIGEST });
    expect(() =>
      cleanResult("failed-closed", null, [{ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" }]),
    ).toThrow();
  });
});
