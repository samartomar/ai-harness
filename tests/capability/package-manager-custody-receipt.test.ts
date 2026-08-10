import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
  capabilityPackageCustodyReceiptPath,
  MAX_CAPABILITY_PACKAGE_CUSTODY_RECEIPT_BYTES,
  parseCapabilityPackageCustodyReceipt,
  readCapabilityPackageCustodyReceipt,
  serializeCapabilityPackageCustodyReceipt,
} from "../../src/capability/package-manager/custody-receipt.js";

const OWNERSHIP_SHA = "a".repeat(64);
const TRUST_SHA = "b".repeat(64);
const FILE_SHA = "c".repeat(64);
let root: string;

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    format: CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
    schemaVersion: 1,
    ownershipReceipt: { sha256: OWNERSHIP_SHA },
    domainReceipt: { kind: "skill-promotion-trust-lock", sha256: TRUST_SHA },
    members: [
      {
        id: "skill:clean",
        packageIds: ["package:skill-pack/docs", "package:skill-pack/base"],
      },
    ],
    files: [
      {
        memberId: "skill:clean",
        path: "ai-coding/skills/owner-repo/clean/SKILL.md",
        sha256: FILE_SHA,
        mode: 0o640,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-package-custody-receipt-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Capability Package Manager custody receipt", () => {
  it("canonically binds both content-addressing digests and exact member files", () => {
    const parsed = parseCapabilityPackageCustodyReceipt(JSON.stringify(receipt()));
    expect(parsed.members[0]?.packageIds).toEqual([
      "package:skill-pack/base",
      "package:skill-pack/docs",
    ]);
    expect(capabilityPackageCustodyReceiptPath(OWNERSHIP_SHA, TRUST_SHA)).toBe(
      `.aih/capability-packages/custody-v1/${OWNERSHIP_SHA}-${TRUST_SHA}.json`,
    );
    const text = serializeCapabilityPackageCustodyReceipt(parsed);
    expect(text.endsWith("\n")).toBe(true);
    expect(
      serializeCapabilityPackageCustodyReceipt(parseCapabilityPackageCustodyReceipt(text)),
    ).toBe(text);
  });

  it("strictly rejects unsafe, partial, duplicate, and mismatched custody claims", () => {
    const cases = [
      receipt({ unknown: true }),
      receipt({ ownershipReceipt: { sha256: "A".repeat(64) } }),
      receipt({ domainReceipt: { kind: "other", sha256: TRUST_SHA } }),
      receipt({ members: [] }),
      receipt({ files: [] }),
      receipt({
        members: [
          { id: "skill:clean", packageIds: ["package:skill-pack/base"] },
          { id: "skill:clean", packageIds: ["package:skill-pack/docs"] },
        ],
      }),
      receipt({
        members: [
          {
            id: "skill:clean",
            packageIds: ["package:skill-pack/base", "package:skill-pack/base"],
          },
        ],
      }),
      receipt({
        members: [
          { id: "skill:clean", packageIds: ["package:skill-pack/base"] },
          { id: "skill:other", packageIds: ["package:skill-pack/base"] },
        ],
      }),
      receipt({ members: [{ id: "agent:bad", packageIds: ["package:skill-pack/base"] }] }),
      receipt({
        members: [{ id: "skill:clean", packageIds: ["package:other/base"] }],
      }),
      receipt({
        files: [
          {
            memberId: "skill:missing",
            path: "ai-coding/skills/owner-repo/clean/SKILL.md",
            sha256: FILE_SHA,
          },
        ],
      }),
      ...["/absolute", "../escape", "C:/escape", "safe:stream", "safe\\file"].map((path) =>
        receipt({
          files: [{ memberId: "skill:clean", path, sha256: FILE_SHA }],
        }),
      ),
      receipt({
        files: [
          {
            memberId: "skill:clean",
            path: "ai-coding/skills/owner-repo/clean/SKILL.md",
            sha256: FILE_SHA,
          },
          {
            memberId: "skill:clean",
            path: "AI-CODING/skills/owner-repo/clean/SKILL.md",
            sha256: FILE_SHA,
          },
        ],
      }),
      receipt({
        files: [
          {
            memberId: "skill:clean",
            path: "ai-coding/skills/owner-repo/clean/SKILL.md",
            sha256: FILE_SHA,
            mode: -1,
          },
        ],
      }),
    ];
    for (const candidate of cases) {
      expect(() => parseCapabilityPackageCustodyReceipt(JSON.stringify(candidate))).toThrow(
        "invalid capability package custody receipt",
      );
    }
    expect(() => capabilityPackageCustodyReceiptPath("bad", TRUST_SHA)).toThrow(
      "invalid capability package custody receipt identity",
    );
  });

  it("reads only the exact two-digest path and returns copied source bytes", () => {
    const path = capabilityPackageCustodyReceiptPath(OWNERSHIP_SHA, TRUST_SHA);
    const source = Buffer.from(serializeCapabilityPackageCustodyReceipt(receipt()), "utf8");
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source, { mode: 0o600 });

    const read = readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, TRUST_SHA);
    expect(read).toMatchObject({
      state: "valid",
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    });
    if (read.state !== "valid") throw new Error("expected valid custody receipt");
    expect(read.sourceBytes).toEqual(source);
    expect(read.sourceBytes).not.toBe(source);
    source.fill(0);
    expect(read.sourceBytes[0]).not.toBe(0);
    expect(readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, "d".repeat(64))).toEqual({
      state: "absent",
    });
  });

  it("fails closed for unsafe or oversized receipt files", () => {
    const path = capabilityPackageCustodyReceiptPath(OWNERSHIP_SHA, TRUST_SHA);
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    const outside = join(root, "outside.json");
    writeFileSync(outside, serializeCapabilityPackageCustodyReceipt(receipt()));
    symlinkSync(outside, absolute);
    expect(readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, TRUST_SHA)).toEqual({
      state: "malformed",
      detail: "invalid capability package custody receipt file",
    });
    rmSync(absolute);
    linkSync(outside, absolute);
    expect(readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, TRUST_SHA).state).toBe(
      "malformed",
    );
    rmSync(absolute);
    writeFileSync(absolute, Buffer.alloc(MAX_CAPABILITY_PACKAGE_CUSTODY_RECEIPT_BYTES + 1));
    expect(readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, TRUST_SHA).state).toBe(
      "malformed",
    );
    rmSync(absolute);
    mkdirSync(absolute);
    expect(readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, TRUST_SHA)).toEqual({
      state: "malformed",
      detail: "invalid capability package custody receipt file",
    });
    rmSync(absolute, { recursive: true });
    writeFileSync(absolute, Buffer.from([0xff]));
    expect(readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, TRUST_SHA).state).toBe(
      "malformed",
    );
  });

  it("rejects internal receipt digests that disagree with the exact requested path", () => {
    const path = capabilityPackageCustodyReceiptPath(OWNERSHIP_SHA, TRUST_SHA);
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    for (const overrides of [
      { ownershipReceipt: { sha256: "d".repeat(64) } },
      {
        domainReceipt: {
          kind: "skill-promotion-trust-lock",
          sha256: "e".repeat(64),
        },
      },
    ]) {
      writeFileSync(absolute, serializeCapabilityPackageCustodyReceipt(receipt(overrides)));
      expect(readCapabilityPackageCustodyReceipt(root, OWNERSHIP_SHA, TRUST_SHA)).toEqual({
        state: "malformed",
        detail: "invalid capability package custody receipt",
      });
    }
  });

  it("never executes inherited toJSON hooks while serializing", () => {
    let calls = 0;
    const objectPrior = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayPrior = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value() {
          calls += 1;
          return { corrupted: true };
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value() {
          calls += 1;
          return ["corrupted"];
        },
      });
      expect(serializeCapabilityPackageCustodyReceipt(receipt())).toContain(
        '"format": "aih-capability-package-custody-receipt"',
      );
    } finally {
      if (objectPrior === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, "toJSON", objectPrior);
      if (arrayPrior === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, "toJSON", arrayPrior);
    }
    expect(calls).toBe(0);
  });

  it("rejects serializer accessors, proxies, and cycles with one fixed error", () => {
    let calls = 0;
    const accessor = receipt();
    Object.defineProperty(accessor, "format", {
      enumerable: true,
      get() {
        calls += 1;
        return CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT;
      },
    });
    const cyclic = receipt() as Record<string, unknown>;
    cyclic.cycle = cyclic;
    for (const candidate of [accessor, new Proxy(receipt(), {}), cyclic]) {
      expect(() => serializeCapabilityPackageCustodyReceipt(candidate)).toThrow(
        "invalid capability package custody receipt",
      );
    }
    expect(calls).toBe(0);
  });
});
