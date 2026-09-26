import { describe, expect, it } from "vitest";
import {
  loadScanCiscoShardRunnerV1,
  loadScanDetectorProbeV1,
  loadScanExecutionAdapterV1,
  loadScanPackageExportsV1,
  SCAN_PACKAGE_INSTALL_COMMAND,
  SCAN_PACKAGE_PEER_RANGE,
  SCAN_PACKAGE_PROJECT_INSTALL_COMMAND,
  scanPackageRefusalMessage,
} from "../../src/scan-package/load-scan-package.js";

// ---------------------------------------------------------------------------
// @aihq/scan is an optional peer of @aihq/core. Core reaches it only through
// this one module, at run time, and a missing or incompatible install is an
// explicit, typed refusal that names the supported install command. It is never
// a throw, a crash, or a silent substitute.
// ---------------------------------------------------------------------------

function moduleNotFound(): Error {
  return Object.assign(
    new Error("Cannot find package '@aihq/scan' imported from /consumer/node_modules/@aihq/core"),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
}

describe("load-scan-package", () => {
  it("states the supported install arrangement", () => {
    expect(SCAN_PACKAGE_INSTALL_COMMAND).toBe("npm install -g @aihq/core @aihq/scan");
    expect(SCAN_PACKAGE_PROJECT_INSTALL_COMMAND).toBe("npm install @aihq/core @aihq/scan");
    expect(SCAN_PACKAGE_PEER_RANGE).toBe(">=0.5.0 <0.6.0");
  });

  it("refuses as scan-package-unavailable when the package cannot be imported", async () => {
    const loaded = await loadScanPackageExportsV1(["createBaselineVetRequestV1"], () =>
      Promise.reject(moduleNotFound()),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("scan-package-unavailable");
    expect(loaded.refusal.detail).toContain("@aihq/scan is not installed");
    expect(loaded.refusal.detail).toContain(SCAN_PACKAGE_INSTALL_COMMAND);
    expect(loaded.refusal.detail).toContain(SCAN_PACKAGE_PROJECT_INSTALL_COMMAND);
    expect(scanPackageRefusalMessage(loaded.refusal)).toBe(
      `scan-package-unavailable: ${loaded.refusal.detail}`,
    );
  });

  it("reports any other import failure as unavailable with its own bounded reason", async () => {
    const loaded = await loadScanPackageExportsV1(["runDetectorV1"], () =>
      Promise.reject(new SyntaxError(`broken install ${"x".repeat(1_000)}`)),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("scan-package-unavailable");
    expect(loaded.refusal.detail).toContain("could not be loaded");
    expect(loaded.refusal.detail).toContain("broken install");
    expect(loaded.refusal.detail).toContain(SCAN_PACKAGE_INSTALL_COMMAND);
    expect(loaded.refusal.detail.length).toBeLessThan(700);
  });

  it("refuses as scan-package-incompatible when a needed export is not a function", async () => {
    const loaded = await loadScanPackageExportsV1(
      ["listDetectorCapabilitiesV1", "runDetectorV1"],
      () => Promise.resolve({ listDetectorCapabilitiesV1: () => [], runDetectorV1: "nope" }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("scan-package-incompatible");
    expect(loaded.refusal.detail).toContain("does not export runDetectorV1");
    expect(loaded.refusal.detail).not.toContain("listDetectorCapabilitiesV1");
    expect(loaded.refusal.detail).toContain(SCAN_PACKAGE_PEER_RANGE);
    expect(loaded.refusal.detail).toContain(SCAN_PACKAGE_INSTALL_COMMAND);
  });

  it("treats an export that throws on access as missing, never as a crash", async () => {
    const hostile = {};
    Object.defineProperty(hostile, "runDetectorV1", {
      get() {
        throw new Error("no such export on this mock");
      },
    });
    const loaded = await loadScanPackageExportsV1(["runDetectorV1"], () =>
      Promise.resolve(hostile),
    );
    expect(loaded).toMatchObject({ ok: false, refusal: { reason: "scan-package-incompatible" } });
  });

  it("refuses a module value that is not an object", async () => {
    const loaded = await loadScanPackageExportsV1(["runDetectorV1"], () =>
      Promise.resolve(undefined),
    );
    expect(loaded).toMatchObject({ ok: false, refusal: { reason: "scan-package-incompatible" } });
  });

  it("checks only the exports this caller needs", async () => {
    const createBaselineVetRequestV1 = () => ({});
    const loaded = await loadScanPackageExportsV1(["createBaselineVetRequestV1"], () =>
      Promise.resolve({ createBaselineVetRequestV1 }),
    );
    expect(loaded).toEqual({ ok: true, exports: { createBaselineVetRequestV1 } });
  });

  it("hands out Scan's own execution functions as the Core adapter", async () => {
    const listDetectorCapabilitiesV1 = () => [{ detectorId: "detector.cisco" }];
    const runDetectorV1 = () => Promise.resolve({ outcome: "refused" });
    const loaded = await loadScanExecutionAdapterV1(() =>
      Promise.resolve({ listDetectorCapabilitiesV1, runDetectorV1, unrelated: 1 }),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.adapter.listDetectorCapabilitiesV1).toBe(listDetectorCapabilitiesV1);
    expect(loaded.adapter.runDetectorV1).toBe(runDetectorV1);
    expect(Object.keys(loaded.adapter).sort()).toEqual([
      "listDetectorCapabilitiesV1",
      "runDetectorV1",
    ]);
  });

  it("refuses the execution adapter from a Scan that predates the runner", async () => {
    const loaded = await loadScanExecutionAdapterV1(() =>
      Promise.resolve({ createBaselineVetRequestV1: () => ({}) }),
    );
    expect(loaded).toMatchObject({ ok: false, refusal: { reason: "scan-package-incompatible" } });
    if (loaded.ok) return;
    expect(loaded.refusal.detail).toContain(
      "does not export listDetectorCapabilitiesV1, runDetectorV1",
    );
  });

  it("hands out Scan's availability probe with its capability list", async () => {
    const listDetectorCapabilitiesV1 = () => [];
    const probeDetectorAvailabilityV1 = () => Promise.resolve({ available: false });
    const loaded = await loadScanDetectorProbeV1(() =>
      Promise.resolve({
        listDetectorCapabilitiesV1,
        probeDetectorAvailabilityV1,
        runDetectorV1: 1,
      }),
    );
    expect(loaded).toEqual({
      ok: true,
      exports: { listDetectorCapabilitiesV1, probeDetectorAvailabilityV1 },
    });
  });

  it("hands out Scan's Cisco shard runner with its capability list", async () => {
    const listDetectorCapabilitiesV1 = () => [];
    const runCiscoShardV1 = () => Promise.resolve({ outcome: "refused" });
    const loaded = await loadScanCiscoShardRunnerV1(() =>
      Promise.resolve({ listDetectorCapabilitiesV1, runCiscoShardV1 }),
    );
    expect(loaded).toEqual({ ok: true, exports: { listDetectorCapabilitiesV1, runCiscoShardV1 } });
  });

  it("refuses a Scan without the shard runner or the probe as incompatible, naming the export", async () => {
    const older = () => Promise.resolve({ listDetectorCapabilitiesV1: () => [] });
    const shard = await loadScanCiscoShardRunnerV1(older);
    const probe = await loadScanDetectorProbeV1(older);
    expect(shard).toMatchObject({ ok: false, refusal: { reason: "scan-package-incompatible" } });
    expect(probe).toMatchObject({ ok: false, refusal: { reason: "scan-package-incompatible" } });
    if (shard.ok || probe.ok) return;
    expect(shard.refusal.detail).toContain("does not export runCiscoShardV1");
    expect(probe.refusal.detail).toContain("does not export probeDetectorAvailabilityV1");
    expect(shard.refusal.detail).toContain(">=0.5.0 <0.6.0");
  });
});
