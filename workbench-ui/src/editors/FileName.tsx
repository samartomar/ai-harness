import { useId } from "react";
import { isPolicyFileName } from "../../../src/org-policy/workbench/engine/index.js";
import { TEXT_INPUT } from "../chrome.js";

/**
 * The policy file name: the field, the rule it must follow, and the command
 * that validates the file (`ui/shell/file-transfer.ts` `updateFilenameHelp`,
 * lines 235-245, and `FILENAME_HELP`, line 59).
 */

const FIELD_LABEL = "File name";
const FILENAME_HELP =
  "Use one safe JSON filename per project or team. The browser chooses the download folder; move the file into an administrator-controlled policy folder when required.";
const FILENAME_REFUSED_HELP = "Use a JSON filename without folders, spaces, or hidden characters.";
const VALIDATE_HINT_PLACEHOLDER =
  "aih policy validate <target-root> --policy <safe-policy-file.json>";

/** The download's own sentence (`file-transfer.ts` lines 393-395), verbatim. */
export function policyDownloadStartedMessage(name: string): string {
  return `Policy download started. Validate this file with: aih policy validate <target-root> --policy ${name}`;
}

export function FileName({
  fileName,
  fieldId,
  onFileName,
}: {
  readonly fileName: string;
  readonly fieldId: string;
  readonly onFileName: (value: string) => void;
}) {
  const valid = isPolicyFileName(fileName);
  const helpId = useId();
  const hintId = useId();
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        {FIELD_LABEL}
        <input
          aria-describedby={`${helpId} ${hintId}`}
          aria-invalid={valid ? undefined : true}
          className={`${TEXT_INPUT} w-64 normal-case tracking-normal`}
          id={fieldId}
          onChange={(event) => onFileName(event.target.value)}
          type="text"
          value={fileName}
        />
      </label>
      <p className={`text-[10.5px] ${valid ? "text-outline" : "text-tertiary"}`} id={helpId}>
        {valid ? FILENAME_HELP : FILENAME_REFUSED_HELP}
      </p>
      <code className="block font-mono text-[10.5px] text-on-surface-variant" id={hintId}>
        {valid
          ? `aih policy validate <target-root> --policy ${fileName.trim()}`
          : VALIDATE_HINT_PLACEHOLDER}
      </code>
    </div>
  );
}
