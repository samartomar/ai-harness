import { useId, useState } from "react";
import type { AdminEngine, AdminState } from "../../../src/org-policy/workbench/engine/index.js";
import { GHOST_BUTTON, PRIMARY_BUTTON, TEXT_INPUT } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Editor 20c: the replacement review and its confirm
 * (`ui/catalog-inventory.ts` lines 2625-2727 and 3533-3575). The engine
 * computes the comparison and refuses a confirm whose draft has moved on, with
 * the hand-built page's own sentence.
 *
 * The hand-built page opens this from a catalog row's add control. Lane A owns
 * the catalog rows, so this panel picks the item instead; the lead wires it to
 * the row's add at merge.
 */

export const COMPARISON_TITLE = "Review replacement";
const ITEM_LABEL = "Item to compare";
const CONFIRM_LABEL = "Confirm replacement";
const CANCEL_LABEL = "Cancel";
const NONE = "Choose an item to see what adding it would replace.";

export function SelectionComparison({
  engine,
  state,
  run,
}: {
  readonly engine: AdminEngine;
  readonly state: AdminState;
  readonly run: RunEngineCall;
}) {
  const fieldId = useId();
  const [assetId, setAssetId] = useState("");
  const items = state.frameworks.flatMap((framework) =>
    framework.groups.flatMap((group) =>
      group.items.filter((item) => item.selectable).map((item) => item),
    ),
  );
  const comparison = assetId === "" ? undefined : engine.comparison(assetId);
  return (
    <section aria-label={COMPARISON_TITLE} className="space-y-1.5">
      <h3 className="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        {COMPARISON_TITLE}
      </h3>
      <label className="flex flex-col gap-1 text-outline" htmlFor={fieldId}>
        {ITEM_LABEL}
        <select
          className={TEXT_INPUT}
          id={fieldId}
          onChange={(event) => setAssetId(event.target.value)}
          value={assetId}
        >
          <option value="">{NONE}</option>
          {items.map((item) => (
            <option key={item.assetId} value={item.assetId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {comparison === undefined ? null : (
        <div className="p-2.5 rounded border border-surface-container-high/60 bg-surface-container flex flex-col gap-1.5">
          <p className="text-on-surface-variant">{comparison.explanation}</p>
          <p className="text-on-surface-variant">{comparison.changes}</p>
          <ul className="list-none m-0 p-0 space-y-0.5">
            {comparison.records.map((record) => (
              <li className="text-on-surface-variant" key={record.detail} title={record.detail}>
                {record.text}
              </li>
            ))}
          </ul>
          <p className="text-on-surface-variant">{comparison.removed}</p>
          <p className="text-on-surface-variant">{comparison.added}</p>
          <div className="flex items-center gap-2">
            <button
              className={PRIMARY_BUTTON}
              disabled={!comparison.confirmable}
              onClick={() => {
                run(() => engine.confirmComparison(comparison.assetId, comparison.token));
                setAssetId("");
              }}
              type="button"
            >
              {CONFIRM_LABEL}
            </button>
            <button className={GHOST_BUTTON} onClick={() => setAssetId("")} type="button">
              {CANCEL_LABEL}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
