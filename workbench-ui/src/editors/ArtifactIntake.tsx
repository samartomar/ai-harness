import { type ChangeEvent, useId, useMemo, useState } from "react";
import type { AdminEngine, IntakeDraftV1 } from "../../../src/org-policy/workbench/engine/index.js";
import { INTAKE_DOWNLOAD_STARTED_MESSAGE } from "../../../src/org-policy/workbench/engine/index.js";
import { PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_INPUT } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * The artifact intake workspace (editor 22): one shared review queue for MCPs,
 * Skills and Agents. Behaviour source `ui/artifact-intake-runtime.js`; look
 * `prototype/policy-workbench/screens/admin-acme.html`.
 *
 * The engine owns every rule and every sentence. This file places them as
 * React text: an intake file's own strings are never markup.
 */

export const INTAKE_TITLE = "Add and review MCP, Skill, or Agent sources";
export const INTAKE_CAPTION = "Organization artifacts";
const INTAKE_HELP =
  "One shared workspace handles MCPs, Skills, and Agents. Add items individually or import one batch, scan each unique exact source once, and review evidence. This preflight intake explicitly declares that it is not authority, does not choose authorized targets, and does not infer launch or transport.";
const ADD_STAGE_TITLE = "1. Add exact sources or discovery claims to the review queue";
const SCAN_STAGE_TITLE = "2. Scan exact sources";
const REVIEW_STAGE_TITLE = "3. Retain exact evidence drafts for Core preparation";
const BATCH_COMMAND =
  "aih trust scan aih-artifact-intake.json --posture enterprise --apply --evidence-out aih-artifact-evidence.json";
const SCAN_HELP =
  "Run from the target root after downloading the intake. Scanner computes observed integrity, acquires duplicate exact sources once, and emits one bundle of enterprise-posture evidence for this Workbench. It does not approve, install, activate, choose targets, infer execution, or grant authority.";
const PREFLIGHT_NOTE =
  "Preflight only; fail closed. Missing, malformed, stale, mismatched, replayed/conflicting, failed, and authority-absent states remain visible. Imported bytes are drafts only. Core must revalidate and prepare a separate evidence summary before any protected decision can refer to it.";
const CAPACITY_DECISIONS = "64 decisions per protected file";
const CAPACITY_DECISIONS_HELP =
  "A 100-item intake may require two protected files if every item is approved.";

/** The fields the runtime clears after an accepted add (line 125). */
const CLEARED_AFTER_ADD = {
  id: "",
  discoveryUrl: "",
  npmPackage: "",
  npmVersion: "",
  npmIntegrity: "",
  githubRepository: "",
  githubCommit: "",
  sourcePath: "",
  directoryUrl: "",
} as const;

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly type?: string;
}) {
  const id = useId();
  return (
    <label className="grid gap-1 min-w-0 text-[10.5px] text-on-surface-variant" htmlFor={id}>
      {label}
      <input
        className={`${TEXT_INPUT} w-full`}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        value={value}
      />
    </label>
  );
}

