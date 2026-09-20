import { type ChangeEvent, useCallback, useId, useMemo, useState } from "react";
import {
  createUserEngine,
  type TrimUseV1,
  type UserDoorSaveInputV1,
  type UserDoorTrimItemV1,
  type UserEngine,
  userModelFromImportedPolicy,
} from "../../src/org-policy/workbench/engine/index.js";
import type { ModeControl } from "./AdminPage.js";
import {
  CARD,
  CARD_FOOTER,
  CARD_GRID,
  CARD_TITLE,
  Divider,
  FACT_ROW,
  FACTS,
  GHOST_BUTTON,
  HEADER,
  Identity,
  KIND_CHIP,
  MessageStrip,
  ModeToggle,
  PANEL_HEADING,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  Segmented,
  SUB_HEADER,
  TEXT_INPUT,
} from "./chrome.js";
import type { WorkbenchHost } from "./host.js";
import { readImportedFile } from "./import-file.js";

/**
 * The project page (journey J2), in the prototype's `user-trim.html` design.
 * The file it produces, and every refusal, come from the engine entry.
 */

export interface UserPageProps {
  readonly host: WorkbenchHost;
  readonly model: unknown;
  readonly mode: ModeControl;
}

type ForType = "project" | "persona" | "agent";

const USE_OPTIONS: readonly { value: TrimUseV1; label: string }[] = [
  { value: "required", label: "Required" },
  { value: "optional", label: "Optional" },
  { value: "skip", label: "Skip" },
];

function bundleOf(model: unknown): unknown {
  return model !== null && typeof model === "object" && !Array.isArray(model)
    ? (model as Record<string, unknown>).workbenchBundle
    : undefined;
}

