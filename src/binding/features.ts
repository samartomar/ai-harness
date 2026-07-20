import { AihError } from "../errors.js";

/**
 * Plan-time feature-key validation — the W2 orchestrator ruling made concrete:
 * the declaration schema accepts `features` as an open `record<string, boolean>`,
 * and PER-ADAPTER key validation is the enforcement point. Every adapter calls
 * this from `plan` with its own known-key list, so an unknown feature key fails
 * closed before any work is scheduled instead of being silently ignored.
 */

/** A declared feature key no adapter recognizes. Fails closed at plan time. */
export class BindingFeatureKeyError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_FEATURES");
  }
}

/**
 * Reject unknown `features` keys for a framework. An absent `features` object is
 * valid (no flags declared); an empty known-key list means the framework accepts
 * no feature flags at all, so any declared key is unknown.
 */
export function assertKnownFeatureKeys(
  declared: Record<string, boolean> | undefined,
  known: readonly string[],
  framework: string,
): void {
  if (declared === undefined) return;
  const knownSet = new Set(known);
  const unknown = Object.keys(declared).filter((key) => !knownSet.has(key));
  if (unknown.length > 0) {
    throw new BindingFeatureKeyError(
      `unknown feature key(s) for ${framework}: ${unknown.join(", ")} — known keys: ${
        known.length > 0 ? known.join(", ") : "(none)"
      }`,
    );
  }
}
