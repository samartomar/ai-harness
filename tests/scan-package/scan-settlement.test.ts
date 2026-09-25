import { describe, expect, it } from "vitest";
import { bindScanSettlement, startTrackedScanCall } from "../../src/scan-package/settlement.js";

describe("delegated Scan call settlement", () => {
  it("registers the settlement before the call starts, and it resolves once the call settles", async () => {
    const controller = new AbortController();
    const settlements: Array<() => Promise<void>> = [];
    bindScanSettlement(controller.signal, (settlement) => settlements.push(settlement), 1_000);
    let release: (value: string) => void = () => {};
    const call = startTrackedScanCall(controller.signal, "detector.semgrep", () => {
      expect(settlements).toHaveLength(1);
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    let settled = false;
    const waiting = settlements[0]?.().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release("done");
    await waiting;
    expect(settled).toBe(true);
    await expect(call).resolves.toBe("done");
  });

  it("settles on a rejected call without rethrowing its error", async () => {
    const controller = new AbortController();
    const settlements: Array<() => Promise<void>> = [];
    bindScanSettlement(controller.signal, (settlement) => settlements.push(settlement), 1_000);
    const call = startTrackedScanCall(controller.signal, "detector.cisco", () =>
      Promise.reject(new Error("cancelled")),
    );
    await expect(call).rejects.toThrow("cancelled");
    await expect(settlements[0]?.()).resolves.toBeUndefined();
  });

  it("bounds the wait and names the call that did not settle", async () => {
    const controller = new AbortController();
    const settlements: Array<() => Promise<void>> = [];
    bindScanSettlement(controller.signal, (settlement) => settlements.push(settlement), 20);
    void startTrackedScanCall(
      controller.signal,
      "detector.skillspector",
      () => new Promise(() => {}),
    );
    await expect(settlements[0]?.()).rejects.toThrow(
      "delegated Scan call detector.skillspector did not settle within 20 ms; its temporary files may remain",
    );
  });

  it("only starts the call when no command bound the signal", async () => {
    const settlements: Array<() => Promise<void>> = [];
    const unbound = new AbortController();
    bindScanSettlement(
      new AbortController().signal,
      (settlement) => settlements.push(settlement),
      1_000,
    );
    await expect(
      startTrackedScanCall(unbound.signal, "detector.semgrep", async () => 1),
    ).resolves.toBe(1);
    await expect(startTrackedScanCall(undefined, "detector.semgrep", async () => 2)).resolves.toBe(
      2,
    );
    expect(settlements).toHaveLength(0);
  });

  it("refuses to bind one signal to two commands", () => {
    const controller = new AbortController();
    bindScanSettlement(controller.signal, () => {}, 1_000);
    expect(() => bindScanSettlement(controller.signal, () => {}, 1_000)).toThrow(
      "this cancellation signal already tracks another command's Scan calls",
    );
  });
});
