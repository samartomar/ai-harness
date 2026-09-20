import type { ChangeEvent } from "react";
import type { AdminScanV1, EngineOutcome } from "../../src/org-policy/workbench/engine/index.js";
import { SECONDARY_BUTTON } from "./chrome.js";

/**
 * The scan view (editors 5, 6 and 10 of the acceptance rule), in the shape of
 * the prototype's `screens/admin-scan.html`: the glance tiles and what each
 * result means, the evidence and decision imports, the two finding groups, the
 * preserved receipt rows, and the imported governance decision.
 *
 * Every sentence comes from the engine; this file places them as React text,
 * never as markup, whatever an imported file says.
 */

/** One "scan at a glance" tile: the figure, its named pill, its caption. */
function GlanceTile({
  figure,
  pill,
  caption,
}: {
  readonly figure: number;
  readonly pill: string;
  readonly caption: string;
}) {
  return (
    <div className="p-2.5 flex flex-col gap-1 min-w-0">
      {/* The pill names the figure, so no tile is read by colour alone. */}
      <span className="text-lg font-bold text-white font-mono">{figure}</span>
      <span className="self-start px-1.5 py-0.5 rounded bg-surface-container-low border border-surface-container-high/40 text-outline font-mono text-[10px]">
        {pill}
      </span>
      <span className="text-[10px] text-outline leading-tight">{caption}</span>
    </div>
  );
}

