interface ExecStdinPayload {
  data: string;
  maxBytes: number;
}

const EXEC_STDIN_PAYLOADS = new WeakMap<object, ExecStdinPayload>();

/** Keep apply-only stdin bytes outside the enumerable/public Plan object. */
export function registerExecStdinPayload(action: object, payload: ExecStdinPayload): void {
  EXEC_STDIN_PAYLOADS.set(action, Object.freeze({ ...payload }));
}

/** Internal executor lookup; this module is deliberately absent from the package root exports. */
export function registeredExecStdinPayload(action: object): ExecStdinPayload | undefined {
  return EXEC_STDIN_PAYLOADS.get(action);
}
