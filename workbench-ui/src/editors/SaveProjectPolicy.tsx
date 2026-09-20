import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../chrome.js";

/** The project file's two controls: run the narrowing check, write the file. */

const CHECK_LABEL = "Check Selection";
const SAVE_LABEL = "Save";
const SAVE_FILE_LABEL = "Save aih-project-policy.json";
export const CHECK_PASSED_MESSAGE = "The selection narrows the organization policy.";

export function CheckSelection({
  disabled,
  onCheck,
}: {
  readonly disabled: boolean;
  readonly onCheck: () => void;
}) {
  return (
    <button className={SECONDARY_BUTTON} disabled={disabled} onClick={onCheck} type="button">
      {CHECK_LABEL}
    </button>
  );
}

export function SaveProjectPolicy({
  disabled,
  onSave,
  withFileName = false,
}: {
  readonly disabled: boolean;
  readonly onSave: () => void;
  /** The aside's button names the file; the header's says only "Save". */
  readonly withFileName?: boolean;
}) {
  return (
    <button
      className={withFileName ? `${PRIMARY_BUTTON} flex-1 justify-center` : PRIMARY_BUTTON}
      disabled={disabled}
      onClick={onSave}
      type="button"
    >
      {withFileName ? SAVE_FILE_LABEL : SAVE_LABEL}
    </button>
  );
}
