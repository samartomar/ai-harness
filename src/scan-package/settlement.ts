/**
 * Settlement of in-flight delegated Scan calls at a command boundary.
 *
 * A signal aborts Core's cancellation signal synchronously; Scan then kills the
 * analyzer's process tree and removes its private temporary directories
 * asynchronously, and only then settles the call. A command that re-raises the
 * signal before that settlement terminates Scan's cleanup half way and leaks
 * its snapshot and analyzer environment. The command therefore binds its
 * cancellation signal here, and every delegated call registers its settlement
 * with the command BEFORE it starts, so the command can await it (bounded)
 * before its own cleanups and before re-raising the signal.
 */

/** How long a command waits for one cancelled Scan call to settle. */
export const SCAN_SETTLEMENT_TIMEOUT_MS = 30_000;

type SettlementRegistrar = (settlement: () => Promise<void>) => void;

interface BoundCommand {
  readonly register: SettlementRegistrar;
  readonly timeoutMs: number;
}

const bound = new WeakMap<AbortSignal, BoundCommand>();

/** Bind a command's cancellation signal to the command's settlement list. */
export function bindScanSettlement(
  signal: AbortSignal,
  register: SettlementRegistrar,
  timeoutMs: number = SCAN_SETTLEMENT_TIMEOUT_MS,
): void {
  if (bound.has(signal))
    throw new Error("this cancellation signal already tracks another command's Scan calls");
  bound.set(signal, { register, timeoutMs });
}

/**
 * Start one delegated Scan call. When a command bound `signal`, the call's
 * settlement is registered with it first; the settlement never rejects with the
 * call's own error, and rejects only when the call has not settled in time.
 */
export function startTrackedScanCall<T>(
  signal: AbortSignal | undefined,
  label: string,
  start: () => Promise<T>,
): Promise<T> {
  const command = signal === undefined ? undefined : bound.get(signal);
  if (command === undefined) return start();
  let markSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  command.register(async () => {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), command.timeoutMs);
    });
    try {
      if ((await Promise.race([settled, expired])) === "expired")
        throw new Error(
          `delegated Scan call ${label} did not settle within ${command.timeoutMs} ms; its temporary files may remain`,
        );
    } finally {
      clearTimeout(timer);
    }
  });
  let call: Promise<T>;
  try {
    call = start();
  } catch (error) {
    markSettled();
    throw error;
  }
  call.then(markSettled, markSettled);
  return call;
}
