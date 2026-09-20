import { useId } from "react";
import { ToggleSwitch } from "../chrome.js";

/**
 * The managed MCP projection opt-in. The prototype has no place for this
 * setting; it belongs with the checks that gate the download, in the
 * prototype's own vocabulary.
 */

const LABEL = "Allow AIH to configure selected MCP tools";
const HELP =
  "Needed when the policy selects Core MCP controls. No server is contacted from this page.";

export function ManagedMcpSwitch({
  checked,
  onToggle,
}: {
  readonly checked: boolean;
  readonly onToggle: (next: boolean) => void;
}) {
  const helpId = useId();
  return (
    <div className="space-y-1 rounded bg-surface-container-low border border-surface-container-high/40 p-2">
      <ToggleSwitch checked={checked} describedBy={helpId} label={LABEL} onToggle={onToggle} />
      <p className="text-[10.5px] text-outline" id={helpId}>
        {HELP}
      </p>
    </div>
  );
}
