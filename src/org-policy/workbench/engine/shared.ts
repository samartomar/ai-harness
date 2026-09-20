/**
 * Shared result shapes and helpers for the engine entry (Policy Workbench UI
 * delivery, "Preview slice"). Pure: no DOM, no `window`, no Node built-ins.
 */

export type EngineOutcome = { readonly ok: boolean; readonly message: string };

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface EngineFile {
  readonly name: string;
  readonly text: string;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** UTF-8 byte length without Node's `Buffer`. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
