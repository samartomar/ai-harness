import type { ReactNode } from "react";
import { FACT_ROW, FACTS, PANEL_HEADING } from "../chrome.js";

/** The aside: what the project's AI carries, and the counts behind it. */

const HEADING = "What your AI carries";
const NO_TOOL = "no AI tool";
const EMPTY_NAME = "—";

export function ProjectFacts({
  forType,
  forName,
  tools,
  counts,
  children,
}: {
  readonly forType: string;
  readonly forName: string;
  readonly tools: readonly string[];
  readonly counts: { readonly required: number; readonly optional: number; readonly skip: number };
  /** The footer controls the page places under the facts. */
  readonly children: ReactNode;
}) {
  return (
    <aside className="w-72 shrink-0 border-l border-surface-container-high/60 bg-surface-container-lowest p-3 space-y-2 overflow-y-auto">
      <h2 className={PANEL_HEADING}>{HEADING}</h2>
      <div className={FACTS}>
        <div className={FACT_ROW}>
          <span>For</span>
          <span className="text-on-surface text-right">
            {forType} · {forName === "" ? EMPTY_NAME : forName}
          </span>
        </div>
        <div className={FACT_ROW}>
          <span>On</span>
          <span className="text-on-surface text-right">
            {tools.length === 0 ? NO_TOOL : tools.join(", ")}
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
      {children}
    </aside>
  );
}
