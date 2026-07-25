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

  it("fails fast: no new task starts once one has rejected, but in-flight tasks settle", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const started: number[] = [];
    await expect(
      runWithConcurrency(items, 3, async (_item, index) => {
        started.push(index);
        if (index === 0) {
          throw new Error("boom");
        }
        // In-flight siblings should be allowed to settle, but nothing new
        // should start after the rejection propagates.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
    ).rejects.toThrow("boom");
    // Give any (buggy) still-running background workers plenty of time to
    // pull further entries before asserting nothing new was started.
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Only the tasks already pulled by the initial 3 workers may have
    // started; none of the remaining 7 items may have been started.
    expect(started.length).toBe(3);
    expect(new Set(started)).toEqual(new Set([0, 1, 2]));
  });

  it("does not produce unhandled rejections when a sibling task also rejects", async () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    await expect(
      runWithConcurrency(items, 3, async (_item, index) => {
        await new Promise((resolve) => setTimeout(resolve, index === 1 ? 1 : 5));
        throw new Error(`fail-${index}`);
      }),
    ).rejects.toThrow(/fail-/);
  });
});

describe("resolveVetConcurrency", () => {
  it("honours a valid AIH_VET_CONCURRENCY override", () => {
    expect(resolveVetConcurrency({ AIH_VET_CONCURRENCY: "4" })).toBe(4);
  });

  it("trims surrounding whitespace on an otherwise valid override", () => {
    expect(resolveVetConcurrency({ AIH_VET_CONCURRENCY: " 2 " })).toBe(2);
  });

  it("ignores empty or invalid overrides and uses the core-based default", () => {
    const fallback = Math.max(1, Math.floor(cpus().length / 2));
    expect(resolveVetConcurrency({})).toBe(fallback);
    for (const bad of ["", "0", "-2", "abc"]) {
      expect(resolveVetConcurrency({ AIH_VET_CONCURRENCY: bad })).toBe(fallback);
    }
  });

  it("rejects malformed values that Number.parseInt would silently reinterpret", () => {
    const fallback = Math.max(1, Math.floor(cpus().length / 2));
    for (const bad of ["2x", "1.5", "1e3", "0x2", "  ", "+2", "2.0", "NaN"]) {
      expect(resolveVetConcurrency({ AIH_VET_CONCURRENCY: bad })).toBe(fallback);
    }
  });
});
