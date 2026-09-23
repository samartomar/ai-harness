import { describe, expect, it } from "vitest";
import {
  assertWorkbenchReleaseCompatibleV1,
  workbenchReleaseCompatibleV1,
} from "../../src/internals/check-workbench-release-compatibility.js";

describe("packed Workbench release compatibility", () => {
  it("refuses a 0.6.2 candidate when Headroom selections require 0.7.0", () => {
    expect(workbenchReleaseCompatibleV1("0.6.2")).toBe(false);
    expect(() => assertWorkbenchReleaseCompatibleV1("0.6.2")).toThrow(
      "Release candidate Core 0.6.2 cannot consume Workbench policies requiring Core 0.7.0.",
    );
  });

  it("accepts the declared floor and later compatible releases", () => {
    expect(workbenchReleaseCompatibleV1("0.7.0")).toBe(true);
    expect(workbenchReleaseCompatibleV1("0.7.0+build-local")).toBe(true);
    expect(workbenchReleaseCompatibleV1("0.7.1")).toBe(true);
    expect(workbenchReleaseCompatibleV1("0.8.0-next.1")).toBe(true);
    expect(workbenchReleaseCompatibleV1("0.6.2", "0.6.0")).toBe(true);
  });

  it("refuses malformed and prerelease candidates at the exact floor", () => {
    expect(workbenchReleaseCompatibleV1("0.7.0-next.1")).toBe(false);
    expect(workbenchReleaseCompatibleV1("0.6")).toBe(false);
  });
});
