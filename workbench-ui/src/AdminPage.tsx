import { type ChangeEvent, useCallback, useId, useMemo, useState } from "react";
import {
  type AdminEngine,
  type AdminState,
  createAdminEngine,
  DEFAULT_POLICY_FILENAME,
  type EngineOutcome,
} from "../../src/org-policy/workbench/engine/index.js";
import {
  CARD_TITLE,
  Divider,
  Flyout,
  GHOST_BUTTON,
  HEADER,
  Identity,
  MessageStrip,
  ModeToggle,
  SECONDARY_BUTTON,
  SUB_HEADER,
} from "./chrome.js";
import { AiTools } from "./editors/AiTools.js";
import {
  type ChangesViewMode,
  COPIED_MESSAGE,
  COPY_FAILED_MESSAGE,
} from "./editors/ChangesView.js";
import { policyDownloadStartedMessage } from "./editors/FileName.js";
import { PostureSwitch } from "./editors/PostureSwitch.js";
import {
  CHECK_FAILED_MESSAGE,
  CHECK_PASSED_MESSAGE,
  CheckPolicy,
  Publish,
} from "./editors/PublishActions.js";
import { REVIEW_DESCRIPTION, REVIEW_TITLE, ReviewChanges } from "./editors/ReviewChanges.js";
import { SCAN_DESCRIPTION, SCAN_TITLE, ScanBody } from "./editors/ScanView.js";
import { ScreenNav } from "./editors/ScreenNav.js";
import type { WorkbenchHost } from "./host.js";
import { readImportedFile } from "./import-file.js";
import { AdditionsScreen } from "./screens/AdditionsScreen.js";
import { OrgScreen } from "./screens/OrgScreen.js";
import { SourcesScreen } from "./screens/SourcesScreen.js";
import type { AdminScreenId, AdminScreenProps } from "./screens/types.js";

/**
 * The organization page (journey J1), in the prototype's `admin-sources.html`
 * design. This file composes only: page-level state, the layout, and one line
 * per editor. Every editor, and its exact texts, lives in `src/editors/`.
 */

const DECISION_DOWNLOADED_MESSAGE =
  "Canonical decision download started; it remains unverified and not effective.";

export interface ModeControl {
  readonly label: string;
  readonly toggle: () => void;
}

export interface AdminPageProps {
  readonly host: WorkbenchHost;
  readonly model: unknown;
  readonly mode: ModeControl;
}

