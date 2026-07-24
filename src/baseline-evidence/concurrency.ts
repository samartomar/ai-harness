import { cpus } from "node:os";

/**
 * Resolve the component-scan concurrency for the baseline vet (issue #519).
 *
 * Default is `max(1, floor(cpus / 2))` — roughly two vCPU per concurrent scan,
 * the ratio measured safe on the AIH vet fleet. Below it (one core per scan)
 * the pinned Cisco detector starves past its internal 30s timeout and the vet
 * aborts, so this self-limits to the safe threshold on any core count. Override
 * with the `AIH_VET_CONCURRENCY` environment variable.
 */
export function resolveVetConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AIH_VET_CONCURRENCY;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return Math.max(1, Math.floor(cpus().length / 2));
}

/**
 * Run `task` over `items` with at most `limit` invocations in flight.
 *
 * Completion order is irrelevant: the task receives each item's catalog index
 * and is expected to write its result by that index, so the produced artifacts
 * are byte-identical to a serial run. Every task is awaited, so the first
 * rejection propagates (matching the original serial `for await` throw). A
 * `limit` of 1 runs strictly sequentially.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const width = Math.max(1, Math.min(limit, items.length));
  // A single shared iterator hands each worker the next [index, item] pair;
  // `.next()` is synchronous, so no two workers ever get the same entry.
  const entries = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of entries) {
      await task(item, index);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
}
