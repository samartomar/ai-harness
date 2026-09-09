import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sourceDataReceiptDigestsV1,
  stageSourceDataLocalHeadV1,
  verifySourceDataLocalHeadV1,
  verifySourceDataLocalReceiptV1,
  writeSourceDataLocalReceiptV1,
} from "../../../src/org-policy/workbench/core/source-data-local-receipt.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("machine-local verified source receipts", () => {
  it("keeps the protected index outside the data store and rejects active/history rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-local-head-"));
    roots.push(root);
    const store = join(root, "data");
    mkdirSync(store);
    vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", join(store, "bad-key-location"));
    expect(() => stageSourceDataLocalHeadV1(store, {}, { sequence: 1 })).toThrow();
    expect(readdirSync(store)).toEqual([]);
    vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", join(root, "verifier"));
    const old = { version: 1, active: "old", history: [] };
    const next = { version: 1, active: "new", history: ["old"] };
    stageSourceDataLocalHeadV1(store, {}, old);
    const restore = stageSourceDataLocalHeadV1(store, old, next);
    expect(() => verifySourceDataLocalHeadV1(store, old)).toThrow();
    expect(() => verifySourceDataLocalHeadV1(store, next)).not.toThrow();
    expect(() => stageSourceDataLocalHeadV1(store, {}, { version: 0 })).toThrow();
    restore();
    expect(() => verifySourceDataLocalHeadV1(store, old)).not.toThrow();
    expect(() => verifySourceDataLocalHeadV1(store, next)).toThrow();
  }, 30_000);
  it("binds exact cache facts, trust and original expiry; a missing or replaced key never blesses old summaries", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-local-receipt-"));
    roots.push(root);
    const store = join(root, "untrusted-data");
    mkdirSync(store);
    const privateDirectory = join(root, "local-verifier");
    vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", privateDirectory);
    const expected = sourceDataReceiptDigestsV1(
      `sha256:${"1".repeat(64)}`,
      { trusted: "root" },
      { evidence: "verified" },
    );
    const now = "2026-09-09T00:00:00.000Z";
    expect(() => verifySourceDataLocalReceiptV1(store, expected, now, false)).toThrow(/reimport/);
    expect(existsSync(privateDirectory)).toBe(false);
    writeSourceDataLocalReceiptV1(store, {
      ...expected,
      verifiedAt: now,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    expect(() => verifySourceDataLocalReceiptV1(store, expected, now, false)).not.toThrow();
    expect(readdirSync(store)).toEqual([]);
    expect(() =>
      verifySourceDataLocalReceiptV1(
        store,
        { ...expected, trustDigest: "f".repeat(64) },
        now,
        false,
      ),
    ).toThrow();
    expect(() =>
      verifySourceDataLocalReceiptV1(
        store,
        { ...expected, summaryDigest: "f".repeat(64) },
        now,
        false,
      ),
    ).toThrow();
    expect(() =>
      verifySourceDataLocalReceiptV1(store, expected, "2026-09-10T00:00:00.000Z", false),
    ).toThrow();
    expect(() =>
      verifySourceDataLocalReceiptV1(store, expected, "2026-09-10T00:00:00.000Z", true),
    ).not.toThrow();
    const receiptPath = join(
      privateDirectory,
      readdirSync(privateDirectory).find((name) => name.endsWith(".json"))!,
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const before = readFileSync(receiptPath);
    receipt.payload.verifierPolicy = "workbench-source-verifier/v0";
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(() => verifySourceDataLocalReceiptV1(store, expected, now, false)).toThrow();
    writeFileSync(receiptPath, before);
    const keyPath = join(privateDirectory, "verification-key.pkcs8.pem");
    const originalKeyHash = createHash("sha256").update(readFileSync(keyPath)).digest("hex");
    writeFileSync(
      keyPath,
      generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    expect(() => verifySourceDataLocalReceiptV1(store, expected, now, false)).toThrow();
    expect(createHash("sha256").update(readFileSync(keyPath)).digest("hex")).not.toBe(
      originalKeyHash,
    );
    unlinkSync(keyPath);
    expect(() => verifySourceDataLocalReceiptV1(store, expected, now, false)).toThrow();
    expect(() =>
      writeSourceDataLocalReceiptV1(store, {
        ...expected,
        verifiedAt: now,
        expiresAt: "2026-09-10T00:00:00.000Z",
      }),
    ).toThrow();
    expect(existsSync(keyPath)).toBe(false);
  }, 30_000);
});
