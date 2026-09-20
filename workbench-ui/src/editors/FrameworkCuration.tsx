import { useId, useState } from "react";
import type {
  AdminEngine,
  CurationInputV1,
  CurationTargetV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { CARD_TITLE, GHOST_BUTTON, PILL, PRIMARY_BUTTON, TEXT_INPUT } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Editor 16, framework curation: add, edit, remove (`ui/shell/acme-screen.ts`
 * lines 452-534 and 720-846, the legacy `Es`, `Cy` and the add handler). The
 * engine owns every rule and every message; this file owns the form.
 */

const TITLE = "ECC / Superpowers curation";
const PURPOSE =
  "Add audited ECC or Superpowers guidance. This is framework curation, not an organization-owned source and not MCP. AIH records report-only policy intent and does not install, run, or enforce the source.";
const FOOTNOTE =
  "AIH preserves audited curation intent for agents, skills and commands. It does not install, project or enforce those external assets.";
const OWNER_LABEL = "External framework owner";
const OWNER_LOCKED_LABEL = "External framework owner (locked while editing)";
const ADD_LABEL = "Add framework curation";
const SAVE_LABEL = "Save framework curation";
const CANCEL_LABEL = "Cancel curation edit";
const EMPTY_ROWS = "No external curation intent.";
const DEFAULT_AUDIT_RECORD = "external-audit";
const DEFAULT_AUDIT_DIGEST = `sha256:${"0".repeat(64)}`;

const KINDS = [
  { value: "agent", label: "Agent" },
  { value: "skill", label: "Skill" },
  { value: "command", label: "Command" },
] as const;

function blank(framework: string): CurationInputV1 {
  return {
    framework,
    kind: "agent",
    id: "",
    accountableOwner: "",
    repository: "",
    commit: "",
    path: "",
    auditRecord: DEFAULT_AUDIT_RECORD,
    auditDigest: DEFAULT_AUDIT_DIGEST,
    clarification: "",
  };
}

export function FrameworkCuration({
  engine,
  run,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
}) {
  const view = engine.additions();
  const first = view.frameworks[0]?.id ?? "";
  const [values, setValues] = useState<CurationInputV1>(() => blank(first));
  const [editing, setEditing] = useState<CurationTargetV1 | undefined>(undefined);
  const [idError, setIdError] = useState("");
  const idErrorId = useId();
  const titleId = useId();

  const set = (patch: Partial<CurationInputV1>) =>
    setValues((current) => ({ ...current, ...patch }));

  /**
   * Leave edit mode, as the legacy `r.editing = null`. The field values stay:
   * the hand-built form clears nothing after an add (`acme-screen.ts` 836-839).
   */
  const leaveEdit = () => {
    setEditing(undefined);
    setIdError("");
  };

  const save = () => {
    // Every commit goes through `run`, so the page re-reads the engine.
    let problem = "";
    let accepted = false;
    run(() => {
      const result = engine.saveCuration(values, editing);
      problem = result.fieldErrors?.find((entry) => entry.field === "curation-id")?.message ?? "";
      accepted = result.ok;
      return result;
    });
    setIdError(problem);
    if (accepted) leaveEdit();
  };

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 className={CARD_TITLE} id={titleId}>
        {TITLE}
      </h2>
      <p className="text-[10.5px] text-outline">{PURPOSE}</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            {editing === undefined ? OWNER_LABEL : OWNER_LOCKED_LABEL}
          </span>
          <select
            className={TEXT_INPUT}
            disabled={editing !== undefined}
            onChange={(event) => set({ framework: event.target.value })}
            value={values.framework}
          >
            {view.frameworks.map((framework) => (
              <option key={framework.id} value={framework.id}>
                {framework.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Item kind
          </span>
          <select
            className={TEXT_INPUT}
            onChange={(event) => set({ kind: event.target.value })}
            value={values.kind}
          >
            {KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Item identifier
          </span>
          <input
            aria-describedby={idError ? idErrorId : undefined}
            aria-invalid={idError ? true : undefined}
            className={TEXT_INPUT}
            onChange={(event) => set({ id: event.target.value })}
            value={values.id}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Accountable owner email
          </span>
          <input
            className={TEXT_INPUT}
            onChange={(event) => set({ accountableOwner: event.target.value })}
            placeholder="name@company.example"
            type="email"
            value={values.accountableOwner}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Source repository
          </span>
          <input
            className={TEXT_INPUT}
            onChange={(event) => set({ repository: event.target.value })}
            placeholder="owner/repository"
            value={values.repository}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Source commit
          </span>
          <input
            className={TEXT_INPUT}
            onChange={(event) => set({ commit: event.target.value })}
            placeholder="40-character commit"
            value={values.commit}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Source path
          </span>
          <input
            className={TEXT_INPUT}
            onChange={(event) => set({ path: event.target.value })}
            placeholder="relative/path"
            value={values.path}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Audit record
          </span>
          <input
            className={TEXT_INPUT}
            onChange={(event) => set({ auditRecord: event.target.value })}
            value={values.auditRecord}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Audit digest
          </span>
          <input
            className={TEXT_INPUT}
            onChange={(event) => set({ auditDigest: event.target.value })}
            value={values.auditDigest}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
            Admin clarification
          </span>
          <input
            className={TEXT_INPUT}
            onChange={(event) => set({ clarification: event.target.value })}
            value={values.clarification}
          />
        </label>
      </div>

      {/* The field's own refusal, beside the page-level message strip. */}
      <p className="text-[11px] text-tertiary" id={idErrorId}>
        {idError}
      </p>

      <div className="flex flex-wrap gap-1.5">
        <button className={PRIMARY_BUTTON} onClick={save} type="button">
          {editing === undefined ? ADD_LABEL : SAVE_LABEL}
        </button>
        {editing === undefined ? null : (
          <button className={GHOST_BUTTON} onClick={leaveEdit} type="button">
            {CANCEL_LABEL}
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {view.curationRows.length === 0 ? (
          <p className="text-[10.5px] text-outline">{EMPTY_ROWS}</p>
        ) : (
          view.curationRows.map((row) => (
            <div
              className="flex flex-wrap items-center gap-2 px-2.5 py-2 rounded border border-surface-container-high/60 bg-surface-container-lowest text-[11.5px]"
              key={row.label}
            >
              <strong className="font-mono font-semibold text-[11px] text-on-surface [overflow-wrap:anywhere]">
                {row.label}
              </strong>
              <span className={PILL}>{row.badge}</span>
              <span className="basis-full text-[10.5px] text-outline [overflow-wrap:anywhere]">
                {row.detail}
              </span>
              <span className="flex gap-1.5">
                <button
                  aria-label={`Edit ${row.label}`}
                  className={GHOST_BUTTON}
                  onClick={() => {
                    setValues(row.item);
                    setEditing({
                      framework: row.item.framework,
                      kind: row.item.kind,
                      id: row.item.id,
                    });
                    setIdError("");
                  }}
                  type="button"
                >
                  Edit
                </button>
                <button
                  aria-label={`Remove ${row.label}`}
                  className={GHOST_BUTTON}
                  onClick={() =>
                    run(() =>
                      engine.removeCuration({
                        framework: row.item.framework,
                        kind: row.item.kind,
                        id: row.item.id,
                      }),
                    )
                  }
                  type="button"
                >
                  Remove
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      <p className="text-[10.5px] text-outline">{FOOTNOTE}</p>
    </section>
  );
}
