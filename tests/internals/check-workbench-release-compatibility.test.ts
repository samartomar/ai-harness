import { describe, expect, it } from "vitest";
import {
  assertWorkbenchReleaseCompatibleV1,
  workbenchReleaseCompatibleV1,
} from "../../src/internals/check-workbench-release-compatibility.js";

describe("packed Workbench release compatibility", () => {
  it("refuses a 0.5.0 candidate when generated policies require 0.6.0", () => {
    expect(workbenchReleaseCompatibleV1("0.5.0")).toBe(false);
    expect(() => assertWorkbenchReleaseCompatibleV1("0.5.0")).toThrow(
      "Release candidate Core 0.5.0 cannot consume Workbench policies requiring Core 0.6.0.",
    );
  });

  it("accepts the declared floor and later compatible releases", () => {
    expect(workbenchReleaseCompatibleV1("0.6.0")).toBe(true);
    expect(workbenchReleaseCompatibleV1("0.6.0+build-local")).toBe(true);
    expect(workbenchReleaseCompatibleV1("0.6.1")).toBe(true);
    expect(workbenchReleaseCompatibleV1("0.7.0-next.1")).toBe(true);
  });

  it("refuses malformed and prerelease candidates at the exact floor", () => {
    expect(workbenchReleaseCompatibleV1("0.6.0-next.1")).toBe(false);
    expect(workbenchReleaseCompatibleV1("0.6")).toBe(false);
  });
});
