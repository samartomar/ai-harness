import { describe, expect, it } from "vitest";
import * as supported from "../../src/org-policy/supported-admin-v2.js";

describe("SupportedQualificationCustodyV2 roots", () => {
  it("derives only the fixed OS-admin enterprise roots and a governed vibe subpath", () => {
    const root = "C:/disposable/governed";
    expect(
      supported.supportedCustodyRootV2({ posture: "enterprise", platform: "win32", root }),
    ).toBe("C:\\ProgramData\\aih\\supported-qualification\\v2");
    expect(
      supported.supportedCustodyRootV2({ posture: "enterprise", platform: "darwin", root }),
    ).toBe("/Library/Application Support/aih/supported-qualification/v2");
    expect(
      supported.supportedCustodyRootV2({ posture: "enterprise", platform: "linux", root }),
    ).toBe("/etc/aih/supported-qualification/v2");
    expect(supported.supportedCustodyRootV2({ posture: "vibe", platform: "linux", root })).toBe(
      "C:/disposable/governed/.aih/supported-qualification/v2",
    );
  });

  it("uses one external shared enterprise lock and a root-local vibe lock", () => {
    const first = supported.supportedCustodyLockV2({
      posture: "enterprise",
      platform: "linux",
      root: "/tmp/a",
    });
    const second = supported.supportedCustodyLockV2({
      posture: "enterprise",
      platform: "linux",
      root: "/tmp/b",
    });
    expect(first).toEqual({
      external: true,
      path: "/etc/aih/supported-qualification/v2/locks/commit.lock",
      trustedBase: "/etc/aih/supported-qualification/v2",
    });
    expect(second).toEqual(first);
    expect(
      supported.supportedCustodyLockV2({ posture: "vibe", platform: "linux", root: "/tmp/a" }),
    ).toBe(".aih/supported-qualification/v2/locks/commit.lock");
  });
});
