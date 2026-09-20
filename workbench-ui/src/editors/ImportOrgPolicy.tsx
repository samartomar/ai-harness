import type { ChangeEvent } from "react";
import { SECONDARY_BUTTON } from "../chrome.js";

/** The user page's own import, for a host that binds no policy. */

const NOTE = "This page has no bound policy. Import your organization's policy file.";
const LABEL = "Import organization policy";

export function ImportOrgPolicy({
  inputId,
  onImport,
}: {
  readonly inputId: string;
  readonly onImport: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
      <p className="text-on-surface-variant">{NOTE}</p>
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
    </div>
  );
}
