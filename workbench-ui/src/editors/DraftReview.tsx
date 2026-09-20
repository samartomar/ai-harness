import { useId, useState } from "react";
import type {
  AdminDraftEntryV1,
  AdminEngine,
} from "../../../src/org-policy/workbench/engine/index.js";
import { FACT_ROW, FACTS, GHOST_BUTTON, PILL, SECONDARY_BUTTON, TEXT_INPUT } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Editor 19a: the draft review panel (`ui/catalog-inventory.ts`
 * `renderDraftReview`, lines 3755-4102). Every sentence comes from the engine,
 * which copies the hand-built page's words; this file places them as text.
 *
 * The hand-built page shows this as an inspector view. Lane A owns the
 * inspector, so this is a standalone panel; the lead moves it into an
 * inspector tab at merge.
 */

export const DRAFT_REVIEW_TITLE = "Review draft";
/** The header badge beside "Review Changes" (`catalog-inventory.ts` line 863). */
export const REVIEW_BADGE_LABEL = "Draft entries";
const COUNTS_LABEL = "Draft counts";
const ENTRIES_LABEL = "Saved draft entries";
const EXCLUDE_LABEL = "Exclude";
const REMOVE_EXCLUSION_LABEL = "Remove exclusion";
const SAVE_REASON_LABEL = "Save reason";
const REASON_PLACEHOLDER =
  "Why this choice? For example: use this MCP for local code review; omit the duplicate from ECC.";

/** The count the hand-built page shows as "Draft (N)" on its panel button. */
export function ReviewBadge({ count }: { readonly count: number }) {
  return (
    <span aria-label={REVIEW_BADGE_LABEL} className={PILL} role="status">
      {`Draft (${count})`}
    </span>
  );
}

export function DraftReview({
  engine,
  run,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
}) {
  const review = engine.draftReview();
  return (
    <section aria-label={DRAFT_REVIEW_TITLE} className="space-y-2">
      <h3 className="font-semibold text-on-surface text-[12px] font-mono">{review.summaryLabel}</h3>
      <p className="text-[10.5px] text-outline font-mono">{review.intro}</p>
      <dl aria-label={COUNTS_LABEL} className={FACTS}>
        {review.counts.map((count) => (
          <div className={FACT_ROW} key={count.label} title={count.help}>
            <dt className="text-on-surface-variant">{count.label}</dt>
            <dd className="text-on-surface font-semibold font-mono tabular-nums">{count.figure}</dd>
          </div>
        ))}
      </dl>
      {review.problem === undefined ? null : (
        <p className="text-tertiary" role="status">
          {review.problem}
        </p>
      )}
      {review.empty === undefined ? (
        <ul aria-label={ENTRIES_LABEL} className="list-none m-0 p-0 space-y-2">
          {review.entries.map((entry) => (
            <li key={`${entry.category}:${entry.assetId}:${entry.origin ?? ""}`}>
              <DraftEntry engine={engine} entry={entry} run={run} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-3 rounded border border-dashed border-surface-container-high/60 text-on-surface-variant">
          {review.empty}
        </p>
      )}
    </section>
  );
}

function DraftEntry({
  engine,
  entry,
  run,
}: {
  readonly engine: AdminEngine;
  readonly entry: AdminDraftEntryV1;
  readonly run: RunEngineCall;
}) {
  return (
    <article className="p-2.5 rounded bg-surface-container-low border border-surface-container-high/60 flex flex-col gap-1.5">
      <p className={PILL}>{entry.category}</p>
      <h4 className="font-mono font-bold text-[12px] text-on-surface break-words">{entry.title}</h4>
      {entry.help === undefined ? null : <p className="text-on-surface-variant">{entry.help}</p>}
      {entry.origin === undefined ? null : (
        <p className="font-mono text-[10px] text-outline">{entry.origin}</p>
      )}
      {entry.templateRemoval === undefined ? null : (
        <div className="flex flex-col items-start gap-1">
          <p className="text-on-surface-variant">{entry.templateRemoval.help}</p>
          <button
            className={SECONDARY_BUTTON}
            onClick={() => {
              const removal = entry.templateRemoval;
              if (removal !== undefined)
                run(() => engine.removeTemplate(removal.templateId, removal.digest));
            }}
            type="button"
          >
            {entry.templateRemoval.label}
          </button>
        </div>
      )}
      {entry.retained === undefined ? null : (
        <div className="flex flex-col items-start gap-1">
          <p className="text-on-surface-variant">{entry.retained.note}</p>
          <button
            aria-label={entry.retained.accessibleName}
            className={SECONDARY_BUTTON}
            onClick={() => {
              const pin = entry.retained;
              if (pin !== undefined)
                run(() => engine.removeRepair(pin.repairType, entry.assetId, pin.originKind));
            }}
            type="button"
          >
            {entry.retained.removeLabel}
          </button>
        </div>
      )}
      {entry.context === undefined ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-on-surface-variant">{entry.context.purpose}</p>
          {/* The report state is told by its words, never by colour alone. */}
          <p className="self-start px-1.5 py-0.5 rounded bg-surface-container font-mono text-[10px] text-on-surface-variant">
            {entry.context.report}
          </p>
          <details>
            <summary className="cursor-pointer text-outline">Adoption details</summary>
            <p className="text-on-surface-variant">{entry.context.consequence}</p>
            {entry.context.nextStep === undefined ? null : (
              <p className="text-on-surface-variant">{entry.context.nextStep}</p>
            )}
            {entry.context.command === undefined ? null : (
              <code className="block mt-1 p-2 rounded bg-surface-container-lowest border border-surface-container-high/60 font-mono text-[10.5px] text-on-surface break-all">
                {entry.context.command}
              </code>
            )}
          </details>
        </div>
      )}
      {entry.entryKind === undefined ? null : (
        <button
          className={`${GHOST_BUTTON} self-start`}
          onClick={() => run(() => engine.toggleExclusion(entry.assetId))}
          type="button"
        >
          {entry.entryKind === "exclusion" ? REMOVE_EXCLUSION_LABEL : EXCLUDE_LABEL}
        </button>
      )}
      {entry.reason === undefined || entry.entryKind === undefined ? null : (
        <Reason
          assetId={entry.assetId}
          engine={engine}
          entryKind={entry.entryKind}
          label={entry.reason.label}
          run={run}
          value={entry.reason.value}
        />
      )}
    </article>
  );
}

/** One saved entry's reason. The engine decides whether it may be saved. */
function Reason({
  engine,
  entryKind,
  assetId,
  label,
  value,
  run,
}: {
  readonly engine: AdminEngine;
  readonly entryKind: "root" | "request" | "exclusion";
  readonly assetId: string;
  readonly label: string;
  readonly value: string;
  readonly run: RunEngineCall;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState(value);
  return (
    <details>
      <summary className="cursor-pointer text-outline">
        {value === "" ? "Add a reason" : "Edit reason"}
      </summary>
      <div className="flex flex-col gap-1.5 pt-1.5">
        <label
          className="text-[10px] font-mono uppercase tracking-wider text-outline"
          htmlFor={fieldId}
        >
          {label}
        </label>
        <textarea
          className={`${TEXT_INPUT} h-16 py-1 leading-snug normal-case`}
          id={fieldId}
          maxLength={1000}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={REASON_PLACEHOLDER}
          value={draft}
        />
        <button
          className={`${SECONDARY_BUTTON} self-start`}
          onClick={() => run(() => engine.setRationale(entryKind, assetId, draft))}
          type="button"
        >
          {SAVE_REASON_LABEL}
        </button>
      </div>
    </details>
  );
}