export function AdminPage({ host, model, mode }: AdminPageProps) {
  const created = useMemo(() => createAdminEngine(model), [model]);
  if (!created.ok) {
    return (
      <main className="p-6 space-y-2">
        <h1 className={CARD_TITLE}>Policy Workbench</h1>
        <div className="space-y-1 text-[11.5px] text-tertiary" role="alert">
          {created.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      </main>
    );
  }
  return <AdminWorkspace engine={created.value} host={host} mode={mode} />;
}

function AdminWorkspace({
  engine,
  host,
  mode,
}: {
  readonly engine: AdminEngine;
  readonly host: WorkbenchHost;
  readonly mode: ModeControl;
}) {
  const [state, setState] = useState<AdminState>(() => engine.state());
  const [outcome, setOutcome] = useState<EngineOutcome | undefined>(undefined);
  const [screen, setScreen] = useState<AdminScreenId>("sources");
  const [fileName, setFileName] = useState(DEFAULT_POLICY_FILENAME);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // The hand-built screen opens on the whole file (`changes-screen.ts` line 325).
  const [changesMode, setChangesMode] = useState<ChangesViewMode>("whole");
  const [scanOpen, setScanOpen] = useState(false);
  const evidenceId = useId();
  const decisionId = useId();
  const policyTextId = useId();
  const fileNameId = useId();

  const run = useCallback(
    (call: () => EngineOutcome) => {
      setOutcome(call());
      setState(engine.state());
    },
    [engine],
  );

  const save = useCallback(
    (name: string) => {
      const file = engine.download(name);
      if (!file.ok) {
        setOutcome({ ok: false, message: file.errors.join("; ") });
        return;
      }
      host.save(file.value);
      setOutcome({ ok: true, message: policyDownloadStartedMessage(file.value.name) });
    },
    [engine, host],
  );

  /** Copy the whole policy text. A refused clipboard never claims a copy. */
  const copy = useCallback(async () => {
    const copied = await host.copyText(engine.state().policyText);
    setOutcome(
      copied ? { ok: true, message: COPIED_MESSAGE } : { ok: false, message: COPY_FAILED_MESSAGE },
    );
  }, [engine, host]);

  const check = useCallback(() => {
    const result = engine.check();
    const detail = [...result.errors, ...result.blockers].join("; ");
    setOutcome(
      result.ok && detail === ""
        ? { ok: true, message: CHECK_PASSED_MESSAGE }
        : { ok: result.ok, message: detail || CHECK_FAILED_MESSAGE },
    );
    setState(engine.state());
  }, [engine]);

  /** Every file import: the host reads the file, the engine judges the text. */
  const importInto = useCallback(
    async (event: ChangeEvent<HTMLInputElement>, call: (text: string) => EngineOutcome) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file === undefined) return;
      const read = await readImportedFile(file);
      if (!read.ok) {
        setOutcome({ ok: false, message: read.message });
        return;
      }
      run(() => call(read.text));
    },
    [run],
  );

  const saveDecision = useCallback(() => {
    const file = engine.downloadDecision();
    if (!file.ok) {
      setOutcome({ ok: false, message: file.errors.join("; ") });
      return;
    }
    host.save(file.value);
    setOutcome({ ok: true, message: DECISION_DOWNLOADED_MESSAGE });
  }, [engine, host]);

  const blocked = !state.catalogValid;
  const screenProps: AdminScreenProps = { engine, host, state, run, setOutcome, importInto };

  return (
    <div className="flex flex-col h-screen">
      <header className={HEADER}>
        <div className="flex items-center gap-2.5 shrink-0">
          <Identity door="Admin" />
          <Divider />
          <PostureSwitch engine={engine} posture={state.posture} run={run} />
          <Divider />
          <AiTools
            engine={engine}
            onOpenChange={setToolsOpen}
            open={toolsOpen}
            run={run}
            tools={state.aiTools}
          />
          <Divider />
          <ScreenNav onScreen={setScreen} screen={screen} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            className={GHOST_BUTTON}
            href={host.navigation.href("user")}
            onClick={(event) => {
              event.preventDefault();
              host.navigation.go("user");
            }}
          >
            User page
          </a>
          <Flyout
            description={REVIEW_DESCRIPTION}
            onOpenChange={setReviewOpen}
            open={reviewOpen}
            title={REVIEW_TITLE}
            trigger={
              <button className={SECONDARY_BUTTON} type="button">
                Review Changes
              </button>
            }
          >
            <ReviewChanges
              blocked={blocked}
              changesMode={changesMode}
              engine={engine}
              fileName={fileName}
              fileNameId={fileNameId}
              managedMcpOptIn={state.managedMcpOptIn}
              onChangesMode={setChangesMode}
              onCopy={() => void copy()}
              onDownload={() => save(fileName)}
              onFileName={setFileName}
              onManagedMcp={(next) => run(() => engine.setManagedMcpOptIn(next))}
              outcome={outcome}
              policyText={state.policyText}
              policyTextId={policyTextId}
            />
          </Flyout>
          {/* The prototype reaches the scan screen from the shell's own screen
           * nav (`screens/admin-scan.html`). This page has no screen nav yet,
           * so the scan opens as a flyout, in the "Review changes" pattern. */}
          <Flyout
            description={SCAN_DESCRIPTION}
            onOpenChange={setScanOpen}
            open={scanOpen}
            title={SCAN_TITLE}
            trigger={
              <button className={SECONDARY_BUTTON} type="button">
                Scan Review
              </button>
            }
          >
            <ScanBody
              decisionInputId={decisionId}
              evidenceInputId={evidenceId}
              onDecision={(event) => void importInto(event, engine.importDecisionText)}
              onDownloadDecision={saveDecision}
              onEvidence={(event) => void importInto(event, engine.importEvidenceText)}
              outcome={outcome}
              scan={engine.scan()}
            />
          </Flyout>
          <CheckPolicy blocked={blocked} onCheck={check} />
          <Publish blocked={blocked} onPublish={() => save(DEFAULT_POLICY_FILENAME)} />
          <Divider />
          <ModeToggle label={mode.label} onToggle={mode.toggle} />
        </div>
      </header>

      <div className={SUB_HEADER}>
        <MessageStrip outcome={outcome} />
      </div>

      {/* ADDING A SCREEN: one more line here, and one entry in `editors/ScreenNav.tsx`. */}
      {screen === "sources" ? <SourcesScreen {...screenProps} /> : null}
      {screen === "org" ? <OrgScreen {...screenProps} /> : null}
      {screen === "additions" ? <AdditionsScreen {...screenProps} /> : null}
    </div>
  );
}