export function ArtifactIntake({
  engine,
  run,
  onDownload,
  draft,
  onDraft,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
  /** The host hands the file over; the page then says so. */
  readonly onDownload: () => void;
  readonly draft: IntakeDraftV1;
  readonly onDraft: (next: IntakeDraftV1) => void;
}) {
  const [filter, setFilter] = useState("");
  const importId = useId();
  const filterId = useId();
  const kindId = useId();
  const sourceTypeId = useId();
  const view = engine.intake();
  const ready = engine.intakeDraftReady(draft);
  const set = (patch: Partial<IntakeDraftV1>) => onDraft({ ...draft, ...patch });

  // The filter is a view of the engine's own row text, as the page filtered it.
  const rows = useMemo(() => {
    const query = filter.toLowerCase();
    return query === "" ? view.rows : view.rows.filter((row) => row.search.includes(query));
  }, [filter, view.rows]);

  return (
    <section aria-label={INTAKE_TITLE} className="space-y-2">
      <p className="m-0 font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
        {INTAKE_CAPTION}
      </p>
      <h2 className="m-0 text-[13px] font-semibold text-on-surface">{INTAKE_TITLE}</h2>
      <p className="m-0 text-[11px] text-on-surface-variant leading-relaxed">{INTAKE_HELP}</p>

      <section aria-label="Artifact workflow capacity" className="grid grid-cols-2 gap-2">
        <div className="rounded border border-surface-container-high/40 bg-surface-container-low p-2">
          <strong className="block text-[13px] font-mono text-on-surface">
            {view.candidateCount}
          </strong>
          <span className="text-[10px] text-outline">
            One mixed intake file for MCPs, Skills, and Agents.
          </span>
        </div>
        <div className="rounded border border-surface-container-high/40 bg-surface-container-low p-2">
          <strong className="block text-[13px] font-mono text-on-surface">
            {CAPACITY_DECISIONS}
          </strong>
          <span className="text-[10px] text-outline">{CAPACITY_DECISIONS_HELP}</span>
        </div>
      </section>

      <section aria-label={ADD_STAGE_TITLE} className="space-y-2">
        <h3 className="m-0 text-[11.5px] font-semibold text-on-surface">{ADD_STAGE_TITLE}</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Field
            label="Default accountable owner email"
            onChange={(next) => set({ defaultOwner: next })}
            type="email"
            value={draft.defaultOwner}
          />
          <label
            className="grid gap-1 min-w-0 text-[10.5px] text-on-surface-variant"
            htmlFor={kindId}
          >
            Artifact kind
            <select
              className={`${TEXT_INPUT} w-full`}
              id={kindId}
              onChange={(event) => set({ kind: event.target.value })}
              value={draft.kind}
            >
              <option value="mcp">MCP</option>
              <option value="skill">Skill</option>
              <option value="agent">Agent</option>
            </select>
          </label>
          <Field label="Item identifier" onChange={(next) => set({ id: next })} value={draft.id} />
          <Field
            label="Discovery URL (optional)"
            onChange={(next) => set({ discoveryUrl: next })}
            type="url"
            value={draft.discoveryUrl}
          />
          <label
            className="grid gap-1 min-w-0 text-[10.5px] text-on-surface-variant"
            htmlFor={sourceTypeId}
          >
            Exact source type
            <select
              className={`${TEXT_INPUT} w-full`}
              id={sourceTypeId}
              onChange={(event) => set({ sourceType: event.target.value })}
              value={draft.sourceType}
            >
              <option value="npm">npm package</option>
              <option value="github">GitHub</option>
              {/* A directory claim is an MCP-only, version-2 route. */}
              <option disabled={draft.kind !== "mcp"} value="directory">
                Directory page (discovery claim)
              </option>
            </select>
          </label>
        </div>

        {draft.sourceType === "npm" ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Field
              label="Exact npm package"
              onChange={(next) => set({ npmPackage: next })}
              value={draft.npmPackage}
            />
            <Field
              label="Exact version"
              onChange={(next) => set({ npmVersion: next })}
              value={draft.npmVersion}
            />
            <Field
              label="Registry integrity (optional)"
              onChange={(next) => set({ npmIntegrity: next })}
              value={draft.npmIntegrity}
            />
          </div>
        ) : null}
        {draft.sourceType === "github" ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Field
              label="Exact repository"
              onChange={(next) => set({ githubRepository: next })}
              value={draft.githubRepository}
            />
            <Field
              label="Exact commit"
              onChange={(next) => set({ githubCommit: next })}
              value={draft.githubCommit}
            />
            <Field
              label="Source path"
              onChange={(next) => set({ sourcePath: next })}
              value={draft.sourcePath}
            />
          </div>
        ) : null}
        {draft.sourceType === "directory" ? (
          <div className="grid grid-cols-1 gap-2">
            <Field
              label="PulseMCP or MCP Market server URL"
              onChange={(next) => set({ directoryUrl: next })}
              type="url"
              value={draft.directoryUrl}
            />
            <p className="m-0 text-[10.5px] text-outline">
              Add the directory page only as a non-authoritative discovery claim. It is not an exact
              package or repository source, evidence, approval, target, or execution instruction.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            className={PRIMARY_BUTTON}
            disabled={!ready}
            onClick={() => {
              run(() => engine.addIntakeItem(draft));
              onDraft({ ...draft, ...CLEARED_AFTER_ADD });
            }}
            type="button"
          >
            Add to review queue
          </button>
          <label className={`${SECONDARY_BUTTON} cursor-pointer`} htmlFor={importId}>
            Import existing artifact intake
          </label>
          <input
            accept="application/json"
            className="sr-only"
            id={importId}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              // The page's own import path reads the file; the engine judges it.
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file === undefined) return;
              void file.text().then((text) => {
                run(() => engine.importIntakeText(text));
              });
            }}
            type="file"
          />
          <button
            className={SECONDARY_BUTTON}
            disabled={view.downloadDisabled}
            onClick={onDownload}
            type="button"
          >
            Download one intake file
          </button>
        </div>
      </section>

      <section aria-label={SCAN_STAGE_TITLE} className="space-y-1">
        <h3 className="m-0 text-[11.5px] font-semibold text-on-surface">{SCAN_STAGE_TITLE}</h3>
        <pre className="m-0 p-2 rounded bg-surface-container-lowest border border-surface-container-high/40 font-mono text-[10.5px] text-on-surface whitespace-pre-wrap break-all">
          {BATCH_COMMAND}
        </pre>
        <p className="m-0 text-[10.5px] text-outline leading-relaxed">{SCAN_HELP}</p>
      </section>

      <section aria-label={REVIEW_STAGE_TITLE} className="space-y-1">
        <h3 className="m-0 text-[11.5px] font-semibold text-on-surface">{REVIEW_STAGE_TITLE}</h3>
        <label
          className="grid gap-1 min-w-0 text-[10.5px] text-on-surface-variant"
          htmlFor={filterId}
        >
          Filter the review queue
          <input
            className={`${TEXT_INPUT} w-full`}
            id={filterId}
            onChange={(event) => setFilter(event.target.value)}
            type="search"
            value={filter}
          />
        </label>
        <p className="m-0 text-[10.5px] text-outline">{view.summary}</p>
        {rows.length === 0 ? null : (
          <ul className="list-none m-0 p-0 flex flex-col gap-1.5 max-h-[520px] overflow-y-auto">
            {rows.map((row) => (
              <li
                className="flex flex-wrap items-center gap-2 px-2.5 py-2 rounded border border-surface-container-high/40 bg-surface-container-low text-[11px]"
                key={row.id}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <strong className="block font-mono text-on-surface break-all">{row.title}</strong>
                  <p className="m-0 font-mono text-[10.5px] text-on-surface-variant break-all">
                    {row.source}
                  </p>
                  <p className="m-0 text-[10.5px] text-outline break-all">{row.owner}</p>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-surface-container-highest font-mono text-[10px] text-on-surface-variant">
                  {row.badge}
                </span>
                <button
                  className={SECONDARY_BUTTON}
                  onClick={() =>
                    run(() =>
                      engine.removeIntakeItem(view.rows.findIndex((item) => item.id === row.id)),
                    )
                  }
                  type="button"
                >
                  {`Remove ${row.id}`}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-[10.5px] text-outline leading-relaxed">{PREFLIGHT_NOTE}</p>
      </section>
    </section>
  );
}

export { INTAKE_DOWNLOAD_STARTED_MESSAGE };
