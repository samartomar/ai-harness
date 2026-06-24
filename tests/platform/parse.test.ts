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
});
