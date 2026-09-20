import { GHOST_BUTTON } from "../chrome.js";

/**
 * Reset (`ui/user-door.ts` lines 785-806): it drops the choices, so every item
 * goes back to the view's own default. It is refused exactly when Save is.
 */

const LABEL = "Reset";

export function ResetChoices({
  disabled,
  onReset,
}: {
  readonly disabled: boolean;
  readonly onReset: () => void;
}) {
  return (
    <button className={GHOST_BUTTON} disabled={disabled} onClick={onReset} type="button">
      {LABEL}
    </button>
  );
}
