import type { ChangeEvent } from "react";
import type {
  AdminEngine,
  AdminState,
  EngineOutcome,
} from "../../../src/org-policy/workbench/engine/index.js";
import { ChangesView, type ChangesViewMode } from "./ChangesView.js";
// LANE B (drafts and repairs, inventory rows 19-21): these panels have no home
// of their own yet. The hand-built page shows the first two as inspector tabs
// and the rest beside the catalog; the lead moves them there at merge.
import { DraftReview } from "./DraftReview.js";
import { FileName } from "./FileName.js";
import { ImportMigration } from "./ImportMigration.js";
import { ManagedMcpSwitch } from "./ManagedMcpSwitch.js";
import { PolicyExposure } from "./PolicyExposure.js";
import { DownloadPolicy } from "./PublishActions.js";
import { Repairs } from "./Repairs.js";
import { SelectionComparison } from "./SelectionComparison.js";
import { StartingPoints } from "./StartingPoints.js";
import type { RunEngineCall } from "./types.js";

/**
 * The "Review changes" flyout body: the checks that gate the download, then
 * the editors it holds. It composes; each editor owns its own texts.
 */

export const REVIEW_TITLE = "Review changes";
export const REVIEW_DESCRIPTION =
  "The policy file exactly as it will be written, and the checks that gate it.";

export function ReviewChanges({
  engine,
  blocked,
  outcome,
  policyText,
  policyTextId,
  managedMcpOptIn,
  onManagedMcp,
  changesMode,
  onChangesMode,
  onCopy,
  fileName,
  fileNameId,
  onFileName,
  onDownload,
  // LANE B: what its panels need beyond the engine.
  state,
  run,
  importInto,
}: {
  readonly engine: AdminEngine;
  readonly blocked: boolean;
  readonly outcome: EngineOutcome | undefined;
  readonly policyText: string;
  readonly policyTextId: string;
  readonly managedMcpOptIn: boolean;
  readonly onManagedMcp: (next: boolean) => void;
  readonly changesMode: ChangesViewMode;
  readonly onChangesMode: (mode: ChangesViewMode) => void;
  readonly onCopy: () => void;
  readonly fileName: string;
  readonly fileNameId: string;
  readonly onFileName: (value: string) => void;
  readonly onDownload: () => void;
  // LANE B.
  readonly state: AdminState;
  readonly run: RunEngineCall;
  readonly importInto: (
    event: ChangeEvent<HTMLInputElement>,
    call: (text: string) => EngineOutcome,
  ) => Promise<void>;
}) {
  const result = engine.check();
  const refused = outcome !== undefined && !outcome.ok ? outcome.message : "";
  const accepted = outcome?.ok === true ? outcome.message : "";
  return (
    <div className="space-y-2">
      <div className="space-y-1 text-tertiary empty:hidden" role="alert">
        {refused === "" ? null : <p>{refused}</p>}
        {[...result.errors, ...result.blockers].map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {/* The status strip lives behind this dialog, so every outcome is also
       * readable here, as text. */}
      <p className="text-secondary empty:hidden" role="status">
        {accepted}
      </p>
      <ManagedMcpSwitch checked={managedMcpOptIn} onToggle={onManagedMcp} />
      <ChangesView
        engine={engine}
        mode={changesMode}
        onCopy={onCopy}
        onMode={onChangesMode}
        policyText={policyText}
        policyTextId={policyTextId}
      />
      <FileName fieldId={fileNameId} fileName={fileName} onFileName={onFileName} />
      <DownloadPolicy blocked={blocked} onDownload={onDownload} />
      {/* LANE B (rows 19-21), mounted here until the inspector exists. */}
      <DraftReview engine={engine} run={run} />
      <PolicyExposure engine={engine} />
      <StartingPoints engine={engine} run={run} />
      <Repairs engine={engine} run={run} />
      <SelectionComparison engine={engine} run={run} state={state} />
      <ImportMigration engine={engine} importInto={importInto} policyText={policyText} />
    </div>
  );
}
