import { describe, expect, it } from "vitest";
import {
  parseCertLines,
  parseFirstInt,
  parseNvidiaSmi,
  parsePemBlocks,
} from "../../src/platform/parse.js";

describe("platform parsers", () => {
  it("parseFirstInt extracts the first integer", () => {
    expect(parseFirstInt("  16\n")).toBe(16);
    expect(parseFirstInt("none")).toBeUndefined();
  });

  it("parseNvidiaSmi maps MiB to GB plus the name", () => {
    const g = parseNvidiaSmi("8192, NVIDIA GeForce RTX 3070\n");
    expect(g).toMatchObject({
      vendor: "nvidia",
      backend: "cuda",
      vramGb: 8,
      name: "NVIDIA GeForce RTX 3070",
    });
  });

  it("parseNvidiaSmi selects the highest-VRAM GPU from multi-GPU output", () => {
    const g = parseNvidiaSmi("8192, RTX 3070\n24576, RTX 4090\n12288, RTX 4070\n");
    expect(g).toMatchObject({ vendor: "nvidia", backend: "cuda", vramGb: 24, name: "RTX 4090" });
  });

  it("parseNvidiaSmi returns none for empty output", () => {
    expect(parseNvidiaSmi("")).toMatchObject({ vendor: "none", backend: "cpu", vramGb: 0 });
  });

  it("parseCertLines builds a PEM from base64<TAB>subject", () => {
    const certs = parseCertLines(`${"Q".repeat(64)}\tCN=Zscaler Root CA`);
    expect(certs).toHaveLength(1);
    expect(certs[0]?.subject).toContain("Zscaler");
    expect(certs[0]?.pem).toContain("BEGIN CERTIFICATE");
  });

  it("parsePemBlocks extracts certificate blocks", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    expect(parsePemBlocks(pem)).toHaveLength(1);
  });

  it("parsePemBlocks extracts multiple blocks in order, trimming each", () => {
    const pem = [
      "noise",
      "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      "between",
      "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----",
    ].join("\n");
    const blocks = parsePemBlocks(pem);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.pem).toBe("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    expect(blocks[1]?.pem).toContain("BBBB");
  });

  it("parsePemBlocks ignores an unterminated BEGIN (and stays linear on the ReDoS input)", () => {
    // Many BEGINs, no END: the old lazy regex rescanned to end from each — O(n²).
    // The indexOf walk returns [] fast and matches nothing, exactly as the regex did.
    const evil = `${"-----BEGIN CERTIFICATE-----\n".repeat(50_000)}x`;
    expect(parsePemBlocks(evil)).toEqual([]);
  });
});
