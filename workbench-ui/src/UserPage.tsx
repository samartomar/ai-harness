import { type ChangeEvent, useCallback, useId, useMemo, useState } from "react";
import {
  createUserEngine,
  type TrimUseV1,
  type UserDoorSaveInputV1,
  type UserEngine,
  userModelFromImportedPolicy,
} from "../../src/org-policy/workbench/engine/index.js";
import type { ModeControl } from "./AdminPage.js";
import {
  Divider,
  GHOST_BUTTON,
  HEADER,
  Identity,
  MessageStrip,
  ModeToggle,
  SUB_HEADER,
} from "./chrome.js";
import { ImportOrgPolicy } from "./editors/ImportOrgPolicy.js";
import { ProjectFacts } from "./editors/ProjectFacts.js";
import { type ForType, ProjectFor } from "./editors/ProjectFor.js";
import { ResetChoices } from "./editors/ResetChoices.js";
import {
  CHECK_PASSED_MESSAGE,
  CheckSelection,
  SaveProjectPolicy,
} from "./editors/SaveProjectPolicy.js";
import { SetAll } from "./editors/SetAll.js";
import { AmbiguousItems, DEFAULT_USE, TrimList } from "./editors/TrimList.js";
import type { WorkbenchHost } from "./host.js";
import { readImportedFile } from "./import-file.js";

/**
 * The project page (journey J2), in the prototype's `user-trim.html` design.
 * This file composes only: page-level state, the layout, and one line per
 * editor. Every editor, and its exact texts, lives in `src/editors/`.
 */

export interface UserPageProps {
  readonly host: WorkbenchHost;
  readonly model: unknown;
  readonly mode: ModeControl;
}

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
        setOutcome({ ok: true, message: CHECK_PASSED_MESSAGE });
        return;
      }
      host.save(result.file);
      setOutcome({ ok: true, message: `Project download started: ${result.file.name}` });
    },
    [engine, host, input],
  );

  const counts = useMemo(() => {
    const total = { required: 0, optional: 0, skip: 0 };
    for (const item of view?.items ?? []) total[choices.get(item.assetId) ?? DEFAULT_USE] += 1;
    return total;
  }, [view, choices]);

  const items = view?.items ?? [];
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
          <CheckSelection disabled={saveDisabled} onCheck={() => check(false)} />
          <SaveProjectPolicy disabled={saveDisabled} onSave={() => check(true)} />
          <Divider />
          <ModeToggle label={mode.label} onToggle={mode.toggle} />
        </div>
      </header>

      <div className={SUB_HEADER}>
        <MessageStrip outcome={outcome} />
      </div>

      <ProjectFor
        aiTools={view?.aiTools ?? []}
        chosenTools={tools}
        forName={forName}
        forType={forType}
        nameFieldId={nameId}
        onForName={setForName}
        onForType={setForType}
        onToolChange={(tool, chosen) =>
          setTools((current) => {
            const next = new Set(current);
            if (chosen) next.add(tool);
            else next.delete(tool);
            return next;
          })
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 bg-[#0d111a] flex flex-col gap-4">
          {bound ? null : (
            <ImportOrgPolicy inputId={importId} onImport={(event) => void importPolicy(event)} />
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

          <SetAll
            choices={choices}
            items={items}
            onSetAll={(use) => setChoices(new Map(items.map((item) => [item.assetId, use])))}
          />

          <TrimList
            choices={choices}
            items={items}
            onChoose={(assetId, use) => setChoices((current) => new Map(current).set(assetId, use))}
          />

          <AmbiguousItems assetIds={view?.ambiguous ?? []} />
        </div>

        <ProjectFacts counts={counts} forName={forName} forType={forType} tools={[...tools]}>
          <div className="flex items-center gap-2">
            <ResetChoices disabled={saveDisabled} onReset={() => setChoices(new Map())} />
            <SaveProjectPolicy disabled={saveDisabled} onSave={() => check(true)} withFileName />
          </div>
        </ProjectFacts>
      </div>
    </div>
  );
}