export function ScanBody({
  scan,
  evidenceInputId,
  decisionInputId,
  onEvidence,
  onDecision,
  onDownloadDecision,
  outcome,
}: {
  readonly scan: AdminScanV1;
  readonly evidenceInputId: string;
  readonly decisionInputId: string;
  readonly onEvidence: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onDecision: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onDownloadDecision: () => void;
  readonly outcome: EngineOutcome | undefined;
}) {
  const glance = scan.glance;
  const needReview = glance === undefined ? undefined : glance.review + glance.notScanned;
  const CARD = "rounded border border-surface-container-high/40 bg-[#141822] p-2";
  const MONO =
    "m-0 p-2 rounded bg-surface-container-lowest border border-surface-container-high/40 font-mono text-[10.5px] text-on-surface whitespace-pre-wrap break-all";
  return (
    <div className="space-y-2">
      {/* The status strip lives behind this dialog, so every outcome is also
       * readable here, as text. */}
      <p className="text-tertiary empty:hidden" role="alert">
        {outcome?.ok === false ? outcome.message : ""}
      </p>
      <p className="text-secondary empty:hidden" role="status">
        {outcome?.ok === true ? outcome.message : ""}
      </p>

      <section aria-label="The scan at a glance" className="space-y-1">
        <h3 className="m-0 text-[10px] font-mono tracking-wider text-outline uppercase font-semibold">
          1 · The scan at a glance
        </h3>
        {glance === undefined || needReview === undefined ? (
          <p className="text-[11.5px] text-on-surface-variant">{scan.glanceUnavailable}</p>
        ) : (
          <>
            <p className="font-mono text-[13px] text-white">{`Scan Review — ${needReview} need review`}</p>
            <div className="grid grid-cols-3 rounded border border-surface-container-high/40 bg-[#141822]">
              <GlanceTile
                caption="a current, verified, clean report"
                figure={glance.passed}
                pill="Passed"
              />
              <GlanceTile
                caption="a person should read the report"
                figure={glance.review}
                pill="Review"
              />
              <GlanceTile
                caption="no report attached"
                figure={glance.notScanned}
                pill="Not scanned"
              />
            </div>
            <p className="font-mono text-[10.5px] text-outline">
              {`${glance.total} catalog items · ${glance.reportsIncluded} reports included · ${glance.currentlyVerified} currently verified`}
            </p>
          </>
        )}
      </section>

      <section aria-label="Do I need to run a scan?" className={`${CARD} space-y-1`}>
        <p className="m-0 text-[11.5px] text-on-surface-variant leading-relaxed">
          <strong className="text-on-surface">In this browser: no.</strong> Scans run in a target
          repository with the AIH engine. Import their evidence or a governance decision here to
          inspect it; nothing imported is verified or becomes effective in this browser.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <label className={`${SECONDARY_BUTTON} cursor-pointer`} htmlFor={evidenceInputId}>
            Import evidence
          </label>
          <input
            accept="application/json"
            className="sr-only"
            id={evidenceInputId}
            onChange={onEvidence}
            type="file"
          />
          <label className={`${SECONDARY_BUTTON} cursor-pointer`} htmlFor={decisionInputId}>
            Import decision (inspection only)
          </label>
          <input
            accept="application/json"
            className="sr-only"
            id={decisionInputId}
            onChange={onDecision}
            type="file"
          />
          <button
            className={SECONDARY_BUTTON}
            disabled={scan.decision === undefined}
            onClick={onDownloadDecision}
            type="button"
          >
            Download decision
          </button>
        </div>
      </section>

      <section aria-label="Needs review, grouped by what it means" className="space-y-1">
        <h3 className="m-0 text-[10px] font-mono tracking-wider text-outline uppercase font-semibold">
          2 · Needs review, grouped
        </h3>
        <div className={`${CARD} space-y-1`}>
          <p className="m-0 text-[12.5px] font-semibold text-on-surface">
            {`Findings an administrator decides — ${scan.findings.dispositionable.length} kinds`}
          </p>
          <p className="m-0 font-mono text-[10.5px] text-on-surface-variant break-words">
            {scan.findings.dispositionable.join(" | ")}
          </p>
        </div>
        <div className="rounded border border-dashed border-surface-container-high bg-surface-container-low p-2 space-y-1">
          <p className="m-0 text-[12.5px] font-semibold text-on-surface">
            {`Nobody can decide these — ${scan.findings.fenced.length} hard blockers`}
          </p>
          <p className="m-0 font-mono text-[10.5px] text-on-surface-variant break-words">
            {scan.findings.fenced.join(" | ")}
          </p>
        </div>
      </section>

      <section aria-label="Approval / evidence" className={`${CARD} space-y-1`}>
        <p className="m-0 text-[12.5px] font-semibold text-on-surface">
          Approval / evidence{" "}
          <span className="font-mono text-[10px] text-outline">preflight only</span>
        </p>
        {scan.receiptRows.length === 0 ? (
          <p className="m-0 text-[11.5px] text-on-surface-variant">
            Import an authority receipt to preserve and inspect its subjects; target-repository
            verification decides authority.
          </p>
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
            {scan.receiptRows.map((row) => (
              <li
                className="flex flex-wrap items-center gap-2 px-2.5 py-2 rounded border border-surface-container-high/40 bg-surface-container-low text-[11.5px]"
                key={`${row.id}-${row.note}`}
              >
                <strong className="font-mono text-on-surface break-all">{row.id}</strong>
                <span className="px-1.5 py-0.5 rounded bg-surface-container-highest font-mono text-[10px] uppercase text-on-surface-variant">
                  Awaiting
                </span>
                <span className="px-1.5 py-0.5 rounded bg-surface-container font-mono text-[10px] text-tertiary">
                  Not verified / not effective
                </span>
                <span className="basis-full text-[11px] text-outline">{row.note}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-[11.5px] text-on-surface-variant">{scan.receiptState}</p>
        {scan.receiptText === undefined ? null : (
          <details className="text-[11.5px]">
            <summary className="cursor-pointer text-[10.5px] font-mono text-on-surface-variant">
              Preserved receipt details
            </summary>
            <p className="text-[11.5px] text-on-surface-variant">
              preserved/preflight-only; not verified or effective.
            </p>
            <pre className={MONO}>{scan.receiptText}</pre>
          </details>
        )}
      </section>

      <section aria-label="Imported governance decision" className={`${CARD} space-y-1`}>
        <p className="m-0 text-[12.5px] font-semibold text-on-surface">
          Imported governance decision{" "}
          <span className="font-mono text-[10px] text-outline">inspection only</span>
        </p>
        <p className="m-0 text-[11.5px] text-on-surface-variant">{scan.decisionState}</p>
        {scan.decision === undefined ? null : (
          <>
            <pre className={MONO}>{scan.decision.lines}</pre>
            <figure aria-label="Canonical decision JSON" className="m-0">
              <pre className={MONO}>{scan.decision.exportText}</pre>
            </figure>
          </>
        )}
      </section>
    </div>
  );
}
