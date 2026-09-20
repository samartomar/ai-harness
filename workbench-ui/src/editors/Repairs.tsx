import type { AdminEngine } from "../../../src/org-policy/workbench/engine/index.js";
import { SECONDARY_BUTTON } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Editor 20b: saved selections needing review (`ui/catalog-inventory.ts`
 * `renderRepairs`, lines 3230-3294). Each row says what is stale and offers
 * exactly the one removal the hand-built page offers. The saved record is
 * never rewritten, only removed.
 */

export const REPAIRS_TITLE = "Saved selections needing review";
const NONE = "No saved selection needs review.";

export function Repairs({
  engine,
  run,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
}) {
  const repairs = engine.repairs();
  return (
    <section aria-label={REPAIRS_TITLE} className="space-y-1.5">
      <h3 className="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        {REPAIRS_TITLE}
      </h3>
      {repairs.length === 0 ? (
        <p className="text-on-surface-variant">{NONE}</p>
      ) : (
        <ul className="list-none m-0 p-0 space-y-1.5">
          {repairs.map((repair) => (
            <li className="flex flex-wrap items-center gap-2" key={repair.removeLabel}>
              <span className="text-on-surface-variant">{repair.text}</span>
              <button
                className={SECONDARY_BUTTON}
                onClick={() =>
                  run(() =>
                    repair.template !== undefined
                      ? engine.removeTemplate(repair.template.templateId, repair.template.digest)
                      : repair.entry !== undefined
                        ? engine.removeRepair(
                            repair.entry.type,
                            repair.entry.assetId,
                            repair.entry.originKind,
                          )
                        : { ok: false, message: "Saved selection removal rejected." },
                  )
                }
                type="button"
              >
                {repair.removeLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
