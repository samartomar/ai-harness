import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../chrome.js";

/** The header's two gates on the policy file: run the checks, write the file. */

const CHECK_LABEL = "Check Policy";
const PUBLISH_LABEL = "Publish";
const DOWNLOAD_LABEL = "Download";
export const CHECK_PASSED_MESSAGE = "Schema and policy-grammar validation passed.";
export const CHECK_FAILED_MESSAGE = "The policy check did not pass.";

export function CheckPolicy({
  blocked,
  onCheck,
}: {
  readonly blocked: boolean;
  readonly onCheck: () => void;
}) {
  return (
    <button className={SECONDARY_BUTTON} disabled={blocked} onClick={onCheck} type="button">
      {CHECK_LABEL}
    </button>
  );
}

export function Publish({
  blocked,
  onPublish,
}: {
  readonly blocked: boolean;
  readonly onPublish: () => void;
}) {
  return (
    <button className={PRIMARY_BUTTON} disabled={blocked} onClick={onPublish} type="button">
      {PUBLISH_LABEL}
    </button>
  );
}

/** The Review flyout's own download, which uses the name in the field. */
export function DownloadPolicy({
  blocked,
  onDownload,
}: {
  readonly blocked: boolean;
  readonly onDownload: () => void;
}) {
  return (
    <button className={PRIMARY_BUTTON} disabled={blocked} onClick={onDownload} type="button">
      {DOWNLOAD_LABEL}
    </button>
  );
}
