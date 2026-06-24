import { describe, expect, it } from "vitest";
import { makeHostAdapter, resolvePlatform } from "../../src/platform/detect.js";

describe("platform detection", () => {
  it("honors the AIH_PLATFORM override", () => {
    expect(resolvePlatform({ AIH_PLATFORM: "linux" })).toBe("linux");
    expect(resolvePlatform({ AIH_PLATFORM: "darwin" })).toBe("darwin");
  });

  it("builds the matching adapter and reports verification status", () => {
    expect(makeHostAdapter({ platform: "windows", env: {} }).platform).toBe("windows");
    expect(makeHostAdapter({ platform: "windows", env: {} }).verified).toBe(true);
    expect(makeHostAdapter({ platform: "linux", env: {} }).verified).toBe(true);
    // macOS path is implemented + fixture-tested but not yet smoke-tested on metal.
    expect(makeHostAdapter({ platform: "darwin", env: {} }).verified).toBe(false);
  });
});
