import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Transport controls use inert bytes; they do not manufacture release authority.
const { maxTarballBytes, validateQualifiedTarball } = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/acquire-public.mjs")).href
);
const { exactRegistryMetadataText } = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/validate-public-inputs.mjs")).href
);

describe("hosted public tarball transport", () => {
  const bytes = Buffer.from("inert transport payload");
  const digest = createHash("sha256").update(bytes).digest("hex");

  it("returns only the exact qualified bytes for exclusive staging", () => {
    expect(validateQualifiedTarball(bytes, digest)).toBe(bytes);
  });

  it("refuses altered or truncated bytes before the caller can persist them", () => {
    const altered = Buffer.from(bytes);
    altered.writeUInt8(altered.readUInt8(0) ^ 1, 0);
    expect(() => validateQualifiedTarball(altered, digest)).toThrow("digest mismatch");
    expect(() => validateQualifiedTarball(bytes.subarray(1), digest)).toThrow("digest mismatch");
  });

  it("refuses empty, oversized or non-byte payloads", () => {
    for (const input of [Buffer.alloc(0), Buffer.alloc(maxTarballBytes + 1), "text"]) {
      expect(() => validateQualifiedTarball(input, digest)).toThrow("size refused");
    }
  });

  it("refuses absent, zero, prefixed or malformed qualification digests", () => {
    for (const value of [undefined, "0".repeat(64), `sha256:${digest}`, "f".repeat(63)]) {
      expect(() => validateQualifiedTarball(bytes, value)).toThrow("digest required");
    }
  });
});

describe("exact registry evidence retention", () => {
  it("preserves original UTF8 bytes, whitespace and Unicode without reserializing", () => {
    const bytes = Buffer.from(' { "description": "café", "n": 1 }\r\n');
    expect(Buffer.from(exactRegistryMetadataText(bytes))).toEqual(bytes);
  });

  it("rejects malformed UTF8 instead of recording replacement characters", () => {
    for (const bytes of [
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from([0xe2, 0x82]),
    ]) {
      expect(() => exactRegistryMetadataText(bytes)).toThrow();
    }
  });

  it("rejects empty, oversized and non-byte metadata", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1), "{}"]) {
      expect(() => exactRegistryMetadataText(bytes)).toThrow("metadata byte limit");
    }
  });
});
