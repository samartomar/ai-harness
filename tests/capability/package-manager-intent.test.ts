import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_PACKAGE_INTENT_PATH,
  MAX_CAPABILITY_PACKAGE_INTENT_BYTES,
  parseCapabilityPackageIntentBytes,
  readCapabilityPackageIntent,
} from "../../src/capability/package-manager/intent.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);
let root: string;

function intent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    authorities: [
      {
        id: "catalog:main",
        kind: "catalog",
        sourceDigest: { algorithm: "sha256", value: SHA256 },
        projectionDigest: "c".repeat(64),
      },
    ],
    roots: ["package:demo/root"],
    packages: [
      {
        kind: "package",
        id: "package:demo/root",
        authorityId: "catalog:main",
        claimDigest: "d".repeat(64),
        sourceDigest: { algorithm: "git-sha1", value: SHA1 },
        dependencies: [],
        members: ["skill:review"],
      },
    ],
    ...extra,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-capability-package-intent-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Capability Package Manager committed intent bytes", () => {
  it("parses strict intent and binds the exact copied bytes", () => {
    const bytes = Buffer.from(`${JSON.stringify(intent(), null, 2)}\r\n`, "utf8");
    const parsed = parseCapabilityPackageIntentBytes(bytes);
    expect(parsed.manifest.schemaVersion).toBe(1);
    expect(parsed.sourceSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(parsed.sourceBytes).toEqual(bytes);
    expect(parsed.sourceBytes).not.toBe(bytes);
    bytes.fill(0);
    expect(parsed.sourceBytes[0]).not.toBe(0);
  });

  it("fails closed on malformed UTF-8, malformed JSON, and unknown manifest fields", () => {
    expect(() => parseCapabilityPackageIntentBytes(Buffer.from([0xff]))).toThrow(
      /invalid capability package intent/i,
    );
    expect(() => parseCapabilityPackageIntentBytes(Buffer.from("not json"))).toThrow(
      /invalid capability package intent/i,
    );
    expect(() =>
      parseCapabilityPackageIntentBytes(Buffer.from(JSON.stringify(intent({ authority: {} })))),
    ).toThrow(/invalid capability package intent/i);
    expect(() =>
      parseCapabilityPackageIntentBytes(
        Buffer.alloc(MAX_CAPABILITY_PACKAGE_INTENT_BYTES + 1, 0x20),
      ),
    ).toThrow(/invalid capability package intent/i);
  });

  it("reads absent and valid intent as distinct states", () => {
    expect(readCapabilityPackageIntent(root)).toEqual({ state: "absent" });
    const bytes = Buffer.from(`${JSON.stringify(intent())}\n`);
    writeFileSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), bytes);
    const result = readCapabilityPackageIntent(root);
    expect(result).toMatchObject({
      state: "valid",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("refuses symlinked, hardlinked, nonregular, and oversized intent without reading through", () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(intent()));
    try {
      symlinkSync(outside, join(root, CAPABILITY_PACKAGE_INTENT_PATH), "file");
      expect(readCapabilityPackageIntent(root)).toMatchObject({ state: "malformed" });
    } catch {
      // Symlink creation can be unavailable on Windows.
    }
    rmSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), { recursive: true, force: true });
    try {
      linkSync(outside, join(root, CAPABILITY_PACKAGE_INTENT_PATH));
      expect(readCapabilityPackageIntent(root)).toMatchObject({ state: "malformed" });
    } catch {
      // Hardlink creation can be unavailable on some filesystems.
    }
    rmSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), { recursive: true, force: true });
    mkdirSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH));
    expect(readCapabilityPackageIntent(root)).toMatchObject({ state: "malformed" });
    rmSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), { recursive: true, force: true });
    writeFileSync(
      join(root, CAPABILITY_PACKAGE_INTENT_PATH),
      Buffer.alloc(MAX_CAPABILITY_PACKAGE_INTENT_BYTES + 1, 0x20),
    );
    expect(readCapabilityPackageIntent(root)).toMatchObject({ state: "malformed" });
  });
});
