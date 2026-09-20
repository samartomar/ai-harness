import { useId, useState } from "react";
import type { AdminEngine } from "../../../src/org-policy/workbench/engine/index.js";
import { CARD_TITLE, GHOST_BUTTON, TEXT_INPUT } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Editor 15, ECC MCP approval (`ui/shell/acme-screen.ts` lines 357-433,
 * 655-718: the legacy `sy`, `Py` and the approval remove handler).
 *
 * The hand-built panel's `#save-ecc-mcp-approval` has NO handler, in the
 * legacy runtime and in the hand-built page alike (ADOPTION-LOG.md): ECC MCP
 * approvals are preserved from an imported policy, listed, and removable. This
 * page therefore lists and removes them, and does not carry an inert Save
 * button or the fields that would only feed it.
 */

const TITLE = "ECC MCP approval";
const HELP =
  "Approval records permission for this pinned ECC MCP. This panel does not install, contact, scan, attest, or claim reachability or a tool surface.";
const AUTHORING_ONLY =
  "Approvals recorded in an imported policy are listed here and can be removed. Recording a new approval is not authored on this page.";
const CHOOSE = "Choose pinned ECC MCP";
const SELECT_LABEL = "ECC MCP";
const EMPTY_ROWS = "No ECC MCP approvals recorded.";

export function EccMcpApproval({
  engine,
  run,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
}) {
  const view = engine.additions();
  const [selected, setSelected] = useState("");
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 className={CARD_TITLE} id={titleId}>
        {TITLE}
      </h2>
      <p className="text-[10.5px] text-outline">{HELP}</p>
      <p className="text-[10.5px] text-outline">{AUTHORING_ONLY}</p>

      <label className="flex flex-col gap-1 max-w-xs">
        <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
          {SELECT_LABEL}
        </span>
        <select
          className={TEXT_INPUT}
          onChange={(event) => {
            const id = event.target.value;
            setSelected(id);
            if (id !== "") run(() => engine.selectEccMcp(id));
          }}
          value={selected}
        >
          <option value="">{CHOOSE}</option>
          {view.eccPinned.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-1">
        {view.eccApprovals.length === 0 ? (
          <p className="text-[10.5px] text-outline">{EMPTY_ROWS}</p>
        ) : (
          view.eccApprovals.map((approval) => (
            <p className="text-[10.5px] text-outline" key={approval.id}>
              <code className="font-mono text-on-surface">{approval.id}</code>
              {` — ${approval.state}; ${approval.authenticationMode}. `}
              <button
                aria-label={`Remove approval ${approval.id}`}
                className={GHOST_BUTTON}
                onClick={() => run(() => engine.removeEccMcpApproval(approval.id))}
                type="button"
              >
                Remove approval
              </button>
            </p>
          ))
        )}
      </div>
    </section>
  );
}
