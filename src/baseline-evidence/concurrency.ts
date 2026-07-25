import { cpus } from "node:os";

/** Matches a plain positive integer (no sign, no decimal point, no exponent). */
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

/**
 * Resolve the component-scan concurrency for the baseline vet (issue #519).
 *
 * Default is `max(1, floor(cpus / 2))` — roughly two vCPU per concurrent scan,
 * the ratio measured safe on the AIH vet fleet. Below it (one core per scan)
 * the pinned Cisco detector starves past its internal 30s timeout and the vet
 * aborts, so this self-limits to the safe threshold on any core count. Override
 * with the `AIH_VET_CONCURRENCY` environment variable.
 *
 * The override is validated strictly: surrounding whitespace is trimmed, but
 * the trimmed value must then be a plain positive integer (`^[1-9]\d*$`) —
 * no sign, decimal point, exponent, or trailing/leading non-digit characters.
 * `Number.parseInt` is deliberately not used directly on the raw value because
 * it silently reinterprets malformed input (e.g. `"2x"` -> `2`, `"1.5"` -> `1`,
 * `"1e3"` -> `1`), which would make the effective concurrency silently diverge
 * from the configured value. Any value that fails this check — including
 * `""`, `"0"`, negative numbers, decimals, and non-numeric strings — falls
 * back to the documented default. This function never throws; the vet run
 * must always get a usable concurrency value.
 */
export function resolveVetConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AIH_VET_CONCURRENCY;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (POSITIVE_INTEGER_PATTERN.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }
  return Math.max(1, Math.floor(cpus().length / 2));
}

/**
 * Run `task` over `items` with at most `limit` invocations in flight.
 *
 * Completion order is irrelevant: the task receives each item's catalog index
 * and is expected to write its result by that index, so the produced artifacts
 * are byte-identical to a serial run. A `limit` of 1 runs strictly
 * sequentially.
 *
 * Fail-fast on rejection: once any task rejects, no worker starts a NEW task
 * — the shared iterator stops being pulled. Tasks already in flight at that
 * point are still awaited to settle (so nothing is orphaned and no unhandled
 * rejection is raised), but their results are discarded. The first rejection
 * observed is the one propagated to the caller, matching the original serial
 * `for await` throw contract.
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
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const next = entries.next();
      if (next.done) {
        return;
      }
      const [index, item] = next.value;
      try {
        await task(item, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.allSettled(Array.from({ length: width }, () => worker()));
  if (failed) {
    throw firstError;
  }
}
