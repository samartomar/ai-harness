import type { ChangeEvent } from "react";
import { SECONDARY_BUTTON } from "../chrome.js";

/** The masthead's policy import: the host reads the file, the engine judges it. */

const LABEL = "Import policy";

export function ImportPolicy({
  inputId,
  onImport,
}: {
  readonly inputId: string;
  readonly onImport: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <label className={`${SECONDARY_BUTTON} cursor-pointer`} htmlFor={inputId}>
        {LABEL}
      </label>
      <input
        accept="application/json"
        className="sr-only"
        id={inputId}
        onChange={onImport}
        type="file"
      />
    </>
  );
}
