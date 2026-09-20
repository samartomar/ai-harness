import type { AdminEngine } from "../../../src/org-policy/workbench/engine/index.js";
import { GHOST_BUTTON } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Clear policy. The hand-built file menu's item, beside its Import policy
 * (`ui/shell/file-transfer.ts` lines 190-192). It runs at once: that page has
 * no confirmation step, and this one adds none.
 */

const LABEL = "Clear policy (resets your work)";

export function ClearPolicy({
  engine,
  run,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
}) {
  return (
    <button
      className={`${GHOST_BUTTON} text-error`}
      onClick={() => run(() => engine.clearPolicy())}
      title={LABEL}
      type="button"
    >
      {LABEL}
    </button>
  );
}
