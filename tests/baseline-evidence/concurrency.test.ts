import { cpus } from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolveVetConcurrency,
  runWithConcurrency,
} from "../../src/baseline-evidence/concurrency.js";

describe("runWithConcurrency", () => {
  it("assembles results in index order regardless of completion order", async () => {
    const items = Array.from({ length: 24 }, (_, i) => i);
    const out: number[] = [];
    await runWithConcurrency(items, 6, async (item, index) => {
      // Lower indices resolve later, so completion order is the reverse of
      // catalog order; a correct scheduler must still place results by index.
      await new Promise((resolve) => setTimeout(resolve, (items.length - item) * 2));
      out[index] = item * 10;
    });
    expect(out).toEqual(items.map((i) => i * 10));
  });

  it("never exceeds the concurrency limit but does run in parallel", async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    await runWithConcurrency(items, 5, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("runs strictly sequentially at limit 1", async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await runWithConcurrency(items, 1, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(item);
      active -= 1;
    });
    expect(peak).toBe(1);
    expect(order).toEqual(items);
  });

  it("propagates the first task rejection", async () => {
    await expect(
      runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
        await Promise.resolve();
        if (item === 2) {
          throw new Error("boom");
        }
      }),
    ).rejects.toThrow("boom");
  });

  it("is a no-op for an empty item list", async () => {
    let calls = 0;
    await runWithConcurrency([], 4, async () => {
      await Promise.resolve();
      calls += 1;
    });
    expect(calls).toBe(0);
  });
});

describe("resolveVetConcurrency", () => {
  it("honours a valid AIH_VET_CONCURRENCY override", () => {
    expect(resolveVetConcurrency({ AIH_VET_CONCURRENCY: "4" })).toBe(4);
  });

  it("ignores empty or invalid overrides and uses the core-based default", () => {
    const fallback = Math.max(1, Math.floor(cpus().length / 2));
    expect(resolveVetConcurrency({})).toBe(fallback);
    for (const bad of ["", "0", "-2", "abc"]) {
      expect(resolveVetConcurrency({ AIH_VET_CONCURRENCY: bad })).toBe(fallback);
    }
  });
});
