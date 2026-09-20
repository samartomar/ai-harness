import type {
  AdminEngine,
  DiffHunkGap,
  DiffLine,
} from "../../../src/org-policy/workbench/engine/index.js";
import { Segmented } from "../chrome.js";

/**
 * The Changes view: the tool row, the Changes / Whole file segmented control,
 * the diff panel with its painted JSON, and the whole-file textarea
 * (`ui/shell/changes-screen.ts`, prototype `screens/admin-changes.html`).
 */

/** The changes screen's exact sentences (`changes-screen.ts` lines 294-321). */
export const COPIED_MESSAGE = "Policy JSON copied to the clipboard.";
export const COPY_FAILED_MESSAGE = "Copy failed: the clipboard is unavailable here.";
const NO_CHANGES_SENTENCE = "No changes from the starting policy.";
const CHANGES_REGION_LABEL = "Changes from the starting policy";
const STAGED_LABEL = "Staged policy delta";
const COPY_LABEL = "Copy JSON";
const SHOW_LABEL = "Show";
const WHOLE_FILE_LABEL = "Organization policy file";

export type ChangesViewMode = "changes" | "whole";

export function ChangesView({
  engine,
  mode,
  onMode,
  onCopy,
  policyText,
  policyTextId,
}: {
  readonly engine: AdminEngine;
  readonly mode: ChangesViewMode;
  readonly onMode: (mode: ChangesViewMode) => void;
  readonly onCopy: () => void;
  readonly policyText: string;
  readonly policyTextId: string;
}) {
  // The diff is computed only when the Changes view asks for it.
  const hunks = mode === "changes" ? engine.changes() : [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
          {STAGED_LABEL}
        </span>
        <button
          className="px-2 py-1 rounded bg-surface-container hover:bg-surface-container-high text-primary transition-colors font-mono text-[10.5px]"
          onClick={onCopy}
          type="button"
        >
          {COPY_LABEL}
        </button>
        <span className="flex-1" />
        <Segmented
          label={SHOW_LABEL}
          onChange={onMode}
          options={[
            { value: "changes", label: "Changes" },
            { value: "whole", label: "Whole file" },
          ]}
          size="sm"
          value={mode}
        />
      </div>
      {mode === "changes" ? (
        <ChangesPanel hunks={hunks} />
      ) : (
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
          {WHOLE_FILE_LABEL}
          <textarea
            className="h-56 w-full p-2 rounded bg-[#141822] border border-surface-container-high/60 font-mono text-[11px] text-on-surface normal-case tracking-normal"
            id={policyTextId}
            readOnly
            value={policyText}
          />
        </label>
      )}
    </>
  );
}

/** The prototype's JSON paint: keys in primary, string values in secondary. */
function PaintedJson({ text }: { readonly text: string }) {
  const pieces: { key: string; className?: string; text: string }[] = [];
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) pieces.push({ key: `t${last}`, text: text.slice(last, index) });
    pieces.push({
      className: match[2] === undefined ? "text-secondary" : "text-primary",
      key: `s${index}`,
      text: match[1] ?? "",
    });
    if (match[2] !== undefined) pieces.push({ key: `c${index}`, text: match[2] });
    last = index + match[0].length;
  }
  if (last < text.length) pieces.push({ key: `t${last}`, text: text.slice(last) });
  return (
    <>
      {pieces.map((piece) => (
        <span className={piece.className} key={piece.key}>
          {piece.text}
        </span>
      ))}
    </>
  );
}

const DIFF_LINE_CLASS: Record<DiffLine["kind"], string> = {
  " ": "px-3",
  "+": "px-3 bg-secondary-container/20 border-l-2 border-secondary",
  "-": "px-3 bg-tertiary-container/20 border-l-2 border-tertiary",
};

/**
 * One diff row. Added and removed lines are told apart by more than colour: a
 * visible "+" or "-" marker, and the row's own accessible label
 * (`changes-screen.ts` lines 105-124).
 */
function DiffRow({ entry }: { readonly entry: DiffLine }) {
  const added = entry.kind === "+";
  return (
    <li
      aria-label={entry.kind === " " ? undefined : `${added ? "Added" : "Removed"}: ${entry.text}`}
      className={`flex whitespace-pre-wrap break-all ${DIFF_LINE_CLASS[entry.kind]}`}
    >
      <span
        aria-hidden="true"
        className="inline-block w-8 shrink-0 text-outline select-none tabular-nums"
      >
        {entry.line === undefined ? "" : String(entry.line)}
      </span>
      <span
        aria-hidden="true"
        className={`inline-block w-3 shrink-0 select-none ${added ? "text-secondary" : "text-tertiary"}`}
      >
        {entry.kind === " " ? "" : entry.kind}
      </span>
      <span className="min-w-0">
        <PaintedJson text={entry.text} />
      </span>
    </li>
  );
}

/** The "Changes" view: hunks with context, the folded gaps between them. */
function ChangesPanel({ hunks }: { readonly hunks: readonly (DiffLine | DiffHunkGap)[] }) {
  return (
    <section
      aria-label={CHANGES_REGION_LABEL}
      className="py-2 rounded bg-[#141822] border border-surface-container-high/60 font-mono text-[10.5px] leading-relaxed text-on-surface overflow-x-auto"
    >
      {hunks.length === 0 ? (
        <p className="m-0 px-3 py-1 text-outline">{NO_CHANGES_SENTENCE}</p>
      ) : (
        <ol className="list-none m-0 p-0">
          {hunks.map((entry, index) =>
            entry.kind === "gap" ? (
              <li
                className="px-3 py-0.5 text-[10px] text-outline bg-surface-container-low select-none"
                // The hunks are a positional list; nothing else identifies a row.
                // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
                key={`gap-${index}`}
              >
                {`⋯ ${entry.skipped} unchanged ${entry.skipped === 1 ? "line" : "lines"}`}
              </li>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
              <DiffRow entry={entry} key={`line-${index}`} />
            ),
          )}
        </ol>
      )}
    </section>
  );
}