export function UserPage({ host, model, mode }: UserPageProps) {
  const bound = host.capabilities.boundPolicy;
  const [imported, setImported] = useState<unknown>(undefined);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | undefined>(undefined);
  const [alerts, setAlerts] = useState<readonly string[]>([]);
  const [choices, setChoices] = useState<ReadonlyMap<string, TrimUseV1>>(() => new Map());
  const [forType, setForType] = useState<ForType>("project");
  const [forName, setForName] = useState("");
  const [tools, setTools] = useState<ReadonlySet<string>>(() => new Set());
  const importId = useId();
  const nameId = useId();

  const engine: UserEngine | undefined = useMemo(() => {
    if (bound) return createUserEngine(model);
    return imported === undefined ? undefined : createUserEngine(imported);
  }, [bound, model, imported]);

  const view = engine?.view();

  const importPolicy = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file === undefined) return;
      const read = await readImportedFile(file);
      if (!read.ok) {
        setAlerts([read.message]);
        setOutcome(undefined);
        return;
      }
      // The digest is the host's, over the ORIGINAL bytes; never over JSON we
      // re-serialize (acceptance §2 rule 5, failure case 11).
      const sha256 = await host.sha256Hex(read.bytes);
      setImported(
        userModelFromImportedPolicy({
          text: read.text,
          sha256,
          fileName: file.name,
          bundle: bundleOf(model),
        }),
      );
      setChoices(new Map());
      setAlerts([]);
      setOutcome({ ok: true, message: `Imported ${file.name}.` });
    },
    [host, model],
  );

  const input: UserDoorSaveInputV1 = useMemo(
    () => ({ choices, forType, forName, aiTools: [...tools] }),
    [choices, forType, forName, tools],
  );

  const check = useCallback(
    (thenSave: boolean) => {
      if (engine === undefined) return;
      const result = engine.check(input);
      if (!result.ok) {
        setAlerts(result.errors);
        setOutcome(undefined);
        return;
      }
      setAlerts([]);
      if (!thenSave) {
        setOutcome({ ok: true, message: "The selection narrows the organization policy." });
        return;
      }
      host.save(result.file);
      setOutcome({ ok: true, message: `Project download started: ${result.file.name}` });
    },
    [engine, host, input],
  );

  const counts = useMemo(() => {
    const total = { required: 0, optional: 0, skip: 0 };
    for (const item of view?.items ?? []) {
      total[choices.get(item.assetId) ?? "optional"] += 1;
    }
    return total;
  }, [view, choices]);

  const blocked = view?.saveBlocked;
  const saveDisabled = engine === undefined || blocked !== undefined;

  return (
    <div className="flex flex-col h-screen">
      <header className={HEADER}>
        <div className="flex items-center gap-2.5 shrink-0">
          <Identity door="User" />
          <Divider />
          <span className="font-mono text-[11px] text-outline">
            {view?.source === undefined
              ? "no policy source"
              : `${view.source.kind} · ${view.source.name ?? "unnamed"} · ${
                  view.source.sha256?.slice(0, 12) ?? "no digest"
                }`}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            className={GHOST_BUTTON}
            href={host.navigation.href("admin")}
            onClick={(event) => {
              event.preventDefault();
              host.navigation.go("admin");
            }}
          >
            Admin page
          </a>
          <button
            className={SECONDARY_BUTTON}
            disabled={saveDisabled}
            onClick={() => check(false)}
            type="button"
          >
            Check Selection
          </button>
          <button
            className={PRIMARY_BUTTON}
            disabled={saveDisabled}
            onClick={() => check(true)}
            type="button"
          >
            Save
          </button>
          <Divider />
          <ModeToggle label={mode.label} onToggle={mode.toggle} />
        </div>
      </header>

      <div className={SUB_HEADER}>
        <MessageStrip outcome={outcome} />
      </div>

      <div className="px-3 py-2 border-b border-surface-container-high/40 flex flex-wrap items-center gap-2.5 text-[11px] shrink-0">
        <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
          For
        </span>
        <Segmented
          label="For"
          onChange={setForType}
          options={[
            { value: "project", label: "Project" },
            { value: "persona", label: "Persona" },
            { value: "agent", label: "Agent" },
          ]}
          value={forType}
        />
        <label className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
          Name
          <input
            className={`${TEXT_INPUT} w-40 normal-case tracking-normal`}
            id={nameId}
            onChange={(event) => setForName(event.target.value)}
            type="text"
            value={forName}
          />
        </label>
        <fieldset className="flex items-center gap-2 border-0 p-0 m-0">
          <legend className="sr-only">AI tools</legend>
          <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
            AI tools
          </span>
          {(view?.aiTools ?? []).map((tool) => (
            <label className="flex items-center gap-1 text-[11px] text-on-surface" key={tool}>
              <input
                checked={tools.has(tool)}
                onChange={(event) =>
                  setTools((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(tool);
                    else next.delete(tool);
                    return next;
                  })
                }
                type="checkbox"
              />
              {tool}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 bg-[#0d111a] flex flex-col gap-4">
          {bound ? null : (
            <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
              <p className="text-on-surface-variant">
                This page has no bound policy. Import your organization's policy file.
              </p>
              <label className={`${SECONDARY_BUTTON} cursor-pointer`} htmlFor={importId}>
                Import organization policy
              </label>
              <input
                accept="application/json"
                className="sr-only"
                id={importId}
                onChange={(event) => void importPolicy(event)}
                type="file"
              />
            </div>
          )}

          {blocked === undefined ? null : <p className="text-[11.5px] text-tertiary">{blocked}</p>}
          {(view?.missing ?? []).length === 0 ? null : (
            <ul className="text-[11px] text-outline list-disc pl-5">
              {view?.missing.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
          {alerts.length === 0 ? null : (
            <div className="space-y-1 text-[11.5px] text-tertiary" role="alert">
              {alerts.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          )}

          {/* The list head's "Set all N" and its group, from `ui/user-door.ts`
           * lines 429-464: one press sets every listed item the same way, and
           * a press is pressed only while they all already agree. */}
          {(view?.items ?? []).length === 0 ? null : (
            <fieldset className="flex items-center gap-2 border-0 p-0 m-0">
              {/* The group's name, and the head label the hand-built page shows. */}
              <legend className="sr-only">Set every item</legend>
              <span className="text-[10.5px] font-mono text-outline uppercase tracking-wider">
                {`Set all ${view?.items.length ?? 0}`}
              </span>
              <div className="flex items-center bg-surface-container-lowest p-0.5 rounded border border-surface-container-high/60">
                {USE_OPTIONS.map((option) => {
                  const all =
                    view?.items.every(
                      (item) => (choices.get(item.assetId) ?? "optional") === option.value,
                    ) === true;
                  return (
                    <button
                      aria-pressed={all}
                      className={`px-2 py-0.5 text-[10.5px] rounded transition-colors ${
                        all
                          ? "bg-surface-container text-primary font-semibold shadow-xs"
                          : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
                      }`}
                      key={option.value}
                      onClick={() =>
                        setChoices(
                          new Map(
                            (view?.items ?? []).map(
                              (item) => [item.assetId, option.value] as const,
                            ),
                          ),
                        )
                      }
                      type="button"
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          <div className={CARD_GRID}>
            {(view?.items ?? []).map((item) => (
              <TrimCard
                item={item}
                key={item.assetId}
                onChange={(use) => setChoices((current) => new Map(current).set(item.assetId, use))}
                use={choices.get(item.assetId) ?? "optional"}
              />
            ))}
          </div>

          {(view?.ambiguous ?? []).length === 0 ? null : (
            <section className="space-y-1">
              <h2 className="font-bold text-white text-[13px] tracking-tight">
                Not offered: listed under more than one origin
              </h2>
              <ul className="text-[11px] font-mono text-outline list-disc pl-5">
                {view?.ambiguous.map((assetId) => (
                  <li key={assetId}>{assetId}</li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="w-72 shrink-0 border-l border-surface-container-high/60 bg-surface-container-lowest p-3 space-y-2 overflow-y-auto">
          <h2 className={PANEL_HEADING}>What your AI carries</h2>
          <div className={FACTS}>
            <div className={FACT_ROW}>
              <span>For</span>
              <span className="text-on-surface text-right">
                {forType} · {forName === "" ? "—" : forName}
              </span>
            </div>
            <div className={FACT_ROW}>
              <span>On</span>
              <span className="text-on-surface text-right">
                {tools.size === 0 ? "no AI tool" : [...tools].join(", ")}
              </span>
            </div>
            <div className={FACT_ROW}>
              <span>Required</span>
              <span className="text-secondary font-mono">{counts.required}</span>
            </div>
            <div className={FACT_ROW}>
              <span>Optional</span>
              <span className="text-primary font-mono">{counts.optional}</span>
            </div>
            <div className={FACT_ROW}>
              <span>Skipped</span>
              <span className="font-mono">{counts.skip}</span>
            </div>
          </div>
          {/* The footer of `ui/user-door.ts` lines 785-806: Reset beside Save.
           * Reset drops the choices, so every item goes back to the view's own
           * default; it is refused exactly when Save is. */}
          <div className="flex items-center gap-2">
            <button
              className={GHOST_BUTTON}
              disabled={saveDisabled}
              onClick={() => setChoices(new Map())}
              type="button"
            >
              Reset
            </button>
            <button
              className={`${PRIMARY_BUTTON} flex-1 justify-center`}
              disabled={saveDisabled}
              onClick={() => check(true)}
              type="button"
            >
              Save aih-project-policy.json
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TrimCard({
  item,
  use,
  onChange,
}: {
  readonly item: UserDoorTrimItemV1;
  readonly use: TrimUseV1;
  readonly onChange: (use: TrimUseV1) => void;
}) {
  const title = item.label ?? item.assetId;
  return (
    <div className={CARD} data-card-id={item.assetId}>
      <div>
        <div className="flex items-start justify-between gap-2">
          <span className={CARD_TITLE}>{title}</span>
          <span className={KIND_CHIP}>{item.kind ?? "item"}</span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-2 leading-relaxed">{item.assetId}</p>
      </div>
      <div className={CARD_FOOTER}>
        <span className="font-mono text-outline">{item.origin.kind}</span>
        <Segmented label={title} onChange={onChange} options={USE_OPTIONS} size="sm" value={use} />
      </div>
    </div>
  );
}
