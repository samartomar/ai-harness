import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_FORMAT,
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES,
  parseCapabilityPackageOwnershipReceipt,
  readCapabilityPackageOwnershipReceipt,
  serializeCapabilityPackageOwnershipReceipt,
} from "../../src/capability/package-manager/receipt.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);
let root: string;

function receipt(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_FORMAT,
    schemaVersion: 1,
    manifest: { sha256: "c".repeat(64) },
    roots: ["package:demo/root"],
    packages: [
      {
        id: "package:demo/root",
        authorityId: "catalog:main",
        claimDigest: "d".repeat(64),
        sourceDigest: { algorithm: "git-sha1", value: SHA1 },
        dependencies: ["package:demo/dep"],
        members: [
          {
            id: "skill:root",
            claimDigest: "e".repeat(64),
            sourceDigest: { algorithm: "sha256", value: SHA256 },
            authorityRefs: [
              {
                authorityId: "lock:baseline",
                claimDigest: "3".repeat(64),
                sourceDigest: { algorithm: "sha256", value: "4".repeat(64) },
              },
              {
                authorityId: "catalog:main",
                claimDigest: "2".repeat(64),
                sourceDigest: { algorithm: "git-sha1", value: SHA1 },
              },
            ],
          },
        ],
      },
      {
        id: "package:demo/dep",
        authorityId: "lock:baseline",
        claimDigest: "f".repeat(64),
        sourceDigest: { algorithm: "sha256", value: SHA256 },
        dependencies: [],
        members: [
          {
            id: "rule:dep",
            claimDigest: "1".repeat(64),
            sourceDigest: { algorithm: "git-sha1", value: SHA1 },
            authorityRefs: [
              {
                authorityId: "receipt:ecc",
                claimDigest: "5".repeat(64),
                sourceDigest: { algorithm: "sha256", value: "6".repeat(64) },
              },
            ],
          },
        ],
      },
    ],
    ...extra,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-capability-package-receipt-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Capability Package Manager ownership receipt", () => {
  it("strictly parses and canonically serializes exact package/member pins", () => {
    const value = receipt({
      roots: ["package:demo/root"],
      packages: [...(receipt().packages as unknown[])].reverse(),
    });
    const parsed = parseCapabilityPackageOwnershipReceipt(JSON.stringify(value));
    expect(parsed.packages.map(({ id }) => id)).toEqual(["package:demo/dep", "package:demo/root"]);
    expect(
      parsed.packages[1]?.members[0]?.authorityRefs.map(({ authorityId }) => authorityId),
    ).toEqual(["catalog:main", "lock:baseline"]);
    const text = serializeCapabilityPackageOwnershipReceipt(parsed);
    expect(text.endsWith("\n")).toBe(true);
    expect(
      serializeCapabilityPackageOwnershipReceipt(parseCapabilityPackageOwnershipReceipt(text)),
    ).toBe(text);
  });

  it("represents final-root removal only while retained package ownership remains", () => {
    const retained = parseCapabilityPackageOwnershipReceipt(JSON.stringify(receipt({ roots: [] })));
    expect(retained.roots).toEqual([]);
    expect(
      parseCapabilityPackageOwnershipReceipt(serializeCapabilityPackageOwnershipReceipt(retained)),
    ).toEqual(retained);
    expect(() =>
      parseCapabilityPackageOwnershipReceipt(JSON.stringify(receipt({ roots: [], packages: [] }))),
    ).toThrow(/invalid capability package ownership receipt/i);
  });

  it("rejects copied authorities, destinations, unknown fields, duplicates, and dangling refs", () => {
    const basePackages = receipt().packages as Array<Record<string, unknown>>;
    const basePackage = basePackages[0];
    if (basePackage === undefined) throw new Error("invalid test fixture");
    const baseMember = (basePackage.members as Array<Record<string, unknown>>)[0];
    if (baseMember === undefined) throw new Error("invalid test fixture");
    const baseAuthorityRefs = baseMember.authorityRefs as unknown[];
    const cases = [
      receipt({ authority: { id: "catalog:main" } }),
      receipt({
        packages: [{ ...basePackages[0], authority: { id: "catalog:main" } }, basePackages[1]],
      }),
      receipt({
        packages: [{ ...basePackages[0], destinationPath: ".claude/skill.md" }, basePackages[1]],
      }),
      receipt({ roots: ["package:demo/root", "package:demo/root"] }),
      receipt({ packages: [basePackages[0], basePackages[0]] }),
      receipt({ roots: ["package:demo/missing"] }),
      receipt({
        packages: [{ ...basePackages[0], authorityId: "skill:not-authority" }, basePackages[1]],
      }),
      receipt({
        packages: [{ ...basePackages[0], dependencies: ["package:demo/missing"] }, basePackages[1]],
      }),
      receipt({
        packages: [
          {
            ...basePackages[0],
            members: [
              {
                ...baseMember,
                authorityRefs: [],
              },
            ],
          },
          basePackages[1],
        ],
      }),
      receipt({
        packages: [
          {
            ...basePackages[0],
            members: [
              {
                ...baseMember,
                authorityRefs: [...baseAuthorityRefs, baseAuthorityRefs[0]],
              },
            ],
          },
          basePackages[1],
        ],
      }),
      receipt({
        packages: [
          {
            ...basePackages[0],
            members: [
              {
                ...baseMember,
                authorityRefs: [
                  {
                    authorityId: "skill:not-authority",
                    claimDigest: "2".repeat(64),
                    sourceDigest: { algorithm: "git-sha1", value: SHA1 },
                    unknown: true,
                  },
                ],
              },
            ],
          },
          basePackages[1],
        ],
      }),
    ];
    for (const value of cases) {
      expect(() => parseCapabilityPackageOwnershipReceipt(JSON.stringify(value))).toThrow(
        /invalid capability package ownership receipt/i,
      );
    }
  });

  it("rejects unsupported members, malformed pins, and foreign versions", () => {
    const packages = receipt().packages as Array<Record<string, unknown>>;
    for (const value of [
      receipt({ format: "foreign" }),
      receipt({ schemaVersion: 2 }),
      receipt({ manifest: { sha256: "C".repeat(64) } }),
      receipt({
        packages: [
          {
            ...packages[0],
            members: [
              {
                id: "hook:bad",
                claimDigest: "e".repeat(64),
                sourceDigest: { algorithm: "sha256", value: SHA256 },
                authorityRefs: [
                  {
                    authorityId: "catalog:main",
                    claimDigest: "2".repeat(64),
                    sourceDigest: { algorithm: "git-sha1", value: SHA1 },
                  },
                ],
              },
            ],
          },
          packages[1],
        ],
      }),
    ]) {
      expect(() => parseCapabilityPackageOwnershipReceipt(JSON.stringify(value))).toThrow(
        /invalid capability package ownership receipt/i,
      );
    }
  });

  it("reads exact receipt bytes with a distinct absent/malformed state", () => {
    expect(readCapabilityPackageOwnershipReceipt(root)).toEqual({ state: "absent" });
    const path = join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from(`${JSON.stringify(receipt(), null, 2)}\r\n`);
    writeFileSync(path, bytes);
    const valid = readCapabilityPackageOwnershipReceipt(root);
    expect(valid).toMatchObject({
      state: "valid",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    writeFileSync(path, Buffer.from([0xff]));
    expect(readCapabilityPackageOwnershipReceipt(root)).toMatchObject({ state: "malformed" });
  });

  it("bounds direct parsing and never invokes hostile serialization hooks", () => {
    expect(() =>
      parseCapabilityPackageOwnershipReceipt(
        " ".repeat(MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES + 1),
      ),
    ).toThrow(/invalid capability package ownership receipt/i);

    let calls = 0;
    const accessor = receipt();
    Object.defineProperty(accessor, "packages", {
      enumerable: true,
      get() {
        calls += 1;
        return [];
      },
    });
    expect(() => serializeCapabilityPackageOwnershipReceipt(accessor as never)).toThrow(
      /invalid capability package ownership receipt/i,
    );

    const ownHook = receipt();
    Object.defineProperty(ownHook, "toJSON", {
      enumerable: true,
      value() {
        calls += 1;
        return {};
      },
    });
    expect(() => serializeCapabilityPackageOwnershipReceipt(ownHook as never)).toThrow(
      /invalid capability package ownership receipt/i,
    );

    const customPrototype = Object.assign(Object.create({ inherited: true }), receipt());
    expect(() => serializeCapabilityPackageOwnershipReceipt(customPrototype as never)).toThrow(
      /invalid capability package ownership receipt/i,
    );

    const proxy = new Proxy(receipt(), {
      ownKeys() {
        calls += 1;
        return [];
      },
    });
    expect(() => serializeCapabilityPackageOwnershipReceipt(proxy as never)).toThrow(
      /invalid capability package ownership receipt/i,
    );

    const valid = parseCapabilityPackageOwnershipReceipt(JSON.stringify(receipt()));
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        calls += 1;
        return {};
      },
    });
    try {
      expect(serializeCapabilityPackageOwnershipReceipt(valid)).toContain(
        CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_FORMAT,
      );
    } finally {
      if (inherited === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, "toJSON", inherited);
    }
    expect(calls).toBe(0);
  });

  it("refuses symlinked, hardlinked, nonregular, and oversized receipts", () => {
    const path = join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(receipt()));
    try {
      symlinkSync(outside, path, "file");
      expect(readCapabilityPackageOwnershipReceipt(root)).toMatchObject({ state: "malformed" });
    } catch {
      // Symlink creation can be unavailable on Windows.
    }
    rmSync(path, { recursive: true, force: true });
    try {
      linkSync(outside, path);
      expect(readCapabilityPackageOwnershipReceipt(root)).toMatchObject({ state: "malformed" });
    } catch {
      // Hardlink creation can be unavailable on some filesystems.
    }
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
    expect(readCapabilityPackageOwnershipReceipt(root)).toMatchObject({ state: "malformed" });
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, Buffer.alloc(MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES + 1, 0x20));
    expect(readCapabilityPackageOwnershipReceipt(root)).toMatchObject({ state: "malformed" });
  });
});
