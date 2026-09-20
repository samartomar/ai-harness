import { useId, useState } from "react";
import type {
  AdditionFieldV1,
  AdminEngine,
  CustomMcpInputV1,
  RemoteMcpInputV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { CARD_TITLE, GHOST_BUTTON, PILL, PRIMARY_BUTTON, TEXT_INPUT } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Editor 17, your own sources: the pending custom MCP form and the fenced
 * remote MCP form (`ui/shell/acme-screen.ts` lines 536-560 and 848-996, over
 * the constant markup of `src/org-policy/studio-custom-mcp.ts`). Both records
 * are authored as fully pinned candidates; neither can be activated here.
 */

const TITLE = "Your sources";
const CUSTOM_TITLE = "Add organization MCP";
const CUSTOM_HELP =
  "Register a pinned organization MCP package and the person accountable for its evidence. The email is an audit identity, not an approval or credential. The candidate stays blocked; next, scan this exact package and bind the completed evidence record to the same pin.";
const REMOTE_TITLE = "Record a pending remote custom MCP";
const REMOTE_HELP =
  "AIH records the exact HTTPS origin and administrator-managed availability. Enter the approving person's email so the policy identifies the human decision-maker; it is an audit identity, not a credential. AIH does not contact or content-scan the endpoint, which remains non-projectable.";
const FOOTNOTE =
  "Custom MCP can only be authored as a fully pinned pending candidate. It has no activation affordance until supported scanning, evidence and projection exist.";
const REMOTE_FOOTNOTE =
  "Content scan: none. This recorded identity is fenced until later remote-endpoint machinery.";
const ADD_CUSTOM = "Add pending custom MCP";
const RECORD_REMOTE = "Record pending remote MCP";
const EMPTY_ROWS = "No custom candidates.";
const VIEW_PRESERVED = "View preserved remote";

const EMPTY_CUSTOM: CustomMcpInputV1 = {
  id: "",
  accountableOwner: "",
  packageName: "",
  version: "",
  integrity: "",
  evidence: "",
  clarification: "",
};

const EMPTY_REMOTE: RemoteMcpInputV1 = {
  id: "",
  origin: "",
  approvedBy: "",
  authenticationMode: "",
  allowedDataClasses: "",
  administrativeStatus: "approved",
  evidence: "",
  clarification: "",
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
  error,
  errorId,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: string;
  readonly error?: string;
  readonly errorId?: string;
}) {
  return (
    // The refusal is a sibling of the label, so the field's accessible name
    // stays the label's own words.
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-outline">{label}</span>
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          className={TEXT_INPUT}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type={type ?? "text"}
          value={value}
        />
      </label>
      {error ? (
        <span className="text-[11px] text-tertiary" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function CustomMcp({
  engine,
  run,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
}) {
  const view = engine.additions();
  const [custom, setCustom] = useState<CustomMcpInputV1>(EMPTY_CUSTOM);
  const [remote, setRemote] = useState<RemoteMcpInputV1>(EMPTY_REMOTE);
  const [errors, setErrors] = useState<Partial<Record<AdditionFieldV1, string>>>({});
  const titleId = useId();
  const ownerErrorId = useId();
  const noteErrorId = useId();
  const originErrorId = useId();

  /** One commit through `run`, keeping the fields a refusal names. */
  const commit = (call: () => ReturnType<AdminEngine["addCustomMcp"]>, done: () => void) => {
    const marked: Partial<Record<AdditionFieldV1, string>> = {};
    let accepted = false;
    run(() => {
      const result = call();
      accepted = result.ok;
      for (const entry of result.fieldErrors ?? []) marked[entry.field] = entry.message;
      return result;
    });
    setErrors(marked);
    if (accepted) done();
  };

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <h2 className={CARD_TITLE} id={titleId}>
        {TITLE}
      </h2>

      <form
        aria-label={CUSTOM_TITLE}
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          commit(
            () => engine.addCustomMcp(custom),
            () => setCustom(EMPTY_CUSTOM),
          );
        }}
      >
        <h3 className="text-[12px] font-medium text-on-surface">{CUSTOM_TITLE}</h3>
        <p className="text-[10.5px] text-outline">{CUSTOM_HELP}</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Field
            label="Identifier"
            onChange={(value) => setCustom({ ...custom, id: value })}
            value={custom.id}
          />
          <Field
            error={errors["custom-owner"]}
            errorId={ownerErrorId}
            label="Accountable owner email"
            onChange={(value) => setCustom({ ...custom, accountableOwner: value })}
            placeholder="name@company.example"
            type="email"
            value={custom.accountableOwner}
          />
          <Field
            label="Exact npm package name"
            onChange={(value) => setCustom({ ...custom, packageName: value })}
            placeholder="mcp-package or @scope/package"
            value={custom.packageName}
          />
          <Field
            label="Exact version"
            onChange={(value) => setCustom({ ...custom, version: value })}
            placeholder="1.2.3"
            value={custom.version}
          />
          <Field
            label="Integrity digest"
            onChange={(value) => setCustom({ ...custom, integrity: value })}
            placeholder="sha256:..."
            value={custom.integrity}
          />
          <Field
            label="Evidence record"
            onChange={(value) => setCustom({ ...custom, evidence: value })}
            value={custom.evidence}
          />
          <Field
            error={errors["custom-note"]}
            errorId={noteErrorId}
            label="Clarification"
            onChange={(value) => setCustom({ ...custom, clarification: value })}
            value={custom.clarification}
          />
        </div>
        <button className={PRIMARY_BUTTON} type="submit">
          {ADD_CUSTOM}
        </button>
      </form>

      <form
        aria-label={REMOTE_TITLE}
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          // The hand-built remote form keeps its values after a record
          // (`acme-screen.ts` 990-996); only the custom form resets.
          commit(
            () => engine.saveRemoteMcp(remote),
            () => {},
          );
        }}
      >
        <h3 className="text-[12px] font-medium text-on-surface">{REMOTE_TITLE}</h3>
        <p className="text-[10.5px] text-outline">{REMOTE_HELP}</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Field
            label="Identifier"
            onChange={(value) => setRemote({ ...remote, id: value })}
            value={remote.id}
          />
          <Field
            error={errors["remote-custom-origin"]}
            errorId={originErrorId}
            label="HTTPS origin"
            onChange={(value) => setRemote({ ...remote, origin: value })}
            placeholder="https://mcp.example.com"
            value={remote.origin}
          />
          <Field
            label="Approver email"
            onChange={(value) => setRemote({ ...remote, approvedBy: value })}
            placeholder="name@company.example"
            type="email"
            value={remote.approvedBy}
          />
          <Field
            label="Authentication mode"
            onChange={(value) => setRemote({ ...remote, authenticationMode: value })}
            placeholder="oauth"
            value={remote.authenticationMode}
          />
          <Field
            label="Allowed data classes"
            onChange={(value) => setRemote({ ...remote, allowedDataClasses: value })}
            placeholder="design-metadata, issue-metadata"
            value={remote.allowedDataClasses}
          />
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
              Administrative status
            </span>
            <select
              className={TEXT_INPUT}
              onChange={(event) =>
                setRemote({ ...remote, administrativeStatus: event.target.value })
              }
              value={remote.administrativeStatus}
            >
              <option value="approved">approved</option>
              <option value="revoked">revoked</option>
            </select>
          </label>
          <Field
            label="Evidence record"
            onChange={(value) => setRemote({ ...remote, evidence: value })}
            value={remote.evidence}
          />
          <Field
            label="Clarification"
            onChange={(value) => setRemote({ ...remote, clarification: value })}
            value={remote.clarification}
          />
        </div>
        <p className="text-[10.5px] text-outline">{REMOTE_FOOTNOTE}</p>
        <button className={PRIMARY_BUTTON} type="submit">
          {RECORD_REMOTE}
        </button>
      </form>

      <div className="space-y-1.5">
        {view.customRows.length === 0 ? (
          <p className="text-[10.5px] text-outline">{EMPTY_ROWS}</p>
        ) : (
          view.customRows.map((row) => (
            <div
              className="flex flex-wrap items-center gap-2 px-2.5 py-2 rounded border border-surface-container-high/60 bg-surface-container-lowest text-[11.5px]"
              key={`${row.kind}:${row.id}`}
            >
              <strong className="font-mono font-semibold text-[11px] text-on-surface [overflow-wrap:anywhere]">
                {row.id}
              </strong>
              <span className={PILL}>{row.badge}</span>
              <span className="basis-full text-[10.5px] font-mono text-on-surface-variant [overflow-wrap:anywhere]">
                {row.detail}
              </span>
              <span className="basis-full text-[10.5px] text-outline">{row.note}</span>
              <span className="flex gap-1.5">
                {row.preserved ? (
                  <button
                    aria-label={`${VIEW_PRESERVED}: ${row.id}`}
                    className={GHOST_BUTTON}
                    onClick={() => run(() => engine.readPreservedRemote())}
                    type="button"
                  >
                    {VIEW_PRESERVED}
                  </button>
                ) : (
                  <>
                    <button
                      aria-label={`Edit ${row.id}`}
                      className={GHOST_BUTTON}
                      onClick={() => {
                        setErrors({});
                        if (row.remote !== undefined) setRemote(row.remote);
                        if (row.custom !== undefined) setCustom(row.custom);
                      }}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      aria-label={`Remove ${row.id}`}
                      className={GHOST_BUTTON}
                      onClick={() => run(() => engine.removeCustomCandidate(row.id, row.kind))}
                      type="button"
                    >
                      Remove
                    </button>
                  </>
                )}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="text-[10.5px] text-outline">{FOOTNOTE}</p>
    </section>
  );
}
